import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiEnvelope, AppSnapshot } from "../shared/types";

export async function request<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Coyote-Request": "1" },
    credentials: "same-origin",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !result.ok)
    throw new Error(result.error || `请求失败 (${response.status})`);
  return result.data as T;
}

export type Action = <T = unknown>(
  path: string,
  body?: unknown,
  method?: string,
  success?: string,
) => Promise<T | undefined>;
export function useAppState() {
  const [state, setState] = useState<AppSnapshot | null>(null);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "polling"
  >("connecting");
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [pending, setPending] = useState(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const snapshot = await request<AppSnapshot>(
        "/api/state",
        undefined,
        "GET",
      );
      if (mounted.current) {
        setState(snapshot);
        setError("");
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
      );
      socket.onopen = () => {
        setConnection("live");
        void refresh();
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string);
          if (message.type === "state" && message.data) {
            setState(message.data);
            setError("");
          }
        } catch {
          /* Ignore unrelated protocol messages. */
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnection("polling");
        reconnect = setTimeout(connect, 4000);
      };
      socket.onerror = () => socket?.close();
    };
    void refresh().then(() => {
      if (!stopped) connect();
    });
    const poll = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) void refresh();
    }, 3000);
    return () => {
      stopped = true;
      mounted.current = false;
      clearInterval(poll);
      clearTimeout(reconnect);
      socket?.close();
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 7000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const action: Action = useCallback(
    async <T>(
      path: string,
      body?: unknown,
      method = "POST",
      success?: string,
    ) => {
      setPending((n) => n + 1);
      try {
        const result = await request<T>(path, body, method);
        await refresh();
        if (success) setToast({ text: success, error: false });
        return result;
      } catch (e) {
        setToast({ text: (e as Error).message, error: true });
        return undefined;
      } finally {
        setPending((n) => Math.max(0, n - 1));
      }
    },
    [refresh],
  );
  return {
    state,
    connection,
    error,
    toast,
    pending,
    action,
    refresh,
    dismissToast: () => setToast(null),
  };
}

export const requestId = () => crypto.randomUUID();
export const isActive = (state: AppSnapshot) =>
  Boolean(state.run && ["running", "paused"].includes(state.run.status));
export const timeLeft = (deadline: number) =>
  Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
export function duration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
export const ownerNames = {
  manual: "控制台",
  "ai-control": "AI 控制",
  "locked-task": "AI 上锁任务",
} as const;
