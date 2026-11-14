import type {
  StoryBootstrap,
  StoryDelta,
  StoryProgress,
  StorySignal,
  StorySync,
} from "../shared/storyFeed";
import type { StoryMessage } from "../shared/roleplay";

type StorySource = Pick<EventSource, "onmessage" | "onerror" | "close">;

export class StoryProgressView {
  private progress?: StoryProgress;
  private listeners = new Set<() => void>();
  read = () => this.progress;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(progress?: StoryProgress) {
    if (this.progress === progress) return;
    this.progress = progress;
    for (const listener of this.listeners) listener();
  }
}

export class StoryFeedClient {
  private readonly abort = new AbortController();
  private source?: StorySource;
  private poll?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private lastPacket = 0;
  private latest: StorySignal;
  private retired = new Set<string>();
  private cursor: {
    instance: string;
    version?: number;
    after: number;
    state: number;
    memory: number;
    bookmarks: number;
  };
  readonly progress = new StoryProgressView();

  constructor(
    baseline: StoryBootstrap,
    private fetchSync: (
      params: URLSearchParams,
      signal: AbortSignal,
    ) => Promise<StorySync>,
    private openSource: () => StorySource,
    private onDelta: (delta: StoryDelta, signal: StorySignal) => void,
    private onError: (message: string) => void,
  ) {
    this.latest = baseline.signal;
    this.cursor = {
      instance: baseline.signal.instance,
      version: baseline.signal.version,
      after: baseline.items.at(-1)?.seq ?? 0,
      state: baseline.story.storyState.version,
      memory: baseline.signal.memoryVersion,
      bookmarks: baseline.signal.bookmarkVersion,
    };
    this.progress.set(baseline.signal.progress);
  }
  private receive(signal: StorySignal) {
    if (
      !signal ||
      typeof signal.instance !== "string" ||
      !Number.isSafeInteger(signal.serial) ||
      !Number.isSafeInteger(signal.version) ||
      !Number.isSafeInteger(signal.memoryVersion) ||
      !Number.isSafeInteger(signal.bookmarkVersion)
    )
      throw new Error("故事同步消息无效");
    if (this.retired.has(signal.instance)) return;
    if (
      signal.instance === this.latest.instance &&
      signal.serial <= this.latest.serial
    )
      return;
    if (signal.instance !== this.latest.instance)
      this.retired.add(this.latest.instance);
    this.latest = signal;
    // If the final notification overtakes its HTTP delta, retain the preview
    // until the same React update installs the authoritative message.
    if (signal.progress || !this.needsSync())
      this.progress.set(signal.progress);
  }
  private needsSync() {
    return (
      this.latest.instance !== this.cursor.instance ||
      this.latest.version !== this.cursor.version
    );
  }
  start() {
    try {
      const source = this.openSource();
      this.source = source;
      source.onmessage = ({ data }) => {
        if (this.abort.signal.aborted) return;
        try {
          const signal = JSON.parse(data);
          if (signal?.heartbeat === true) {
            if (this.lastPacket) this.lastPacket = Date.now();
            return;
          }
          this.receive(signal);
          this.lastPacket = Date.now();
          if (this.needsSync()) void this.refresh();
        } catch {
          this.lastPacket = 0;
          void this.refresh();
        }
      };
      source.onerror = () => {
        this.lastPacket = 0;
        void this.refresh();
      };
    } catch {
      // A browser or intermediary without EventSource uses the same cursor.
    }
    this.poll = setInterval(() => {
      if (
        this.needsSync() ||
        !this.lastPacket ||
        Date.now() - this.lastPacket >= 7500
      )
        void this.refresh();
    }, 1500);
  }
  stop() {
    this.abort.abort();
    this.source?.close();
    clearInterval(this.poll);
  }
  refresh(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.read()
      .catch((error: unknown) => {
        if (!this.abort.signal.aborted)
          this.onError(
            error instanceof Error ? error.message : "暂时无法同步故事。",
          );
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }
  private async read() {
    do {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(this.cursor))
        if (value !== undefined) params.set(key, String(value));
      const { signal, delta } = await this.fetchSync(
        params,
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]),
      );
      if (this.abort.signal.aborted) return;
      if (this.retired.has(signal.instance)) return;
      this.receive(signal);
      if (
        delta &&
        (this.cursor.instance !== signal.instance ||
          this.cursor.version === undefined ||
          signal.version >= this.cursor.version)
      ) {
        this.cursor = {
          instance: signal.instance,
          version: delta.more ? undefined : signal.version,
          after:
            delta.items.at(-1)?.seq ?? (delta.reset ? 0 : this.cursor.after),
          state: delta.status.storyState?.version ?? this.cursor.state,
          memory: signal.memoryVersion,
          bookmarks: signal.bookmarkVersion,
        };
        this.onDelta(delta, signal);
      }
      if (!this.needsSync()) this.progress.set(this.latest.progress);
      this.onError("");
      // One valid authoritative snapshot can fill a notification gap. If a
      // newer event arrived during this read, continue from the applied cursor.
    } while (this.needsSync());
  }
}

export function mergeStoryMessages(
  previous: StoryMessage[],
  items: StoryMessage[],
  bookmarks?: string[],
) {
  if (!items.length && !bookmarks) return previous;
  const merged = new Map(previous.map((message) => [message.seq, message]));
  let changed = false;
  for (const item of items) {
    const old = merged.get(item.seq);
    if (old?.id === item.id && !!old.bookmarked === !!item.bookmarked) continue;
    merged.set(item.seq, item);
    changed = true;
  }
  if (bookmarks) {
    const saved = new Set(bookmarks);
    for (const [seq, message] of merged)
      if (message.nodeRound && !!message.bookmarked !== saved.has(message.id)) {
        merged.set(seq, { ...message, bookmarked: saved.has(message.id) });
        changed = true;
      }
  }
  return changed
    ? [...merged.values()].sort((a, b) => a.seq - b.seq)
    : previous;
}
