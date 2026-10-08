/**
 * 两个 provider 必须共同通过的测试套件。
 *
 * "适配完成"的定义就是：这套用例在 LocalSandbox 与 DockerSandbox 上同样全绿。
 * 因此本文件只依赖 SandboxProvider 接口，不得引用任何实现细节。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  SandboxError,
  type EnvType,
  type SandboxHandle,
  type SandboxProcess,
  type SandboxProvider,
} from '../types.js';

export interface ProviderSuiteOptions {
  /** 被测 provider。 */
  readonly provider: SandboxProvider;
  /** 套件名。 */
  readonly name: string;
  /** 已就绪的沙盒句柄；套件结束后会 destroy。 */
  readonly handle: SandboxHandle;
  /**
   * 该 provider 是否提供真实的安全边界。
   * false 时跳过"越界写入必须失败"之类的安全断言，改为只断言路径解析被拒绝。
   */
  readonly enforcesIsolation: boolean;
  /** 覆盖默认超时（容器冷启动较慢时可放宽）。 */
  readonly timeouts?: { readonly exec?: number };
}

/** 生成唯一的测试用项目目录名，避免并发跑测时互相踩。 */
function tag(label: string): string {
  return `t_${label}_${process.pid}_${Date.now().toString(36)}`;
}

/**
 * 反复读长驻进程的输出，直到匹配上或超时。
 *
 * 必须轮询而不是"读一次就断言"：输出什么时候到取决于进程调度，
 * 一次读不到不代表它永远不来（同理，也不能拿一次读到的东西当全部输出）。
 */
async function readUntil(
  proc: SandboxProcess,
  pattern: RegExp,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let collected = '';
  for (;;) {
    const chunk = await proc.read();
    collected += chunk.stdout + chunk.stderr;
    if (pattern.test(collected)) return collected;
    if (Date.now() > deadline) return collected;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 等进程退出。长驻进程自己退出是常态，测试要能等它。 */
async function waitForExit(
  proc: SandboxProcess,
  timeoutMs = 30_000,
): Promise<{ running: boolean; exitCode: number | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await proc.status();
    if (!status.running) return status;
    if (Date.now() > deadline) return status;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function defineProviderSuite(options: ProviderSuiteOptions): void {
  const { provider, handle, name } = options;
  const execTimeout = options.timeouts?.exec ?? 60_000;

  describe(`${name} · SandboxProvider 一致性套件`, () => {
    before(async () => {
      assert.equal(handle.provider, provider.kind, 'handle.provider 与 provider.kind 应一致');
    });

    after(async () => {
      await provider.destroy(handle);
    });

    it('get() 能取回已创建的沙盒，未知 id 返回 undefined', async () => {
      const found = await provider.get(handle.id);
      assert.ok(found, 'create() 之后 get() 应能找到沙盒');
      assert.equal(found.id, handle.id);
      assert.equal(await provider.get('no-such-sandbox-id'), undefined);
    });

    it('adopt() 接管已有沙盒，且接管之后真的能用', { timeout: execTimeout }, async () => {
      const adopted = await provider.adopt(handle.id, {
        projectId: handle.projectId,
        envType: handle.envType,
      });
      // 身份必须与 create() 时一致：接管出来一个"同名但换了项目/环境"的句柄，
      // 会让后续 SANDBOX_PROJECT_ID 与文案派生都拿到错的值。
      assert.equal(adopted.id, handle.id);
      assert.equal(adopted.projectId, handle.projectId);
      assert.equal(adopted.envType, handle.envType);
      assert.equal(adopted.provider, provider.kind);
      assert.equal(adopted.workDir, handle.workDir);

      // 只是把句柄造出来不算接管：得能真的执行。
      const result = await provider.exec(adopted, 'node -e "process.stdout.write(\'adopted-ok\')"');
      assert.equal(result.exitCode, 0, `stderr=${result.stderr}`);
      assert.equal(result.stdout, 'adopted-ok');
    });

    it('adopt() 对不存在的 id 抛 NO_SUCH_SANDBOX，不返回假句柄', async () => {
      await assert.rejects(
        () => provider.adopt('no-such-sandbox-id', { projectId: tag('ghost'), envType: 'copy' }),
        (error: unknown) => error instanceof SandboxError && error.code === 'NO_SUCH_SANDBOX',
      );
    });

    it('start() 起长驻进程：能写 stdin、能读到回显、kill 之后不再活着', { timeout: execTimeout }, async () => {
      // 一个把 stdin 回显出来的小程序：**只有 stdin 真的送到了**才会读到 ECHO。
      // 用 `exec` 做不到这件事——它不支持"跑起来之后再写输入"。
      const proc = await provider.start(
        handle,
        'node -e "process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',d=>process.stdout.write(\'ECHO:\'+d))"',
      );
      try {
        assert.equal((await proc.status()).running, true, '刚起的进程应当还在跑');
        assert.equal(await proc.write('ping\n'), true, 'stdin 写不进去');
        const echoed = await readUntil(proc, /ECHO:ping/);
        assert.match(echoed, /ECHO:ping/, 'stdin 没送到进程里（或回显没读回来）');
        // 没退出之前 exitCode 必须是 null，而不是 0——否则调用方会以为它已经跑完了。
        assert.equal((await proc.status()).exitCode, null);
      } finally {
        await proc.kill();
      }

      const after = await proc.status();
      assert.equal(after.running, false, 'kill 之后进程还在跑');
      // 幂等：重复 kill 不该抛错。
      await proc.kill();
    });

    it('start() 的进程自己退出时如实报退出码，write 返回 false 而不是抛错', { timeout: execTimeout }, async () => {
      const proc = await provider.start(
        handle,
        'node -e "process.stdout.write(\'bye\');process.exit(3)"',
      );
      const output = await readUntil(proc, /bye/);
      assert.match(output, /bye/);

      const settled = await waitForExit(proc);
      assert.equal(settled.running, false);
      assert.equal(settled.exitCode, 3, '退出码没有被如实带出来');
      // 对已退出的进程写 stdin 是**正常结局**，不该抛错。
      assert.equal(await proc.write('after-exit\n'), false);
      await proc.kill();
    });

    it('exec 正常执行并捕获 stdout/退出码 0', { timeout: execTimeout }, async () => {
      const result = await provider.exec(handle, 'node -e "process.stdout.write(\'hello-sandbox\')"');
      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 0, `stderr=${result.stderr}`);
      assert.equal(result.stdout.trim(), 'hello-sandbox');
      assert.ok(result.durationMs >= 0);
    });

    it('exec 把 stderr 与退出码分开回报', { timeout: execTimeout }, async () => {
      const result = await provider.exec(
        handle,
        'node -e "process.stderr.write(\'boom\');process.exit(7)"',
      );
      assert.equal(result.exitCode, 7);
      assert.equal(result.stderr.trim(), 'boom');
      assert.equal(result.timedOut, false);
    });

    it('exec 超时后终止并把 timedOut 置真', { timeout: execTimeout }, async () => {
      const result = await provider.exec(handle, 'node -e "setTimeout(()=>{},60000)"', {
        timeoutMs: 1_500,
      });
      assert.equal(result.timedOut, true, '应当报告超时');
      assert.ok(result.durationMs < 30_000, `超时后应尽快返回，实际 ${result.durationMs}ms`);
    });

    it('exec 超时终止整棵进程树（子进程不留活口）', { timeout: execTimeout }, async () => {
      // 孙子进程监听一个回环端口——**死进程占不住端口**，这是最不含糊的判活方式。
      //
      // 不用 `kill -0 <pid>`：僵尸进程也让它返回成功（实测踩到过：Docker 里树其实
      // 已经被杀干净，孙子成了 defunct，而 `kill -0` 说"还活着"）。
      const port = 34_000 + (process.pid % 1_000);
      await provider.writeFile(
        handle,
        'orphan-listener.js',
        `const net = require('net');\n` +
          `net.createServer().listen(${port}, '127.0.0.1');\n` +
          `setInterval(() => {}, 1000);\n`,
      );

      // 父进程**保持存活**（否则树在超时前就散了，这条用例又会退化成"什么都没验"），
      // 它拉起的孙子活在这棵树里。超时清理必须把整棵树带走，而不只是直接子进程。
      await provider.exec(
        handle,
        'node -e "const{spawn}=require(\'child_process\');spawn(process.execPath,[\'orphan-listener.js\'],{stdio:\'ignore\'});console.log(\'marker\');setInterval(()=>{},1000)"',
        { timeoutMs: 2_000 },
      );

      const liveness = await provider.exec(
        handle,
        `node -e "const s=require('net').connect(${port},'127.0.0.1');` +
          `s.on('connect',()=>{process.stdout.write('ALIVE');s.destroy()});` +
          `s.on('error',()=>process.stdout.write('GONE'))"`,
        { timeoutMs: 10_000 },
      );
      assert.match(
        liveness.stdout.trim(),
        /^GONE/,
        `超时后孙进程还活着（${liveness.stdout.trim()}）——进程树没被清掉`,
      );

      const result = await provider.exec(handle, 'node -e "process.stdout.write(\'alive\')"', {
        timeoutMs: 10_000,
      });
      assert.equal(result.stdout.trim(), 'alive', '沙盒应仍可继续执行命令');
    });

    it('exec 输出超过上限时截断并置 truncated', { timeout: execTimeout }, async () => {
      const result = await provider.exec(
        handle,
        'node -e "for(let i=0;i<2000;i++)process.stdout.write(\'x\'.repeat(1000))"',
        { maxOutputBytes: 4_096 },
      );
      assert.equal(result.truncated, true);
      assert.ok(
        result.stdout.length < 20_000,
        `截断后长度应受控，实际 ${result.stdout.length}`,
      );
    });

    it('exec 支持自定义环境变量与工作目录', { timeout: execTimeout }, async () => {
      const script =
        "process.stdout.write(process.env.MY_FLAG+':'+(/artifacts$/.test(process.cwd())?'at-artifacts':'elsewhere'))";
      const result = await provider.exec(handle, `node -e "${script}"`, {
        env: { MY_FLAG: 'flag-value' },
        cwd: 'artifacts',
      });
      assert.equal(result.exitCode, 0, `stderr=${result.stderr}`);
      assert.equal(result.stdout.trim(), 'flag-value:at-artifacts');
    });

    it('exec 拒绝逃出沙盒的 cwd', async () => {
      await assert.rejects(
        () => provider.exec(handle, 'node -e "0"', { cwd: '../..' }),
        (error: unknown) => {
          assert.ok(error instanceof SandboxError, '应抛 SandboxError');
          assert.equal(error.code, 'PATH_ESCAPE');
          return true;
        },
      );
    });

    it('writeFile / readFile 往返一致（含二进制）', async () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
      await provider.writeFile(handle, 'artifacts/blob.bin', bytes);
      const back = await provider.readFile(handle, 'artifacts/blob.bin');
      assert.deepEqual(Array.from(back), Array.from(bytes));

      await provider.writeFile(handle, 'artifacts/nested/deep/note.txt', '深层文本');
      const text = await provider.readFile(handle, 'artifacts/nested/deep/note.txt');
      assert.equal(new TextDecoder().decode(text), '深层文本');
    });

    it('readFile 对缺失文件抛 NO_SUCH_FILE', async () => {
      await assert.rejects(
        () => provider.readFile(handle, 'artifacts/definitely-missing.txt'),
        (error: unknown) => {
          assert.ok(error instanceof SandboxError, '应抛 SandboxError');
          assert.equal(error.code, 'NO_SUCH_FILE');
          return true;
        },
      );
    });

    it('exists 区分存在与不存在', async () => {
      await provider.writeFile(handle, 'artifacts/probe.txt', 'x');
      assert.equal(await provider.exists(handle, 'artifacts/probe.txt'), true);
      assert.equal(await provider.exists(handle, 'artifacts/nope.txt'), false);
    });

    it('listFiles 支持 ** 与 * 模式', async () => {
      await provider.writeFile(handle, 'src/a.ts', 'a');
      await provider.writeFile(handle, 'src/nested/b.ts', 'b');
      await provider.writeFile(handle, 'src/nested/c.md', 'c');

      const all = await provider.listFiles(handle, 'src/**');
      const paths = all.map((f) => f.path);
      assert.ok(paths.includes('src/a.ts'), `实际: ${paths.join(',')}`);
      assert.ok(paths.includes('src/nested/b.ts'), `实际: ${paths.join(',')}`);
      assert.ok(paths.includes('src/nested/c.md'), `实际: ${paths.join(',')}`);

      const onlyTs = await provider.listFiles(handle, 'src/**/*.ts');
      assert.deepEqual(
        onlyTs.map((f) => f.path).sort(),
        ['src/a.ts', 'src/nested/b.ts'],
      );

      const rootOnly = await provider.listFiles(handle, '*.txt');
      assert.deepEqual(rootOnly, [], '根层无 .txt 时应为空，* 不得向下递归');
    });

    it('collectArtifacts 收集 artifacts/ 下的产物并给出 mimeHint', async () => {
      await provider.writeFile(handle, 'artifacts/out.png', new Uint8Array([137, 80, 78, 71]));
      await provider.writeFile(handle, 'artifacts/out.json', '{}');
      const artifacts = await provider.collectArtifacts(handle);
      const byPath = new Map(artifacts.map((a) => [a.path, a]));
      assert.equal(byPath.get('artifacts/out.png')?.mimeHint, 'image/png');
      assert.equal(byPath.get('artifacts/out.json')?.mimeHint, 'application/json');
    });

    it('stats 反映写入的文件数与体积', async () => {
      const before = await provider.stats(handle);
      await provider.writeFile(handle, 'artifacts/size-probe.bin', new Uint8Array(5_000));
      const afterStats = await provider.stats(handle);
      assert.ok(
        afterStats.diskBytes >= before.diskBytes + 5_000,
        `体积应增长至少 5000，before=${before.diskBytes} after=${afterStats.diskBytes}`,
      );
      assert.ok(afterStats.fileCount > before.fileCount);
    });

    it('拒绝逃出沙盒的写入路径', async () => {
      for (const bad of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd', 'C:\\Windows\\evil.txt']) {
        await assert.rejects(
          () => provider.writeFile(handle, bad, 'x'),
          (error: unknown) => {
            assert.ok(error instanceof SandboxError, `路径 ${bad} 应抛 SandboxError`);
            assert.equal(error.code, 'PATH_ESCAPE', `路径 ${bad} 的错误码应为 PATH_ESCAPE`);
            return true;
          },
          `路径 ${bad} 必须被拒绝`,
        );
      }
    });

    it('命令在工作区内看到的 cwd 就是沙盒目录', { timeout: execTimeout }, async () => {
      const result = await provider.exec(handle, 'node -e "process.stdout.write(process.env.SANDBOX_ENV_TYPE)"');
      assert.equal(result.stdout.trim(), handle.envType);
    });

    it('destroy 之后沙盒不可再用，且重复 destroy 幂等', async () => {
      const throwawayProject = tag('destroy');
      const temp = await provider.create(throwawayProject, handle.envType as EnvType);
      await provider.destroy(temp);
      assert.equal(await provider.get(temp.id), undefined, 'destroy 后 get() 应返回 undefined');
      await provider.destroy(temp); // 幂等，不应抛
    });

    it('create 拒绝非法 projectId', async () => {
      for (const bad of ['../evil', 'has space', 'has/slash', '']) {
        await assert.rejects(
          () => provider.create(bad, handle.envType as EnvType),
          (error: unknown) => {
            assert.ok(error instanceof SandboxError, `projectId ${JSON.stringify(bad)} 应被拒绝`);
            return true;
          },
        );
      }
    });
  });
}
