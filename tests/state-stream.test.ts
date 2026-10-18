import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppSnapshot } from "../shared/types.ts";
import { AppStateStream, type StateConnection } from "../src/stateStream.ts";

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
  message(state: AppSnapshot) {
    this.onmessage?.({ data: JSON.stringify({ type: "state", data: state }) });
  }
}
const snapshot = (owner: string) =>
  ({
    owner,
    device: {},
    channels: {},
    waveforms: [],
    logs: [],
  }) as unknown as AppSnapshot;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("a delayed GET cannot overwrite a newer WebSocket snapshot", async (t) => {
  const socket = new FakeSocket();
  const received: AppSnapshot[] = [];
  let resolveFetch: (value: AppSnapshot) => void = () => undefined;
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
  socket.message(snapshot("newer-websocket"));
  resolveFetch(snapshot("older-get"));
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
  let resolveFetch: (value: AppSnapshot) => void = () => undefined;
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
