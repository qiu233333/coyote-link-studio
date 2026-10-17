import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { CoyoteDevice, getBuiltinWaveforms } from "../server/device.js";

const until = async (predicate: () => boolean) => {
  const end = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function relay(
  options: {
    ignoreClear?: boolean;
    ignoreIntensity?: boolean;
    retainIntensity?: boolean;
  } = {},
) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address)
    throw new Error("Missing relay address");
  const requests: Record<string, unknown>[] = [];
  let peer: WebSocket | undefined;
  const intensities = { A: 0, B: 0 };
  const limits = { A: 80, B: 60 };
  const device = () => ({
    slotId: "slot-1",
    name: "Test Coyote",
    type: "COYOTE_030",
    props: {
      intensityA: intensities.A,
      intensityB: intensities.B,
      connectState: "connected",
    },
    slotState: {
      hasDevice: true,
      channelA: { intensityMax: limits.A },
      channelB: { intensityMax: limits.B },
    },
  });
  const send = (data: unknown) =>
    peer?.send(JSON.stringify({ type: "message", clientId: "app-1", data }));
  server.on("connection", (socket) => {
    peer = socket;
    socket.send(JSON.stringify({ type: "hello", clientId: "controller-1" }));
    setTimeout(() => {
      if (socket.readyState !== 1) return;
      socket.send(
        JSON.stringify({ type: "client_attached", clientId: "app-1" }),
      );
      send({ t: "ev", ev: "devices.snapshot", devices: [device()] });
    }, 20);
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== "message") return;
      const req = frame.data;
      requests.push(req);
      if (req.m === "device.op.clear" && options.ignoreClear) return;
      if (req.m === "device.op" && req.data.t !== 0 && options.ignoreIntensity)
        return;
      let result: unknown = {};
      if (req.m === "devices.get") result = { devices: [device()] };
      if (req.m === "device.op") {
        const c = req.data.c === 0 ? "A" : "B";
        if (!options.retainIntensity && req.data.t === 3)
          intensities[c] += req.data.v;
        if (!options.retainIntensity && req.data.t === 7) intensities[c] = 0;
        result = {
          type: req.data.t,
          reason: "completed",
          channel: req.data.c,
          slotId: "slot-1",
        };
      }
      send({ t: "resp", reqId: req.reqId, result });
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}/v4`,
    requests,
    intensities,
    limits,
    send,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("simulator is explicit, validates bounds, sends no real frames, and stops both channels", async () => {
  const driver = new CoyoteDevice();
  assert.equal(driver.state.connected, false);
  await driver.connect({ protocol: "simulator" });
  assert.equal(driver.state.connected, true);
  await driver.setIntensity("A", 20);
  await driver.setIntensity("B", 10);
  assert.deepEqual(driver.state.intensities, { A: 20, B: 10 });
  await assert.rejects(driver.setIntensity("A", 201), /范围/);
  await assert.rejects(
    driver.sendFrames("A", Array(6).fill("0A0A0A0A00000000")),
    /500ms/,
  );
  await driver.sendFrames("A", ["0A0A0A0A00000000"]);
  assert.equal(await driver.stop(), true);
  assert.deepEqual(driver.state.intensities, { A: 0, B: 0 });
  await driver.dispose();
});

test("V4 discovers devices, uses reported limits and translates absolute targets once", async () => {
  const mock = await relay();
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    assert.equal(
      driver.state.connected,
      false,
      "discovered device must be selected",
    );
    assert.match(driver.state.qrUrl!, /^data:image\/png;base64,/);
    assert.match(
      decodeURIComponent(driver.state.pairingUrl!),
      /tid=controller-1/,
    );
    await driver.selectDevice("app-1", "slot-1");
    assert.equal(driver.state.connected, true);
    assert.deepEqual(driver.state.limits, { A: 80, B: 60 });
    await driver.setIntensity("A", 8);
    await driver.setIntensity("A", 11);
    assert.equal(driver.state.intensities.A, 11);
    const adjustments = mock.requests
      .filter((r) => r.m === "device.op")
      .map((r) => r.data as { t: number; v: number })
      .filter((d) => d.t === 3);
    assert.deepEqual(
      adjustments.map((r) => r.v),
      [8, 3],
    );
    await driver.sendFrames("A", ["0A0A0A0A00000000", "0A0A0A0A00000000"]);
    const pulse = mock.requests.find(
      (r) => r.m === "device.op" && (r.data as { t: number }).t === 0,
    )!;
    assert.equal((pulse.data as { d: number }).d, 200);
    assert.equal((pulse.data as { im: boolean }).im, true);
    const start = mock.requests.length;
    assert.equal(await driver.stop(), true);
    const stop = mock.requests
      .slice(start)
      .filter((r) => r.m !== "devices.get");
    assert.equal(stop[0]!.m, "device.op.clear");
    assert.deepEqual(
      stop.slice(1).map((r) => r.data),
      [
        { s: "slot-1", c: 0, t: 7, v: 0 },
        { s: "slot-1", c: 1, t: 7, v: 0 },
      ],
    );
  } finally {
    await driver.dispose();
    await mock.close();
  }
});

test("V4 preserves actual 20/19 ceilings and receives lower slot ceiling patches", async () => {
  const mock = await relay();
  mock.limits.A = 20;
  mock.limits.B = 19;
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    assert.deepEqual(driver.state.limits, { A: 20, B: 19 });
    await assert.rejects(driver.setIntensity("B", 20), /范围/);
    mock.limits.B = 6;
    mock.send({
      t: "ev",
      ev: "slots.patch",
      slots: [
        { slotId: "slot-1", slotState: { channelB: { intensityMax: 6 } } },
      ],
    });
    await until(() => driver.state.limits.B === 6);
    assert.deepEqual(driver.state.limits, { A: 20, B: 6 });
    await assert.rejects(driver.setIntensity("B", 7), /范围/);
    await driver.setIntensity("B", 6);
    assert.equal(driver.state.intensities.B, 6);
  } finally {
    await driver.dispose();
    await mock.close();
  }
});

test("an intensity already queued is revalidated against a newly lowered hardware ceiling", async () => {
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "simulator" });
    driver.state.limits.A = 20;
    const queued = driver.setIntensity("A", 15);
    driver.state.limits.A = 5;
    await assert.rejects(queued, /设备当前范围.*排队指令/);
    assert.equal(driver.state.intensities.A, 0);
    await driver.setIntensity("A", 5);
    assert.equal(
      driver.state.intensities.A,
      5,
      "rejected stale work does not block subsequent safe commands",
    );
  } finally {
    await driver.dispose();
  }
});

test("a missing clear ACK never reports successful stop or enqueues zeros behind an unconfirmed clear", async () => {
  const mock = await relay({ ignoreClear: true });
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    const start = mock.requests.length;
    assert.equal(await driver.stop(), false);
    assert.equal(driver.state.canConfirmZero, false);
    assert.match(driver.state.error!, /停止未确认/);
    assert.equal(
      mock.requests.slice(start).filter((r) => r.m === "device.op").length,
      0,
    );
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("an intensity timeout is not retried and does not invent a physical value", async () => {
  const mock = await relay({ ignoreIntensity: true });
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    await assert.rejects(driver.setIntensity("A", 12));
    assert.equal(driver.state.intensities.A, 0);
    assert.equal(
      mock.requests.filter(
        (r) => r.m === "device.op" && (r.data as { t: number }).t === 3,
      ).length,
      1,
    );
    mock.send({
      t: "ev",
      ev: "slots.patch",
      slots: [{ slotId: "slot-1", slotState: { hasDevice: false } }],
    });
    await until(() => !driver.state.connected);
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("successful reset RPCs do not count as a stopped device without zero telemetry", async () => {
  const mock = await relay({ retainIntensity: true });
  const driver = new CoyoteDevice();
  mock.intensities.A = 18;
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    assert.equal(driver.state.intensities.A, 18);
    assert.equal(await driver.stop(), false);
    assert.equal(driver.state.intensities.A, 18);
    assert.match(driver.state.error!, /停止未确认/);
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("builtins are official complete byte frames, and invalid relays fail without connecting", async () => {
  const waveforms = getBuiltinWaveforms();
  assert.ok(waveforms.length > 5);
  for (const waveform of waveforms) {
    assert.ok(waveform.name);
    assert.ok(waveform.frames.length);
    assert.ok(waveform.frames.every((frame) => /^[a-f0-9]{16}$/i.test(frame)));
  }
  const driver = new CoyoteDevice();
  await assert.rejects(
    driver.connect({ protocol: "v4", relayUrl: "https://invalid.example/" }),
    /中继地址/,
  );
  assert.equal(driver.state.connected, false);
  await driver.dispose();
});

test("legacy V3 requires actual strength telemetry and confirms zeros from APP messages", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing relay address");
  const values = { A: 9, B: 4 };
  const commands: Record<string, unknown>[] = [];
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({ type: "bind", clientId: "legacy-controller" }),
    );
    const report = () =>
      socket.send(
        JSON.stringify({
          type: "msg",
          clientId: "legacy-controller",
          targetId: "legacy-app",
          message: `strength-${values.A}+${values.B}+70+60`,
        }),
      );
    setTimeout(() => {
      if (socket.readyState !== 1) return;
      socket.send(
        JSON.stringify({
          type: "bind",
          clientId: "legacy-controller",
          targetId: "legacy-app",
          message: "200",
        }),
      );
      report();
    }, 20);
    socket.on("message", (raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 3) {
        values[command.channel === 1 ? "A" : "B"] = command.strength;
        report();
      }
    });
  });
  const driver = new CoyoteDevice();
  try {
    await driver.connect({
      protocol: "v3",
      relayUrl: `ws://127.0.0.1:${address.port}/`,
    });
    await until(() => driver.state.connected);
    assert.deepEqual(driver.state.intensities, { A: 9, B: 4 });
    assert.deepEqual(driver.state.limits, { A: 70, B: 60 });
    await driver.setIntensity("A", 12);
    assert.equal(driver.state.intensities.A, 12);
    await driver.sendFrames("B", ["0A0A0A0A00000000"]);
    await until(() => commands.some((c) => c.type === "clientMsg"));
    assert.equal(commands.find((c) => c.type === "clientMsg")!.time, 0.1);
    assert.equal(await driver.stop(), true);
    assert.deepEqual(driver.state.intensities, { A: 0, B: 0 });
  } finally {
    await driver.dispose();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
