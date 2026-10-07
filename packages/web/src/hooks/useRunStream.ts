/**
 * 运行事件流：WebSocket 订阅 + 断线重连。
 *
 * 服务端会**补发历史事件**（`ws?runId=` 连上时先推已有事件，再补一个终态），
 * 所以重连后不需要前端自己拼接状态——清空重放即可，这也避免了
 * "重连后事件缺一段"的隐性 bug。
 *
 * 后端只有一个 `/ws` 端点，`runId` 是可选的查询参数：
 * 不传则订阅全部运行（工作台首页用），传了就只看那一个。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WireEvent } from '../api/types.js';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface UseRunStreamResult {
  readonly events: readonly WireEvent[];
  readonly connection: ConnectionState;
  /** 清空已收事件（切到另一次运行时用）。 */
  readonly reset: () => void;
}

/**
 * 订阅运行事件。
 *
 * @param runId 只看这一次运行；省略则订阅全部。
 */
export function useRunStream(runId?: string | undefined): UseRunStreamResult {
  const [events, setEvents] = useState<readonly WireEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  /** 重连定时器。组件卸载时要清掉，否则会泄漏。 */
  const retryRef = useRef<number | null>(null);
  /** 卸载标记：阻止卸载后仍安排重连。 */
  const disposedRef = useRef(false);

  const reset = useCallback(() => {
    setEvents([]);
  }, []);

  useEffect(() => {
    disposedRef.current = false;

    /** 建连。失败或断开时按退避重连。 */
    const connect = (): void => {
      if (disposedRef.current) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const query = runId !== undefined ? `?runId=${encodeURIComponent(runId)}` : '';
      const url = `${protocol}//${window.location.host}/ws${query}`;

      setConnection('connecting');
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposedRef.current) return;
        setConnection('open');
      };

      socket.onmessage = (message: MessageEvent<string>) => {
        if (disposedRef.current) return;
        try {
          const parsed = JSON.parse(message.data) as WireEvent;
          setEvents((prev) => [...prev, parsed]);
        } catch {
          // 解析不了就丢弃这一条，不要让一条坏消息拖垮整个事件流。
        }
      };

      socket.onclose = () => {
        if (disposedRef.current) return;
        setConnection('closed');
        // 固定 1.5s 退避。服务端会补发历史，重连不会丢状态。
        retryRef.current = window.setTimeout(connect, 1500);
      };

      socket.onerror = () => {
        // onerror 后必定跟 onclose，重连交给 onclose 统一处理。
      };
    };

    connect();

    return () => {
      disposedRef.current = true;
      if (retryRef.current !== null) {
        window.clearTimeout(retryRef.current);
        retryRef.current = null;
      }
      // 先摘掉 onclose，避免关闭时又安排一次重连。
      const socket = socketRef.current;
      if (socket !== null) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.close();
        socketRef.current = null;
      }
    };
  }, [runId]);

  return { events, connection, reset };
}
