/**
 * 运行事件流：WebSocket 订阅 + 断线重连（Vue 组合式函数）。
 *
 * 服务端会**补发历史事件**（`ws?runId=` 连上时先推已有事件，再补一个终态），
 * 所以重连后不需要前端自己拼接状态——清空重放即可，这也避免了
 * "重连后事件缺一段"的隐性 bug。
 *
 * 后端只有一个 `/ws` 端点，`runId` 是可选的查询参数：
 * 不传则订阅全部运行（概览用），传了就只看那一个。
 *
 * ## 与 React 版的一处差异
 *
 * React 版用 `useState([...prev, parsed])` 的是不可变数组；这里用 `shallowRef`
 * 装数组、每次推进替换整个数组，避免大数组被深度代理——事件量不大，但
 * `ref` 的深层代理会让每次 `foldEvents` 白跑一遍 Proxy 开销。
 */
import { onScopeDispose, readonly, ref, shallowRef, watch, type Ref } from 'vue';
import type { WireEvent } from '@/api/types';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface UseRunStreamResult {
  /** 收到的全部事件（只读）。 */
  readonly events: Ref<readonly WireEvent[]>;
  /** 连接状态。 */
  readonly connection: Ref<ConnectionState>;
  /** 清空已收事件（切到另一次运行时用）。 */
  readonly eventsReset: () => void;
}

/**
 * 订阅运行事件。
 *
 * @param runId 只看这一次运行；省略则订阅全部。
 */
export function useRunStream(runId?: Ref<string | undefined>): UseRunStreamResult {
  const events = shallowRef<readonly WireEvent[]>([]);
  const connection = ref<ConnectionState>('connecting');

  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const eventsReset = (): void => {
    events.value = [];
  };

  /** 建连。失败或断开时按固定退避重连。 */
  function connect(target: string | undefined): void {
    if (disposed) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = target !== undefined ? `?runId=${encodeURIComponent(target)}` : '';
    const url = `${protocol}//${window.location.host}/ws${query}`;

    connection.value = 'connecting';
    const current = new WebSocket(url);
    socket = current;

    current.onopen = () => {
      if (disposed) return;
      connection.value = 'open';
    };

    current.onmessage = (message: MessageEvent<string>) => {
      if (disposed) return;
      try {
        const parsed = JSON.parse(message.data) as WireEvent;
        events.value = [...events.value, parsed];
      } catch {
        // 解析不了就丢弃这一条，不要让一条坏消息拖垮整个事件流。
      }
    };

    current.onclose = () => {
      if (disposed) return;
      connection.value = 'closed';
      // 固定 1.5s 退避。服务端会补发历史，重连不会丢状态。
      retryTimer = setTimeout(() => connect(target), 1500);
    };

    current.onerror = () => {
      // onerror 后必定跟 onclose，重连交给 onclose 统一处理。
    };
  }

  function disconnect(): void {
    disposed = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const current = socket;
    if (current !== null) {
      current.onclose = null;
      current.onerror = null;
      current.onmessage = null;
      current.close();
      socket = null;
    }
  }

  /** 切换订阅目标：先断旧的再连新的。 */
  function resubscribe(target: string | undefined): void {
    disconnect();
    disposed = false;
    connect(target);
  }

  if (runId === undefined) {
    connect(undefined);
  } else {
    watch(runId, (next) => resubscribe(next), { immediate: true });
  }

  onScopeDispose(() => disconnect());

  return { events: readonly(events) as Ref<readonly WireEvent[]>, connection, eventsReset };
}
