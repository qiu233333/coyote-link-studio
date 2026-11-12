import type { ActionChannel, ActionRecord } from "../shared/actionRecord";
import type { AppSnapshot, Channel, ControlSession } from "../shared/types";
import type { StoryMessage } from "../shared/roleplay";
import { DEVICE_STATE_STALE_MS } from "../shared/executionPolicy";

const channels: Channel[] = ["A", "B"];
export function storyAction(message: StoryMessage): ActionRecord | undefined {
  if (message.actionRecord) return message.actionRecord;
  if (!message.control) return;
  const patch = message.control;
  const channel = (c: Channel): ActionChannel => ({
    after: message.output?.[c],
    participating:
      patch.action === "keep"
        ? false
        : patch.action === "rest"
          ? patch.channels.includes(c)
          : !!patch.channels[c],
  });
  return {
    id: message.id,
    at: message.at,
    kind: patch.action,
    reason: message.controlReason,
    contextLabel: message.output ? undefined : message.execution,
    channels: { A: channel("A"), B: channel("B") },
    raw: patch,
  };
}
export function sessionAction(run: ControlSession): ActionRecord | undefined {
  if (run.lastAction) return run.lastAction;
  const d = run.lastDecision;
  if (!d) return;
  const advance =
    run.owner === "locked-task" && d.phaseComplete && d.action !== "finish";
  const channel = (c: Channel): ActionChannel => ({
    participating:
      !advance && (d.action !== "adjust" || d.channels.includes(c)),
    after: advance
      ? undefined
      : {
          target:
            d.action === "adjust" && d.channels.includes(c)
              ? d.intensity[c]
              : 0,
        },
  });
  // Legacy records contain no acceptance time, authorization or waveform snapshot.
  return {
    id: `legacy-${run.id}`,
    at: 0,
    kind: advance ? "advance" : d.action,
    reason: d.reason,
    channels: { A: channel("A"), B: channel("B") },
    raw: d,
  };
}
export function targetChange(c: ActionChannel) {
  const before = c.before?.target,
    after = c.after?.target;
  if (after === undefined) return "目标 —";
  if (before === undefined) return `目标 ${after}`;
  return before === after
    ? `目标 ${after} · 不变`
    : `目标 ${before} → ${after}`;
}
export function channelChange(c: ActionChannel, kind: ActionRecord["kind"]) {
  if (c.authorized === false) return "未授权";
  const before = c.before,
    after = c.after;
  if (kind === "advance") return "交由下一阶段安排";
  if (kind === "finish") return "结束会话 · 目标归零";
  if (kind === "rest" && c.participating) return "归零休息";
  if (
    kind === "keep" ||
    (c.participating === false && (kind === "update" || kind === "rest"))
  )
    return after?.target === 0 ? "保持零值" : "保持原参数";
  if (
    before?.target !== undefined &&
    after?.target !== undefined &&
    before.target !== after.target
  )
    return after.target === 0
      ? "目标归零"
      : after.target > before.target
        ? "提高强度"
        : "降低强度";
  if (
    before?.waveformId !== undefined &&
    after?.waveformId !== undefined &&
    before.waveformId !== after.waveformId
  )
    return "切换波形";
  if (
    before?.rampPerSecond !== undefined &&
    after?.rampPerSecond !== undefined &&
    before.rampPerSecond !== after.rampPerSecond
  )
    return "调整变化速率";
  if (c.participating === false) return "未参与本轮";
  return before && after ? "保持原参数" : "参数记录";
}
export function waveformChange(c: ActionChannel) {
  const a = c.after,
    b = c.before;
  if (!a?.waveformId) return "—";
  const name = a.waveformName ?? "名称未记录";
  if (b?.waveformId === undefined) return name;
  if (b.waveformId === a.waveformId) return `${name} · 保持`;
  return `${b.waveformName ?? "—"} → ${name}`;
}
export function actionCardModel(
  record: ActionRecord,
  state?: AppSnapshot,
  now = Date.now(),
) {
  const run = state?.run,
    execution = state?.actionExecution;
  const live = !!(
    record.runId &&
    run?.id === record.runId &&
    record.boundsVersion === run.boundsVersion &&
    run.lastAction?.id === record.id &&
    run.status === "running" &&
    !state?.stopping &&
    !state?.stopUnconfirmed &&
    execution?.id === record.id &&
    execution.runId === record.runId
  );
  const device = live ? state!.device : undefined;
  const fresh = !!(
    device?.connected &&
    device.relayStatus === "connected" &&
    device.appStatus === "paired" &&
    device.lastSeenAt > 0 &&
    now >= device.lastSeenAt &&
    now - device.lastSeenAt <= DEVICE_STATE_STALE_MS
  );
  // Strictly later than acceptance: a same-millisecond prior report is ambiguous.
  const currentReport = fresh && device!.lastSeenAt > record.at;
  const observed = !!(
    live &&
    execution?.evaluatedAt &&
    execution.evaluatedAt >= record.at &&
    now - execution.evaluatedAt <= 1500
  );
  const relevant = channels.filter(
    (c) =>
      record.channels[c].authorized !== false &&
      record.channels[c].after?.target !== undefined,
  );
  const matches =
    observed &&
    relevant.length > 0 &&
    relevant.every(
      (c) =>
        execution!.channels?.[c].target === record.channels[c].after?.target,
    );
  const reached =
    currentReport &&
    matches &&
    relevant.every(
      (c) => device!.intensities[c] === record.channels[c].after?.target,
    );
  const resting = relevant.filter(
    (c) => record.kind === "rest" && record.channels[c].participating,
  );
  const zeroConfirmed =
    currentReport &&
    observed &&
    resting.length > 0 &&
    resting.every(
      (c) =>
        execution!.channels?.[c].target === 0 && device!.intensities[c] === 0,
    );
  const ramping =
    currentReport &&
    matches &&
    relevant.some((c) => execution!.channels?.[c].ramping);
  let status = record.contextLabel ?? "历史记录";
  const latest = run?.id === record.runId && run?.lastAction?.id === record.id;
  if (!live && latest) {
    if (state?.stopUnconfirmed || run?.status === "faulted")
      status = "当前状态未确认";
    else if (run?.status === "paused") status = "已暂停 · 历史参数";
    else if (run?.status !== "running") status = "会话已结束 · 历史记录";
  }
  if (live) {
    status = !fresh
      ? "当前状态未确认"
      : !currentReport
        ? "等待设备回传"
        : zeroConfirmed
          ? `${resting.join(" / ")} 归零已确认`
          : reached
            ? record.kind === "keep"
              ? "保持不变 · 强度已回传"
              : "已到目标强度"
            : ramping
              ? "正在渐变"
              : "等待目标强度回传";
  }
  const report =
    device && device.lastSeenAt > 0
      ? { at: device.lastSeenAt, ...device.intensities }
      : record.previousReport;
  const reportLabel = currentReport ? "设备回传" : "上次回传（旧值）";
  let note = "历史记录只展示当时参数，未保存执行确认。";
  if (live) {
    note = !fresh
      ? "当前状态未确认，旧数值不代表当前输出。"
      : !currentReport
        ? "参数已提交，等待设备回传。"
        : `设备已回传 A ${device!.intensities.A} / B ${device!.intensities.B}。${ramping ? "后台正在渐变接近目标。" : reached ? "强度与目标一致。" : "等待目标强度确认。"}`;
  }
  if (record.kind === "finish")
    note = "已记录结束会话请求，执行结果请查看会话停止状态。";
  return {
    live,
    status,
    report,
    reportLabel,
    currentReport,
    note,
    title:
      record.contextLabel ??
      (record.kind === "advance"
        ? "推进任务阶段"
        : record.kind === "keep"
          ? "沿用当前节奏"
          : channels
              .map(
                (c) => `${c} ${channelChange(record.channels[c], record.kind)}`,
              )
              .join("，")),
  };
}

export function percent(value: number | undefined, max: number | undefined) {
  return value === undefined || max === undefined || max <= 0
    ? 0
    : Math.max(0, Math.min(100, (value / max) * 100));
}
