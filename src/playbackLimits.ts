import type { AppSnapshot, Channel, PlaybackConfig } from "../shared/types";
import { channelLimit, outputLimit, playbackLimit } from "../shared/limits";

const channels: Channel[] = ["A", "B"];
const active = (state: AppSnapshot) =>
  state.run?.status === "running" || state.run?.status === "paused";

export function effectiveChannelLimit(state: AppSnapshot, channel: Channel) {
  if (!state.device.connected) return 0;
  const bounds = active(state) ? state.run?.bounds : undefined;
  return active(state) && state.owner !== "manual"
    ? channelLimit(state.channels, state.device.limits, channel, bounds)
    : outputLimit(state.channels, state.device.limits, channel, state.synced);
}

export function playbackChannelsLimit(
  state: AppSnapshot,
  selected: Channel[],
): { channels: Channel[]; limit: number; reason?: string } {
  const selectedChannels = channels.filter((c) => selected.includes(c));
  const limit = state.device.connected
    ? playbackLimit(
        state.channels,
        state.device.limits,
        selectedChannels,
        state.synced,
      )
    : 0;
  let reason: string | undefined;
  if (!state.device.connected) reason = "请先连接并选择设备。";
  else if (!selectedChannels.length) reason = "请至少选择一个输出通道。";
  else if (state.synced && selectedChannels.length !== 2)
    reason = "A / B 同步需要同时选择两个通道；单通道播放请先关闭同步。";
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
  return { channels: selectedChannels, limit, reason };
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
    const selection = playbackChannelsLimit(state, random.channels);
    if (selection.reason) return selection.reason;
    if (
      !random.waveformIds.length ||
      random.waveformIds.some((id) => !waves.has(id))
    )
      return "请至少选择一个有效波形。";
    if (random.minIntensity < 0 || random.maxIntensity < random.minIntensity)
      return "随机强度上限不能小于下限，且强度不能为负数。";
    if (random.maxIntensity > selection.limit)
      return `随机强度超过所选通道强度上限 ${selection.limit}，请调低后播放。`;
    return null;
  }
  if (!config.stages.length) return "请添加播放条目或阶段。";
  for (const stage of config.stages) {
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
      if (state.synced && targets[0] !== targets[1])
        return "同步模式下 A / B 播放强度必须相同。";
      if (
        targets.some(
          (target, index) =>
            target < 0 ||
            target > effectiveChannelLimit(state, selection.channels[index]),
        )
      )
        return `播放强度超过所选通道强度上限 ${selection.limit}，请调低目标后播放。`;
    } else if (
      Math.min(stage.intensity, stage.startIntensity) < 0 ||
      Math.max(stage.intensity, stage.startIntensity) > selection.limit
    )
      return `「${stage.name}」强度超过所选通道强度上限 ${selection.limit}，请调低后播放。`;
  }
  return null;
}
