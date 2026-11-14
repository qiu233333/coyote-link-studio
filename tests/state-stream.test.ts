import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppSnapshot } from "../shared/types.ts";
import type { StateUpdate } from "../shared/stateSync.ts";
import { AppStateStream, type StateConnection } from "../src/stateStream.ts";
import { SyncedState } from "../src/syncState.ts";

class FakeSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  message(state: StateUpdate) {
    this.onmessage?.({ data: JSON.stringify({ type: "state", data: state }) });
  }
}
let sequence = 0;
const snapshot = (owner: string, seq = ++sequence) =>
  ({
    instance: "test-service",
    sequence: seq,
    live: { owner, device: {}, channels: {} },
    versions: { waveforms: 0, settings: 0, plans: 0, presets: 0 },
    resources: { waveforms: [], settings: {}, plans: [], presets: [] },
    logs: { start: 0, entries: [] },
    history: { start: 0, entries: [] },
  }) as unknown as StateUpdate;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("a delayed GET cannot overwrite a newer WebSocket snapshot", async (t) => {
  const socket = new FakeSocket();
  const received: AppSnapshot[] = [];
  let resolveFetch: (value: StateUpdate) => void = () => undefined;
  let fetches = 0;
  const stream = new AppStateStream(
    () =>
      ++fetches === 1
        ? Promise.resolve(snapshot("initial"))
        : new Promise((resolve) => {
            resolveFetch = resolve;
          }),
    () => socket as unknown as WebSocket,
    (state) => received.push(state),
    () => undefined,
    () => undefined,
  );
  t.after(() => stream.stop());
  stream.start();
  await flush();
  const refresh = stream.refresh();
  assert.equal(
    stream.refresh(),
    refresh,
    "concurrent state requests are deduplicated",
  );
  const old = snapshot("older-get");
  socket.message(snapshot("newer-websocket"));
  resolveFetch(old);
  await refresh;
  assert.equal(received.at(-1)?.owner, "newer-websocket");
});

test("silent OPEN socket falls back to GET without changing the server run", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1000,
  });
  const sockets: FakeSocket[] = [];
  const connections: StateConnection[] = [];
  let fetches = 0;
  const stream = new AppStateStream(
    async () => {
      fetches++;
      return snapshot("ai-control");
    },
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    (state) => assert.equal(state.owner, "ai-control"),
    (state) => connections.push(state),
    () => undefined,
  );
  t.after(() => stream.stop());
  stream.start();
  await flush();
  sockets[0].message(snapshot("ai-control"));
  t.mock.timers.tick(9000);
  await flush();
  assert.equal(sockets[0].readyState, 3);
  assert.equal(connections.at(-1), "polling");
  assert.ok(fetches >= 2);
  t.mock.timers.tick(4000);
  await flush();
  assert.equal(sockets.length, 2, "state stream reconnects independently");
  sockets[1].message(snapshot("ai-control"));
  assert.equal(connections.at(-1), "live");
});

test("timed-out initial state read is aborted and does not block WebSocket forever", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1000,
  });
  let opened = 0;
  const errors: string[] = [];
  const connections: StateConnection[] = [];
  const stream = new AppStateStream(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
    () => {
      opened++;
      return new FakeSocket() as unknown as WebSocket;
    },
    () => undefined,
    (state) => connections.push(state),
    (error) => errors.push(error),
  );
  t.after(() => stream.stop());
  stream.start();
  t.mock.timers.tick(8000);
  await flush();
  assert.equal(opened, 1);
  assert.equal(connections.at(-1), "stale");
  assert.match(errors.at(-1)!, /超时/);
});

test("invalid state frames are reported and replaced by polling", async (t) => {
  const socket = new FakeSocket();
  const errors: string[] = [];
  const connections: StateConnection[] = [];
  const stream = new AppStateStream(
    async () => snapshot("ai-control"),
    () => socket as unknown as WebSocket,
    () => undefined,
    (state) => connections.push(state),
    (error) => errors.push(error),
  );
  t.after(() => stream.stop());
  stream.start();
  await flush();
  socket.onmessage?.({ data: '{"type":"state","data":{}}' });
  assert.equal(socket.readyState, 3);
  assert.ok(errors.some((error) => /消息无效/.test(error)));
  await flush();
  assert.equal(connections.at(-1), "polling");
});

test("failed polling stays stale across socket reconnect attempts until a valid state arrives", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1000,
  });
  const socket = new FakeSocket();
  const connections: StateConnection[] = [];
  const stream = new AppStateStream(
    async () => {
      throw new Error("offline fixture");
    },
    () => socket as unknown as WebSocket,
    () => undefined,
    (state) => connections.push(state),
    () => undefined,
  );
  t.after(() => stream.stop());
  stream.start();
  await flush();
  assert.equal(connections.at(-1), "stale");
  socket.close();
  assert.equal(connections.at(-1), "stale");
  socket.readyState = 1;
  socket.message(snapshot("ai-control"));
  assert.equal(connections.at(-1), "live");
});

test("unmounted transport ignores late snapshots and does not reconnect", async () => {
  let resolveFetch: (value: StateUpdate) => void = () => undefined;
  let received = 0,
    opened = 0;
  const stream = new AppStateStream(
    () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    () => {
      opened++;
      return new FakeSocket() as unknown as WebSocket;
    },
    () => {
      received++;
    },
    () => undefined,
    () => undefined,
  );
  stream.start();
  stream.stop();
  resolveFetch(snapshot("late"));
  await flush();
  assert.equal(received, 0);
  assert.equal(opened, 0);
});

test("heartbeats keep a quiet socket live without polling or rendering", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1000,
  });
  const socket = new FakeSocket();
  let fetches = 0,
    views = 0;
  const stream = new AppStateStream(
    async () => {
      fetches++;
      return snapshot("manual");
    },
    () => socket as unknown as WebSocket,
    () => {
      views++;
    },
    () => undefined,
    () => undefined,
  );
  t.after(() => stream.stop());
  stream.start();
  await flush();
  socket.message(snapshot("manual"));
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(3000);
    socket.onmessage?.({ data: '{"type":"heartbeat"}' });
  }
  assert.equal(socket.readyState, 1);
  assert.equal(fetches, 1);
  assert.equal(views, 1);
});

test("an older resource response can fill a current version without replacing telemetry", () => {
  const state = new SyncedState();
  const baseline = snapshot("manual");
  const initial = state.apply(baseline)!;
  const update = snapshot("ai-control");
  update.versions.waveforms = 1;
  const rename = {
    ...update,
    resources: {
      waveforms: [
        { id: "wave", hash: "same-hash", name: "renamed" },
      ] as AppSnapshot["waveforms"],
    },
  };
  delete update.resources;
  state.apply(update);
  const newer = {
    ...update,
    sequence: update.sequence + 1,
    live: { ...update.live, stopping: true },
  };
  state.apply(newer);
  assert.equal(state.needsResources(), true);
  const view = state.apply(rename)!;
  assert.equal(view.stopping, true);
  assert.equal(view.waveforms[0].name, "renamed");
  assert.equal(view.settings, initial.settings);
  assert.equal(state.needsResources(), false);
  assert.equal(state.apply(baseline), undefined);
});

test("overlapping windows append once, gaps replace the window, and restart resets cursors", () => {
  const state = new SyncedState();
  const log = (at: number): AppSnapshot["logs"][number] => ({
    id: String(at),
    at,
    level: "info",
    source: "test",
    message: "sample",
  });
  const sample = (at: number) => ({ at, A: at, B: 0 });
  const base = snapshot("manual");
  base.logs = { start: 0, entries: [log(1), log(2)] };
  base.history = { start: 0, entries: [sample(1), sample(2)] };
  const first = state.apply(base)!;
  const overlap = {
    ...base,
    sequence: base.sequence + 1,
    logs: { start: 1, entries: [log(2), log(3)] },
    history: { start: 1, entries: [sample(2), sample(3)] },
  };
  const merged = state.apply(overlap)!;
  assert.equal(first.waveforms, merged.waveforms);
  assert.deepEqual(
    merged.logs.map((item) => item.id),
    ["3", "2", "1"],
  );
  assert.deepEqual(
    merged.history.map((item) => item.at),
    [1, 2, 3],
  );
  assert.equal(state.apply(overlap), undefined);
  const gap = state.apply({
    ...overlap,
    sequence: overlap.sequence + 1,
    logs: { start: 310, entries: [log(311)] },
    history: { start: 200, entries: [sample(201)] },
  })!;
  assert.deepEqual(
    gap.logs.map((item) => item.id),
    ["311"],
  );
  assert.deepEqual(
    gap.history.map((item) => item.at),
    [201],
  );
  const restart = state.apply({
    ...snapshot("manual", 1),
    instance: "restarted",
  })!;
  assert.equal(restart.history.length, 0);
  assert.equal(state.cursor()?.history, 0);
  assert.equal(state.apply(overlap), undefined);
});
