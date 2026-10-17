import type { ChannelValues } from "./types.js";

/** Create an explicit value for both channels, including legacy scalar imports. */
export const channelValues = (value: number): ChannelValues => ({
  A: value,
  B: value,
});
