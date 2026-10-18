export type Channel = "A" | "B";
export type ChannelValues = Record<Channel, number>;
export type Owner = "manual" | "ai-control" | "locked-task";
export type Protocol = "v4" | "v3" | "simulator";
export type RunStatus =
  "running" | "paused" | "completed" | "stopped" | "faulted" | "interrupted";
export interface DeviceInfo {
  clientId: string;
  slotId: string;
  name: string;
  type: string;
}
export interface DeviceState {
  protocol: Protocol;
  relayStatus: "disconnected" | "connecting" | "connected" | "fault";
  appStatus: "waiting" | "paired" | "disconnected";
  connected: boolean;
  name: string;
  qrUrl?: string;
  pairingUrl?: string;
  targetId?: string;
  clientId?: string;
  slotId?: string;
  devices: DeviceInfo[];
  intensities: Record<Channel, number>;
  limits: Record<Channel, number>;
  lastSeenAt: number;
  latencyMs?: number;
  error?: string;
  canConfirmZero: boolean;
}
export interface DeviceDriver {
  state: DeviceState;
  connect(options: { protocol: Protocol; relayUrl?: string }): Promise<void>;
  selectDevice(clientId: string, slotId: string): Promise<void>;
  disconnect(): Promise<void>;
  setIntensity(channel: Channel, target: number): Promise<void>;
  sendFrames(channel: Channel, frames: string[]): Promise<void>;
  stop(): Promise<boolean>;
  on(event: "state", listener: (state: DeviceState) => void): unknown;
}
export interface Waveform {
  id: string;
  name: string;
  frames: string[];
  hash: string;
  builtin: boolean;
  favorite: boolean;
  lastUsedAt: number;
  durationMs: number;
}
export interface ChannelConfig {
  enabled: boolean;
  limit: number;
  rampPerSecond: number;
  target: number;
  waveformId: string;
}
export interface Stage {
  id: string;
  name: string;
  durationSec: number;
  gapSec: number;
  channels: Channel[];
  waveformId: string;
  waveformBId?: string;
  intensity: ChannelValues;
  startIntensity: ChannelValues;
  behavior: "hold" | "ramp" | "rest";
}
export interface RandomConfig {
  channels: Channel[];
  waveformIds: string[];
  minIntensity: ChannelValues;
  maxIntensity: ChannelValues;
  minIntervalSec: number;
  maxIntervalSec: number;
  minDurationSec: number;
  maxDurationSec: number;
  randomWaveform: boolean;
  randomIntensity: boolean;
  randomDuration: boolean;
  seed?: number;
}
export interface PlaybackConfig {
  mode: "single" | "playlist" | "stages" | "random";
  stages: Stage[];
  repeat: number;
  shuffle: boolean;
  durationSec: number;
  random?: RandomConfig;
  singleTargets?: Partial<Record<Channel, number>>;
}
export interface ControlBounds {
  channels: Channel[];
  waveformIds: string[];
  minIntensity: ChannelValues;
  maxIntensity: ChannelValues;
  rampPerSecond: ChannelValues;
  allowSync: boolean;
  allowRandom: boolean;
  allowRamp: boolean;
  allowRest: boolean;
  maxActionSec: number;
  durationSec: number;
  decisionIntervalSec: number;
  preference: string;
}
export interface AiDecision {
  action: "adjust" | "rest" | "finish";
  channels: Channel[];
  waveformId: string;
  intensity: ChannelValues;
  durationSec: number;
  reason: string;
  phaseComplete?: boolean;
  stageDurationSec?: number;
}
export interface TaskPlan {
  id: string;
  version: number;
  title: string;
  description: string;
  completionCriteria: string;
  bounds: ControlBounds;
  stages: Stage[];
  createdAt: number;
}
export interface Feedback {
  id: string;
  at: number;
  role: "user" | "assistant";
  text: string;
}
export type RunTerminationSource =
  | "deadline"
  | "ai-finish"
  | "stages-completed"
  | "user-stop"
  | "emergency"
  | "takeover"
  | "device-disconnected"
  | "device-stale"
  | "device-command"
  | "authorization"
  | "ai-inference"
  | "ai-runtime"
  | "stop-unconfirmed"
  | "service-shutdown"
  | "service-restart";
export interface ControlSession {
  id: string;
  owner: Owner;
  status: RunStatus;
  mode: string;
  startedAt: number;
  deadlineAt: number;
  boundsVersion: number;
  bounds?: ControlBounds;
  plan?: TaskPlan;
  playback?: PlaybackConfig;
  stageIndex: number;
  stageStartedAt: number;
  elapsedMs: number;
  reason?: string;
  termination?: {
    source: RunTerminationSource;
    triggerSource?: RunTerminationSource;
    at: number;
    code?: string;
  };
  inferenceRecovery?: {
    attempt: number;
    maxAttempts: number;
    retryAt: number;
    code: string;
    message: string;
  };
  randomSeed?: number;
  waveformSnapshots: Record<string, Waveform>;
  feedback: Feedback[];
  lastDecision?: AiDecision;
  thinking: boolean;
}
export interface LogEntry {
  id: string;
  at: number;
  level: "info" | "warning" | "error";
  source: string;
  message: string;
  channel?: Channel;
}
export interface AiSettings {
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  contextWindow: number;
  timeoutSec: number;
  draftTimeoutSec?: number;
}
export interface AiProfile extends AiSettings {
  apiKey: string;
}
export interface AppSnapshot {
  device: DeviceState;
  channels: Record<Channel, ChannelConfig>;
  synced: boolean;
  owner: Owner;
  run: ControlSession | null;
  locked: boolean;
  stopUnconfirmed: boolean;
  stopping: boolean;
  waveforms: Waveform[];
  logs: LogEntry[];
  history: { at: number; A: number; B: number }[];
  settings: AiSettings;
  plans: TaskPlan[];
  presets: { id: string; name: string; config: PlaybackConfig }[];
  aiRuntime: { ready: boolean; error?: string };
}
export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}
