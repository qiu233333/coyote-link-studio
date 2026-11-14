import type { AppSnapshot } from "../shared/types";
import {
  HISTORY_WINDOW,
  LOG_WINDOW,
  resourceKeys,
  type StateUpdate,
  type StateWindow,
  type StateResources,
  type SyncCursor,
  type ResourceKey,
  type ResourceVersions,
} from "../shared/stateSync";

/** Keep unchanged JSON subtrees stable for memoized views. */
function share<T>(previous: T, next: T): T {
  if (previous === next) return previous;
  if (
    !previous ||
    !next ||
    typeof previous !== "object" ||
    typeof next !== "object"
  )
    return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous) || previous.length !== next.length)
      return next;
    const values = next.map((item, i) => share(previous[i], item));
    return (
      values.every((item, i) => item === previous[i]) ? previous : values
    ) as T;
  }
  const old = previous as Record<string, unknown>;
  const fields = Object.entries(next).map(
    ([key, value]) => [key, share(old[key], value)] as const,
  );
  if (
    fields.length === Object.keys(old).length &&
    fields.every(
      ([key, value]) => Object.hasOwn(old, key) && value === old[key],
    )
  )
    return previous;
  return Object.fromEntries(fields) as T;
}

function end<T>(window: StateWindow<T>) {
  return window.start + window.entries.length;
}

function append<T>(
  previous: StateWindow<T>,
  next: StateWindow<T>,
  limit: number,
) {
  if (end(next) <= end(previous)) return previous;
  const entries =
    next.start > end(previous)
      ? next.entries
      : [
          ...previous.entries,
          ...next.entries.slice(end(previous) - next.start),
        ].slice(-limit);
  return { start: end(next) - entries.length, entries };
}

export class SyncedState {
  private latest?: StateUpdate;
  private retired = new Set<string>();
  private versions: Partial<ResourceVersions> = {};
  private resources: Partial<StateResources> = {};
  private logs: StateUpdate["logs"] = { start: 0, entries: [] };
  private history: StateUpdate["history"] = { start: 0, entries: [] };
  private displayedLogs: AppSnapshot["logs"] = [];
  private view?: AppSnapshot;

  cursor(): SyncCursor | undefined {
    return (
      this.latest && {
        instance: this.latest.instance,
        logs: end(this.logs),
        history: end(this.history),
        resources: { ...this.versions },
      }
    );
  }
  needsResources() {
    const versions = this.latest?.versions;
    return (
      !versions ||
      resourceKeys.some((key) => versions[key] !== this.versions[key])
    );
  }
  hasBaseline() {
    return this.view !== undefined;
  }
  apply(update: StateUpdate): AppSnapshot | undefined {
    if (this.retired.has(update.instance)) return;
    if (this.latest && this.latest.instance !== update.instance) {
      this.retired.add(this.latest.instance);
      this.latest = undefined;
      this.versions = {};
      this.resources = {};
      this.logs = { start: 0, entries: [] };
      this.history = { start: 0, entries: [] };
      this.displayedLogs = [];
      this.view = undefined;
    }
    if (!this.latest || update.sequence > this.latest.sequence) {
      this.latest = { ...update, live: share(this.latest?.live, update.live)! };
      const logs = append(this.logs, update.logs, LOG_WINDOW);
      if (logs !== this.logs) this.displayedLogs = [...logs.entries].reverse();
      this.logs = logs;
      this.history = append(this.history, update.history, HISTORY_WINDOW);
    }
    const latest = this.latest;
    const cacheResource = <K extends ResourceKey>(key: K) => {
      const next = update.resources?.[key];
      const version = update.versions[key];
      // A slow read may fill a missing resource while newer telemetry is already
      // on screen. Accept it only if the server still advertises this version.
      if (
        next !== undefined &&
        latest.versions[key] === version &&
        this.versions[key] !== version
      ) {
        this.resources[key] = share(this.resources[key], next);
        this.versions[key] = version;
      }
    };
    resourceKeys.forEach(cacheResource);
    if (resourceKeys.some((key) => this.versions[key] === undefined)) return;
    const next = {
      ...latest.live,
      ...(this.resources as StateResources),
      logs: this.displayedLogs,
      history: this.history.entries,
    };
    if (
      this.view &&
      Object.keys(next).length === Object.keys(this.view).length &&
      Object.entries(next).every(
        ([key, value]) => this.view?.[key as keyof AppSnapshot] === value,
      )
    )
      return;
    this.view = next;
    return next;
  }
}
