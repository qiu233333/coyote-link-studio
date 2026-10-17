import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppSnapshot,
  Channel,
  ControlBounds,
  PlaybackConfig,
  TaskPlan,
} from "../shared/types.js";
import {
  effectiveChannelLimit,
  playbackChannelsLimit,
  playbackConfigIssue,
  controlBoundsIssue,
  taskPlanIssue,
} from "../src/playbackLimits.js";

function state(): AppSnapshot {
  return {
    device: {
      protocol: "simulator",
      relayStatus: "connected",
      appStatus: "paired",
      connected: true,
      name: "20/19 fixture",
      devices: [],
      intensities: { A: 0, B: 0 },
      limits: { A: 20, B: 19 },
      lastSeenAt: Date.now(),
      canConfirmZero: true,
    },
    channels: {
      A: {
        enabled: true,
        limit: 0,
        rampPerSecond: 2,
        target: 0,
        waveformId: "wave",
      },
      B: {
        enabled: true,
        limit: 0,
        rampPerSecond: 2,
        target: 0,
        waveformId: "wave",
      },
    },
    synced: false,
    owner: "manual",
    run: null,
    locked: false,
    stopUnconfirmed: false,
    stopping: false,
    waveforms: [
      {
        id: "wave",
        name: "测试",
        frames: ["0A0A0A0A32323232"],
        hash: "wave",
        builtin: true,
        favorite: false,
        lastUsedAt: 0,
        durationMs: 100,
      },
    ],
    logs: [],
    history: [],
    plans: [],
    presets: [],
    aiRuntime: { ready: false },
    settings: {
      baseUrl: "",
      model: "",
      apiKeySet: false,
      contextWindow: 8192,
      timeoutSec: 30,
    },
  };
}

function playback(
  selected: Channel[] = ["A", "B"],
  intensity = 5,
): PlaybackConfig {
  return {
    mode: "single",
    repeat: 0,
    shuffle: false,
    durationSec: 30,
    singleTargets: Object.fromEntries(selected.map((c) => [c, intensity])),
    stages: [
      {
        id: "stage",
        name: "测试阶段",
        channels: selected,
        waveformId: "wave",
        intensity: { A: intensity, B: intensity },
        startIntensity: { A: 0, B: 0 },
        durationSec: 30,
        gapSec: 0,
        behavior: "hold",
      },
    ],
  };
}

test("强度上限直接读取设备 A20/B19，旧用户上限 0 不再阻止配置", () => {
  const snapshot = state();
  const before = structuredClone(snapshot.channels);
  assert.equal(effectiveChannelLimit(snapshot, "A"), 20);
  assert.equal(effectiveChannelLimit(snapshot, "B"), 19);
  assert.deepEqual(playbackChannelsLimit(snapshot, ["A", "B"]).limits, {
    A: 20,
    B: 19,
  });
  assert.equal(playbackConfigIssue(snapshot, playback()), null);
  assert.deepEqual(snapshot.channels, before);

  snapshot.channels.A.limit = 12;
  assert.equal(playbackConfigIssue(snapshot, playback(["A"])), null);
  assert.equal(playbackConfigIssue(snapshot, playback()), null);
  snapshot.channels.B.limit = 19;
  assert.deepEqual(playbackChannelsLimit(snapshot, ["A", "B"]).limits, {
    A: 20,
    B: 19,
  });
  assert.equal(playbackConfigIssue(snapshot, playback()), null);
});

test("所选通道分别受 20/19 限制，旧同步设置不再阻止独立编排", () => {
  const snapshot = state();
  snapshot.channels.A.limit = 20;
  snapshot.channels.B.limit = 19;
  assert.equal(playbackChannelsLimit(snapshot, ["A"]).limits.A, 20);
  assert.equal(playbackChannelsLimit(snapshot, ["B"]).limits.B, 19);
  assert.deepEqual(playbackChannelsLimit(snapshot, ["A", "B"]).limits, {
    A: 20,
    B: 19,
  });
  assert.equal(playbackConfigIssue(snapshot, playback(["A"], 20)), null);
  assert.match(
    playbackConfigIssue(snapshot, playback(["A", "B"], 20))!,
    /强度上限 19/,
  );
  const independent = playback();
  independent.singleTargets = { A: 20, B: 19 };
  assert.equal(playbackConfigIssue(snapshot, independent), null);

  snapshot.synced = true;
  assert.equal(effectiveChannelLimit(snapshot, "A"), 20);
  assert.equal(effectiveChannelLimit(snapshot, "B"), 19);
  assert.equal(playbackConfigIssue(snapshot, playback(["A"], 1)), null);
  assert.equal(playbackConfigIssue(snapshot, independent), null);
  assert.equal(playbackConfigIssue(snapshot, playback(["A", "B"], 19)), null);
  snapshot.channels.B.enabled = false;
  assert.equal(effectiveChannelLimit(snapshot, "A"), 20);
  assert.match(playbackConfigIssue(snapshot, playback())!, /B 通道未启用/);
  snapshot.synced = false;
  assert.equal(playbackConfigIssue(snapshot, playback(["A"])), null);
});

test("已打开的方案在设备上限下降后失效，各模式都保留草稿并解释限制", () => {
  const snapshot = state();
  snapshot.channels.A.limit = 20;
  snapshot.channels.B.limit = 19;
  const single = playback(["A", "B"], 15);
  const sequence = { ...playback(["A", "B"], 15), mode: "stages" as const };
  const random: PlaybackConfig = {
    ...playback(),
    mode: "random",
    stages: [],
    random: {
      channels: ["A", "B"],
      waveformIds: ["wave"],
      minIntensity: { A: 0, B: 0 },
      maxIntensity: { A: 15, B: 15 },
      minIntervalSec: 5,
      maxIntervalSec: 10,
      minDurationSec: 1,
      maxDurationSec: 5,
      randomWaveform: true,
      randomIntensity: true,
      randomDuration: true,
    },
  };
  for (const config of [single, sequence, random]) {
    const before = structuredClone(config);
    assert.equal(playbackConfigIssue(snapshot, config), null);
    snapshot.device.limits.B = 9;
    assert.match(playbackConfigIssue(snapshot, config)!, /强度上限 9/);
    assert.deepEqual(config, before);
    assert.equal(snapshot.channels.B.limit, 19);
    snapshot.device.limits.B = 19;
  }
});

test("列表与渐变阶段接受 A20/B19，越界只报告对应通道且不修改草稿", () => {
  const snapshot = state();
  for (const mode of ["playlist", "stages"] as const) {
    const config = { ...playback(), mode };
    const stage = config.stages[0];
    stage.intensity = { A: 20, B: 19 };
    stage.startIntensity = { A: 2, B: 7 };
    stage.behavior = "ramp";
    const before = structuredClone(config);
    assert.equal(playbackConfigIssue(snapshot, config), null);
    assert.deepEqual(config, before);
    stage.intensity.B = 20;
    assert.match(playbackConfigIssue(snapshot, config)!, /B 通道.*强度上限 19/);
    stage.channels = ["A"];
    assert.equal(playbackConfigIssue(snapshot, config), null);
    stage.startIntensity.A = 21;
    assert.match(playbackConfigIssue(snapshot, config)!, /A 通道.*强度上限 20/);
  }
});

test("随机范围按选中通道单独预检，A 的20不受 B 的19限制", () => {
  const snapshot = state();
  const config: PlaybackConfig = {
    ...playback(),
    mode: "random",
    stages: [],
    random: {
      channels: ["A", "B"],
      waveformIds: ["wave"],
      minIntensity: { A: 10, B: 2 },
      maxIntensity: { A: 20, B: 19 },
      minIntervalSec: 1,
      maxIntervalSec: 2,
      minDurationSec: 1,
      maxDurationSec: 2,
      randomWaveform: true,
      randomIntensity: true,
      randomDuration: true,
    },
  };
  assert.equal(playbackConfigIssue(snapshot, config), null);
  config.random!.maxIntensity.B = 20;
  assert.match(playbackConfigIssue(snapshot, config)!, /B 通道.*强度上限 19/);
  config.random!.channels = ["A"];
  assert.equal(playbackConfigIssue(snapshot, config), null);
  config.random!.minIntensity.A = 21;
  assert.match(
    playbackConfigIssue(snapshot, config)!,
    /A 通道随机强度上限不能小于下限/,
  );
});

function bounds(): ControlBounds {
  return {
    channels: ["A", "B"],
    waveformIds: ["wave"],
    minIntensity: { A: 2, B: 4 },
    maxIntensity: { A: 20, B: 19 },
    rampPerSecond: { A: 2, B: 6 },
    allowSync: true,
    allowRamp: true,
    allowRandom: true,
    allowRest: true,
    maxActionSec: 15,
    durationSec: 120,
    decisionIntervalSec: 15,
    preference: "fixture",
  };
}

test("AI 范围逐通道校验并保留未选通道草稿", () => {
  const snapshot = state();
  const config = bounds();
  assert.equal(controlBoundsIssue(snapshot, config), null);
  config.maxIntensity.B = 20;
  assert.match(controlBoundsIssue(snapshot, config)!, /B 通道.*强度上限 19/);
  config.channels = ["A"];
  assert.equal(controlBoundsIssue(snapshot, config), null);
  config.rampPerSecond.A = 0;
  assert.match(controlBoundsIssue(snapshot, config)!, /A 通道变化速率/);
  config.rampPerSecond.A = 2;
  config.minIntensity.A = 21;
  assert.match(controlBoundsIssue(snapshot, config)!, /A 通道强度范围/);
});

test("任务草稿逐通道验证目标和渐变起点，确认不接受越界值", () => {
  const snapshot = state();
  const plan: TaskPlan = {
    id: "plan",
    version: 1,
    title: "fixture",
    description: "fixture",
    completionCriteria: "time",
    createdAt: 0,
    bounds: bounds(),
    stages: playback().stages,
  };
  plan.stages[0].intensity = { A: 20, B: 19 };
  assert.equal(taskPlanIssue(snapshot, plan), null);
  plan.stages[0].behavior = "ramp";
  plan.stages[0].startIntensity = { A: 2, B: 3 };
  assert.match(taskPlanIssue(snapshot, plan)!, /B 通道强度超出授权范围 4–19/);
  plan.stages[0].startIntensity.B = 4;
  assert.equal(taskPlanIssue(snapshot, plan), null);
  plan.bounds.channels = ["A"];
  plan.stages[0].channels = ["A"];
  plan.stages[0].intensity.B = 200;
  assert.equal(taskPlanIssue(snapshot, plan), null);
});

test("未选通道保留合法草稿，播放预检只额外拒绝全局非法强度格式", () => {
  const snapshot = state();
  const config = { ...playback(["A"]), mode: "stages" as const };
  const stage = config.stages[0];
  stage.intensity.B = 200;
  stage.startIntensity.B = 199;
  assert.equal(playbackConfigIssue(snapshot, config), null);
  for (const invalid of [-1, 201, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    stage.intensity.B = invalid;
    assert.match(
      playbackConfigIssue(snapshot, config)!,
      /B 通道强度须为 0–200 的整数/,
    );
  }
  stage.intensity.B = 200;
  stage.startIntensity.B = -1;
  assert.match(playbackConfigIssue(snapshot, config)!, /起始强度.*B 通道/);
});

test("随机未选通道反向范围不阻挡，但非法数值在提交前指出通道", () => {
  const snapshot = state();
  const config: PlaybackConfig = {
    ...playback(),
    mode: "random",
    stages: [],
    random: {
      channels: ["A"],
      waveformIds: ["wave"],
      minIntensity: { A: 2, B: 200 },
      maxIntensity: { A: 20, B: 100 },
      minIntervalSec: 1,
      maxIntervalSec: 2,
      minDurationSec: 1,
      maxDurationSec: 2,
      randomWaveform: true,
      randomIntensity: true,
      randomDuration: true,
    },
  };
  assert.equal(playbackConfigIssue(snapshot, config), null);
  config.random!.minIntensity.B = 201;
  assert.match(
    playbackConfigIssue(snapshot, config)!,
    /随机最低强度.*B 通道强度须为/,
  );
  config.random!.minIntensity.B = 200;
  config.random!.maxIntensity.B = 1.5;
  assert.match(
    playbackConfigIssue(snapshot, config)!,
    /随机最高强度.*B 通道强度须为/,
  );
});

test("AI 及任务预检全局数据格式，未选通道设备上限及反向范围仍保留", () => {
  const snapshot = state();
  const config = bounds();
  config.channels = ["A"];
  config.minIntensity.B = 200;
  config.maxIntensity.B = 100;
  assert.equal(controlBoundsIssue(snapshot, config), null);
  for (const invalid of [0, 21, Number.NaN, Number.NEGATIVE_INFINITY]) {
    config.rampPerSecond.B = invalid;
    assert.match(
      controlBoundsIssue(snapshot, config)!,
      /B 通道变化速率须在 0.1–20/,
    );
  }
  config.rampPerSecond.B = 0.1;
  const plan: TaskPlan = {
    id: "plan",
    version: 1,
    title: "fixture",
    description: "fixture",
    completionCriteria: "time",
    createdAt: 0,
    bounds: config,
    stages: playback(["A"]).stages,
  };
  plan.stages[0].intensity.B = 200;
  assert.equal(taskPlanIssue(snapshot, plan), null);
  plan.stages[0].startIntensity.B = 201;
  assert.match(taskPlanIssue(snapshot, plan)!, /起始强度.*B 通道强度须为/);
  plan.stages[0].startIntensity.B = 0;
  plan.bounds.maxIntensity.B = 201;
  assert.match(taskPlanIssue(snapshot, plan)!, /AI 最高强度.*B 通道强度须为/);
});

test("播放器明确说明失联、停止未确认、运行和锁定阻止启动", () => {
  const snapshot = state();
  snapshot.channels.A.limit = snapshot.channels.B.limit = 10;
  snapshot.device.connected = false;
  assert.match(playbackConfigIssue(snapshot, playback())!, /连接/);
  snapshot.device.connected = true;
  snapshot.device.lastSeenAt = Date.now() - 7000;
  assert.match(playbackConfigIssue(snapshot, playback())!, /已过期/);
  snapshot.device.lastSeenAt = Date.now();
  snapshot.stopUnconfirmed = true;
  assert.match(playbackConfigIssue(snapshot, playback())!, /停止尚未确认/);
  snapshot.stopUnconfirmed = false;
  snapshot.stopping = true;
  assert.match(playbackConfigIssue(snapshot, playback())!, /正在停止/);
  snapshot.stopping = false;
  snapshot.run = {
    id: "run",
    owner: "manual",
    status: "paused",
    mode: "single",
    startedAt: 0,
    deadlineAt: Date.now() + 10000,
    boundsVersion: 1,
    stageIndex: 0,
    stageStartedAt: 0,
    elapsedMs: 0,
    waveformSnapshots: {},
    feedback: [],
    thinking: false,
  };
  assert.match(playbackConfigIssue(snapshot, playback())!, /先停止/);
  snapshot.locked = true;
  assert.match(playbackConfigIssue(snapshot, playback())!, /上锁任务/);
});
