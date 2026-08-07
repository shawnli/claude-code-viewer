import type { SSEEventMap } from "../../types/sse.ts";

// SSE 自愈: onerror 指数退避重连 + 25s heartbeat watchdog
// 只在 callSSE 内部包装 EventSource,外层 ServerEventsProvider 完全不变
// (它的 onOpen 会在重连时自动触发 invalidateQueries 补齐断线漏事件)
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 25000; // 服务端 10s 心跳,2.5x 给一次丢包 + jitter 缓冲

export const callSSE = (options?: { onOpen?: (event: Event) => void }) => {
  const { onOpen } = options ?? {};

  const url = new URL("/api/sse", window.location.origin).href;
  let eventSource: EventSource | null = null;
  let closed = false;
  let backoffMs = BACKOFF_START_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastEventAt = Date.now();

  type StoredListener = { eventName: string; callback: (event: MessageEvent) => void };
  const storedListeners: StoredListener[] = [];

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }, backoffMs);
  };

  const connect = () => {
    if (closed) return;
    if (eventSource !== null) {
      try {
        eventSource.close();
      } catch {
        /* noop */
      }
    }
    const es = new EventSource(url);
    eventSource = es;

    es.onopen = (event) => {
      console.log("SSE connection opened", event);
      backoffMs = BACKOFF_START_MS;
      lastEventAt = Date.now();
      onOpen?.(event);
    };

    es.onerror = (event) => {
      console.warn("SSE onerror, will reconnect with backoff", event);
      try {
        es.close();
      } catch {
        /* noop */
      }
      scheduleReconnect();
    };

    // 重连时重新绑定之前的 listener + 每次收到事件刷新 lastEventAt
    for (const { eventName, callback } of storedListeners) {
      const wrapped = (event: MessageEvent) => {
        lastEventAt = Date.now();
        callback(event);
      };
      es.addEventListener(eventName, wrapped);
    }
  };

  // heartbeat watchdog: >25s 没收到任何事件 → 主动 close 触发 onerror → 走 backoff 重连
  watchdogTimer = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastEventAt > HEARTBEAT_TIMEOUT_MS) {
      console.warn("SSE heartbeat timeout, forcing reconnect");
      lastEventAt = Date.now(); // 防止连续触发
      if (eventSource !== null) {
        try {
          eventSource.close();
        } catch {
          /* noop */
        }
      }
      scheduleReconnect();
    }
  }, 5000);

  connect();

  const addEventListener = <EventName extends keyof SSEEventMap>(
    eventName: EventName,
    listener: (event: SSEEventMap[EventName]) => void,
  ) => {
    const callbackFn = (event: MessageEvent) => {
      lastEventAt = Date.now();
      try {
        // oxlint-disable-next-line no-unsafe-assignment -- JSON.parse returns unknown-typed data, validated by downstream consumers
        const sseEvent: SSEEventMap[EventName] = JSON.parse(String(event.data));
        listener(sseEvent);
      } catch (error) {
        console.error("Failed to parse SSE event data:", error);
      }
    };
    storedListeners.push({ eventName: eventName as string, callback: callbackFn });
    eventSource?.addEventListener(eventName, callbackFn);

    const removeEventListener = () => {
      const idx = storedListeners.findIndex((l) => l.callback === callbackFn);
      if (idx >= 0) storedListeners.splice(idx, 1);
      eventSource?.removeEventListener(eventName, callbackFn);
    };

    return {
      removeEventListener,
    } as const;
  };

  const cleanUp = () => {
    closed = true;
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (eventSource !== null) {
      eventSource.onopen = null;
      eventSource.onmessage = null;
      eventSource.onerror = null;
      eventSource.close();
    }
    storedListeners.length = 0;
  };

  return {
    addEventListener,
    cleanUp,
    get eventSource() {
      return eventSource;
    },
  } as const;
};
