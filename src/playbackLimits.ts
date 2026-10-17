import type {
  AppSnapshot,
  Channel,
  ChannelValues,
  ControlBounds,
  PlaybackConfig,
  TaskPlan,
} from "../shared/types";
import { channelLimit } from "../shared/limits";

const channels: Channel[] = ["A", "B"];
const active = (state: AppSnapshot) =>
  state.run?.status === "running" || state.run?.status === "paused";

// Both stored values must be representable by the shared API schema, including
// disabled-channel drafts. Hardware caps and authorization are checked only for
// selected channels below; a valid inactive value is never clamped or discarded.
function valuesFormatIssue(
  values: ChannelValues,
  label: string,
  rate = false,
): string | null {
  for (const channel of channels) {
    const value = values?.[channel];
    if (rate) {
      if (!Number.isFinite(value) || value < 0.1 || value > 20)
        return `${label}：${channel} 通道变化速率须在 0.1–20 之间（未选通道的草稿也须符合格式）。`;
    } else if (!Number.isInteger(value) || value < 0 || value > 200)
      return `${label}：${channel} 通道强度须为 0–200 的整数（未选通道的草稿也须符合格式）。`;
  }
  return null;
}

export function effectiveChannelLimit(state: AppSnapshot, channel: Channel) {
  if (!state.device.connected) return 0;
  const bounds = active(state) ? state.run?.bounds : undefined;
  return channelLimit(state.channels, state.device.limits, channel, bounds);
}

export function playbackChannelsLimit(
  state: AppSnapshot,
  selected: Channel[],
): { channels: Channel[]; limits: Record<Channel, number>; reason?: string } {
  const selectedChannels = channels.filter((c) => selected.includes(c));
  const limits = {
    A: effectiveChannelLimit(state, "A"),
    B: effectiveChannelLimit(state, "B"),
  };
  let reason: string | undefined;
  if (!state.device.connected) reason = "请先连接并选择设备。";
  else if (!selectedChannels.length) reason = "请至少选择一个输出通道。";
  else {
    const disabled = selectedChannels.filter((c) => !state.channels[c].enabled);
    const unavailable = selectedChannels.filter(
      (c) => state.device.limits[c] === 0,
    );
    if (disabled.length)
      reason = `${disabled.join(" / ")} 通道未启用，请启用或取消选择。`;
    else if (unavailable.length)
      reason = `${unavailable.join(" / ")} 通道强度上限为 0，请检查 APP 的上限设置与回传。`;
  }
  return { channels: selectedChannels, limits, reason };
}

// Keep editable plans intact when telemetry changes. The player and confirmation
// dialog both recheck them against the latest limits before a start is offered.
export function playbackConfigIssue(
  state: AppSnapshot,
  config: PlaybackConfig,
): string | null {
  if (state.locked) return "上锁任务运行中，只能反馈或紧急停止。";
  if (state.stopping) return "设备正在停止，请等待归零确认。";
  if (state.stopUnconfirmed) return "设备停止尚未确认，请重新连接并清理。";
  if (active(state)) return "请先停止当前控制，再开始新的播放。";
  if (!state.device.connected) return "请先连接并选择设备。";
  if (Date.now() - state.device.lastSeenAt > 6000)
    return "设备状态已过期，请重新连接。";
  const waves = new Set(state.waveforms.map((wave) => wave.id));
  if (config.mode === "random") {
    const random = config.random;
    if (!random) return "请设置随机播放范围。";
    const formatIssue =
      valuesFormatIssue(random.minIntensity, "随机最低强度") ||
      valuesFormatIssue(random.maxIntensity, "随机最高强度");
    if (formatIssue) return formatIssue;
    const selection = playbackChannelsLimit(state, random.channels);
    if (selection.reason) return selection.reason;
    if (
      !random.waveformIds.length ||
      random.waveformIds.some((id) => !waves.has(id))
    )
      return "请至少选择一个有效波形。";
    for (const channel of selection.channels) {
      if (
        !Number.isInteger(random.minIntensity[channel]) ||
        !Number.isInteger(random.maxIntensity[channel]) ||
        random.minIntensity[channel] < 0 ||
        random.maxIntensity[channel] < random.minIntensity[channel]
      )
        return `${channel} 通道随机强度上限不能小于下限，且强度须为非负整数。`;
      if (random.maxIntensity[channel] > selection.limits[channel])
        return `${channel} 通道随机强度超过强度上限 ${selection.limits[channel]}，请调低后播放。`;
    }
    return null;
  }
  if (!config.stages.length) return "请添加播放条目或阶段。";
  for (const stage of config.stages) {
    const formatIssue =
      valuesFormatIssue(stage.intensity, `「${stage.name}」目标强度`) ||
      valuesFormatIssue(stage.startIntensity, `「${stage.name}」起始强度`);
    if (formatIssue) return formatIssue;
    const selection = playbackChannelsLimit(state, stage.channels);
    if (selection.reason) return selection.reason;
    if (stage.behavior === "rest") continue;
    if (
      !waves.has(stage.waveformId) ||
      (stage.waveformBId && !waves.has(stage.waveformBId))
    )
      return `「${stage.name}」请选择有效波形。`;
    if (config.mode === "single") {
      const targets = selection.channels.map(
        (c) => config.singleTargets?.[c] ?? state.channels[c].target,
      );
      for (let i = 0; i < selection.channels.length; i++) {
        const channel = selection.channels[i];
        if (
          !Number.isInteger(targets[i]) ||
          targets[i] < 0 ||
          targets[i] > selection.limits[channel]
        )
          return `${channel} 通道播放强度超过强度上限 ${selection.limits[channel]}，请调低目标后播放。`;
      }
    } else {
      for (const channel of selection.channels) {
        if (
          !Number.isInteger(stage.intensity[channel]) ||
          !Number.isInteger(stage.startIntensity[channel]) ||
          Math.min(stage.intensity[channel], stage.startIntensity[channel]) <
            0 ||
          Math.max(stage.intensity[channel], stage.startIntensity[channel]) >
            selection.limits[channel]
        )
          return `「${stage.name}」${channel} 通道强度超过强度上限 ${selection.limits[channel]}，请调低后播放。`;
      }
    }
  }
  return null;
}

export function controlBoundsIssue(
  state: AppSnapshot,
  bounds: ControlBounds,
): string | null {
  const formatIssue =
    valuesFormatIssue(bounds.minIntensity, "AI 最低强度") ||
    valuesFormatIssue(bounds.maxIntensity, "AI 最高强度") ||
    valuesFormatIssue(bounds.rampPerSecond, "AI 强度变化速率", true);
  if (formatIssue) return formatIssue;
  if (!bounds.channels.length) return "请至少授权一个通道。";
  if (
    !bounds.waveformIds.length ||
    bounds.waveformIds.some(
      (id) => !state.waveforms.some((wave) => wave.id === id),
    )
  )
    return "请至少选择一个有效授权波形。";
  for (const channel of bounds.channels) {
    if (!state.channels[channel].enabled)
      return `${channel} 通道未启用，请先在控制台启用。`;
    const minimum = bounds.minIntensity[channel];
    const maximum = bounds.maxIntensity[channel];
    const rate = bounds.rampPerSecond[channel];
    if (
      !Number.isInteger(minimum) ||
      !Number.isInteger(maximum) ||
      minimum < 0 ||
      maximum < minimum
    )
      return `${channel} 通道强度范围须为非负整数，最高强度不能小于最低强度。`;
    if (maximum > (state.device.connected ? state.device.limits[channel] : 200))
      return `${channel} 通道 AI 范围超过强度上限 ${state.device.limits[channel]}。`;
    if (!Number.isFinite(rate) || rate < 0.1 || rate > 20)
      return `${channel} 通道变化速率须在 0.1–20 之间。`;
  }
  return null;
}

export function taskPlanIssue(
  state: AppSnapshot,
  plan: TaskPlan,
): string | null {
  const bounds = plan.bounds;
  const issue = controlBoundsIssue(state, bounds);
  if (issue) return issue;
  if (!plan.stages.length) return "请添加至少一个任务阶段。";
  for (const stage of plan.stages) {
    const formatIssue =
      valuesFormatIssue(stage.intensity, `「${stage.name}」目标强度`) ||
      valuesFormatIssue(stage.startIntensity, `「${stage.name}」起始强度`);
    if (formatIssue) return formatIssue;
    if (
      !stage.channels.length ||
      stage.channels.some((channel) => !bounds.channels.includes(channel))
    )
      return `「${stage.name}」使用了未授权通道。`;
    if (stage.channels.length > 1 && !bounds.allowSync)
      return `「${stage.name}」需要双通道联动授权。`;
    if (stage.behavior === "rest") {
      if (!bounds.allowRest) return `「${stage.name}」需要归零休息授权。`;
      continue;
    }
    if (stage.behavior === "ramp" && !bounds.allowRamp)
      return `「${stage.name}」需要渐变授权。`;
    if (
      !bounds.waveformIds.includes(stage.waveformId) ||
      (stage.waveformBId && !bounds.waveformIds.includes(stage.waveformBId))
    )
      return `「${stage.name}」使用了未授权波形。`;
    for (const channel of stage.channels) {
      const target = stage.intensity[channel];
      const start = stage.startIntensity[channel];
      if (
        !Number.isInteger(target) ||
        target < bounds.minIntensity[channel] ||
        target > bounds.maxIntensity[channel] ||
        !Number.isInteger(start) ||
        start < 0 ||
        start > bounds.maxIntensity[channel] ||
        (stage.behavior === "ramp" && start < bounds.minIntensity[channel])
      )
        return `「${stage.name}」${channel} 通道强度超出授权范围 ${bounds.minIntensity[channel]}–${bounds.maxIntensity[channel]}。`;
    }
  }
  return null;
}
