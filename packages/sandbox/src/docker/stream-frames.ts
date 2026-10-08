/**
 * Docker 附着流的**两套帧格式**。
 *
 * ## 为什么单独一个文件
 *
 * 这是纯字节处理，与容器无关：不需要 Docker 就能测，也不该被"本机没起 Docker"
 * 挡住。实测里最容易出错的也正是它——错位之后看起来像"程序输出乱码"，
 * 很难归因回"帧头没解对"。
 *
 * ## 两种格式
 *
 * **非 TTY（多路复用）**：每帧 8 字节头 `[type(1)][0][0][0][size(4, 大端)]`，
 * `type` 0=stdin、1=stdout、2=stderr。Docker 把两个流复用在这一条流里，
 * 必须按帧拆开，否则 stderr 会混进 stdout（而 provider 套件明确要求二者分离）。
 *
 * **TTY（裸流）**：**没有任何帧头**，stdout 与 stderr 在容器侧就已经合并。
 * 拿解帧器去解裸流，前 8 个字节会被当成帧头吃掉，输出从第 9 个字节开始错位——
 * 所以这一层必须显式区分，而不是"试试看能不能解"。
 *
 * ## 反向也要一致
 *
 * 多路复用模式下**写 stdin 同样要加帧**（`type=0`）。漏了这一步的表现是
 * "输入写进去了，容器里却什么都没收到"，而这几乎没法从输出侧看出来。
 */

/** 一帧的头部长度。 */
export const FRAME_HEADER_BYTES = 8;

/** 帧类型。与 Docker 的 `STREAM_TYPE` 一致。 */
export const STREAM_STDIN = 0;
export const STREAM_STDOUT = 1;
export const STREAM_STDERR = 2;

export interface DemuxerOptions {
  /**
   * 是否带 8 字节帧头。缺省 `true`（非 TTY 的多路复用）。
   *
   * 传 `false` 即裸流模式：不做任何解析，字节原样交给 stdout 回调。
   */
  readonly framed?: boolean | undefined;
}

export interface Demuxer {
  /** 喂入一段流数据。可以是不完整的帧——残帧会被留到下一次。 */
  push(chunk: Buffer): void;
  /** 流结束时调用：把残帧当 stdout 交出，避免丢内容。 */
  flush(): void;
  /** 还没消费掉的字节数。排查与测试用。 */
  pending(): number;
}

/**
 * 造一个解帧器。
 *
 * `streamType === 0`（stdin 回显）与未知类型一律忽略：它们不该出现在输出里，
 * 真出现了也只是把输入回显一遍，混进 stdout 反而更难查。
 */
export function createDemuxer(
  onStdout: (chunk: Buffer) => void,
  onStderr: (chunk: Buffer) => void,
  options: DemuxerOptions = {},
): Demuxer {
  if (options.framed === false) {
    // 裸流：没有帧可解，也不存在"残帧"。整段直接算 stdout。
    return {
      push(chunk: Buffer): void {
        if (chunk.length > 0) onStdout(chunk);
      },
      flush(): void {
        /* 裸流不缓冲，没有残帧要交 */
      },
      pending(): number {
        return 0;
      },
    };
  }

  // 显式标注为 Buffer（默认泛型参数），否则 Buffer.alloc 的收窄类型
  // 与 data 事件给的 Buffer 不兼容。
  let buffer: Buffer = Buffer.alloc(0);

  return {
    push(chunk: Buffer): void {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      // 只要还剩完整的头 + 载荷，就继续解帧。
      while (buffer.length >= FRAME_HEADER_BYTES) {
        const streamType = buffer[0];
        const size = buffer.readUInt32BE(4);
        if (buffer.length < FRAME_HEADER_BYTES + size) break; // 载荷未到齐，等下一块

        const payload = buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size);
        if (streamType === STREAM_STDERR) onStderr(payload);
        else if (streamType === STREAM_STDOUT) onStdout(payload);

        buffer = buffer.subarray(FRAME_HEADER_BYTES + size);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        onStdout(buffer);
        buffer = Buffer.alloc(0);
      }
    },
    pending(): number {
      return buffer.length;
    },
  };
}

/** 把一段数据包成 stdin 帧（`type=0`）。多路复用模式下写 stdin 必须走它。 */
export function frameStdin(chunk: Buffer | string): Buffer {
  const payload = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header[0] = STREAM_STDIN;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
