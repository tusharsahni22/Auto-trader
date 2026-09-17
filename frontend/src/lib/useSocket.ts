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
      if (closedByUs) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${proto}//${location.host}/ws`);
      ws = socket;
      socket.onopen = () => {
        // React Strict Mode can mount, clean up, and mount this hook again while
        // the first socket is still connecting. Close that stale socket only
        // after the handshake instead of aborting it in CONNECTING state.
        if (closedByUs) socket.close();
      };
      socket.onmessage = (ev) => {
        try {
          const { event, payload } = JSON.parse(ev.data);
          handlerRef.current(event, payload);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        if (!closedByUs) retryTimer = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      closedByUs = true;
      clearTimeout(retryTimer);
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        if (ws.readyState === WebSocket.CONNECTING) {
          // onopen above will close it after the handshake.
        } else {
          ws.close();
        }
      }
    };
  }, []);
}
