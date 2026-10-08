/**
 * 运行事件流：WebSocket 订阅 + 断线重连（Vue 版）。
 *
 * 由 `packages/web/src/hooks/useRunStream.ts` 移植。原版是 React Hook，
 * 这里改成接收一个 getter，从而支持"切换运行就换订阅"。
 *
 * 服务端会**补发历史事件**（`ws?runId=` 连上时先推已有事件，再补一个终态），
 * 所以重连后不需要前端自己拼接状态——清空重放即可，这也避免了
 * "重连后事件缺一段"的隐性 bug。
 *
 * 后端只有一个 `/ws` 端点，`runId` 是可选的查询参数：
 * 不传则订阅全部运行，传了就只看那一个。
 */
import { onUnmounted, ref, watch, type Ref } from "vue";
import type { WireEvent } from "@/api/mediasandbox/types";

export type ConnectionState = "connecting" | "open" | "closed";

/** 固定 1.5s 退避。服务端会补发历史，重连不会丢状态。 */
const RETRY_DELAY_MS = 1500;

/**
 * 订阅运行事件。
 *
 * @param getRunId 返回要看的 runId；返回 `undefined` 表示订阅全部运行。
 */
export function useRunStream(getRunId: () => string | undefined): {
  events: Ref<WireEvent[]>;
  connection: Ref<ConnectionState>;
  reset: () => void;
} {
  const events = ref<WireEvent[]>([]);
  const connection = ref<ConnectionState>("connecting");

  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  /** 卸载标记：阻止卸载后仍安排重连。 */
  let disposed = false;

  const reset = (): void => {
    events.value = [];
  };

  /** 摘掉回调再关闭，避免关闭时又安排一次重连。 */
  const closeSocket = (): void => {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    const current = socket;
    if (current !== null) {
      current.onclose = null;
      current.onerror = null;
      current.onmessage = null;
      current.onopen = null;
      current.close();
      socket = null;
    }
  };

  /** 建连。失败或断开时按退避重连。 */
  const connect = (): void => {
    if (disposed) return;

    const runId = getRunId();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = runId !== undefined ? `?runId=${encodeURIComponent(runId)}` : "";
    const url = `${protocol}//${window.location.host}/ws${query}`;

    connection.value = "connecting";
    const next = new WebSocket(url);
    socket = next;

    next.onopen = () => {
      if (disposed) return;
      connection.value = "open";
    };

    next.onmessage = (message: MessageEvent<string>) => {
      if (disposed) return;
      try {
        events.value.push(JSON.parse(message.data) as WireEvent);
      } catch {
        // 解析不了就丢弃这一条，不要让一条坏消息拖垮整个事件流。
      }
    };

    next.onclose = () => {
      if (disposed) return;
      connection.value = "closed";
      retryTimer = window.setTimeout(connect, RETRY_DELAY_MS);
    };

    next.onerror = () => {
      // onerror 后必定跟 onclose，重连交给 onclose 统一处理。
    };
  };

  // 换运行 = 换订阅：先断开旧的，再清空重放。
  watch(
    () => getRunId(),
    () => {
      closeSocket();
      reset();
      connect();
    }
  );

  connect();

  onUnmounted(() => {
    disposed = true;
    closeSocket();
  });

  return { events, connection, reset };
}
