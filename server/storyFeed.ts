import { randomUUID } from "node:crypto";
import type { StoryProgress, StorySignal } from "../shared/storyFeed.js";

type Entry = {
  signal: StorySignal;
  listeners: Set<(signal: StorySignal) => void>;
  expiry?: ReturnType<typeof setTimeout>;
};

/** Reconnectable snapshots of ephemeral progress, separate from committed story rows. */
export class StoryFeed {
  private readonly instance = randomUUID();
  private clock = 0;
  private readonly entries = new Map<string, Entry>();

  private entry(id: string) {
    const existing = this.entries.get(id);
    if (existing) return existing;
    if (this.entries.size >= 64) {
      for (const [key, entry] of this.entries) {
        if (
          entry.listeners.size ||
          (entry.signal.progress?.phase &&
            entry.signal.progress.phase !== "unfinished")
        )
          continue;
        clearTimeout(entry.expiry);
        this.entries.delete(key);
        break;
      }
    }
    const version = ++this.clock;
    const entry: Entry = {
      signal: {
        instance: this.instance,
        serial: version,
        version,
        memoryVersion: version,
        bookmarkVersion: version,
      },
      listeners: new Set(),
    };
    this.entries.set(id, entry);
    return entry;
  }
  signal(id: string) {
    return this.entry(id).signal;
  }
  subscribe(id: string, listener: (signal: StorySignal) => void) {
    const entry = this.entry(id);
    entry.listeners.add(listener);
    listener(entry.signal);
    return () => {
      entry.listeners.delete(listener);
    };
  }
  private publish(entry: Entry, update: Partial<StorySignal>) {
    entry.signal = { ...entry.signal, ...update, serial: ++this.clock };
    for (const listener of entry.listeners) listener(entry.signal);
  }
  change(
    id: string,
    {
      memory = false,
      bookmarks = false,
      complete = false,
    }: {
      memory?: boolean;
      bookmarks?: boolean;
      complete?: boolean;
    } = {},
  ) {
    const entry = this.entry(id);
    if (complete) clearTimeout(entry.expiry);
    const version = this.clock + 1;
    this.publish(entry, {
      version,
      ...(memory && { memoryVersion: version }),
      ...(bookmarks && { bookmarkVersion: version }),
      ...(complete && { progress: undefined }),
    });
  }
  invalidateOpen() {
    for (const id of this.entries.keys()) this.change(id);
  }
  progress(id: string, value: StoryProgress) {
    const entry = this.entry(id);
    clearTimeout(entry.expiry);
    this.publish(entry, { progress: value });
    if (value.phase === "unfinished") {
      entry.expiry = setTimeout(
        () => this.publish(entry, { progress: undefined }),
        5 * 60_000,
      );
      entry.expiry.unref();
    }
  }
  close() {
    for (const entry of this.entries.values()) clearTimeout(entry.expiry);
    this.entries.clear();
  }
}
