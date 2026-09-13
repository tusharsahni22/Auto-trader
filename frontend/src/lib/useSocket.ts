import { useEffect, useRef } from "react";

export type SocketHandler = (event: string, payload: unknown) => void;

export function useSocket(onMessage: SocketHandler) {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByUs = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onmessage = (ev) => {
        try {
          const { event, payload } = JSON.parse(ev.data);
          handlerRef.current(event, payload);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (!closedByUs) retryTimer = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      closedByUs = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);
}
