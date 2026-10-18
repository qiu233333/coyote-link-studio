import type { AppSnapshot } from "../shared/types";

export type StateConnection = "connecting" | "live" | "polling" | "stale";
type StateSocket = Pick<
  WebSocket,
  "readyState" | "onopen" | "onmessage" | "onclose" | "onerror" | "close"
>;

/** Read-only transport. Reconnecting the browser never changes a control run. */
export class AppStateStream {
  private stopped = true;
  private socket?: StateSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private abort?: AbortController;
  private revision = 0;
  private lastMessageAt = 0;
  private lastPollAt = 0;
  private connectedAt = 0;
  private failedRead = false;

  constructor(
    private readonly fetchState: (signal: AbortSignal) => Promise<AppSnapshot>,
    private readonly openSocket: () => StateSocket,
    private readonly onState: (state: AppSnapshot) => void,
    private readonly onConnection: (state: StateConnection) => void,
    private readonly onError: (error: string) => void,
  ) {}

  start() {
    this.stopped = false;
    // The initial GET establishes the same-origin WebSocket session cookie.
    void this.refresh().then(() => this.connect());
    this.poll = setInterval(() => {
      if (
        this.socket &&
        this.socket.readyState <= 1 &&
        Date.now() - (this.lastMessageAt || this.connectedAt) >= 8000
      ) {
        this.onConnection(this.failedRead ? "stale" : "polling");
        this.socket.close();
      }
      if (!this.hasLiveState() || Date.now() - this.lastPollAt >= 10000)
        void this.refresh();
    }, 3000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.poll);
    clearTimeout(this.reconnect);
    this.abort?.abort();
    this.socket?.close();
  }

  private hasLiveState() {
    return (
      this.socket?.readyState === 1 &&
      this.lastMessageAt > 0 &&
      Date.now() - this.lastMessageAt < 8000
    );
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    const revision = this.revision;
    const abort = new AbortController();
    this.abort = abort;
    this.lastPollAt = Date.now();
    const timeout = setTimeout(() => abort.abort(), 8000);
    this.flight = this.fetchState(abort.signal)
      .then((snapshot) => {
        if (this.stopped || this.revision !== revision) return;
        this.failedRead = false;
        this.onState(snapshot);
        this.onError("");
        this.onConnection(this.hasLiveState() ? "live" : "polling");
      })
      .catch((error: unknown) => {
        if (this.stopped || this.revision !== revision) return;
        this.failedRead = true;
        this.onError(
          abort.signal.aborted
            ? "状态请求超时，请检查本地服务。"
            : error instanceof Error
              ? error.message
              : "无法读取服务状态。",
        );
        if (!this.hasLiveState()) this.onConnection("stale");
      })
      .finally(() => {
        clearTimeout(timeout);
        this.flight = undefined;
        if (this.abort === abort) this.abort = undefined;
      });
    return this.flight;
  }

  private connect() {
    if (this.stopped) return;
    let socket: StateSocket;
    try {
      socket = this.openSocket();
    } catch {
      this.onError("无法建立实时状态连接，正在使用轮询。");
      this.onConnection(this.failedRead ? "stale" : "polling");
      this.reconnect = setTimeout(() => this.connect(), 4000);
      return;
    }
    this.socket = socket;
    this.connectedAt = Date.now();
    this.lastMessageAt = 0;
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return;
      // OPEN alone says nothing about whether state messages are arriving.
      void this.refresh();
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.type !== "state") return;
        if (
          !message.data ||
          typeof message.data !== "object" ||
          !message.data.device ||
          !message.data.channels ||
          !Array.isArray(message.data.waveforms) ||
          !Array.isArray(message.data.logs)
        )
          throw new Error("状态消息缺少数据");
        this.revision++;
        this.failedRead = false;
        this.lastMessageAt = Date.now();
        this.onState(message.data as AppSnapshot);
        this.onConnection("live");
        this.onError("");
      } catch {
        this.onError("实时状态消息无效，正在改用轮询并重新连接。");
        this.onConnection("polling");
        socket.close();
        void this.refresh();
      }
    };
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;
      this.onConnection(this.failedRead ? "stale" : "polling");
      void this.refresh();
      this.reconnect = setTimeout(() => this.connect(), 4000);
    };
    socket.onerror = () => socket.close();
  }
}
