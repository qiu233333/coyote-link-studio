import type { Channel, ChannelConfig, ControlBounds } from "./types.js";

type Channels = Record<Channel, ChannelConfig>;
type Limits = Record<Channel, number>;
const channels: Channel[] = ["A", "B"];
const safeLimit = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(200, Math.floor(value))) : 0;

/** Enabled channel hardware ceiling, optionally narrowed by session bounds. */
export function channelLimit(
  config: Channels,
  deviceLimits: Limits,
  channel: Channel,
  bounds?: ControlBounds,
): number {
  if (
    !config[channel].enabled ||
    (bounds && !bounds.channels.includes(channel))
  )
    return 0;
  return Math.min(
    safeLimit(deviceLimits[channel]),
    safeLimit(bounds?.maxIntensity[channel] ?? 200),
  );
}

/** Synchronized manual output always shares the lower enabled channel ceiling. */
export function outputLimit(
  config: Channels,
  deviceLimits: Limits,
  channel: Channel,
  synced: boolean,
  bounds?: ControlBounds,
): number {
  return synced
    ? Math.min(
        ...channels.map((c) => channelLimit(config, deviceLimits, c, bounds)),
      )
    : channelLimit(config, deviceLimits, channel, bounds);
}

/** A common playback target must be valid for every selected channel. */
export function playbackLimit(
  config: Channels,
  deviceLimits: Limits,
  selected: Channel[],
  synced: boolean,
): number {
  if (
    !selected.length ||
    (synced && !channels.every((c) => selected.includes(c)))
  )
    return 0;
  return Math.min(
    ...selected.map((c) => channelLimit(config, deviceLimits, c)),
  );
}
