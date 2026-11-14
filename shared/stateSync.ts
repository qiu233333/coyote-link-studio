import type { AppSnapshot } from "./types.js";

export const resourceKeys = [
  "waveforms",
  "plans",
  "presets",
  "settings",
] as const;
export type ResourceKey = (typeof resourceKeys)[number];
export type StateResources = Pick<AppSnapshot, ResourceKey>;
export type ResourceVersions = Record<ResourceKey, number>;
export type LiveState = Omit<AppSnapshot, ResourceKey | "logs" | "history">;

export const LOG_WINDOW = 300;
export const HISTORY_WINDOW = 180;
export const STATE_HEARTBEAT_MS = 3000;

/** Entries are oldest first, with absolute offsets within one service instance. */
export type StateWindow<T> = { start: number; entries: T[] };
export interface SyncCursor {
  instance: string;
  logs: number;
  history: number;
  resources: Partial<ResourceVersions>;
}
export interface StateUpdate {
  instance: string;
  sequence: number;
  live: LiveState;
  versions: ResourceVersions;
  resources?: Partial<StateResources>;
  logs: StateWindow<AppSnapshot["logs"][number]>;
  history: StateWindow<AppSnapshot["history"][number]>;
}

export function cursorParams(cursor?: SyncCursor): URLSearchParams {
  const params = new URLSearchParams({ sync: "1" });
  if (cursor) {
    params.set("instance", cursor.instance);
    params.set("logs", String(cursor.logs));
    params.set("history", String(cursor.history));
    for (const key of resourceKeys)
      if (cursor.resources[key] !== undefined)
        params.set(key, String(cursor.resources[key]));
  }
  return params;
}
