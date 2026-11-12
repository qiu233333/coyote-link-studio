import test from "node:test";
import assert from "node:assert/strict";
import type { ActionRecord } from "../shared/actionRecord.ts";
import type { AppSnapshot } from "../shared/types.ts";
import type { StoryMessage } from "../shared/roleplay.ts";
import {
  actionCardModel,
  channelChange,
  targetChange,
  waveformChange,
  storyAction,
  sessionAction,
  percent,
} from "../src/actionCardModel.ts";
import { DEVICE_STATE_STALE_MS } from "../shared/executionPolicy.ts";

const record = (): ActionRecord => ({
  id: "action",
  runId: "run",
  boundsVersion: 1,
  at: 1000,
  kind: "update",
  raw: {},
  channels: {
    A: {
      authorized: true,
      participating: true,
      before: { target: 4, waveformId: "a", waveformName: "呼吸" },
      after: {
        target: 8,
        waveformId: "a",
        waveformName: "呼吸",
        rampPerSecond: 1,
      },
      range: { min: 0, max: 15, source: "authorization" },
    },
    B: {
      authorized: true,
      participating: false,
      before: { target: 3 },
      after: { target: 3 },
      range: { min: 0, max: 12, source: "authorization" },
    },
  },
  previousReport: { at: 900, A: 4, B: 3 },
});
const state = (r: ActionRecord) =>
  ({
    run: { id: "run", status: "running", boundsVersion: 1, lastAction: r },
    device: {
      connected: true,
      relayStatus: "connected",
      appStatus: "paired",
      lastSeenAt: 1500,
      intensities: { A: 6, B: 3 },
    },
    actionExecution: {
      id: r.id,
      runId: "run",
      evaluatedAt: 1500,
      channels: {
        A: { target: 8, ramping: true },
        B: { target: 3, ramping: false },
      },
    },
  }) as AppSnapshot;

test("partial update preserves target, distinguishes waveform and unchanged channel", () => {
  const r = record();
  r.channels.A.after = { target: 4, waveformId: "b", waveformName: "潮汐" };
  assert.equal(targetChange(r.channels.A), "目标 4 · 不变");
  assert.equal(channelChange(r.channels.A, r.kind), "切换波形");
  assert.equal(waveformChange(r.channels.A), "呼吸 → 潮汐");
  assert.equal(channelChange(r.channels.B, r.kind), "保持原参数");
  assert.equal(targetChange({ after: { target: 8 } }), "目标 8");
});
test("keeping zero never implies nonzero output and zero limits have finite bars", () => {
  assert.equal(channelChange({ after: { target: 0 } }, "keep"), "保持零值");
  assert.equal(percent(0, 0), 0);
  assert.equal(percent(8, undefined), 0);
  assert.equal(percent(20, 15), 100);
});
test("ramping requires scheduler evidence, fresh telemetry and matching targets", () => {
  const r = record(),
    s = state(r);
  assert.equal(actionCardModel(r, s, 1600).status, "正在渐变");
  s.actionExecution!.channels!.A.ramping = false;
  assert.equal(actionCardModel(r, s, 1600).status, "等待目标强度回传");
  s.device.intensities.A = 8;
  assert.equal(actionCardModel(r, s, 1600).status, "已到目标强度");
  s.actionExecution!.channels!.A.target = 0;
  assert.notEqual(actionCardModel(r, s, 1600).status, "已到目标强度");
});
test("old or pre-action reports cannot confirm execution even when values match", () => {
  const r = record(),
    s = state(r);
  s.device.intensities.A = 8;
  s.device.lastSeenAt = r.at;
  assert.equal(actionCardModel(r, s, 1600).status, "等待设备回传");
  assert.equal(actionCardModel(r, s, 1600).reportLabel, "上次回传（旧值）");
  s.device.lastSeenAt = 1500;
  assert.equal(
    actionCardModel(r, s, 1501 + DEVICE_STATE_STALE_MS).status,
    "当前状态未确认",
  );
  s.device.connected = false;
  assert.equal(actionCardModel(r, s, 1600).status, "当前状态未确认");
});
test("single channel rest only confirms the resting channel", () => {
  const r = record(),
    s = state(r);
  r.kind = "rest";
  r.channels.A.after!.target = 0;
  s.actionExecution!.channels!.A = { target: 0, ramping: false };
  s.device.intensities = { A: 0, B: 2 };
  assert.equal(actionCardModel(r, s, 1600).status, "A 归零已确认");
  assert.notEqual(channelChange(r.channels.B, "rest"), "归零休息");
});
test("historical records ignore newer runs, actions, authorization and waveform library", () => {
  const r = record(),
    s = state(r),
    saved = structuredClone(r);
  s.run!.lastAction = { ...r, id: "new" };
  s.device.intensities.A = 200;
  const view = actionCardModel(r, s, 1600);
  assert.equal(view.status, "历史记录");
  assert.equal(view.report!.A, 4);
  assert.equal(view.currentReport, false);
  assert.deepEqual(r, saved);
  s.run!.lastAction = r;
  s.run!.boundsVersion = 2;
  assert.equal(actionCardModel(r, s, 1600).live, false);
  s.run!.boundsVersion = 1;
  s.run!.status = "paused";
  assert.equal(actionCardModel(r, s, 1600).live, false);
});
test("legacy missing fields remain unknown, no current-state backfill", () => {
  const r = storyAction({
    id: "old",
    at: 1000,
    control: { action: "update", channels: { A: { waveformId: "a" } } },
  } as StoryMessage)!;
  assert.equal(targetChange(r.channels.A), "目标 —");
  assert.equal(waveformChange(r.channels.A), "—");
  assert.equal(actionCardModel(r, state(record()), 1600).report, undefined);
  const run = state(record()).run!;
  delete run.lastAction;
  run.lastDecision = {
    action: "finish",
    channels: [],
    intensity: { A: 0, B: 0 },
    waveformId: "",
    durationSec: 1,
    reason: "结束",
  };
  assert.equal(sessionAction(run)!.at, 0);
  assert.equal(
    actionCardModel(sessionAction(run)!, state(record()), 1600).live,
    false,
  );
});

test("authorization, participation and stage advancement are not mistaken for target changes", () => {
  assert.equal(channelChange({ authorized: false }, "update"), "未授权");
  assert.equal(channelChange({ participating: false }, "adjust"), "未参与本轮");
  const s = state(record());
  const run = s.run!;
  delete run.lastAction;
  run.owner = "locked-task";
  run.lastDecision = {
    action: "adjust",
    phaseComplete: true,
    channels: ["A"],
    intensity: { A: 8, B: 0 },
    waveformId: "a",
    durationSec: 1,
    reason: "进入下一阶段",
  };
  const r = sessionAction(run)!;
  assert.equal(r.kind, "advance");
  assert.equal(targetChange(r.channels.A), "目标 —");
  assert.equal(actionCardModel(r, s, 1600).title, "推进任务阶段");
  const unlinked = storyAction({
    id: "plain",
    at: 1000,
    control: { action: "keep" },
    execution: "纯文字演绎",
  } as StoryMessage)!;
  assert.equal(actionCardModel(unlinked, s, 1600).title, "纯文字演绎");
});
