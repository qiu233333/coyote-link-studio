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
    getWithoutTelemetry?: boolean;
    resetReplyDelay?: Partial<Record<"A" | "B", number>>;
    pulseReplyDelay?: number;
    holdNextGet?: boolean;
  } = {},
) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address)
    throw new Error("Missing relay address");
  const requests: Record<string, unknown>[] = [];
  const held: (() => void)[] = [];
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
      if (req.m === "devices.get" && !options.getWithoutTelemetry)
        result = { devices: [device()] };
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
      const response = { t: "resp", reqId: req.reqId, result };
      if (req.m === "devices.get" && options.holdNextGet) {
        held.push(() => send(response));
        return;
      }
      const delay =
        req.m === "device.op" && req.data.t === 7
          ? options.resetReplyDelay?.[req.data.c === 0 ? "A" : "B"]
          : req.m === "device.op" && req.data.t === 0
            ? options.pulseReplyDelay
            : undefined;
      if (delay)
        setTimeout(() => {
          if (socket.readyState === 1) send(response);
        }, delay);
      else send(response);
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}/v4`,
    requests,
    intensities,
    limits,
    send,
    held,
    detach: () =>
      peer?.send(
        JSON.stringify({ type: "client_disconnected", clientId: "app-1" }),
      ),
    attach: () =>
      peer?.send(
        JSON.stringify({ type: "client_attached", clientId: "app-1" }),
      ),
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function legacyRelay(
  options: {
    initial?: { A: number; B: number };
    changedOnly?: boolean;
    reportOnSet?: boolean;
    ignoreZeroB?: boolean;
    initialReport?: boolean;
  } = {},
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing relay address");
  let peer: WebSocket | undefined;
  const values = { ...(options.initial ?? { A: 0, B: 0 }) };
  const commands: Record<string, unknown>[] = [];
  const report = () =>
    peer?.send(
      JSON.stringify({
        type: "msg",
        clientId: "legacy-controller",
        targetId: "legacy-app",
        message: `strength-${values.A}+${values.B}+70+60`,
      }),
    );
  server.on("connection", (socket) => {
    peer = socket;
    socket.send(
      JSON.stringify({ type: "bind", clientId: "legacy-controller" }),
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
      if (options.initialReport !== false) report();
    }, 20);
    socket.on("message", (raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type !== 3) return;
      const channel = command.channel === 1 ? "A" : "B";
      const previous = values[channel];
      if (!(options.ignoreZeroB && channel === "B" && command.strength === 0))
        values[channel] = command.strength;
      if (
        options.reportOnSet !== false &&
        (!options.changedOnly || values[channel] !== previous)
      )
        report();
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    values,
    commands,
    report,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("an untouched driver stops idempotently without pretending to have device telemetry", async () => {
  const driver = new CoyoteDevice();
  assert.equal(await driver.stop(), true);
  assert.equal(await driver.stop(), true);
  assert.equal(driver.state.lastSeenAt, 0);
  assert.equal(driver.state.canConfirmZero, false);
  assert.equal(driver.state.connected, false);
  await driver.dispose();
});

test("V3 unchanged dual zero uses fresh real telemetry, and repeated stops need no new event", async () => {
  const mock = await legacyRelay({ changedOnly: true });
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v3", relayUrl: mock.url });
    await until(() => driver.state.connected);
    const reportedAt = driver.state.lastSeenAt;
    assert.equal(await driver.stop(), true);
    await until(() => mock.commands.length === 4);
    assert.equal(
      driver.state.lastSeenAt,
      reportedAt,
      "no zero telemetry was invented",
    );
    assert.equal(await driver.stop(), true);
    assert.equal(mock.commands.length, 4, "a completed stop is idempotent");
    await mock.close();
    await until(() => !driver.state.connected);
    assert.equal(
      await driver.stop(),
      true,
      "a completed stop survives a pure disconnect",
    );
    assert.equal(driver.state.canConfirmZero, false);
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("V3 paired APP without its first strength report is not an untouched idle driver", async () => {
  const mock = await legacyRelay({
    initial: { A: 8, B: 9 },
    initialReport: false,
    reportOnSet: false,
  });
  const driver = new CoyoteDevice();
  let stopAtPairing: Promise<boolean> | undefined;
  driver.on("state", () => {
    if (driver.state.appStatus === "paired" && !stopAtPairing)
      stopAtPairing = driver.stop();
  });
  try {
    await driver.connect({ protocol: "v3", relayUrl: mock.url });
    await until(() => driver.state.appStatus === "paired");
    assert.equal(driver.state.lastSeenAt, 0);
    assert.equal(driver.state.connected, false);
    assert.equal(
      await stopAtPairing,
      false,
      "pairing cannot prove an unknown physical strength is zero",
    );
    assert.equal(
      mock.commands.filter((command) => command.type === 4).length,
      2,
    );
    assert.equal(
      mock.commands.filter((command) => command.type === 3).length,
      2,
    );
    assert.equal(
      driver.state.lastSeenAt,
      0,
      "sent reset commands are not device telemetry",
    );
    assert.equal(driver.state.canConfirmZero, false);
    mock.report();
    await until(() => driver.state.connected);
    assert.equal(await driver.stop(), true);
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("V3 rejects old zero evidence after an unconfirmed positive command and accepts later real recovery", async () => {
  const options = { reportOnSet: false };
  const mock = await legacyRelay(options);
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v3", relayUrl: mock.url });
    await until(() => driver.state.connected);
    await assert.rejects(driver.setIntensity("A", 8), /回传未确认/);
    assert.equal(
      driver.state.intensities.A,
      0,
      "retained zero is only the last real sample",
    );
    assert.equal(await driver.stop(), false);
    assert.match(driver.state.error!, /停止未确认/);
    mock.report();
    await until(() => driver.state.canConfirmZero);
    assert.equal(
      await driver.stop(),
      true,
      "fresh zero after the failed stop can resolve it",
    );
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("V3 only one channel reaching zero cannot confirm stop", async () => {
  const mock = await legacyRelay({
    initial: { A: 6, B: 9 },
    ignoreZeroB: true,
  });
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v3", relayUrl: mock.url });
    await until(() => driver.state.connected);
    assert.equal(await driver.stop(), false);
    assert.deepEqual(driver.state.intensities, { A: 0, B: 9 });
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("V4 disconnect with retained zero values is unconfirmed until a real completed stop", async () => {
  const mock = await relay();
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    mock.detach();
    await until(() => driver.state.appStatus === "disconnected");
    assert.equal(driver.state.clientId, "app-1");
    assert.deepEqual(driver.state.intensities, { A: 0, B: 0 });
    assert.equal(await driver.stop(), false);
    assert.match(driver.state.error!, /APP.*断开/);
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("V4 reattaching APP invalidates the old stop certificate before refreshed telemetry", async () => {
  const options = { getWithoutTelemetry: false };
  const mock = await relay(options);
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    assert.equal(await driver.stop(), true);
    mock.detach();
    await until(() => driver.state.appStatus === "disconnected");
    assert.equal(await driver.stop(), true);
    options.getWithoutTelemetry = true;
    mock.attach();
    await until(() => driver.state.appStatus === "paired");
    assert.equal(
      await driver.stop(),
      false,
      "new pairing needs new physical zero proof",
    );
    assert.equal(driver.state.canConfirmZero, false);
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("V4 slot metadata and A-only patches cannot refresh B telemetry or confirm a new stop", async () => {
  const options = { getWithoutTelemetry: false };
  const mock = await relay(options);
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    const lastSeen = driver.state.lastSeenAt;
    options.getWithoutTelemetry = true;
    const start = mock.requests.length;
    const stopping = driver.stop();
    await until(() =>
      mock.requests.slice(start).some((r) => r.m === "devices.get"),
    );
    mock.send({
      t: "ev",
      ev: "slots.patch",
      slots: [
        { slotId: "slot-1", slotState: { channelA: { intensityMax: 79 } } },
      ],
    });
    mock.send({
      t: "ev",
      ev: "slots.patch",
      slots: [{ slotId: "slot-1", props: { intensityA: 0 } }],
    });
    await until(() => driver.state.limits.A === 79);
    assert.equal(driver.state.lastSeenAt, lastSeen);
    assert.equal(await stopping, false);
    options.getWithoutTelemetry = false;
    assert.equal(
      await driver.stop(),
      true,
      "a later complete real snapshot resolves the failure",
    );
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("V4 selected hardware removal invalidates stop proof before the same slot reappears", async () => {
  const options = { getWithoutTelemetry: false };
  const mock = await relay(options);
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    assert.equal(await driver.stop(), true);
    mock.send({ t: "ev", ev: "devices.patch", removed: ["slot-1"] });
    await until(() => !driver.state.connected);
    mock.send({
      t: "ev",
      ev: "devices.patch",
      added: [
        {
          slotId: "slot-1",
          name: "Reattached Coyote",
          type: "COYOTE_030",
          slotState: { hasDevice: true },
        },
      ],
    });
    await until(() => driver.state.devices.length === 1);
    options.getWithoutTelemetry = true;
    assert.equal(
      await driver.stop(),
      false,
      "the replacement has not reported its actual A/B values",
    );
    options.getWithoutTelemetry = false;
    assert.equal(await driver.stop(), true);
    mock.send({
      t: "ev",
      ev: "slots.patch",
      slots: [{ slotId: "slot-1", slotState: { hasDevice: false } }],
    });
    await until(() => !driver.state.connected);
    options.getWithoutTelemetry = true;
    assert.equal(
      await driver.stop(),
      false,
      "a hardware disconnect also invalidates the old stop proof",
    );
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("V4 concurrent stops share one ordered clear/reset sequence and discard queued positive work", async () => {
  const mock = await relay({ resetReplyDelay: { A: 70, B: 20 } });
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    const queued = driver.setIntensity("A", 12);
    const rejected = assert.rejects(queued, /动作已被停止操作废弃/);
    const start = mock.requests.length;
    const first = driver.stop();
    const second = driver.stop();
    assert.equal(first, second);
    await assert.rejects(driver.setIntensity("B", 6), /正在停止/);
    assert.equal(await first, true);
    await rejected;
    const commands = mock.requests
      .slice(start)
      .filter((r) => r.m !== "devices.get");
    assert.equal(commands.length, 3);
    assert.equal(commands[0]!.m, "device.op.clear");
    assert.deepEqual(
      commands.slice(1).map((r) => (r.data as { c: number }).c),
      [0, 1],
    );
    assert.equal(await driver.stop(), true);
    assert.equal(
      mock.requests.slice(start).filter((r) => r.m === "device.op.clear")
        .length,
      1,
    );
  } finally {
    await driver.dispose();
    await mock.close();
  }
});

test("V4 a delayed old heartbeat snapshot cannot replace the stop query's missing telemetry", async () => {
  const options = { holdNextGet: false, getWithoutTelemetry: false };
  const mock = await relay(options);
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    options.holdNextGet = true;
    const oldPoll = (
      driver as unknown as { heartbeat(): Promise<void> }
    ).heartbeat();
    await until(() => mock.held.length === 1);
    options.holdNextGet = false;
    options.getWithoutTelemetry = true;
    const start = mock.requests.length;
    const stopping = driver.stop();
    await until(() =>
      mock.requests.slice(start).some((r) => r.m === "devices.get"),
    );
    mock.held[0]!();
    await oldPoll;
    assert.equal(await stopping, false);
    options.getWithoutTelemetry = false;
    assert.equal(await driver.stop(), true);
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

test("V4 a pulse ACK arriving after stop cannot revive output or invalidate the completed stop", async () => {
  const mock = await relay({ pulseReplyDelay: 120 });
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    const pulse = driver.sendFrames("A", ["0A0A0A0A00000000"]);
    await until(() =>
      mock.requests.some(
        (r) => r.m === "device.op" && (r.data as { t: number }).t === 0,
      ),
    );
    assert.equal(await driver.stop(), true);
    const commands = mock.requests.length;
    await pulse;
    assert.equal(await driver.stop(), true);
    assert.equal(mock.requests.length, commands);
    assert.deepEqual(driver.state.intensities, { A: 0, B: 0 });
  } finally {
    await driver.dispose();
    await mock.close();
  }
});

test("V4 a missing B reset ACK retains an unconfirmed stop even when A already reset", async () => {
  const options = { resetReplyDelay: { B: 1_200 } };
  const mock = await relay(options);
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    const start = mock.requests.length;
    assert.equal(await driver.stop(), false);
    assert.equal(driver.state.canConfirmZero, false);
    assert.match(driver.state.error!, /停止未确认/);
    const stopCommands = mock.requests
      .slice(start)
      .filter((r) => r.m === "device.op");
    assert.deepEqual(
      stopCommands.map((r) => (r.data as { c: number }).c),
      [0, 1],
    );
    options.resetReplyDelay.B = 0;
    assert.equal(
      await driver.stop(),
      true,
      "a later fully acknowledged stop resolves the failure",
    );
  } finally {
    await mock.close();
    await driver.dispose();
  }
});

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

test("a late heartbeat failure from the previous connection cannot fault a replacement device", async () => {
  const mock = await relay();
  const driver = new CoyoteDevice();
  try {
    await driver.connect({ protocol: "v4", relayUrl: mock.url });
    await until(() => driver.state.devices.length === 1);
    await driver.selectDevice("app-1", "slot-1");
    const internals = driver as unknown as {
      heartbeat(): Promise<void>;
      refresh(clientId: string): Promise<void>;
      polling: boolean;
    };
    const refresh = internals.refresh.bind(driver);
    let rejectOldPoll!: (error: Error) => void;
    let first = true;
    internals.refresh = (clientId) => {
      if (!first) return refresh(clientId);
      first = false;
      return new Promise((_resolve, reject) => {
        rejectOldPoll = reject;
      });
    };
    const oldPoll = internals.heartbeat();
    assert.equal(internals.polling, true);
    await driver.connect({ protocol: "simulator" });
    // Release the stale failure only after the replacement is fully connected.
    rejectOldPoll(new Error("Previous connection heartbeat failed"));
    await oldPoll;
    assert.equal(driver.state.protocol, "simulator");
    assert.equal(driver.state.connected, true);
    assert.equal(driver.state.error, undefined);
    assert.equal(internals.polling, false);
  } finally {
    await driver.dispose();
    await mock.close();
  }
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
