import type { Channel, ChannelConfig } from "../shared/types";

export type LiveChannelPatch = Partial<
  Pick<ChannelConfig, "enabled" | "target" | "waveformId">
>;
export type LiveChannelsPatch = Partial<Record<Channel, LiveChannelPatch>>;
type VersionedPatch = Partial<
  Record<
    Channel,
    {
      values: LiveChannelPatch;
      versions: Partial<Record<keyof LiveChannelPatch, number>>;
    }
  >
>;

/** Serialize device configuration changes and keep only the latest unsent value.
 * The visible overlay includes in-flight changes until their state refresh ends.
 */
export class LiveChannelQueue {
  private queued: VersionedPatch = {};
  private requested: VersionedPatch = {};
  private version = 0;
  private running = false;
  private disposed = false;

  constructor(
    private send: (patch: LiveChannelsPatch) => Promise<unknown>,
    private changed: (pending: LiveChannelsPatch) => void,
  ) {}

  enqueue(patch: LiveChannelsPatch) {
    if (this.disposed) return;
    const version = ++this.version;
    for (const channel of ["A", "B"] as Channel[]) {
      const values = patch[channel];
      if (!values || !Object.keys(values).length) continue;
      for (const destination of [this.queued, this.requested]) {
        const entry = (destination[channel] ??= { values: {}, versions: {} });
        Object.assign(entry.values, values);
        for (const field of Object.keys(values) as (keyof LiveChannelPatch)[])
          entry.versions[field] = version;
      }
    }
    this.publish();
    void this.flush();
  }

  dispose() {
    this.disposed = true;
    this.queued = {};
    this.requested = {};
  }

  private values(patch: VersionedPatch): LiveChannelsPatch {
    return Object.fromEntries(
      Object.entries(patch).map(([channel, entry]) => [
        channel,
        { ...entry!.values },
      ]),
    );
  }

  private publish() {
    if (!this.disposed) this.changed(this.values(this.requested));
  }

  private async flush() {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed && Object.keys(this.queued).length) {
        const batch = this.queued;
        this.queued = {};
        try {
          await this.send(this.values(batch));
        } catch {
          // Action reports the request error; never retry an output change.
        }
        if (this.disposed) return;
        for (const channel of ["A", "B"] as Channel[]) {
          const sent = batch[channel];
          const latest = this.requested[channel];
          if (!sent || !latest) continue;
          for (const field of Object.keys(
            sent.values,
          ) as (keyof LiveChannelPatch)[]) {
            if (latest.versions[field] !== sent.versions[field]) continue;
            delete latest.values[field];
            delete latest.versions[field];
          }
          if (!Object.keys(latest.values).length)
            delete this.requested[channel];
        }
        this.publish();
      }
    } finally {
      this.running = false;
    }
  }
}
