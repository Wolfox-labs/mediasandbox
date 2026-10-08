/**
 * 附流帧格式的测试。
 *
 * 这一组**不需要 Docker**：帧处理是纯字节逻辑，也正是最容易出错的一层。
 * 真出错时的表现是"输出乱码/输入丢失"，从容器侧看不出来任何异常，所以只能在这里守住。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FRAME_HEADER_BYTES,
  STREAM_STDERR,
  STREAM_STDIN,
  STREAM_STDOUT,
  createDemuxer,
  frameStdin,
} from './stream-frames.js';

/** 造一帧（与 Docker 的格式一致：type 1 字节 + 3 字节填充 + 长度 4 字节大端）。 */
function frame(type: number, payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** 收集两个流，便于断言。 */
function collect(): {
  out: string[];
  err: string[];
  demux: ReturnType<typeof createDemuxer>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const demux = createDemuxer(
    (chunk) => out.push(chunk.toString('utf8')),
    (chunk) => err.push(chunk.toString('utf8')),
  );
  return { out, err, demux };
}

describe('附流：多路复用（非 TTY）', () => {
  it('按帧头把 stdout 与 stderr 分开', () => {
    const { out, err, demux } = collect();
    demux.push(Buffer.concat([frame(STREAM_STDOUT, 'hello'), frame(STREAM_STDERR, 'boom')]));
    demux.flush();
    assert.equal(out.join(''), 'hello');
    assert.equal(err.join(''), 'boom', 'stderr 混进了 stdout 或丢了');
  });

  it('一帧被切成两半也能解出来——流的分块边界与帧边界无关', () => {
    const { out, err, demux } = collect();
    const bytes = Buffer.concat([frame(STREAM_STDOUT, 'hello'), frame(STREAM_STDERR, 'boom')]);
    // 逐字节喂：这是最坏的分块情况。
    for (const byte of bytes) demux.push(Buffer.from([byte]));
    demux.flush();
    assert.equal(out.join(''), 'hello');
    assert.equal(err.join(''), 'boom');
    assert.equal(demux.pending(), 0, '还有没消费掉的字节');
  });

  it('多个帧的先后顺序保持不变', () => {
    const { out, demux } = collect();
    demux.push(
      Buffer.concat([
        frame(STREAM_STDOUT, 'a'),
        frame(STREAM_STDOUT, 'b'),
        frame(STREAM_STDERR, '!'),
        frame(STREAM_STDOUT, 'c'),
      ]),
    );
    demux.flush();
    assert.equal(out.join(''), 'abc');
  });

  it('stdin 回显与未知帧类型被忽略，不混进输出', () => {
    const { out, err, demux } = collect();
    demux.push(
      Buffer.concat([frame(STREAM_STDIN, 'echoed'), frame(7, 'weird'), frame(STREAM_STDOUT, 'ok')]),
    );
    demux.flush();
    assert.equal(out.join(''), 'ok');
    assert.equal(err.join(''), '');
  });

  it('零长度帧不产生空输出，也不会卡住后面的帧', () => {
    const { out, demux } = collect();
    demux.push(Buffer.concat([frame(STREAM_STDOUT, ''), frame(STREAM_STDOUT, 'after')]));
    demux.flush();
    assert.equal(out.join(''), 'after');
  });

  it('载荷没到齐时留在缓冲里，flush 时当 stdout 交出——不丢内容', () => {
    const { out, demux } = collect();
    const whole = frame(STREAM_STDERR, 'truncated-payload');
    // 只给头部 + 3 个字节载荷：帧不完整。
    demux.push(whole.subarray(0, FRAME_HEADER_BYTES + 3));
    assert.equal(out.join(''), '', '不完整的帧不该被提前吐出');
    assert.equal(demux.pending(), FRAME_HEADER_BYTES + 3);
    demux.flush();
    // 残帧整体当 stdout 交出：宁可归错流，也不能把内容丢掉。
    assert.equal(out.join('').length, FRAME_HEADER_BYTES + 3);
    assert.equal(demux.pending(), 0);
  });

  it('write 侧：stdin 必须自己加帧，长度与类型都对', () => {
    const framed = frameStdin('ls\n');
    assert.equal(framed[0], STREAM_STDIN, 'stdin 帧的类型应为 0');
    assert.equal(framed.readUInt32BE(4), 3, '长度应写进头部');
    assert.equal(framed.subarray(FRAME_HEADER_BYTES).toString('utf8'), 'ls\n');
    // 解帧器忽略 stdin 帧——回显不该混进输出。
    const { out, err, demux } = collect();
    demux.push(framed);
    demux.flush();
    assert.equal(out.join(''), '');
    assert.equal(err.join(''), '');
  });
});

describe('附流：裸流（TTY）', () => {
  /** 裸流要**按字节**断言：这些字节里有控制字符，解码成字符串长度就变了。 */
  function collectRaw(): {
    out: Buffer[];
    err: Buffer[];
    demux: ReturnType<typeof createDemuxer>;
  } {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const demux = createDemuxer(
      (chunk) => out.push(Buffer.from(chunk)),
      (chunk) => err.push(Buffer.from(chunk)),
      { framed: false },
    );
    return { out, err, demux };
  }

  it('字节原样交给 stdout，不做任何解析', () => {
    const { out, err, demux } = collectRaw();
    const text = Buffer.from('total 3\nfile.txt\n', 'utf8');
    demux.push(text);
    demux.flush();
    assert.ok(Buffer.concat(out).equals(text));
    assert.equal(Buffer.concat(err).length, 0, 'TTY 下不该凭空造出 stderr');
  });

  it('长得像帧头的字节也不会被吃掉——这正是拿错格式时的错位点', () => {
    // 前 8 个字节恰好构成一个"type=1, size=0"的合法帧头。
    const deceptive = Buffer.concat([frame(STREAM_STDOUT, ''), Buffer.from('真正的输出', 'utf8')]);
    const { out, demux } = collectRaw();
    demux.push(deceptive);
    demux.flush();
    const received = Buffer.concat(out);
    assert.equal(
      received.length,
      deceptive.length,
      `裸流模式下少了 ${deceptive.length - received.length} 个字节（说明被当帧头吃掉了）`,
    );
    assert.ok(received.equals(deceptive), '裸流模式下字节被改写了');
  });

  it('裸流不缓冲，pending 永远是 0', () => {
    const { demux } = collectRaw();
    demux.push(Buffer.from('partial'));
    assert.equal(demux.pending(), 0);
  });
});
