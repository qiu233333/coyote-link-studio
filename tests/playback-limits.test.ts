import assert from "node:assert/strict";
import test from "node:test";
import type { AppSnapshot, Channel, PlaybackConfig } from "../shared/types.js";
import {
  effectiveChannelLimit,
  playbackChannelsLimit,
  playbackConfigIssue,
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
        intensity,
        startIntensity: 0,
        durationSec: 30,
        gapSec: 0,
        behavior: "hold",
      },
    ],
  };
}

test("播放器解释 20/19 设备已连接但用户上限 0，选择或预览均不扩大授权", () => {
  const snapshot = state();
  const before = structuredClone(snapshot.channels);
  assert.equal(effectiveChannelLimit(snapshot, "A"), 0);
  assert.equal(playbackChannelsLimit(snapshot, ["A", "B"]).limit, 0);
  assert.match(
    playbackConfigIssue(snapshot, playback())!,
    /用户上限为 0.*保存/,
  );
  assert.deepEqual(snapshot.channels, before);

  snapshot.channels.A.limit = 12;
  assert.equal(playbackConfigIssue(snapshot, playback(["A"])), null);
  assert.match(
    playbackConfigIssue(snapshot, playback())!,
    /B 通道用户上限为 0/,
  );
  snapshot.channels.B.limit = 19;
  assert.equal(playbackChannelsLimit(snapshot, ["A", "B"]).limit, 12);
  assert.equal(playbackConfigIssue(snapshot, playback()), null);
});

test("所选通道分别受 20/19 限制，双通道共用强度和同步采用较低值", () => {
  const snapshot = state();
  snapshot.channels.A.limit = 20;
  snapshot.channels.B.limit = 19;
  assert.equal(playbackChannelsLimit(snapshot, ["A"]).limit, 20);
  assert.equal(playbackChannelsLimit(snapshot, ["B"]).limit, 19);
  assert.equal(playbackChannelsLimit(snapshot, ["A", "B"]).limit, 19);
  assert.equal(playbackConfigIssue(snapshot, playback(["A"], 20)), null);
  assert.match(
    playbackConfigIssue(snapshot, playback(["A", "B"], 20))!,
    /有效上限 19/,
  );
  const independent = playback();
  independent.singleTargets = { A: 20, B: 19 };
  assert.equal(playbackConfigIssue(snapshot, independent), null);

  snapshot.synced = true;
  assert.equal(effectiveChannelLimit(snapshot, "A"), 19);
  assert.equal(effectiveChannelLimit(snapshot, "B"), 19);
  assert.match(
    playbackConfigIssue(snapshot, playback(["A"], 1))!,
    /同步.*两个通道/,
  );
  assert.match(playbackConfigIssue(snapshot, independent)!, /必须相同/);
  assert.equal(playbackConfigIssue(snapshot, playback(["A", "B"], 19)), null);
  snapshot.channels.B.enabled = false;
  assert.equal(effectiveChannelLimit(snapshot, "A"), 0);
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
      minIntensity: 0,
      maxIntensity: 15,
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
    assert.match(playbackConfigIssue(snapshot, config)!, /有效上限 9/);
    assert.deepEqual(config, before);
    assert.equal(snapshot.channels.B.limit, 19);
    snapshot.device.limits.B = 19;
  }
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
