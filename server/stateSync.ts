import { randomUUID } from "node:crypto";
import {
  resourceKeys,
  type ResourceVersions,
  type StateUpdate,
  type SyncCursor,
} from "../shared/stateSync.js";
import type { Controller } from "./controller.js";

export class StatePublisher {
  private readonly instance = randomUUID();
  private sequence = 0;

  constructor(private readonly controller: Controller) {}

  cursor(params: URLSearchParams): SyncCursor | undefined {
    if (params.get("instance") !== this.instance) return;
    const number = (key: string) => {
      const value = params.get(key);
      const parsed = Number(value);
      return value !== null && Number.isSafeInteger(parsed) && parsed >= 0
        ? parsed
        : undefined;
    };
    return {
      instance: this.instance,
      logs: number("logs") ?? -1,
      history: number("history") ?? -1,
      resources: Object.fromEntries(
        resourceKeys.map((key) => [key, number(key)]),
      ),
    };
  }

  capture() {
    const controller = this.controller;
    return {
      instance: this.instance,
      sequence: ++this.sequence,
      live: controller.liveState(),
      versions: Object.fromEntries(
        resourceKeys.map((key) => [key, controller.store.revision(key)]),
      ) as ResourceVersions,
    };
  }

  update(
    cursor: SyncCursor | undefined,
    includeResources: boolean,
    base = this.capture(),
  ): StateUpdate {
    return {
      ...base,
      logs: this.controller.logWindow(cursor?.logs),
      history: this.controller.historyWindow(cursor?.history),
      ...(includeResources && {
        resources: Object.fromEntries(
          resourceKeys
            .filter((key) => base.versions[key] !== cursor?.resources[key])
            .map((key) => [key, this.controller.resource(key)]),
        ),
      }),
    };
  }
}
