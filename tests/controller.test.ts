import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { CoyoteDevice } from "../server/device.js";
import { Controller, type AiBridge } from "../server/controller.js";
import { AiServiceError } from "../server/ai.js";
import { parseBounds, parsePlayback, parsePlan } from "../server/validation.js";
import type {
  AiDecision,
  Channel,
  ControlBounds,
  PlaybackConfig,
  Stage,
  TaskPlan,
  Waveform,
} from "../shared/types.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, timeout = 2000) => {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error("Timed out");
    await sleep(10);
  }
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
const executeTick = (controller: Controller) =>
  (controller as unknown as { tick(): void }).tick();
const flush = async () => {
  for (let index = 0; index < 8; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};
const retryNow = (controller: Controller) => {
  controller.run!.inferenceRecovery!.retryAt = 0;
  (controller as unknown as { nextAiAt: number }).nextAiAt = 0;
  executeTick(controller);
};

async function fixture(
  options: {
    authorize?: boolean;
    limits?: Record<Channel, number>;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "coyote-controller-"));
  const store = new Store(directory);
  store.saveSettings({
    baseUrl: "http://127.0.0.1:9876/v1",
    model: "fixture-model",
    apiKey: "fixture-secret",
  });
  let decision = async (): Promise<AiDecision> => ({
    action: "rest",
    channels: [],
    waveformId: "",
    intensity: { A: 0, B: 0 },
    durationSec: 1,
    reason: "Fixture rest",
  });
  let draft!: Omit<TaskPlan, "id" | "version" | "createdAt">;
  const ai: AiBridge = {
    status: { ready: true },
    decide: () => decision(),
    draft: async () => draft,
  };
  const device = new CoyoteDevice();
  const controller = new Controller(store, device, ai, [
    { name: "测试波形", frames: ["0A0A0A0A00000000", "0B0B0B0B10101010"] },
  ]);
  await controller.connect({ protocol: "simulator" });
  if (options.limits) {
    device.state.limits = options.limits;
    device.emit("state", device.state);
  }
  const wave = store.list<Waveform>("waveforms")[0]!;
  if (options.authorize !== false)
    await controller.updateChannels({
      channels: {
        A: { limit: 20, rampPerSecond: 20, target: 4, waveformId: wave.id },
        B: { limit: 20, rampPerSecond: 20, target: 7, waveformId: wave.id },
      },
    });
  const stage = (overrides: Partial<Stage> = {}): Stage => ({
    id: randomUUID(),
    name: "测试阶段",
    durationSec: 5,
    gapSec: 0,
    channels: ["A"],
    waveformId: wave.id,
    intensity: { A: 4, B: 4 },
    startIntensity: { A: 0, B: 0 },
    behavior: "hold",
    ...overrides,
  });
  const bounds = (overrides: Partial<ControlBounds> = {}): ControlBounds => ({
    channels: ["A"],
    waveformIds: [wave.id],
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 10, B: 10 },
    rampPerSecond: { A: 20, B: 20 },
    allowSync: false,
    allowRandom: false,
    allowRamp: true,
    allowRest: true,
    maxActionSec: 10,
    durationSec: 60,
    decisionIntervalSec: 15,
    preference: "fixture",
    ...overrides,
  });
  const playback = (
    overrides: Partial<PlaybackConfig> = {},
  ): PlaybackConfig => ({
    mode: "single",
    stages: [stage()],
    repeat: 0,
    shuffle: false,
    durationSec: 60,
    ...overrides,
  });
  const plan = (b = bounds(), stages = [stage()]) => {
    const p: TaskPlan = {
      id: randomUUID(),
      version: 1,
      title: "Fixture task",
      description: "确认内容",
      completionCriteria: "计时或文字反馈",
      bounds: b,
      stages,
      createdAt: Date.now(),
    };
    store.set("plans", p.id, p);
    draft = p;
    return p;
  };
  return {
    directory,
    store,
    device,
    controller,
    ai,
    wave,
    stage,
    bounds,
    playback,
    plan,
    decide: (fn: () => Promise<AiDecision>) => {
      decision = fn;
    },
    cleanup: async () => {
      await controller.close();
      await device.dispose();
      store.close();
      assert.ok(
        resolve(directory).startsWith(resolve(tmpdir())) &&
          basename(directory).startsWith("coyote-controller-"),
      );
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("manual single mode preserves independent channel targets and stops both channels", async () => {
  const f = await fixture();
  try {
    await f.controller.startPlayback(
      f.playback({ stages: [f.stage({ channels: ["A", "B"] })] }),
      randomUUID(),
    );
    await until(
      () =>
        f.device.state.intensities.A === 4 &&
        f.device.state.intensities.B === 7,
    );
    assert.equal(f.controller.run!.owner, "manual");
    await f.controller.updateChannels({ channels: { A: { target: 2 } } });
    await until(() => f.device.state.intensities.A === 2);
    assert.equal(f.device.state.intensities.B, 7);
    await f.controller.stop("manual");
    assert.equal(f.controller.run!.status, "stopped");
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    assert.equal(f.controller.stopping, false);
  } finally {
    await f.cleanup();
  }
});

test("20/19 device ceilings allow live control with legacy user limits still zero", async () => {
  const f = await fixture({ authorize: false, limits: { A: 20, B: 19 } });
  try {
    assert.deepEqual(f.controller.snapshot().device.limits, { A: 20, B: 19 });
    assert.equal(f.controller.config.A.limit, 0);
    assert.equal(f.controller.config.B.limit, 0);
    await f.controller.updateLiveChannels({
      channels: { A: { target: 20 }, B: { target: 19 } },
    });
    assert.deepEqual(
      f.device.state.intensities,
      { A: 0, B: 0 },
      "editing idle targets never emits output",
    );
    await f.controller.startLive(randomUUID());
    await until(
      () =>
        f.device.state.intensities.A === 20 &&
        f.device.state.intensities.B === 19,
    );
    assert.equal(f.controller.run!.mode, "live");
    assert.equal(f.controller.config.A.limit, 0);
    assert.equal(f.controller.config.B.limit, 0);
  } finally {
    await f.cleanup();
  }
});

test("first live start clears persisted sync before reset telemetry can lower independent targets", async () => {
  const f = await fixture({ authorize: false, limits: { A: 20, B: 19 } });
  try {
    f.controller.synced = true;
    f.store.set("settings", "synced", true);
    f.controller.config.A.target = 20;
    f.controller.config.B.target = 19;
    f.store.set("settings", "channels", f.controller.config);
    await f.controller.startLive(randomUUID());
    assert.equal(f.controller.synced, false);
    assert.equal(f.store.get("settings", "synced"), false);
    assert.deepEqual(
      [f.controller.config.A.target, f.controller.config.B.target],
      [20, 19],
    );
    await until(
      () =>
        f.device.state.intensities.A === 20 &&
        f.device.state.intensities.B === 19,
    );
  } finally {
    await f.cleanup();
  }
});

test("live targets ignore old sync settings and hot channel/waveform changes reach device frames", async () => {
  const f = await fixture({ authorize: false, limits: { A: 20, B: 19 } });
  const frames: { channel: Channel; frames: string[] }[] = [];
  const send = f.device.sendFrames.bind(f.device);
  f.device.sendFrames = async (channel, values) => {
    frames.push({ channel, frames: values });
    return send(channel, values);
  };
  try {
    f.controller.synced = true;
    f.store.set("settings", "synced", true);
    await f.controller.updateLiveChannels({
      channels: { A: { target: 6 }, B: { enabled: false, target: 0 } },
    });
    assert.equal(f.controller.synced, false);
    assert.equal(f.store.get("settings", "synced"), false);
    assert.deepEqual(
      [f.controller.config.A.target, f.controller.config.B.target],
      [6, 0],
    );
    const request = randomUUID();
    await f.controller.startLive(request);
    const runId = f.controller.run!.id;
    await f.controller.startLive(request);
    assert.equal(f.controller.run!.id, runId);
    await until(() => f.device.state.intensities.A === 6);
    assert.equal(f.device.state.intensities.B, 0);
    assert.ok(frames.some((call) => call.channel === "A"));
    assert.ok(!frames.some((call) => call.channel === "B"));
    await f.controller.updateLiveChannels({
      channels: { B: { enabled: true } },
    });
    await sleep(120);
    assert.equal(
      f.device.state.intensities.B,
      0,
      "enabling never restores the old target",
    );
    const wave = f.controller.importWaveform(["0C0C0C0C32323232"], "实时切换");
    await f.controller.updateLiveChannels({
      channels: { B: { target: 9, waveformId: wave.id } },
    });
    await until(() => f.device.state.intensities.B === 9);
    await until(() =>
      frames.some(
        (call) => call.channel === "B" && call.frames.includes(wave.frames[0]),
      ),
    );
    assert.equal(f.device.state.intensities.A, 6);
    assert.equal(f.controller.run!.id, runId);
    await f.controller.updateLiveChannels({
      channels: { B: { enabled: false } },
    });
    await until(() => f.device.state.intensities.B === 0);
    assert.equal(f.device.state.intensities.A, 6);
    assert.equal(f.controller.run!.status, "running");
    await f.controller.updateLiveChannels({ channels: { B: { target: 7 } } });
    executeTick(f.controller);
    await sleep(120);
    assert.equal(f.controller.config.B.target, 7);
    assert.equal(
      f.device.state.intensities.B,
      0,
      "closed channels may be configured without output",
    );
    await f.controller.updateLiveChannels({
      channels: { B: { enabled: true } },
    });
    await until(() => f.device.state.intensities.B === 7);
    assert.equal(f.device.state.intensities.A, 6);
  } finally {
    await f.cleanup();
  }
});

test("rapid live patches remain independent and paused configuration only outputs after resume", async () => {
  const f = await fixture({ authorize: false, limits: { A: 20, B: 19 } });
  try {
    await f.controller.startLive(randomUUID());
    await Promise.all([
      f.controller.updateLiveChannels({ channels: { A: { target: 2 } } }),
      f.controller.updateLiveChannels({ channels: { B: { target: 4 } } }),
      f.controller.updateLiveChannels({ channels: { A: { target: 8 } } }),
      f.controller.updateLiveChannels({ channels: { B: { target: 3 } } }),
    ]);
    await until(
      () =>
        f.device.state.intensities.A === 8 &&
        f.device.state.intensities.B === 3,
    );
    await assert.rejects(
      f.controller.updateLiveChannels({ channels: { B: { target: 20 } } }),
      /B 通道目标强度超过设备上限/,
    );
    await assert.rejects(
      f.controller.updateLiveChannels({ channels: { A: { limit: 1 } } }),
    );
    const runId = f.controller.run!.id;
    const deadline = f.controller.run!.deadlineAt;
    await f.controller.pause("manual");
    const wave = f.controller.importWaveform(["0D0D0D0D10101010"], "暂停配置");
    await f.controller.updateLiveChannels({
      channels: {
        A: { target: 5, waveformId: wave.id },
        B: { enabled: false },
      },
    });
    executeTick(f.controller);
    await sleep(150);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    assert.equal(f.controller.run!.status, "paused");
    await f.controller.startLive(randomUUID());
    assert.equal(f.controller.run!.id, runId);
    assert.equal(f.controller.run!.deadlineAt, deadline);
    await until(() => f.device.state.intensities.A === 5);
    assert.equal(f.device.state.intensities.B, 0);
    assert.ok(f.controller.run!.waveformSnapshots[wave.id]);
  } finally {
    await f.cleanup();
  }
});

test("a late live configuration patch survives pause stop confirmation without sending output", async () => {
  const f = await fixture({ authorize: false, limits: { A: 20, B: 19 } });
  const gate = deferred<void>();
  const stop = f.device.stop.bind(f.device);
  const set = f.device.setIntensity.bind(f.device);
  let stopping = false;
  let intensityCalls = 0;
  f.device.setIntensity = (channel, target) => {
    intensityCalls++;
    return set(channel, target);
  };
  try {
    await f.controller.updateLiveChannels({ channels: { A: { target: 4 } } });
    await f.controller.startLive(randomUUID());
    await until(() => f.device.state.intensities.A === 4);
    const wave = f.controller.importWaveform(
      ["0E0E0E0E11111111"],
      "暂停在途配置",
    );
    f.device.stop = async () => {
      stopping = true;
      await gate.promise;
      return stop();
    };
    const pausing = f.controller.pause("manual");
    await until(() => stopping);
    assert.equal(f.controller.stopping, true);
    assert.equal(f.controller.run!.status, "paused");
    const before = intensityCalls;
    await f.controller.updateLiveChannels({
      channels: {
        A: { target: 7, waveformId: wave.id },
        B: { enabled: false, target: 3 },
      },
    });
    executeTick(f.controller);
    assert.equal(
      intensityCalls,
      before,
      "configuration patch must never send device commands",
    );
    assert.equal(f.controller.config.A.target, 7);
    gate.resolve();
    await pausing;
    assert.equal(f.controller.run!.status, "paused");
    assert.equal(f.controller.stopping, false);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    assert.equal(f.controller.config.A.waveformId, wave.id);
    assert.equal(f.controller.config.B.target, 3);
    await f.controller.startLive(randomUUID());
    await until(() => f.device.state.intensities.A === 7);
    assert.equal(f.device.state.intensities.B, 0);
    const emergencyGate = deferred<void>();
    f.device.stop = async () => {
      await emergencyGate.promise;
      return stop();
    };
    const emergency = f.controller.emergency();
    await assert.rejects(
      f.controller.updateLiveChannels({ channels: { A: { target: 9 } } }),
      /设备正在停止/,
    );
    emergencyGate.resolve();
    await emergency;
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    gate.resolve();
    f.device.stop = stop;
    await f.cleanup();
  }
});

test("live controls retain device, waveform, ownership and locked-task checks", async () => {
  const f = await fixture({ authorize: false, limits: { A: 20, B: 19 } });
  try {
    await assert.rejects(
      f.controller.updateLiveChannels({
        channels: { A: { waveformId: "missing" } },
      }),
      /波形不存在/,
    );
    await assert.rejects(
      f.controller.updateLiveChannels({ channels: { A: { target: 21 } } }),
      /设备上限/,
    );
    await f.controller.startAi(
      f.bounds({ maxIntensity: { A: 20, B: 20 } }),
      randomUUID(),
    );
    await assert.rejects(
      f.controller.startLive(randomUUID()),
      /先停止当前控制/,
    );
    await assert.rejects(
      f.controller.updateLiveChannels({ channels: { A: { target: 3 } } }),
      /先停止当前控制/,
    );
    await f.controller.emergency();
    const plan = f.plan();
    await f.controller.startTask(plan.id, randomUUID());
    await assert.rejects(f.controller.startLive(randomUUID()), /上锁任务/);
    await assert.rejects(
      f.controller.updateLiveChannels({ channels: { A: { target: 3 } } }),
      /上锁任务/,
    );
    await f.controller.emergency();
    await f.controller.startPlayback(f.playback(), randomUUID());
    await assert.rejects(
      f.controller.startLive(randomUUID()),
      /先停止当前控制/,
    );
    await assert.rejects(
      f.controller.updateLiveChannels({ channels: { A: { target: 3 } } }),
      /先停止当前控制/,
    );
    await f.controller.emergency();
    await f.controller.disconnect();
    await assert.rejects(f.controller.startLive(randomUUID()), /请先连接/);
  } finally {
    await f.cleanup();
  }
});

test("AI uses current device ceilings and its own bounds when legacy limit fields are zero", async () => {
  const f = await fixture({ authorize: false, limits: { A: 20, B: 19 } });
  try {
    let observed = false;
    f.ai.decide = async (_profile, input) => {
      const context = input as {
        channels: Record<Channel, { limit: number; rampPerSecond?: number }>;
        bounds: ControlBounds;
      };
      assert.equal(context.channels.A.limit, 20);
      assert.equal(context.channels.B.limit, 19);
      assert.equal(context.channels.A.rampPerSecond, undefined);
      assert.deepEqual(context.bounds.maxIntensity, { A: 10, B: 10 });
      observed = true;
      return {
        action: "adjust",
        channels: ["A"],
        waveformId: f.wave.id,
        intensity: { A: 6, B: 6 },
        durationSec: 5,
        reason: "设备边界内运行",
      };
    };
    await f.controller.startAi(f.bounds(), randomUUID());
    executeTick(f.controller);
    await until(() => f.device.state.intensities.A === 6, 4000);
    assert.equal(observed, true);
    assert.equal(f.controller.config.A.limit, 0);
    assert.equal(f.controller.config.B.limit, 0);
    assert.equal(f.device.state.intensities.B, 0);
  } finally {
    await f.cleanup();
  }
});

test("live hardware decreases clamp independent targets and excessive actual telemetry still stops", async () => {
  const f = await fixture({ authorize: false, limits: { A: 20, B: 19 } });
  try {
    await f.controller.updateLiveChannels({
      channels: { A: { target: 15 }, B: { target: 6 } },
    });
    await f.controller.startLive(randomUUID());
    await until(
      () =>
        f.device.state.intensities.A >= 5 && f.device.state.intensities.B >= 5,
    );
    f.device.state.limits.A = 8;
    f.device.emit("state", f.device.state);
    assert.equal(f.controller.config.A.target, 8);
    assert.equal(f.controller.config.B.target, 6);
    await until(
      () =>
        f.device.state.intensities.A === 8 &&
        f.device.state.intensities.B === 6,
    );
    assert.equal(f.controller.run!.status, "running");
    f.device.state.limits.A = 2;
    f.device.emit("state", f.device.state);
    await until(
      () => f.controller.run!.status === "faulted" && !f.controller.stopping,
    );
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    assert.match(f.controller.run!.reason!, /回传强度超出确认边界/);
  } finally {
    await f.cleanup();
  }
});

test("editing a running single channel never adds the other enabled channel", async () => {
  const f = await fixture();
  try {
    assert.equal(f.controller.config.B.target, 7);
    await f.controller.startPlayback(f.playback(), randomUUID());
    await until(() => f.device.state.intensities.A === 4);
    await f.controller.updateChannels({ channels: { A: { target: 2 } } });
    await f.controller.updateChannels({ channels: { B: { target: 6 } } });
    await until(() => f.device.state.intensities.A === 2);
    assert.deepEqual(f.controller.run!.playback!.stages[0].channels, ["A"]);
    assert.equal(f.device.state.intensities.B, 0);
  } finally {
    await f.cleanup();
  }
});

test("synchronized selected channels survive disable and enable without restoring output", async () => {
  const f = await fixture();
  try {
    await f.controller.updateChannels({
      synced: true,
      channels: { A: { target: 3 }, B: { target: 3 } },
    });
    await f.controller.startPlayback(
      f.playback({ stages: [f.stage({ channels: ["A", "B"] })] }),
      randomUUID(),
    );
    await until(
      () =>
        f.device.state.intensities.A === 3 &&
        f.device.state.intensities.B === 3,
    );
    await f.controller.updateChannels({ channels: { B: { enabled: false } } });
    await until(
      () =>
        f.device.state.intensities.A === 0 &&
        f.device.state.intensities.B === 0,
    );
    assert.equal(f.controller.run!.status, "running");
    assert.deepEqual(f.controller.run!.playback!.stages[0].channels, [
      "A",
      "B",
    ]);
    await f.controller.updateChannels({ channels: { B: { enabled: true } } });
    executeTick(f.controller);
    await sleep(120);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    assert.deepEqual(
      [f.controller.config.A.target, f.controller.config.B.target],
      [0, 0],
    );
    await f.controller.updateChannels({ channels: { A: { target: 3 } } });
    await until(
      () =>
        f.device.state.intensities.A === 3 &&
        f.device.state.intensities.B === 3,
    );
  } finally {
    await f.cleanup();
  }
});

test("a single selected channel survives disable and enable and still excludes the other channel", async () => {
  const f = await fixture();
  try {
    await f.controller.startPlayback(f.playback(), randomUUID());
    await until(() => f.device.state.intensities.A === 4);
    await f.controller.updateChannels({ channels: { A: { enabled: false } } });
    await until(() => f.device.state.intensities.A === 0);
    assert.equal(f.controller.run!.status, "running");
    assert.deepEqual(f.controller.run!.playback!.stages[0].channels, ["A"]);
    await f.controller.updateChannels({ channels: { A: { enabled: true } } });
    executeTick(f.controller);
    await sleep(120);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    assert.equal(f.controller.config.A.target, 0);
    await f.controller.updateChannels({ channels: { A: { target: 3 } } });
    await until(() => f.device.state.intensities.A === 3);
    assert.equal(f.device.state.intensities.B, 0);
  } finally {
    await f.cleanup();
  }
});

test("legacy user ceiling fields no longer constrain targets or start output", async () => {
  const f = await fixture();
  try {
    await f.controller.updateChannels({
      synced: true,
      channels: { A: { target: 12 }, B: { target: 12 } },
    });
    await f.controller.updateChannels({ channels: { A: { limit: 6 } } });
    assert.deepEqual(
      [f.controller.config.A.limit, f.controller.config.B.limit],
      [6, 20],
    );
    assert.deepEqual(
      [f.controller.config.A.target, f.controller.config.B.target],
      [12, 12],
    );
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    assert.equal(f.controller.run, null);
  } finally {
    await f.cleanup();
  }
});

test("dual and synchronized playback respect the lower selected ceiling and enabled channels", async () => {
  const f = await fixture({ limits: { A: 20, B: 19 } });
  const both = () =>
    f.playback({
      stages: [f.stage({ channels: ["A", "B"] })],
      singleTargets: { A: 20, B: 20 },
    });
  try {
    await assert.rejects(
      f.controller.startPlayback(both(), randomUUID()),
      /B 通道播放强度超过上限/,
    );
    await f.controller.updateChannels({
      synced: true,
      channels: { A: { target: 0 }, B: { target: 0 } },
    });
    await assert.rejects(
      f.controller.startPlayback(f.playback(), randomUUID()),
      /同时选择 A\/B/,
    );
    await assert.rejects(
      f.controller.startPlayback(both(), randomUUID()),
      /播放强度超过上限/,
    );
    await assert.rejects(
      f.controller.updateChannels({ channels: { A: { target: 20 } } }),
      /有效上限/,
    );
    await f.controller.updateChannels({
      channels: { A: { limit: 8 }, B: { limit: 6 } },
    });
    await f.controller.startPlayback(
      { ...both(), singleTargets: { A: 6, B: 6 } },
      randomUUID(),
    );
    await until(
      () =>
        f.device.state.intensities.A === 6 &&
        f.device.state.intensities.B === 6,
    );
    await f.controller.stop();
    await f.controller.updateChannels({
      synced: false,
      channels: { B: { enabled: false } },
    });
    await assert.rejects(
      f.controller.startPlayback(
        { ...both(), singleTargets: { A: 6, B: 6 } },
        randomUUID(),
      ),
      /B 通道未启用/,
    );
    await f.controller.startPlayback(
      f.playback({ singleTargets: { A: 6 } }),
      randomUUID(),
    );
    await until(() => f.device.state.intensities.A === 6);
    assert.equal(f.device.state.intensities.B, 0);
  } finally {
    await f.cleanup();
  }
});

test("limits and ramp rates remain immutable while running, paused or task locked", async () => {
  const f = await fixture();
  try {
    await f.controller.startPlayback(f.playback(), randomUUID());
    for (const pause of [false, true]) {
      if (pause) await f.controller.pause();
      await assert.rejects(
        f.controller.updateChannels({ channels: { A: { limit: 19 } } }),
        /播放期间不能修改上限或变化速率/,
      );
      await assert.rejects(
        f.controller.updateChannels({ channels: { B: { rampPerSecond: 1 } } }),
        /播放期间不能修改上限或变化速率/,
      );
      assert.equal(f.controller.config.A.limit, 20);
      assert.equal(f.controller.config.B.rampPerSecond, 20);
    }
    await f.controller.stop();
    const plan = f.plan();
    await f.controller.startTask(plan.id, randomUUID());
    await assert.rejects(
      f.controller.updateChannels({ channels: { A: { limit: 19 } } }),
      /上锁任务/,
    );
    await assert.rejects(
      f.controller.updateChannels({ channels: { B: { rampPerSecond: 1 } } }),
      /上锁任务/,
    );
  } finally {
    await f.cleanup();
  }
});

test("lower hardware limits clamp live single targets and ramp state without restoring them on increase", async () => {
  const f = await fixture({ limits: { A: 20, B: 19 } });
  try {
    await f.controller.startPlayback(
      f.playback({ singleTargets: { A: 15 } }),
      randomUUID(),
    );
    await until(() => f.device.state.intensities.A >= 5);
    f.device.state.limits.A = 4;
    f.device.state.intensities.A = 4;
    f.device.emit("state", f.device.state);
    assert.equal(f.controller.config.A.target, 4);
    assert.equal(
      f.controller.config.A.limit,
      20,
      "saved authorization is unchanged",
    );
    assert.equal(f.controller.run!.playback!.singleTargets!.A, 4);
    const internals = f.controller as unknown as {
      levels: Record<Channel, number>;
    };
    assert.ok(internals.levels.A <= 4);
    executeTick(f.controller);
    await sleep(120);
    assert.equal(f.controller.run!.status, "running");
    assert.equal(f.device.state.intensities.A, 4);
    f.device.state.limits.A = 20;
    f.device.emit("state", f.device.state);
    await sleep(120);
    assert.equal(f.controller.config.A.target, 4);
    assert.equal(f.device.state.intensities.A, 4);
  } finally {
    await f.cleanup();
  }
});

test("a ceiling drop cancels a queued controller increase and continues at the safe target", async () => {
  const f = await fixture();
  try {
    await f.controller.startPlayback(
      f.playback({ singleTargets: { A: 15 } }),
      randomUUID(),
    );
    const internals = f.controller as unknown as {
      tickAt: number;
      intensityBusy: Record<Channel, boolean>;
    };
    internals.tickAt = Date.now() - 500;
    executeTick(f.controller);
    assert.equal(internals.intensityBusy.A, true);
    f.device.state.limits.A = 3;
    f.device.emit("state", f.device.state);
    await until(() => !internals.intensityBusy.A);
    assert.equal(f.controller.run!.status, "running");
    assert.equal(f.controller.config.A.target, 3);
    await until(() => f.device.state.intensities.A === 3);
    assert.equal(f.controller.run!.status, "running");
  } finally {
    await f.cleanup();
  }
});

test("hardware decreases clamp programmed stages and both synchronized targets", async () => {
  const f = await fixture({ limits: { A: 20, B: 19 } });
  try {
    await f.controller.startPlayback(
      f.playback({
        mode: "stages",
        stages: [f.stage({ intensity: { A: 12, B: 12 } })],
      }),
      randomUUID(),
    );
    await until(() => f.device.state.intensities.A >= 3);
    f.device.state.limits.A = 4;
    f.device.state.intensities.A = Math.min(4, f.device.state.intensities.A);
    f.device.emit("state", f.device.state);
    await until(() => f.device.state.intensities.A === 4);
    assert.equal(
      f.controller.run!.status,
      "running",
      "preauthorized stage is safely limited instead of faulting",
    );
    await f.controller.stop();
    f.device.state.limits.A = 20;
    await f.controller.updateChannels({ synced: true });
    await f.controller.startPlayback(
      f.playback({
        stages: [f.stage({ channels: ["A", "B"] })],
        singleTargets: { A: 12, B: 12 },
      }),
      randomUUID(),
    );
    await until(
      () =>
        f.device.state.intensities.A >= 4 && f.device.state.intensities.B >= 4,
    );
    f.device.state.limits.B = 3;
    f.device.state.intensities = { A: 3, B: 3 };
    f.device.emit("state", f.device.state);
    assert.deepEqual(
      [f.controller.config.A.target, f.controller.config.B.target],
      [3, 3],
    );
    executeTick(f.controller);
    await sleep(120);
    assert.equal(f.controller.run!.status, "running");
    assert.deepEqual(f.device.state.intensities, { A: 3, B: 3 });
  } finally {
    await f.cleanup();
  }
});

test("physical telemetry above a lowered boundary still faults and confirms zero", async () => {
  const f = await fixture();
  try {
    await f.controller.startPlayback(f.playback(), randomUUID());
    await until(() => f.device.state.intensities.A === 4);
    f.device.state.limits.A = 2;
    f.device.emit("state", f.device.state);
    await until(
      () => f.controller.run!.status === "faulted" && !f.controller.stopping,
    );
    assert.match(f.controller.run!.reason!, /回传强度超出确认边界/);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.cleanup();
  }
});

test("start rechecks a lower ceiling reported during initial reset", async () => {
  const f = await fixture();
  const stop = f.device.stop.bind(f.device);
  try {
    f.device.stop = async () => {
      const confirmed = await stop();
      f.device.state.limits.A = 2;
      f.device.emit("state", f.device.state);
      return confirmed;
    };
    await assert.rejects(
      f.controller.startPlayback(
        f.playback({ singleTargets: { A: 10 } }),
        randomUUID(),
      ),
      /播放强度超过上限/,
    );
    assert.equal(f.controller.run, null);
    assert.equal(f.controller.stopping, false);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    f.device.stop = stop;
    await f.cleanup();
  }
});

test("single-player explicit targets validate before reset and update actual channel controls", async () => {
  const f = await fixture({ limits: { A: 20, B: 19 } });
  const originalStop = f.device.stop.bind(f.device);
  let resets = 0;
  f.device.stop = async () => {
    resets++;
    return originalStop();
  };
  try {
    const imported = f.controller.importWaveform(
      ["0C0C0C0C00000000"],
      "播放器选择",
    );
    await f.controller.updateChannels({
      channels: { A: { target: 0 }, B: { target: 0 } },
    });
    await assert.rejects(
      f.controller.startPlayback(
        f.playback({ singleTargets: { A: 21 } }),
        randomUUID(),
      ),
      /播放强度超过上限/,
    );
    assert.equal(
      resets,
      0,
      "invalid targets must be rejected before physical prepare",
    );
    await f.controller.startPlayback(
      f.playback({
        stages: [f.stage({ waveformId: imported.id, channels: ["A", "B"] })],
        singleTargets: { A: 3, B: 6 },
      }),
      randomUUID(),
    );
    assert.equal(f.controller.config.A.waveformId, imported.id);
    assert.equal(f.controller.config.B.waveformId, imported.id);
    assert.equal(f.controller.config.A.target, 3);
    assert.equal(f.controller.config.B.target, 6);
    await until(
      () =>
        f.device.state.intensities.A === 3 &&
        f.device.state.intensities.B === 6,
    );
  } finally {
    f.device.stop = originalStop;
    await f.cleanup();
  }
});

test("locked tasks reject mutations, ordinary controls and takeover; repeated starts are idempotent", async () => {
  const f = await fixture();
  try {
    const p = f.plan();
    const requestId = randomUUID();
    await f.controller.startTask(p.id, requestId);
    const id = f.controller.run!.id;
    await f.controller.startTask(p.id, requestId);
    assert.equal(f.controller.run!.id, id);
    await assert.rejects(
      f.controller.updateChannels({ channels: { A: { target: 1 } } }),
      /上锁任务/,
    );
    assert.throws(
      () => f.controller.importWaveform(["0A0A0A0A01010101"]),
      /上锁任务/,
    );
    assert.throws(() => f.controller.updatePlan(p.id, p), /上锁任务/);
    await assert.rejects(f.controller.pause(), /上锁任务/);
    await assert.rejects(f.controller.stop(), /上锁任务/);
    await assert.rejects(f.controller.takeover(), /上锁任务/);
    await assert.rejects(
      f.controller.startAi(f.bounds(), randomUUID()),
      /上锁任务/,
    );
    await f.controller.feedback("阶段已完成", "locked-task");
    await f.controller.emergency();
    assert.equal(f.controller.isLocked(), false);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.cleanup();
  }
});

test("emergency awaits a pending start reset and permanently invalidates that start", async () => {
  const f = await fixture();
  const gate = deferred<boolean>();
  const stop = f.device.stop.bind(f.device);
  let calls = 0;
  f.device.stop = async () => {
    calls++;
    return gate.promise;
  };
  try {
    const starting = f.controller.startPlayback(f.playback(), randomUUID());
    const rejected = assert.rejects(starting, /取消/);
    await until(() => calls === 1);
    let finished = false;
    const emergency = f.controller.emergency().then(() => {
      finished = true;
    });
    await sleep(20);
    assert.equal(
      finished,
      false,
      "emergency must await physical stop confirmation",
    );
    assert.equal(f.controller.stopping, true);
    gate.resolve(true);
    await Promise.all([rejected, emergency]);
    assert.equal(calls, 1, "the same in-flight physical reset is shared");
    assert.equal(f.controller.stopping, false);
    assert.equal(f.controller.isActive(), false);
    f.device.stop = stop;
    await f.controller.startPlayback(f.playback(), randomUUID());
    assert.equal(
      f.controller.run!.status,
      "running",
      "cancelled start does not leave a permanent stopping flag",
    );
  } finally {
    gate.resolve(true);
    f.device.stop = stop;
    await f.cleanup();
  }
});

test("emergency during pause wins over the stale pause result", async () => {
  const f = await fixture();
  const gate = deferred<boolean>();
  const stop = f.device.stop.bind(f.device);
  try {
    await f.controller.startPlayback(f.playback(), randomUUID());
    f.device.stop = () => gate.promise;
    const pausing = f.controller.pause("manual");
    const emergency = f.controller.emergency();
    gate.resolve(true);
    await Promise.all([pausing, emergency]);
    assert.equal(f.controller.run!.status, "stopped");
    assert.match(f.controller.run!.reason!, /紧急停止/);
    assert.equal(f.controller.stopping, false);
    await assert.rejects(f.controller.resume(), /没有可恢复/);
  } finally {
    gate.resolve(true);
    f.device.stop = stop;
    await f.cleanup();
  }
});

test("emergency during connection blocks starts until cancelled connection cleanup finishes", async () => {
  const f = await fixture();
  const gate = deferred<void>();
  const connect = f.device.connect.bind(f.device);
  let entered = false;
  f.device.connect = async (options) => {
    entered = true;
    await gate.promise;
    await connect(options);
  };
  try {
    const connecting = f.controller.connect({ protocol: "simulator" });
    const rejected = assert.rejects(connecting, /取消/);
    await until(() => entered);
    let finished = false;
    const emergency = f.controller.emergency().then(() => {
      finished = true;
    });
    await sleep(20);
    assert.equal(finished, false);
    await assert.rejects(
      f.controller.startPlayback(f.playback(), randomUUID()),
      /先停止/,
    );
    gate.resolve();
    await Promise.all([rejected, emergency]);
    assert.equal(f.device.state.connected, false);
    assert.equal(f.controller.stopping, false);
    f.device.connect = connect;
    await f.controller.connect({ protocol: "simulator" });
    assert.equal(f.device.state.connected, true);
  } finally {
    gate.resolve();
    f.device.connect = connect;
    await f.cleanup();
  }
});

test("late AI responses cannot restore stopped output or a discarded range", async () => {
  const f = await fixture();
  const request = deferred<AiDecision>();
  try {
    f.decide(() => request.promise);
    await f.controller.startAi(f.bounds(), randomUUID());
    executeTick(f.controller);
    assert.equal(f.controller.run!.thinking, true);
    await f.controller.emergency();
    request.resolve({
      action: "adjust",
      channels: ["A"],
      waveformId: f.wave.id,
      intensity: { A: 9, B: 9 },
      durationSec: 5,
      reason: "late",
    });
    await sleep(120);
    assert.equal(f.controller.run!.status, "stopped");
    assert.equal(f.controller.run!.lastDecision, undefined);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.cleanup();
  }
});

test("feedback supersedes earlier AI results; confirmed range changes remain paused", async () => {
  const f = await fixture();
  const old = deferred<AiDecision>();
  const next = deferred<AiDecision>();
  let calls = 0;
  try {
    f.decide(() => (++calls === 1 ? old.promise : next.promise));
    await f.controller.startAi(f.bounds(), randomUUID());
    executeTick(f.controller);
    await f.controller.feedback("请减弱", "ai-control");
    executeTick(f.controller);
    assert.equal(
      calls,
      1,
      "replacement waits for the cancelled inference to settle",
    );
    old.resolve({
      action: "adjust",
      channels: ["A"],
      waveformId: f.wave.id,
      intensity: { A: 9, B: 9 },
      durationSec: 5,
      reason: "stale",
    });
    await until(() => calls === 2);
    assert.notEqual(f.controller.run!.lastDecision?.reason, "stale");
    next.resolve({
      action: "adjust",
      channels: ["A"],
      waveformId: f.wave.id,
      intensity: { A: 2, B: 2 },
      durationSec: 5,
      reason: "updated",
    });
    await until(() => f.controller.run?.lastDecision?.reason === "updated");
    await f.controller.changeBounds(
      f.bounds({ maxIntensity: { A: 3, B: 3 }, durationSec: 20 }),
    );
    assert.equal(f.controller.run!.status, "paused");
    assert.equal(f.controller.run!.boundsVersion, 2);
    assert.deepEqual(f.controller.run!.bounds!.maxIntensity, { A: 3, B: 3 });
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.cleanup();
  }
});

test("deadlines end paused and background runs without a browser", async () => {
  const f = await fixture();
  try {
    await f.controller.startPlayback(f.playback(), randomUUID());
    await f.controller.pause();
    f.controller.run!.deadlineAt = Date.now() - 1;
    executeTick(f.controller);
    await until(
      () => f.controller.run!.status === "completed" && !f.controller.stopping,
    );
    await f.controller.startPlayback(
      f.playback({ durationSec: 0.2 }),
      randomUUID(),
    );
    await until(
      () => f.controller.run!.status === "completed" && !f.controller.stopping,
    );
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.cleanup();
  }
});

test("random playback repeats a recorded seed and stays inside its authorized range", async () => {
  const f = await fixture();
  try {
    const config = f.playback({
      mode: "random",
      stages: [],
      random: {
        channels: ["A"],
        waveformIds: [f.wave.id],
        minIntensity: { A: 3, B: 3 },
        maxIntensity: { A: 6, B: 6 },
        minIntervalSec: 1,
        maxIntervalSec: 1,
        minDurationSec: 1,
        maxDurationSec: 1,
        randomWaveform: true,
        randomIntensity: true,
        randomDuration: true,
        seed: 12345,
      },
    });
    const sequence = async () => {
      await f.controller.startPlayback(config, randomUUID());
      const values: number[] = [];
      const internals = f.controller as unknown as {
        playbackDesired(now: number): {
          A: { target: number };
          B: { target: number };
        };
      };
      const start = Date.now();
      for (let i = 0; i < 8; i++) {
        const desired = internals.playbackDesired(start + i * 1001);
        assert.ok(desired.A.target >= 3 && desired.A.target <= 6);
        assert.equal(desired.B.target, 0);
        values.push(desired.A.target);
      }
      assert.equal(f.controller.run!.randomSeed, 12345);
      await f.controller.stop();
      return values;
    };
    assert.deepEqual(await sequence(), await sequence());
  } finally {
    await f.cleanup();
  }
});

test("task authorization rejects unapproved ramp, rest gaps and simultaneous channels", async () => {
  const f = await fixture();
  try {
    const noRamp = f.plan(f.bounds({ allowRamp: false }), [
      f.stage({ behavior: "ramp" }),
    ]);
    await assert.rejects(
      f.controller.startTask(noRamp.id, randomUUID()),
      /授权范围/,
    );
    const noRest = f.plan(f.bounds({ allowRest: false }), [
      f.stage({ gapSec: 1 }),
    ]);
    await assert.rejects(
      f.controller.startTask(noRest.id, randomUUID()),
      /授权范围/,
    );
    const noSync = f.plan(f.bounds({ channels: ["A", "B"] }), [
      f.stage({ channels: ["A", "B"] }),
    ]);
    await assert.rejects(
      f.controller.startTask(noSync.id, randomUUID()),
      /授权范围/,
    );
    assert.equal(f.controller.isActive(), false);
  } finally {
    await f.cleanup();
  }
});

test("unapproved AI actions fault the session and cannot send out-of-range output", async () => {
  const f = await fixture();
  try {
    f.decide(async () => ({
      action: "adjust",
      channels: ["A"],
      waveformId: f.wave.id,
      intensity: { A: 15, B: 15 },
      durationSec: 5,
      reason: "Unapproved target",
    }));
    await f.controller.startAi(f.bounds(), randomUUID());
    executeTick(f.controller);
    await until(
      () => f.controller.run!.status === "faulted" && !f.controller.stopping,
    );
    assert.match(f.controller.run!.reason!, /授权范围/);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.cleanup();
  }
});

test("an unavailable AI runtime immediately ends an active session between decision intervals", async () => {
  const f = await fixture();
  try {
    f.decide(async () => ({
      action: "adjust",
      channels: ["A"],
      waveformId: f.wave.id,
      intensity: { A: 4, B: 4 },
      durationSec: 10,
      reason: "Continue",
    }));
    await f.controller.startAi(f.bounds(), randomUUID());
    executeTick(f.controller);
    await until(() => f.device.state.intensities.A === 4);
    f.ai.status = { ready: false, error: "Fixture runtime disconnected" };
    executeTick(f.controller);
    await until(
      () => f.controller.run!.status === "faulted" && !f.controller.stopping,
    );
    assert.match(f.controller.run!.reason!, /runtime disconnected/);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.cleanup();
  }
});

test("a fresh task draft sees the current library and no ended-run authorization", async () => {
  const f = await fixture();
  try {
    const p = f.plan();
    await f.controller.startTask(p.id, randomUUID());
    await f.controller.emergency();
    const imported = f.controller.importWaveform(
      ["0C0C0C0C00000000"],
      "后来导入",
    );
    let context:
      | { run: unknown; bounds?: unknown; waveforms: { id: string }[] }
      | undefined;
    f.ai.draft = async (_profile, _prompt, input) => {
      context = input as typeof context;
      return p;
    };
    await f.controller.draftTask("新的独立任务");
    assert.equal(context!.run, null);
    assert.equal(context!.bounds, undefined);
    assert.ok(context!.waveforms.some((w) => w.id === imported.id));
  } finally {
    await f.cleanup();
  }
});

test("service restart marks persisted execution interrupted and never restarts output", async () => {
  const f = await fixture();
  try {
    await f.controller.startPlayback(f.playback(), randomUUID());
    const persisted = structuredClone(f.controller.run!);
    persisted.status = "running";
    await f.controller.close();
    f.store.set("runtime", "current", persisted);
    const other = new Controller(f.store, f.device, f.ai);
    try {
      assert.equal(other.run!.status, "interrupted");
      assert.equal(other.config.A.target, 0);
      assert.equal(other.config.B.target, 0);
      await sleep(150);
      assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    } finally {
      await other.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("programmed A20/B5 targets remain independent under 20/19 hardware and old sync state", async () => {
  const f = await fixture({ limits: { A: 20, B: 19 } });
  try {
    for (const mode of ["playlist", "stages"] as const) {
      await f.controller.updateChannels({ synced: true });
      await f.controller.startPlayback(
        f.playback({
          mode,
          stages: [
            f.stage({ channels: ["A", "B"], intensity: { A: 20, B: 5 } }),
          ],
        }),
        randomUUID(),
      );
      assert.equal(f.controller.synced, false);
      await until(
        () =>
          f.device.state.intensities.A === 20 &&
          f.device.state.intensities.B === 5,
      );
      assert.deepEqual(f.controller.run!.playback!.stages[0].intensity, {
        A: 20,
        B: 5,
      });
      await f.controller.stop();
      assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    }
  } finally {
    await f.cleanup();
  }
});

test("stage ramps interpolate each selected channel and ignore unselected draft ceilings", async () => {
  const f = await fixture({ limits: { A: 20, B: 19 } });
  try {
    await f.controller.startPlayback(
      f.playback({
        mode: "stages",
        stages: [
          f.stage({
            channels: ["A", "B"],
            behavior: "ramp",
            durationSec: 10,
            startIntensity: { A: 4, B: 1 },
            intensity: { A: 20, B: 5 },
          }),
        ],
      }),
      randomUUID(),
    );
    const internals = f.controller as unknown as {
      progressAt: number;
      playbackDesired(now: number): Record<Channel, { target: number }>;
    };
    const desired = internals.playbackDesired(internals.progressAt + 5000);
    assert.deepEqual(
      { A: desired.A.target, B: desired.B.target },
      { A: 12, B: 3 },
    );
    await f.controller.stop();
    await f.controller.startPlayback(
      f.playback({
        mode: "stages",
        stages: [
          f.stage({
            channels: ["A"],
            intensity: { A: 20, B: 200 },
            startIntensity: { A: 0, B: 200 },
          }),
        ],
      }),
      randomUUID(),
    );
    const single = internals.playbackDesired(Date.now());
    assert.equal(single.A.target, 20);
    assert.equal(single.B.target, 0);
  } finally {
    await f.cleanup();
  }
});

test("random generation independently samples and records both channel ranges", async () => {
  const f = await fixture({ limits: { A: 20, B: 19 } });
  try {
    const config = f.playback({
      mode: "random",
      stages: [],
      random: {
        channels: ["A", "B"],
        waveformIds: [f.wave.id],
        minIntensity: { A: 18, B: 1 },
        maxIntensity: { A: 20, B: 5 },
        minIntervalSec: 1,
        maxIntervalSec: 1,
        minDurationSec: 1,
        maxDurationSec: 1,
        randomWaveform: false,
        randomIntensity: true,
        randomDuration: false,
        seed: 5150,
      },
    });
    const sequence = async () => {
      await f.controller.updateChannels({ synced: true });
      await f.controller.startPlayback(config, randomUUID());
      const desired = f.controller as unknown as {
        playbackDesired(now: number): Record<Channel, { target: number }>;
      };
      const values = [];
      const start = Date.now();
      for (let index = 0; index < 16; index++) {
        const result = desired.playbackDesired(start + index * 1001);
        assert.ok(result.A.target >= 18 && result.A.target <= 20);
        assert.ok(result.B.target >= 1 && result.B.target <= 5);
        values.push([result.A.target, result.B.target]);
      }
      assert.ok(new Set(values.map(([a]) => a)).size > 1);
      assert.ok(new Set(values.map(([, b]) => b)).size > 1);
      assert.match(
        f.controller
          .snapshot()
          .logs.find((entry) => entry.source === "随机控制")!.message,
        /A 目标.*B 目标/,
      );
      await f.controller.stop();
      return values;
    };
    assert.deepEqual(await sequence(), await sequence());
  } finally {
    await f.cleanup();
  }
});

test("AI keeps independent bounds, targets and ramp rates on A/B", async () => {
  const f = await fixture({ authorize: false, limits: { A: 20, B: 19 } });
  try {
    assert.equal(f.controller.config.A.rampPerSecond, 2);
    assert.equal(f.controller.config.B.rampPerSecond, 2);
    f.decide(async () => ({
      action: "adjust",
      channels: ["A", "B"],
      waveformId: f.wave.id,
      intensity: { A: 20, B: 5 },
      durationSec: 10,
      reason: "独立强度与变化速率",
    }));
    await f.controller.startAi(
      f.bounds({
        channels: ["A", "B"],
        allowSync: true,
        minIntensity: { A: 10, B: 1 },
        maxIntensity: { A: 20, B: 5 },
        rampPerSecond: { A: 20, B: 2 },
      }),
      randomUUID(),
    );
    executeTick(f.controller);
    await until(() => Boolean(f.controller.run!.lastDecision));
    const internals = f.controller as unknown as {
      tickAt: number;
      levels: Record<Channel, number>;
    };
    internals.levels = { A: 0, B: 0 };
    internals.tickAt = Date.now() - 500;
    executeTick(f.controller);
    assert.deepEqual(internals.levels, { A: 10, B: 1 });
    await until(
      () =>
        f.device.state.intensities.A === 20 &&
        f.device.state.intensities.B === 5,
      4000,
    );
    assert.deepEqual(f.controller.run!.lastDecision!.intensity, {
      A: 20,
      B: 5,
    });
    await f.controller.pause("ai-control");
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.cleanup();
  }
});

test("each AI channel authorization rejects an out-of-range decision and zeroes both", async () => {
  const f = await fixture({ limits: { A: 20, B: 19 } });
  try {
    for (const intensity of [
      { A: 21, B: 5 },
      { A: 20, B: 6 },
      { A: 9, B: 5 },
      { A: 20, B: 0 },
    ]) {
      f.decide(async () => ({
        action: "adjust",
        channels: ["A", "B"],
        waveformId: f.wave.id,
        intensity,
        durationSec: 5,
        reason: "反例校验",
      }));
      await f.controller.startAi(
        f.bounds({
          channels: ["A", "B"],
          allowSync: true,
          minIntensity: { A: 10, B: 1 },
          maxIntensity: { A: 20, B: 5 },
        }),
        randomUUID(),
      );
      executeTick(f.controller);
      await until(
        () => f.controller.run!.status === "faulted" && !f.controller.stopping,
      );
      assert.match(f.controller.run!.reason!, /授权范围/);
      assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    }
  } finally {
    await f.cleanup();
  }
});

test("locked task freezes independent maps and enforces each channel stage boundary", async () => {
  const f = await fixture({ limits: { A: 20, B: 19 } });
  const pending = deferred<AiDecision>();
  try {
    f.decide(() => pending.promise);
    const bounds = f.bounds({
      channels: ["A", "B"],
      allowSync: true,
      maxIntensity: { A: 20, B: 5 },
      rampPerSecond: { A: 20, B: 3 },
    });
    const plan = f.plan(bounds, [
      f.stage({ channels: ["A", "B"], intensity: { A: 20, B: 5 } }),
    ]);
    await f.controller.startTask(plan.id, randomUUID());
    plan.bounds.maxIntensity.B = 19;
    plan.stages[0].intensity.B = 19;
    f.store.set("plans", plan.id, plan);
    assert.deepEqual(f.controller.run!.bounds!.maxIntensity, { A: 20, B: 5 });
    assert.deepEqual(f.controller.run!.plan!.stages[0].intensity, {
      A: 20,
      B: 5,
    });
    await until(
      () =>
        f.device.state.intensities.A === 20 &&
        f.device.state.intensities.B === 5,
    );
    await assert.rejects(f.controller.changeBounds(bounds), /上锁任务/);
    await f.controller.emergency();
    bounds.maxIntensity.B = 5;
    const invalid = f.plan(bounds, [
      f.stage({ channels: ["A", "B"], intensity: { A: 20, B: 6 } }),
    ]);
    await assert.rejects(
      f.controller.startTask(invalid.id, randomUUID()),
      /B 通道阶段强度超过上限/,
    );
  } finally {
    await f.cleanup();
  }
});

for (const owner of ["ai-control", "locked-task"] as const) {
  test(`${owner}: a transient timeout zeroes output, retries once, and keeps original authorization`, async () => {
    const f = await fixture();
    let calls = 0;
    const pending = deferred<AiDecision>();
    try {
      f.decide(async () => {
        if (++calls === 1)
          throw new AiServiceError("AI_TIMEOUT", "Fixture timeout");
        return pending.promise;
      });
      if (owner === "ai-control")
        await f.controller.startAi(f.bounds(), randomUUID());
      else await f.controller.startTask(f.plan().id, randomUUID());
      const deadline = f.controller.run!.deadlineAt;
      executeTick(f.controller);
      await until(
        () =>
          Boolean(f.controller.run!.inferenceRecovery) &&
          !f.controller.stopping,
      );
      assert.equal(f.controller.run!.status, "running");
      assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
      executeTick(f.controller);
      await flush();
      assert.equal(
        calls,
        1,
        "the backoff cannot be bypassed by scheduler ticks",
      );
      await f.controller.feedback("新偏好", owner);
      executeTick(f.controller);
      await flush();
      assert.equal(
        calls,
        1,
        "feedback cannot reset the recovery delay or retry budget",
      );
      retryNow(f.controller);
      await until(() => calls === 2);
      executeTick(f.controller);
      assert.deepEqual(
        f.device.state.intensities,
        { A: 0, B: 0 },
        "locked stage fallback must stay zero during retry",
      );
      pending.resolve({
        action: "adjust",
        channels: ["A"],
        waveformId: f.wave.id,
        intensity: { A: 3, B: 0 },
        durationSec: 5,
        reason: "Recovered",
      });
      await until(() => f.controller.run!.lastDecision?.reason === "Recovered");
      assert.equal(f.controller.run!.inferenceRecovery, undefined);
      assert.equal(f.controller.run!.deadlineAt, deadline);
      assert.equal(f.controller.run!.boundsVersion, 1);
      if (owner === "locked-task") assert.equal(f.controller.isLocked(), true);
    } finally {
      await f.cleanup();
    }
  });

  test(`${owner}: persistent transient failures exhaust one retry and never restart`, async () => {
    const f = await fixture();
    let calls = 0;
    try {
      f.decide(async () => {
        calls++;
        throw new AiServiceError(
          "AI_PROVIDER_UNAVAILABLE",
          "Fixture unavailable",
        );
      });
      if (owner === "ai-control")
        await f.controller.startAi(f.bounds(), randomUUID());
      else await f.controller.startTask(f.plan().id, randomUUID());
      executeTick(f.controller);
      await until(
        () =>
          Boolean(f.controller.run!.inferenceRecovery) &&
          !f.controller.stopping,
      );
      retryNow(f.controller);
      await until(
        () => f.controller.run!.status === "faulted" && !f.controller.stopping,
      );
      assert.equal(calls, 2);
      assert.equal(f.controller.run!.termination?.source, "ai-inference");
      assert.equal(
        f.controller.run!.termination?.code,
        "AI_PROVIDER_UNAVAILABLE",
      );
      assert.equal(f.controller.run!.inferenceRecovery, undefined);
      executeTick(f.controller);
      await flush();
      assert.equal(calls, 2);
      assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    } finally {
      await f.cleanup();
    }
  });

  test(`${owner}: controlled 50 minute run keeps distinct channel limits and hard deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = await fixture({ limits: { A: 20, B: 19 } });
    let calls = 0;
    try {
      clearInterval(
        (f.controller as unknown as { timer: ReturnType<typeof setInterval> })
          .timer,
      );
      const bounds = f.bounds({
        channels: ["A", "B"],
        allowSync: true,
        durationSec: 3600,
        decisionIntervalSec: 5,
        maxIntensity: { A: 20, B: 5 },
        rampPerSecond: { A: 20, B: 3 },
      });
      f.decide(async () => {
        calls++;
        return {
          action: "adjust",
          channels: ["A", "B"],
          waveformId: f.wave.id,
          intensity: { A: 12, B: 3 },
          durationSec: 10,
          reason: "Continue safely",
        };
      });
      if (owner === "ai-control")
        await f.controller.startAi(bounds, randomUUID());
      else
        await f.controller.startTask(
          f.plan(bounds, [
            f.stage({
              durationSec: 1800,
              channels: ["A", "B"],
              intensity: { A: 12, B: 3 },
            }),
            f.stage({
              durationSec: 1800,
              channels: ["A", "B"],
              intensity: { A: 12, B: 3 },
            }),
          ]).id,
          randomUUID(),
        );
      const deadline = f.controller.run!.deadlineAt;
      for (let index = 0; index < 300; index++) {
        t.mock.timers.tick(10_000);
        f.device.state.lastSeenAt = Date.now();
        executeTick(f.controller);
        await flush();
        assert.equal(f.controller.run!.status, "running");
        assert.equal(f.controller.run!.deadlineAt, deadline);
        assert.ok(
          f.device.state.intensities.A <= 20 &&
            f.device.state.intensities.B <= 5,
        );
      }
      assert.ok(calls >= 250);
      if (owner === "locked-task")
        assert.equal(f.controller.run!.stageIndex, 1);
      t.mock.timers.tick(600_000);
      f.device.state.lastSeenAt = Date.now();
      executeTick(f.controller);
      await flush();
      assert.equal(f.controller.run!.status, "completed");
      assert.equal(f.controller.run!.termination?.source, "deadline");
      assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    } finally {
      await f.cleanup();
      t.mock.timers.reset();
    }
  });
}

test("recovery cannot bypass an unconfirmed stop, an emergency or the original deadline", async () => {
  for (const scenario of [
    "unconfirmed",
    "stop-error",
    "emergency",
    "deadline",
  ] as const) {
    const f = await fixture();
    const originalStop = f.device.stop.bind(f.device);
    let calls = 0;
    let stopCalls = 0;
    try {
      f.decide(async () => {
        calls++;
        throw new AiServiceError("AI_TIMEOUT", "Fixture timeout");
      });
      await f.controller.startAi(f.bounds(), randomUUID());
      if (scenario === "unconfirmed" || scenario === "stop-error")
        f.device.stop = async () => {
          stopCalls++;
          if (scenario === "stop-error") throw new Error("Fixture stop failed");
          return false;
        };
      executeTick(f.controller);
      await until(
        () =>
          !f.controller.stopping &&
          Boolean(
            f.controller.run!.inferenceRecovery ||
            f.controller.run!.termination,
          ),
      );
      if (scenario === "unconfirmed" || scenario === "stop-error") {
        assert.equal(f.controller.run!.termination?.source, "stop-unconfirmed");
        assert.equal(f.controller.stopUnconfirmed, true);
        assert.equal(
          stopCalls,
          1,
          "a failed physical stop must not be silently retried",
        );
      } else if (scenario === "emergency") {
        await f.controller.emergency();
        assert.equal(f.controller.run!.termination?.source, "emergency");
      } else {
        f.controller.run!.deadlineAt = Date.now() - 1;
        executeTick(f.controller);
        await flush();
        assert.equal(f.controller.run!.termination?.source, "deadline");
        assert.equal(f.controller.run!.status, "completed");
      }
      executeTick(f.controller);
      await flush();
      assert.equal(calls, 1);
    } finally {
      f.device.stop = originalStop;
      await f.cleanup();
    }
  }
});

test("model finish, explicit phase completion, device stale and disconnect have separate sources", async () => {
  const f = await fixture();
  try {
    f.decide(async () => ({
      action: "finish",
      channels: [],
      waveformId: "",
      intensity: { A: 0, B: 0 },
      durationSec: 1,
      reason: "Model considers task complete",
    }));
    await f.controller.startAi(f.bounds(), randomUUID());
    executeTick(f.controller);
    await until(
      () => f.controller.run!.status === "completed" && !f.controller.stopping,
    );
    assert.equal(f.controller.run!.termination?.source, "ai-finish");
    f.decide(async () => ({
      action: "rest",
      channels: [],
      waveformId: "",
      intensity: { A: 0, B: 0 },
      durationSec: 1,
      reason: "Explicit phase completion",
      phaseComplete: true,
    }));
    await f.controller.startTask(f.plan().id, randomUUID());
    executeTick(f.controller);
    await until(
      () => f.controller.run!.status === "completed" && !f.controller.stopping,
    );
    assert.equal(f.controller.run!.termination?.source, "stages-completed");
    for (const disconnected of [false, true]) {
      await f.controller.startAi(f.bounds(), randomUUID());
      if (disconnected) f.device.state.connected = false;
      else f.device.state.lastSeenAt = Date.now() - 7000;
      executeTick(f.controller);
      await until(
        () => f.controller.run!.status === "faulted" && !f.controller.stopping,
      );
      // The simulator can only confirm zero while connected; a real disconnection
      // may therefore replace the trigger source with stop-unconfirmed.
      assert.equal(
        f.controller.run!.termination?.source,
        disconnected ? "stop-unconfirmed" : "device-stale",
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("the hard deadline marks completion while recovery still awaits physical zero confirmation", async () => {
  const f = await fixture();
  const stopped = deferred<boolean>();
  try {
    await f.controller.startAi(f.bounds(), randomUUID());
    f.decide(async () => {
      throw new AiServiceError("AI_TIMEOUT", "Fixture timeout");
    });
    const originalStop = f.device.stop.bind(f.device);
    f.device.stop = () => stopped.promise;
    executeTick(f.controller);
    await until(
      () =>
        Boolean(f.controller.run!.inferenceRecovery) && f.controller.stopping,
    );
    f.controller.run!.deadlineAt = Date.now() - 1;
    executeTick(f.controller);
    assert.equal(f.controller.run!.status, "completed");
    assert.equal(f.controller.run!.termination?.source, "deadline");
    assert.equal(
      f.controller.stopping,
      true,
      "completion must not imply that physical zero was acknowledged",
    );
    stopped.resolve(await originalStop());
    await until(() => !f.controller.stopping);
    assert.equal(f.controller.run!.inferenceRecovery, undefined);
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    stopped.resolve(false);
    await f.cleanup();
  }
});

test("frequent feedback cancels serially and only the latest decision can become effective", async () => {
  const f = await fixture();
  let calls = 0,
    inFlight = 0,
    maximum = 0;
  let complete: (decision: AiDecision) => void = () => undefined;
  let latestContext: { run: { feedback: { text: string }[] } } | undefined;
  f.ai.decide = (_profile, context, signal) =>
    new Promise((resolve, reject) => {
      calls++;
      maximum = Math.max(maximum, ++inFlight);
      latestContext = context as typeof latestContext;
      complete = (decision) => {
        inFlight--;
        resolve(decision);
      };
      signal!.addEventListener(
        "abort",
        () => {
          inFlight--;
          reject(
            new AiServiceError("AI_CANCELLED", "Cancelled by newer feedback"),
          );
        },
        { once: true },
      );
    });
  try {
    await f.controller.startAi(f.bounds(), randomUUID());
    executeTick(f.controller);
    for (let round = 0; round < 10; round++) {
      for (let update = 0; update < 3; update++) {
        await f.controller.feedback(
          `feedback-${round}-${update}`,
          "ai-control",
        );
        executeTick(f.controller);
      }
      await flush();
      executeTick(f.controller);
      await flush();
      assert.equal(f.controller.run!.status, "running");
      assert.equal(
        latestContext!.run.feedback.at(-1)!.text,
        `feedback-${round}-2`,
      );
    }
    assert.equal(maximum, 1);
    assert.equal(calls, 11);
    complete({
      action: "adjust",
      channels: ["A"],
      waveformId: f.wave.id,
      intensity: { A: 2, B: 0 },
      durationSec: 5,
      reason: "Latest feedback applied",
    });
    await flush();
    assert.equal(
      f.controller.run!.lastDecision!.reason,
      "Latest feedback applied",
    );
    assert.equal(f.controller.run!.termination, undefined);
  } finally {
    await f.cleanup();
  }
});

test("strict complete maps reject malformed input while old scalar records migrate atomically", async () => {
  const f = await fixture();
  try {
    const bounds = f.bounds();
    for (const invalid of [
      { A: 3 },
      { B: 3 },
      { A: 3, B: undefined },
      { A: 3, B: NaN },
      { A: 3, B: Infinity },
      { A: 3, B: -1 },
      { A: 3, B: 201 },
      { A: 3, B: 3, C: 0 },
    ]) {
      assert.throws(() => parseBounds({ ...bounds, maxIntensity: invalid }));
      assert.throws(() =>
        parsePlayback(
          f.playback({
            stages: [{ ...f.stage(), intensity: invalid } as Stage],
          }),
        ),
      );
    }
    const legacyBounds = {
      ...bounds,
      minIntensity: 1,
      maxIntensity: 10,
      rampPerSecond: 3,
    };
    const normalized = parseBounds(legacyBounds);
    assert.deepEqual(normalized.minIntensity, { A: 1, B: 1 });
    assert.deepEqual(normalized.maxIntensity, { A: 10, B: 10 });
    assert.deepEqual(normalized.rampPerSecond, { A: 3, B: 3 });
    const legacyStage = { ...f.stage(), intensity: 4, startIntensity: 2 };
    const legacyPlayback = { ...f.playback(), stages: [legacyStage] };
    const plan = { ...f.plan(), bounds: legacyBounds, stages: [legacyStage] };
    assert.deepEqual(parsePlan(plan).stages[0].intensity, { A: 4, B: 4 });
    f.store.set("plans", plan.id, plan);
    f.store.set("presets", "scalar", {
      id: "scalar",
      name: "旧预设",
      config: legacyPlayback,
    });
    const storedRun = {
      ...f.controller.run,
      id: "legacy-run",
      owner: "manual",
      status: "running",
      mode: "stages",
      bounds: legacyBounds,
      playback: legacyPlayback,
      waveformSnapshots: {},
      feedback: [],
      startedAt: Date.now(),
      deadlineAt: Date.now() + 60000,
      boundsVersion: 1,
      stageIndex: 0,
      stageStartedAt: Date.now(),
      elapsedMs: 0,
      thinking: false,
    };
    await f.controller.close();
    f.store.set("runtime", "current", storedRun);
    const other = new Controller(f.store, f.device, f.ai);
    try {
      assert.deepEqual(other.snapshot().plans[0].bounds.maxIntensity, {
        A: 10,
        B: 10,
      });
      assert.deepEqual(
        other.snapshot().presets[0].config.stages[0].startIntensity,
        { A: 2, B: 2 },
      );
      assert.equal(other.run!.status, "interrupted");
      assert.deepEqual(other.run!.playback!.stages[0].intensity, {
        A: 4,
        B: 4,
      });
      assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
      await other.startTask(plan.id, randomUUID());
      assert.deepEqual(other.run!.plan!.bounds.rampPerSecond, { A: 3, B: 3 });
      assert.deepEqual(other.run!.plan!.stages[0].intensity, { A: 4, B: 4 });
    } finally {
      await other.close();
    }
  } finally {
    await f.cleanup();
  }
});

for (const owner of ["ai-control", "locked-task"] as const) {
  for (const command of ["intensity", "frames"] as const) {
    test(`${owner}: recovery stop discards a late ${command} rejection without faulting the run`, async () => {
      const f = await fixture();
      let calls = 0;
      let rejectCommand: ((error: Error) => void) | undefined;
      let commands = 0;
      try {
        clearInterval(
          (f.controller as unknown as { timer: ReturnType<typeof setInterval> })
            .timer,
        );
        f.decide(async () => {
          if (++calls === 2)
            throw new AiServiceError("AI_TIMEOUT", "Fixture timeout");
          return {
            action: "adjust",
            channels: ["A"],
            waveformId: f.wave.id,
            intensity: { A: 3, B: 0 },
            durationSec: 10,
            reason: "Continue",
          };
        });
        if (owner === "ai-control")
          await f.controller.startAi(f.bounds(), randomUUID());
        else await f.controller.startTask(f.plan().id, randomUUID());
        executeTick(f.controller);
        await flush();
        const pendingCommand = async () => {
          commands++;
          return new Promise<void>((_, reject) => {
            rejectCommand = reject;
          });
        };
        if (command === "intensity") f.device.setIntensity = pendingCommand;
        else f.device.sendFrames = pendingCommand;
        const nativeStop = f.device.stop.bind(f.device);
        f.device.stop = async () => {
          const confirmed = await nativeStop();
          rejectCommand?.(new Error("动作已被停止操作废弃"));
          return confirmed;
        };
        // Schedule a model timeout while the old tick has a command in flight.
        // The stop invalidates that command, just as the real driver epoch does.
        const runtime = f.controller as unknown as {
          nextAiAt: number;
          nextPulse: { A: number; B: number };
          tickAt: number;
        };
        runtime.nextAiAt = 0;
        runtime.nextPulse = { A: 0, B: 0 };
        runtime.tickAt = Date.now() - 500;
        f.device.state.intensities.A = 0;
        executeTick(f.controller);
        await flush();
        assert.ok(
          commands >= 1,
          "the test must have an actual pending output command",
        );
        assert.equal(calls, 2);
        assert.equal(f.controller.run!.status, "running");
        assert.equal(f.controller.run!.termination, undefined);
        assert.equal(f.controller.run!.inferenceRecovery?.code, "AI_TIMEOUT");
        assert.equal(f.controller.stopping, false);
        assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
      } finally {
        rejectCommand?.(new Error("Fixture cleanup"));
        await f.cleanup();
      }
    });
  }
}
