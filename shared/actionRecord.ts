import type { Channel, ControlSession, DeviceState } from "./types.js";

export interface ActionParameters {
  target?: number;
  waveformId?: string;
  waveformName?: string;
  rampPerSecond?: number;
}
export interface ActionChannel {
  authorized?: boolean;
  participating?: boolean;
  before?: ActionParameters;
  after?: ActionParameters;
  range?: { min: number; max: number; source: "authorization" | "device" };
}
/** Immutable acceptance record. Telemetry here predates execution, not an ACK. */
export interface ActionRecord {
  id: string;
  runId?: string;
  boundsVersion?: number;
  at: number;
  kind: "update" | "adjust" | "keep" | "rest" | "finish" | "advance";
  reason?: string;
  contextLabel?: string;
  channels: Record<Channel, ActionChannel>;
  previousReport?: { at: number; A: number; B: number };
  raw: unknown;
}
/** Read-only observation of the scheduler, never used to drive output. */
export interface ActionExecution {
  id: string;
  runId: string;
  evaluatedAt?: number;
  channels?: Record<Channel, { target: number; ramping: boolean }>;
}

export function recordAction(
  run: ControlSession,
  input: Pick<ActionRecord, "id" | "kind" | "reason" | "raw">,
  before: Partial<Record<Channel, ActionParameters>>,
  after: Partial<Record<Channel, ActionParameters>>,
  participating: Channel[],
  device: DeviceState,
): ActionRecord {
  const bounds = run.roleplay?.bounds ?? run.bounds;
  const parameters = (p?: ActionParameters): ActionParameters | undefined =>
    p && {
      ...p,
      waveformName: p.waveformId
        ? run.waveformSnapshots[p.waveformId]?.name
        : undefined,
    };
  const channel = (c: Channel): ActionChannel => ({
    authorized: bounds?.channels.includes(c),
    participating: participating.includes(c),
    before: parameters(before[c]),
    after: parameters(after[c]),
    range: bounds?.channels.includes(c)
      ? {
          min: bounds.minIntensity[c],
          max: bounds.maxIntensity[c],
          source: "authorization",
        }
      : { min: 0, max: device.limits[c], source: "device" },
  });
  return structuredClone({
    ...input,
    runId: run.id,
    boundsVersion: run.boundsVersion,
    at: Date.now(),
    channels: { A: channel("A"), B: channel("B") },
    previousReport:
      device.lastSeenAt > 0
        ? { at: device.lastSeenAt, ...device.intensities }
        : undefined,
  });
}
