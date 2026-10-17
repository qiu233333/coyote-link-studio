import { EventEmitter } from "node:events";
import { randomUUID, randomInt } from "node:crypto";
import { z } from "zod";
import { channelLimit, outputLimit } from "../shared/limits.js";
import { channelValues } from "../shared/intensity.js";
import type {
  AiProfile,
  AiDecision,
  AppSnapshot,
  Channel,
  ChannelConfig,
  ControlBounds,
  ControlSession,
  DeviceDriver,
  Feedback,
  LogEntry,
  Owner,
  PlaybackConfig,
  RunStatus,
  Stage,
  TaskPlan,
  Waveform,
} from "../shared/types.js";
import { AppError, assert } from "./errors.js";
import { Store } from "./store.js";
import {
  normalizeWaveform,
  channelIntensitySchema,
  parseBounds,
  parsePlan,
  parsePlayback,
} from "./validation.js";

export interface AiBridge {
  status: { ready: boolean; error?: string };
  decide(
    profile: AiProfile,
    context: unknown,
    signal?: AbortSignal,
  ): Promise<AiDecision>;
  draft(
    profile: AiProfile,
    prompt: string,
    context: unknown,
    signal?: AbortSignal,
  ): Promise<Omit<TaskPlan, "id" | "version" | "createdAt">>;
}
type Desired = Record<Channel, { target: number; waveformId: string }>;
const channels: Channel[] = ["A", "B"];
const active = (run: ControlSession | null) =>
  Boolean(run && ["running", "paused"].includes(run.status));
const decisionSchema = z.object({
  action: z.enum(["adjust", "rest", "finish"]),
  channels: z.array(z.enum(["A", "B"])).max(2),
  waveformId: z.string(),
  intensity: channelIntensitySchema,
  durationSec: z.number().min(0.1).max(300),
  reason: z.string().min(1).max(2000),
  phaseComplete: z.boolean().optional(),
  stageDurationSec: z.number().min(0.1).max(86400).optional(),
});

export class Controller extends EventEmitter {
  public run: ControlSession | null;
  public config: Record<Channel, ChannelConfig>;
  public synced = false;
  public stopUnconfirmed = false;
  public stopping = false;
  private logs: LogEntry[];
  private history: AppSnapshot["history"] = [];
  private timer: ReturnType<typeof setInterval>;
  private epoch = 0;
  private emitAt = 0;
  private persistedAt = 0;
  private tickAt = Date.now();
  private progressAt = Date.now();
  private nextPulse = { A: 0, B: 0 };
  private pulseBusy = { A: false, B: false };
  private intensityBusy = { A: false, B: false };
  private levels = { A: 0, B: 0 };
  private cursors = { A: 0, B: 0 };
  private cursorWaves = { A: "", B: "" };
  private lastReported = { A: 0, B: 0 };
  private nextAiAt = 0;
  private aiEpoch = 0;
  private aiAbort?: AbortController;
  private profile?: AiProfile;
  private aiAction?: {
    decision: AiDecision;
    expiresAt: number;
    stageIndex: number;
  };
  private stageDurations = new Map<number, number>();
  private randomState = 1;
  private nextRandomAt = 0;
  private randomUntil = 0;
  private randomDesired?: Desired;
  private closed = false;
  private stopFlight?: Promise<boolean>;
  private finishFlight?: Promise<void>;
  private deviceTransition?: Promise<void>;

  constructor(
    public store: Store,
    public device: DeviceDriver,
    public ai: AiBridge,
    builtins: { name: string; frames: string[] }[] = [],
  ) {
    super();
    if (!store.list<Waveform>("waveforms").length)
      for (const waveform of builtins) {
        const item = normalizeWaveform(waveform.frames, waveform.name, true);
        store.set("waveforms", item.id, item);
      }
    const first = store.list<Waveform>("waveforms")[0]?.id ?? "";
    this.config = store.get("settings", "channels") ?? {
      A: {
        enabled: true,
        limit: 0,
        rampPerSecond: 2,
        target: 0,
        waveformId: first,
      },
      B: {
        enabled: true,
        limit: 0,
        rampPerSecond: 2,
        target: 0,
        waveformId: first,
      },
    };
    for (const channel of channels) this.config[channel].target = 0;
    this.synced = store.get<boolean>("settings", "synced") ?? false;
    this.logs = store.list<LogEntry>("logs").slice(0, 500).reverse();
    // Normalize saved scalar-era records before any snapshot or frozen run can
    // expose them. Invalid partial maps fail validation instead of gaining zeroes.
    for (const saved of store.list<TaskPlan>("plans"))
      store.set("plans", saved.id, parsePlan(saved));
    for (const saved of store.list<{
      id: string;
      name: string;
      config: PlaybackConfig;
    }>("presets"))
      store.set("presets", saved.id, {
        ...saved,
        config: parsePlayback(saved.config),
      });
    this.run = store.get<ControlSession>("runtime", "current") ?? null;
    if (this.run) {
      if (this.run.bounds) this.run.bounds = parseBounds(this.run.bounds);
      if (this.run.plan) this.run.plan = parsePlan(this.run.plan);
      if (this.run.playback)
        this.run.playback = parsePlayback(this.run.playback);
      if (this.run.lastDecision)
        this.run.lastDecision = decisionSchema.parse(this.run.lastDecision);
      store.set("runtime", "current", this.run);
    }
    if (active(this.run)) {
      this.run!.status = "interrupted";
      this.run!.thinking = false;
      this.run!.reason = "服务重启，原运行已中断，设备输出不会自动恢复。";
      store.set("runtime", "current", this.run);
      this.log("warning", "系统", this.run!.reason);
    }
    device.on("state", (state) => {
      // Hardware ceilings may fall between ticks. Immediately lower configured
      // targets and live ramp state without waiting for another scheduler tick.
      if (state.connected) this.clampToDeviceLimits();
      for (const channel of channels)
        if (state.intensities[channel] !== this.lastReported[channel]) {
          this.lastReported[channel] = state.intensities[channel];
          this.log(
            "info",
            "设备回传",
            `${channel} 通道已回传强度 ${state.intensities[channel]}`,
            channel,
          );
        }
      if (
        active(this.run) &&
        !this.stopping &&
        (!state.connected || state.relayStatus === "fault")
      )
        void this.finish("faulted", state.error || "设备或 APP 连接中断");
      if (active(this.run) && !this.stopping) {
        // Disabling changes the next output target to zero. While the two zero
        // commands are confirmed independently, telemetry must still be checked
        // against session authorization and hardware ceilings rather than treating
        // the other channel's previous value as a newly unauthorized increase.
        const reportedConfig = {
          A: { ...this.config.A, enabled: true },
          B: { ...this.config.B, enabled: true },
        };
        for (const channel of channels) {
          const limit = outputLimit(
            reportedConfig,
            state.limits,
            channel,
            this.synced &&
              this.run?.mode === "single" &&
              this.config.A.enabled &&
              this.config.B.enabled &&
              this.run?.owner === "manual",
            this.run?.bounds,
          );
          if (state.intensities[channel] > limit) {
            void this.finish("faulted", `${channel} 通道回传强度超出确认边界`);
            break;
          }
        }
      }
      this.broadcast();
    });
    this.timer = setInterval(() => this.tick(), 100);
    this.timer.unref();
  }
  isActive() {
    return active(this.run);
  }
  isLocked() {
    return active(this.run) && this.run?.owner === "locked-task";
  }
  assertUnlocked() {
    assert(
      !this.isLocked(),
      "上锁任务运行中，只能反馈或紧急停止。",
      "TASK_LOCKED",
      423,
    );
  }
  assertIdle() {
    this.assertUnlocked();
    assert(
      !active(this.run) && !this.stopping,
      "请先停止当前控制，再执行此操作。",
      "CONTROLLER_BUSY",
      409,
    );
  }
  private assertDevice() {
    assert(
      this.device.state.connected,
      "请先连接并选择设备。",
      "DEVICE_NOT_READY",
      409,
    );
    assert(
      Date.now() - this.device.state.lastSeenAt <= 6000,
      "设备状态已过期，请重新连接。",
      "DEVICE_STALE",
      409,
    );
    assert(
      !this.stopUnconfirmed && !this.stopping,
      "设备停止尚未确认，请重新连接并清理。",
      "STOP_UNCONFIRMED",
      409,
    );
  }
  private effectiveLimit(channel: Channel) {
    return outputLimit(
      this.config,
      this.device.state.limits,
      channel,
      this.synced &&
        this.run?.mode !== "live" &&
        (!active(this.run) || this.run?.mode === "single") &&
        (!active(this.run) || this.run?.owner === "manual"),
      active(this.run) ? this.run?.bounds : undefined,
    );
  }
  private clampToDeviceLimits() {
    let changed = false;
    const configured = {
      A: { ...this.config.A, enabled: true },
      B: { ...this.config.B, enabled: true },
    };
    for (const channel of channels) {
      const maximum = outputLimit(
        configured,
        this.device.state.limits,
        channel,
        this.synced && (!active(this.run) || this.run?.mode === "single"),
      );
      if (this.config[channel].target > maximum) {
        this.config[channel].target = maximum;
        if (this.run?.playback?.singleTargets?.[channel] !== undefined)
          this.run.playback.singleTargets[channel] = maximum;
        changed = true;
      }
      this.levels[channel] = Math.min(
        this.levels[channel],
        this.effectiveLimit(channel),
      );
    }
    if (changed) {
      this.store.set("settings", "channels", this.config);
      this.persist();
      this.log("warning", "控制器", "设备上限降低，已下调目标强度。");
    }
  }
  snapshot(): AppSnapshot {
    return {
      device: this.device.state,
      channels: this.config,
      synced: this.synced,
      owner: active(this.run) ? this.run!.owner : "manual",
      run: this.run,
      locked: this.isLocked(),
      stopUnconfirmed: this.stopUnconfirmed,
      stopping: this.stopping,
      waveforms: this.store
        .list<Waveform>("waveforms")
        .sort(
          (a, b) =>
            Number(b.builtin) - Number(a.builtin) ||
            a.name.localeCompare(b.name, "zh-CN"),
        ),
      logs: this.logs.slice(-300).reverse(),
      history: this.history,
      settings: this.store.settings(),
      plans: this.store.list<TaskPlan>("plans"),
      presets: this.store.list("presets"),
      aiRuntime: this.ai.status,
    };
  }
  broadcast(force = false) {
    if (this.closed) return;
    const now = Date.now();
    if (!force && now - this.emitAt < 400) return;
    this.emitAt = now;
    this.emit("state", this.snapshot());
  }
  log(
    level: LogEntry["level"],
    source: string,
    message: string,
    channel?: Channel,
  ) {
    const entry: LogEntry = {
      id: randomUUID(),
      at: Date.now(),
      level,
      source,
      message: this.store.redact(message).slice(0, 2000),
      channel,
    };
    this.logs.push(entry);
    this.store.set("logs", entry.id, entry);
    if (this.logs.length > 500) {
      const old = this.logs.shift()!;
      this.store.delete("logs", old.id);
    }
    this.broadcast(true);
  }
  private persist() {
    if (this.run) this.store.set("runtime", "current", this.run);
  }
  private waves() {
    return this.store.list<Waveform>("waveforms");
  }
  private requireWave(id: string) {
    const wave = this.waves().find((w) => w.id === id);
    assert(wave, "所选波形不存在。", "WAVEFORM_NOT_FOUND", 404);
    return wave;
  }
  importWaveform(input: unknown, name?: string) {
    this.assertUnlocked();
    const wave = normalizeWaveform(input, name);
    assert(
      !this.waves().some((w) => w.hash === wave.hash),
      "该波形已存在，已跳过重复导入。",
      "DUPLICATE_WAVEFORM",
      409,
    );
    this.store.set("waveforms", wave.id, wave);
    this.log(
      "info",
      "波形库",
      `导入波形「${wave.name}」，${wave.frames.length} 帧`,
    );
    return wave;
  }
  updateWaveform(id: string, patch: { name?: string; favorite?: boolean }) {
    this.assertUnlocked();
    const wave = this.requireWave(id);
    if (patch.name !== undefined) {
      assert(
        patch.name.trim().length > 0 && patch.name.length <= 100,
        "波形名称须为 1 到 100 字。",
      );
      wave.name = patch.name.trim();
    }
    if (patch.favorite !== undefined) {
      assert(typeof patch.favorite === "boolean", "收藏状态无效。");
      wave.favorite = patch.favorite;
    }
    this.store.set("waveforms", id, wave);
    this.broadcast(true);
  }
  deleteWaveform(id: string) {
    this.assertUnlocked();
    this.requireWave(id);
    assert(
      !active(this.run) || !this.run?.waveformSnapshots[id],
      "波形正在使用，请先停止。",
      "WAVEFORM_BUSY",
      409,
    );
    this.store.delete("waveforms", id);
    this.broadcast(true);
  }
  savePreset(name: string, config: unknown) {
    this.assertUnlocked();
    assert(name.trim().length > 0 && name.length <= 100, "请填写预设名称。");
    const preset = {
      id: randomUUID(),
      name: name.trim(),
      config: parsePlayback(config),
    };
    this.store.set("presets", preset.id, preset);
    this.broadcast(true);
    return preset;
  }
  deletePreset(id: string) {
    this.assertUnlocked();
    this.store.delete("presets", id);
    this.broadcast(true);
  }
  private async transitionDevice(action: () => Promise<void>) {
    const operation = action();
    this.deviceTransition = operation;
    try {
      await operation;
    } finally {
      if (this.deviceTransition === operation)
        this.deviceTransition = undefined;
    }
  }
  async connect(options: Parameters<DeviceDriver["connect"]>[0]) {
    this.assertIdle();
    assert(
      ["simulator", "v4", "v3"].includes(options.protocol),
      "协议选择无效。",
    );
    const epoch = ++this.epoch;
    this.stopping = true;
    this.broadcast(true);
    try {
      await this.transitionDevice(async () => {
        await this.device.connect(options);
        if (epoch !== this.epoch) {
          await this.device.disconnect();
          throw new AppError("连接已被停止操作取消。", "START_CANCELLED", 409);
        }
        // A real relay connection alone says nothing about physical outputs. Only
        // selecting a device and confirming its reset may clear this latch.
        if (options.protocol === "simulator") this.stopUnconfirmed = false;
        this.log(
          "info",
          "设备",
          options.protocol === "simulator"
            ? "已连接模拟设备：不会产生真实硬件输出"
            : "中继已连接，请使用官方 APP 扫码并选择设备",
        );
      });
    } finally {
      if (epoch === this.epoch) this.stopping = false;
      this.broadcast(true);
    }
  }
  async selectDevice(clientId: string, slotId: string) {
    this.assertIdle();
    const epoch = ++this.epoch;
    this.stopping = true;
    try {
      await this.transitionDevice(async () => {
        await this.device.selectDevice(clientId, slotId);
        assert(
          epoch === this.epoch,
          "设备选择已被停止操作取消。",
          "START_CANCELLED",
          409,
        );
        this.stopUnconfirmed = !(await this.stopDevice());
        assert(
          epoch === this.epoch,
          "设备选择已被停止操作取消。",
          "START_CANCELLED",
          409,
        );
        assert(
          !this.stopUnconfirmed,
          "无法确认设备归零，请检查 APP。",
          "STOP_UNCONFIRMED",
          409,
        );
      });
    } finally {
      if (epoch === this.epoch) this.stopping = false;
      this.broadcast(true);
    }
  }
  async disconnect() {
    this.assertUnlocked();
    await this.finish("stopped", "用户断开设备");
    const epoch = ++this.epoch;
    this.stopping = true;
    try {
      await this.transitionDevice(() => this.device.disconnect());
    } finally {
      if (this.epoch === epoch) this.stopping = false;
      this.broadcast(true);
    }
  }
  private checkLiveChannels(config = this.config) {
    for (const channel of channels) {
      if (config[channel].enabled) this.requireWave(config[channel].waveformId);
      assert(
        config[channel].target <= this.device.state.limits[channel],
        `${channel} 通道目标强度超过设备上限。`,
      );
    }
  }
  async updateLiveChannels(input: unknown) {
    this.assertUnlocked();
    assert(
      !active(this.run) ||
        (this.run?.owner === "manual" && this.run.mode === "live"),
      "请先停止当前控制，再编辑实时通道。",
      "OWNER_CONFLICT",
      409,
    );
    const pausingLive =
      this.run?.owner === "manual" &&
      this.run.mode === "live" &&
      this.run.status === "paused";
    assert(
      !this.stopping || pausingLive,
      "设备正在停止，请稍候。",
      "CONTROLLER_BUSY",
      409,
    );
    const channelPatch = z
      .object({
        enabled: z.boolean().optional(),
        target: z.number().int().min(0).max(200).optional(),
        waveformId: z.string().min(1).optional(),
      })
      .strict();
    const patch = z
      .object({
        channels: z
          .object({ A: channelPatch.optional(), B: channelPatch.optional() })
          .strict(),
      })
      .strict()
      .parse(input);
    const next = structuredClone(this.config);
    for (const channel of channels) {
      Object.assign(next[channel], patch.channels[channel]);
      if (patch.channels[channel]?.waveformId)
        this.requireWave(next[channel].waveformId);
    }
    this.checkLiveChannels(next);
    this.config = next;
    // Older installations can have manual synchronization persisted. Live
    // control explicitly owns independent targets, including its first patch.
    this.synced = false;
    this.store.set("settings", "channels", this.config);
    this.store.set("settings", "synced", false);
    if (active(this.run) && this.run?.mode === "live") {
      this.run.waveformSnapshots = Object.fromEntries(
        this.waves().map((wave) => [wave.id, structuredClone(wave)]),
      );
      this.persist();
    }
    this.log("info", "实时控制", "已更新实时通道");
  }
  async startLive(requestId: string) {
    if (this.seenRequest(requestId)) return;
    this.assertUnlocked();
    assert(
      !active(this.run) ||
        (this.run?.owner === "manual" && this.run.mode === "live"),
      "请先停止当前控制，再开始实时控制。",
      "OWNER_CONFLICT",
      409,
    );
    this.assertDevice();
    this.checkLiveChannels();
    if (active(this.run)) {
      if (this.run!.status === "paused") await this.resume("manual");
      this.store.set("requests", requestId, { at: Date.now() });
      return;
    }
    // Reset telemetry must already use independent ceilings on the first start.
    this.synced = false;
    this.store.set("settings", "synced", false);
    await this.prepare(requestId);
    this.checkLiveChannels();
    this.run = this.makeRun(
      "manual",
      "live",
      86400,
      this.waves().map((wave) => wave.id),
    );
    this.persist();
    this.log("info", "实时控制", "已开始实时控制");
  }
  async updateChannels(patch: {
    channels?: Partial<Record<Channel, Partial<ChannelConfig>>>;
    synced?: boolean;
  }) {
    this.assertUnlocked();
    assert(
      !active(this.run) || this.run?.owner === "manual",
      "请先暂停并接管为手动。",
      "OWNER_CONFLICT",
      409,
    );
    assert(!this.stopping, "设备正在停止，请稍候。", "CONTROLLER_BUSY", 409);
    const next = structuredClone(this.config);
    for (const channel of channels)
      if (patch.channels?.[channel]) {
        const item = patch.channels[channel]!;
        const parsed = z
          .object({
            enabled: z.boolean(),
            limit: z.number().int().min(0).max(200),
            rampPerSecond: z.number().min(0.1).max(20),
            target: z.number().int().min(0).max(200),
            waveformId: z.string(),
          })
          .parse({ ...next[channel], ...item });
        if (parsed.waveformId) this.requireWave(parsed.waveformId);
        if (!parsed.enabled) parsed.target = 0;
        next[channel] = parsed;
      }
    const synced = patch.synced ?? this.synced;
    assert(typeof synced === "boolean", "同步模式无效。");
    if (synced) {
      const changed = patch.channels?.A?.target ?? patch.channels?.B?.target;
      const target =
        next.A.enabled && next.B.enabled
          ? (changed ?? Math.min(next.A.target, next.B.target))
          : 0;
      next.A.target = target;
      next.B.target = target;
    }
    if (this.device.state.connected)
      for (const channel of channels)
        assert(
          next[channel].target <=
            outputLimit(next, this.device.state.limits, channel, synced),
          `${channel} 通道目标强度超过设备或同步有效上限。`,
        );
    if (active(this.run)) {
      assert(
        patch.synced === undefined || synced === this.synced,
        "切换通道关系前请先停止播放。",
        "CONTROLLER_BUSY",
        409,
      );
      assert(
        this.run?.mode === "single",
        "编排播放期间请先停止再编辑通道配置。",
        "CONTROLLER_BUSY",
        409,
      );
      assert(
        !channels.some(
          (c) =>
            next[c].limit !== this.config[c].limit ||
            next[c].rampPerSecond !== this.config[c].rampPerSecond,
        ),
        "播放期间不能修改上限或变化速率，请先停止。",
        "CONTROLLER_BUSY",
        409,
      );
    }
    this.config = next;
    this.synced = synced;
    this.store.set("settings", "channels", this.config);
    this.store.set("settings", "synced", this.synced);
    if (active(this.run) && this.run?.playback) {
      const stage = this.run.playback.stages[0];
      // Keep the original selection. Enabling a channel never adds one, and a
      // temporary disable only zeros its target rather than deleting selection.
      stage.intensity = { A: next.A.target, B: next.B.target };
      stage.waveformId = next.A.waveformId;
      stage.waveformBId = next.B.waveformId;
      this.run.waveformSnapshots = Object.fromEntries(
        this.waves().map((w) => [w.id, structuredClone(w)]),
      );
    }
    this.log("info", "控制台", "已更新通道配置");
  }
  private checkStage(stage: Stage, bounds?: ControlBounds) {
    if (stage.behavior !== "rest") {
      this.requireWave(stage.waveformId);
      if (stage.waveformBId) this.requireWave(stage.waveformBId);
    }
    for (const channel of stage.channels) {
      assert(this.config[channel].enabled, `${channel} 通道未启用。`);
      const maximum = bounds
        ? channelLimit(this.config, this.device.state.limits, channel, bounds)
        : channelLimit(this.config, this.device.state.limits, channel);
      assert(
        stage.behavior === "rest" ||
          Math.max(stage.intensity[channel], stage.startIntensity[channel]) <=
            maximum,
        `${channel} 通道阶段强度超过上限。`,
      );
      if (bounds)
        assert(bounds.channels.includes(channel), "任务阶段使用了未授权通道。");
    }
    if (bounds && stage.behavior !== "rest") {
      assert(
        bounds.waveformIds.includes(stage.waveformId) &&
          (!stage.waveformBId ||
            bounds.waveformIds.includes(stage.waveformBId)),
        "任务阶段使用了未授权波形。",
      );
      for (const channel of stage.channels)
        assert(
          stage.intensity[channel] >= bounds.minIntensity[channel] &&
            (stage.behavior !== "ramp" ||
              stage.startIntensity[channel] >= bounds.minIntensity[channel]),
          `${channel} 通道阶段强度低于确认范围。`,
        );
    }
    if (bounds)
      assert(
        ((stage.behavior !== "rest" && stage.gapSec === 0) ||
          bounds.allowRest) &&
          (stage.behavior !== "ramp" || bounds.allowRamp) &&
          (stage.channels.length < 2 || bounds.allowSync),
        "阶段行为不在授权范围内。",
      );
  }
  private checkBounds(bounds: ControlBounds) {
    for (const channel of bounds.channels) {
      assert(
        this.config[channel].enabled,
        `请先在控制台启用 ${channel} 通道。`,
      );
      assert(
        bounds.maxIntensity[channel] <= this.device.state.limits[channel],
        `${channel} 通道 AI 范围超过设备上限。`,
      );
    }
    for (const id of bounds.waveformIds) this.requireWave(id);
  }
  private seenRequest(requestId: string) {
    assert(
      typeof requestId === "string" &&
        requestId.length >= 8 &&
        requestId.length <= 200,
      "启动请求需要有效幂等标识。",
    );
    return Boolean(this.store.get("requests", requestId));
  }
  private async prepare(requestId: string) {
    this.assertIdle();
    this.assertDevice();
    this.store.set("requests", requestId, { at: Date.now() });
    this.stopping = true;
    const epoch = ++this.epoch;
    this.broadcast(true);
    try {
      const stopped = await this.stopDevice();
      assert(
        epoch === this.epoch,
        "启动已被停止操作取消。",
        "START_CANCELLED",
        409,
      );
      this.stopUnconfirmed = !stopped;
      assert(
        stopped,
        "无法确认设备初始归零，禁止启动。",
        "STOP_UNCONFIRMED",
        409,
      );
      assert(
        this.device.state.connected,
        "设备连接已中断。",
        "DEVICE_NOT_READY",
        409,
      );
      this.levels = { A: 0, B: 0 };
      this.cursors = { A: 0, B: 0 };
      this.cursorWaves = { A: "", B: "" };
      this.nextPulse = { A: 0, B: 0 };
      this.aiAction = undefined;
      this.stageDurations.clear();
      this.nextRandomAt = 0;
      this.randomDesired = undefined;
    } finally {
      if (this.epoch === epoch) this.stopping = false;
    }
  }
  private makeRun(
    owner: Owner,
    mode: string,
    durationSec: number,
    waveformIds: string[],
  ): ControlSession {
    const now = Date.now();
    const snapshots = Object.fromEntries(
      [...new Set(waveformIds)].map((id) => {
        const wave = this.requireWave(id);
        wave.lastUsedAt = now;
        this.store.set("waveforms", wave.id, wave);
        return [id, structuredClone(wave)];
      }),
    );
    this.progressAt = now;
    this.tickAt = now;
    return {
      id: randomUUID(),
      owner,
      status: "running",
      mode,
      startedAt: now,
      deadlineAt: now + durationSec * 1000,
      boundsVersion: 1,
      stageIndex: 0,
      stageStartedAt: now,
      elapsedMs: 0,
      waveformSnapshots: snapshots,
      feedback: [],
      thinking: false,
    };
  }
  private checkPlayback(config: PlaybackConfig) {
    const selections =
      config.mode === "random"
        ? [config.random!.channels]
        : config.stages.map((stage) => stage.channels);
    if (this.synced && config.mode === "single")
      assert(
        selections.every((selected) =>
          channels.every((c) => selected.includes(c)),
        ),
        "同步模式需要同时选择 A/B 通道；单通道播放请先关闭同步。",
      );
    if (config.mode === "random") {
      const r = config.random!;
      for (const id of r.waveformIds) this.requireWave(id);
      for (const c of r.channels)
        assert(
          this.config[c].enabled &&
            r.maxIntensity[c] <=
              channelLimit(this.config, this.device.state.limits, c),
          `${c} 通道随机范围超过上限。`,
        );
    } else if (config.mode === "single") {
      assert(config.stages.length === 1, "单波形播放器只接受一个播放阶段。");
      const stage = config.stages[0];
      // Single mode follows independent channel targets; the stage carries its
      // waveform and duration, while singleTargets explicitly updates sliders.
      this.checkStage({
        ...stage,
        intensity: channelValues(0),
        startIntensity: channelValues(0),
      });
      for (const c of stage.channels) {
        const target = config.singleTargets?.[c] ?? this.config[c].target;
        assert(
          target <=
            outputLimit(this.config, this.device.state.limits, c, this.synced),
          `${c} 通道播放强度超过上限（设备或同步有效上限）。`,
        );
      }
      if (this.synced && stage.channels.length === 2)
        assert(
          (config.singleTargets?.A ?? this.config.A.target) ===
            (config.singleTargets?.B ?? this.config.B.target),
          "同步模式下 A/B 播放强度必须相同。",
        );
    } else for (const stage of config.stages) this.checkStage(stage);
  }
  async startPlayback(input: unknown, requestId: string) {
    if (this.seenRequest(requestId)) return;
    this.assertUnlocked();
    const config = parsePlayback(input);
    this.checkPlayback(config);
    await this.prepare(requestId);
    // Reset confirmation can take time and report a lower hardware ceiling.
    if (config.mode !== "single") {
      this.synced = false;
      this.store.set("settings", "synced", false);
    }
    this.checkPlayback(config);
    if (config.mode === "single") {
      const stage = config.stages[0];
      for (const c of stage.channels) {
        if (config.singleTargets?.[c] !== undefined)
          this.config[c].target = config.singleTargets[c]!;
        this.config[c].waveformId =
          c === "B" && stage.waveformBId ? stage.waveformBId : stage.waveformId;
      }
      this.store.set("settings", "channels", this.config);
    }
    if (config.shuffle)
      for (let i = config.stages.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [config.stages[i], config.stages[j]] = [
          config.stages[j],
          config.stages[i],
        ];
      }
    let duration = config.durationSec;
    if (config.mode !== "random" && config.repeat > 0)
      duration = Math.min(
        duration,
        config.stages.reduce((sum, s) => sum + s.durationSec + s.gapSec, 0) *
          config.repeat,
      );
    const ids =
      config.mode === "random"
        ? config.random!.waveformIds
        : config.stages.flatMap((s) =>
            s.behavior === "rest"
              ? []
              : [s.waveformId, s.waveformBId].filter((id): id is string =>
                  Boolean(id),
                ),
          );
    this.run = this.makeRun("manual", config.mode, duration, ids);
    this.run.playback = config;
    this.randomState = config.random?.seed ?? randomInt(1, 4294967295);
    this.run.randomSeed = this.randomState;
    this.persist();
    this.log(
      "info",
      "控制台",
      `已启动 ${config.mode} 播放${config.mode === "random" ? `，随机种子 ${this.randomState}` : ""}`,
    );
  }
  async startAi(input: unknown, requestId: string) {
    if (this.seenRequest(requestId)) return;
    this.assertUnlocked();
    const bounds = parseBounds(input);
    this.checkBounds(bounds);
    this.requireAi();
    await this.prepare(requestId);
    this.checkBounds(bounds);
    this.profile = this.store.profile();
    this.run = this.makeRun(
      "ai-control",
      "ai-control",
      bounds.durationSec,
      bounds.waveformIds,
    );
    this.run.bounds = bounds;
    this.persist();
    this.log("info", "AI 控制", "AI 已获得确认范围内的控制权");
    this.nextAiAt = 0;
  }
  private requireAi() {
    assert(
      this.ai.status.ready,
      this.ai.status.error || "AI 本地运行时尚未就绪。",
      "AI_NOT_READY",
      503,
    );
    const profile = this.store.profile();
    assert(
      profile.baseUrl && profile.model,
      "请先在系统设置填写并测试 AI 接口。",
      "AI_NOT_CONFIGURED",
      409,
    );
  }
  async draftTask(prompt: string) {
    this.assertUnlocked();
    this.requireAi();
    assert(
      typeof prompt === "string" &&
        prompt.trim().length > 0 &&
        prompt.length <= 8000,
      "请填写 1 到 8000 字的任务需求。",
    );
    const context = this.aiContext(false);
    const generated = await this.ai.draft(
      this.store.profile(),
      prompt,
      context,
    );
    this.assertUnlocked();
    const plan = parsePlan({
      ...generated,
      id: randomUUID(),
      version: 1,
      createdAt: Date.now(),
    });
    for (const id of plan.bounds.waveformIds) this.requireWave(id);
    this.store.set("plans", plan.id, plan);
    this.log("info", "上锁任务", `已生成草稿「${plan.title}」，等待编辑和确认`);
    return plan;
  }
  updatePlan(id: string, input: unknown) {
    this.assertUnlocked();
    const old = this.store.get<TaskPlan>("plans", id);
    assert(old, "任务草稿不存在。", "NOT_FOUND", 404);
    const plan = parsePlan({
      ...(input as object),
      id,
      version: old.version + 1,
      createdAt: old.createdAt,
    });
    for (const waveId of plan.bounds.waveformIds) this.requireWave(waveId);
    this.store.set("plans", id, plan);
    this.broadcast(true);
    return plan;
  }
  async startTask(id: string, requestId: string) {
    if (this.seenRequest(requestId)) return;
    this.assertUnlocked();
    const saved = this.store.get<TaskPlan>("plans", id);
    assert(saved, "任务草稿不存在。", "NOT_FOUND", 404);
    const plan = parsePlan(saved);
    this.checkBounds(plan.bounds);
    this.requireAi();
    for (const stage of plan.stages) this.checkStage(stage, plan.bounds);
    assert(
      plan.stages.reduce((sum, s) => sum + s.durationSec + s.gapSec, 0) <=
        plan.bounds.durationSec,
      "阶段总时长超过任务最长时间。",
    );
    await this.prepare(requestId);
    this.checkBounds(plan.bounds);
    for (const stage of plan.stages) this.checkStage(stage, plan.bounds);
    this.profile = this.store.profile();
    this.run = this.makeRun(
      "locked-task",
      "locked-task",
      plan.bounds.durationSec,
      plan.bounds.waveformIds,
    );
    this.run.bounds = structuredClone(plan.bounds);
    this.run.plan = structuredClone(plan);
    this.persist();
    this.log(
      "info",
      "上锁任务",
      `「${plan.title}」已确认并锁定，最晚 ${new Date(this.run.deadlineAt).toLocaleTimeString("zh-CN")} 结束`,
    );
    this.nextAiAt = 0;
  }
  private cancelAi() {
    ++this.aiEpoch;
    this.aiAbort?.abort();
    this.aiAbort = undefined;
    if (this.run) this.run.thinking = false;
  }
  async pause(owner?: Owner) {
    this.assertUnlocked();
    assert(
      this.run?.status === "running",
      "当前没有可暂停的运行。",
      "NOT_RUNNING",
      409,
    );
    if (owner)
      assert(
        this.run.owner === owner,
        "当前控制方不匹配。",
        "OWNER_CONFLICT",
        409,
      );
    assert(!this.stopping, "设备正在停止，请稍候。", "CONTROLLER_BUSY", 409);
    const run = this.run,
      epoch = ++this.epoch;
    run.elapsedMs += Date.now() - this.progressAt;
    run.status = "paused";
    this.cancelAi();
    this.stopping = true;
    this.broadcast(true);
    try {
      const confirmed = await this.stopDevice();
      if (epoch !== this.epoch || this.run !== run) return;
      this.stopUnconfirmed = !confirmed;
      this.levels = { A: 0, B: 0 };
      this.aiAction = undefined;
      if (!confirmed) {
        run.status = "faulted";
        run.reason = "暂停时停止未确认";
      }
      this.persist();
      this.log(
        confirmed ? "info" : "error",
        "控制器",
        confirmed
          ? "已暂停，队列已清理且通道已归零；截止时间继续计时"
          : "停止未确认，请检查设备",
      );
    } catch (error) {
      if (epoch === this.epoch) {
        this.stopUnconfirmed = true;
        run.status = "faulted";
        run.reason = "暂停时停止未确认";
        this.persist();
      }
      throw error;
    } finally {
      if (epoch === this.epoch) this.stopping = false;
      this.broadcast(true);
    }
  }
  async resume(owner?: Owner) {
    this.assertUnlocked();
    assert(
      this.run?.status === "paused",
      "当前没有可恢复的运行。",
      "NOT_PAUSED",
      409,
    );
    if (owner)
      assert(
        this.run.owner === owner,
        "当前控制方不匹配。",
        "OWNER_CONFLICT",
        409,
      );
    this.assertDevice();
    assert(
      Date.now() < this.run.deadlineAt,
      "会话已经到期，不能恢复。",
      "RUN_EXPIRED",
      409,
    );
    if (this.run.mode === "live") this.checkLiveChannels();
    this.run.status = "running";
    this.progressAt = Date.now();
    this.tickAt = Date.now();
    this.nextPulse = { A: 0, B: 0 };
    this.nextAiAt = 0;
    ++this.epoch;
    this.persist();
    this.log("info", "控制器", "用户已确认恢复，从零重新渐变");
  }
  async changeBounds(input: unknown) {
    this.assertUnlocked();
    assert(
      active(this.run) && this.run?.owner === "ai-control",
      "当前不是 AI 控制会话。",
      "OWNER_CONFLICT",
      409,
    );
    const bounds = parseBounds(input);
    this.checkBounds(bounds);
    if (this.run.status === "running") await this.pause("ai-control");
    assert(
      this.run.status === "paused" && !this.stopUnconfirmed,
      "无法确认暂停，不允许修改范围。",
      "STOP_UNCONFIRMED",
      409,
    );
    this.run.bounds = bounds;
    this.run.boundsVersion++;
    this.run.deadlineAt = Date.now() + bounds.durationSec * 1000;
    this.run.waveformSnapshots = Object.fromEntries(
      bounds.waveformIds.map((id) => [
        id,
        structuredClone(this.requireWave(id)),
      ]),
    );
    this.profile = this.store.profile();
    this.cancelAi();
    this.persist();
    this.log(
      "info",
      "AI 控制",
      "已确认新版范围和截止时间，保持暂停；请点击恢复",
    );
  }
  async feedback(text: string, owner: Owner) {
    assert(
      owner !== "manual",
      "手动控制不支持 AI 反馈。",
      "OWNER_CONFLICT",
      409,
    );
    assert(
      active(this.run) && this.run?.owner === owner,
      "当前没有对应的 AI 运行。",
      "OWNER_CONFLICT",
      409,
    );
    assert(
      typeof text === "string" && text.trim().length > 0 && text.length <= 4000,
      "反馈须为 1 到 4000 字。",
    );
    const item: Feedback = {
      id: randomUUID(),
      at: Date.now(),
      role: "user",
      text: text.trim(),
    };
    this.run.feedback.push(item);
    this.run.feedback = this.run.feedback.slice(-100);
    this.cancelAi();
    this.nextAiAt = 0;
    this.persist();
    this.log(
      "info",
      owner === "locked-task" ? "上锁任务" : "AI 控制",
      `收到反馈：${text.trim().slice(0, 150)}`,
    );
  }
  async stop(owner?: Owner) {
    this.assertUnlocked();
    if (owner && active(this.run))
      assert(
        this.run?.owner === owner,
        "当前控制方不匹配。",
        "OWNER_CONFLICT",
        409,
      );
    await this.finish("stopped", "用户停止运行");
  }
  async takeover() {
    this.assertUnlocked();
    await this.finish("stopped", "用户接管为手动");
    assert(
      !this.stopUnconfirmed,
      "停止未确认，暂不能手动接管。",
      "STOP_UNCONFIRMED",
      409,
    );
  }
  async emergency() {
    await this.finish("stopped", "用户触发紧急停止");
  }
  private stopDevice(): Promise<boolean> {
    if (this.stopFlight) return this.stopFlight;
    this.stopFlight = Promise.resolve()
      .then(() => this.device.stop())
      .finally(() => {
        this.stopFlight = undefined;
      });
    return this.stopFlight;
  }
  async finish(status: RunStatus, reason: string) {
    // Always invalidate pending starts, pauses and model results immediately.
    // An in-flight physical stop is shared and awaited, never mistaken for an
    // already completed stop merely because another operation set `stopping`.
    ++this.epoch;
    this.cancelAi();
    this.stopping = true;
    if (this.run && active(this.run)) {
      this.run.status = status;
      this.run.reason = reason;
    }
    this.aiAction = undefined;
    this.randomDesired = undefined;
    for (const channel of channels) this.config[channel].target = 0;
    this.persist();
    this.broadcast(true);
    if (this.finishFlight) return this.finishFlight;
    this.finishFlight = this.completeStop(status, reason).finally(() => {
      this.finishFlight = undefined;
    });
    return this.finishFlight;
  }
  private async completeStop(status: RunStatus, reason: string) {
    try {
      const confirmed = await this.stopDevice();
      // An emergency during connection/selection must keep new starts blocked
      // until the cancelled transition has finished cleaning up its socket.
      if (this.deviceTransition) await this.deviceTransition.catch(() => {});
      this.stopUnconfirmed = !confirmed;
      if (!confirmed && this.run) {
        this.run.status = "faulted";
        this.run.reason = `${reason}；设备停止未确认`;
      }
      this.levels = { A: 0, B: 0 };
      this.persist();
      this.log(
        confirmed ? (status === "faulted" ? "error" : "info") : "error",
        "控制器",
        confirmed
          ? `${reason}；已清队列并确认归零`
          : `${reason}；停止未确认，请检查官方 APP 或设备`,
      );
    } catch (error) {
      this.stopUnconfirmed = true;
      if (this.run) {
        this.run.status = "faulted";
        this.run.reason = reason + "；停止未确认";
      }
      this.persist();
      this.log(
        "error",
        "控制器",
        `停止未确认：${error instanceof Error ? error.message : "未知异常"}`,
      );
    } finally {
      this.stopping = false;
      this.broadcast(true);
    }
  }
  async next() {
    this.assertUnlocked();
    assert(
      this.run?.owner === "manual" &&
        this.run.status === "running" &&
        this.run.playback &&
        ["playlist", "stages"].includes(this.run.mode),
      "当前模式不支持跳项。",
    );
    const run = this.run,
      config = run.playback!;
    const elapsed = run.elapsedMs + Date.now() - this.progressAt;
    const pass =
      config.stages.reduce((sum, s) => sum + s.durationSec + s.gapSec, 0) *
      1000;
    let cursor = 0;
    for (const stage of config.stages) {
      cursor += (stage.durationSec + stage.gapSec) * 1000;
      if (cursor > (elapsed % pass) + 1) break;
    }
    await this.pause("manual");
    run.elapsedMs = Math.floor(elapsed / pass) * pass + cursor;
    if (Date.now() < run.deadlineAt) await this.resume("manual");
  }
  private zeroDesired(): Desired {
    return {
      A: { target: 0, waveformId: "" },
      B: { target: 0, waveformId: "" },
    };
  }
  private random() {
    let x = this.randomState >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x >>> 0 || 1;
    return this.randomState / 4294967296;
  }
  private range(min: number, max: number) {
    return min + this.random() * (max - min);
  }
  private playbackDesired(now: number): Desired {
    if (this.run!.mode === "live") {
      const desired = this.zeroDesired();
      for (const channel of channels)
        if (this.config[channel].enabled)
          desired[channel] = {
            target: this.config[channel].target,
            waveformId: this.config[channel].waveformId,
          };
      return desired;
    }
    const run = this.run!,
      config = run.playback!,
      result = this.zeroDesired();
    if (config.mode === "random") {
      const random = config.random!;
      if (now >= this.nextRandomAt) {
        const wave =
          random.waveformIds[
            random.randomWaveform
              ? Math.floor(this.random() * random.waveformIds.length)
              : 0
          ];
        this.randomUntil =
          now +
          (random.randomDuration
            ? this.range(random.minDurationSec, random.maxDurationSec)
            : random.minDurationSec) *
            1000;
        this.nextRandomAt =
          now + this.range(random.minIntervalSec, random.maxIntervalSec) * 1000;
        this.randomDesired = this.zeroDesired();
        for (const c of random.channels)
          this.randomDesired[c] = {
            target: random.randomIntensity
              ? Math.floor(
                  this.range(
                    random.minIntensity[c],
                    random.maxIntensity[c] + 0.999,
                  ),
                )
              : random.minIntensity[c],
            waveformId: wave,
          };
        this.log(
          "info",
          "随机控制",
          `选择 ${run.waveformSnapshots[wave]?.name}，${random.channels.map((c) => `${c} 目标 ${this.randomDesired![c].target}`).join(" / ")}，持续 ${((this.randomUntil - now) / 1000).toFixed(1)} 秒`,
        );
      }
      return now < this.randomUntil ? this.randomDesired! : result;
    }
    const elapsed = run.elapsedMs + now - this.progressAt;
    const pass =
      config.stages.reduce((sum, s) => sum + s.durationSec + s.gapSec, 0) *
      1000;
    if (config.repeat > 0 && elapsed >= pass * config.repeat) {
      void this.finish("completed", "播放内容已完成");
      return result;
    }
    let local = elapsed % pass;
    for (let index = 0; index < config.stages.length; index++) {
      const stage = config.stages[index],
        duration = stage.durationSec * 1000;
      if (local < duration + stage.gapSec * 1000) {
        if (run.stageIndex !== index) {
          run.stageIndex = index;
          run.stageStartedAt = now - local;
          this.log("info", "阶段", `进入「${stage.name}」`);
        }
        if (local < duration && stage.behavior !== "rest")
          for (const c of stage.channels) {
            const target =
              config.mode === "single"
                ? this.config[c].target
                : stage.behavior === "ramp"
                  ? stage.startIntensity[c] +
                    ((stage.intensity[c] - stage.startIntensity[c]) * local) /
                      duration
                  : stage.intensity[c];
            result[c] = {
              target,
              waveformId:
                c === "B" && stage.waveformBId
                  ? stage.waveformBId
                  : stage.waveformId,
            };
          }
        break;
      }
      local -= duration + stage.gapSec * 1000;
    }
    return result;
  }
  private lockedDesired(now: number): Desired {
    const run = this.run!,
      stage = run.plan!.stages[run.stageIndex],
      desired = this.zeroDesired();
    if (!stage) {
      void this.finish("completed", "所有任务阶段已结束");
      return desired;
    }
    const duration =
      (this.stageDurations.get(run.stageIndex) ?? stage.durationSec) * 1000;
    const elapsed = now - run.stageStartedAt;
    if (elapsed >= duration + stage.gapSec * 1000) {
      this.advanceStage(now);
      return desired;
    }
    if (elapsed >= duration || stage.behavior === "rest") return desired;
    if (
      this.aiAction &&
      this.aiAction.stageIndex === run.stageIndex &&
      this.aiAction.expiresAt > now
    )
      return this.actionDesired(this.aiAction.decision);
    for (const c of stage.channels)
      desired[c] = {
        target:
          stage.behavior === "ramp"
            ? stage.startIntensity[c] +
              (stage.intensity[c] - stage.startIntensity[c]) *
                Math.min(elapsed / duration, 1)
            : stage.intensity[c],
        waveformId:
          c === "B" && stage.waveformBId ? stage.waveformBId : stage.waveformId,
      };
    return desired;
  }
  private advanceStage(now: number) {
    const run = this.run!;
    run.stageIndex++;
    run.stageStartedAt = now;
    this.aiAction = undefined;
    this.cancelAi();
    this.nextAiAt = 0;
    const stage = run.plan!.stages[run.stageIndex];
    if (!stage) void this.finish("completed", "任务阶段已完成");
    else {
      this.persist();
      this.log("info", "上锁任务", `进入「${stage.name}」`);
    }
  }
  private actionDesired(decision: AiDecision): Desired {
    const result = this.zeroDesired();
    if (decision.action === "adjust")
      for (const c of decision.channels)
        result[c] = {
          target: decision.intensity[c],
          waveformId: decision.waveformId,
        };
    return result;
  }
  private aiContext(includeRun = true) {
    const run = includeRun ? this.run : null;
    return {
      bounds: run?.bounds,
      run: run
        ? {
            id: run.id,
            owner: run.owner,
            deadlineAt: run.deadlineAt,
            stageIndex: run.stageIndex,
            stage: run.plan?.stages[run.stageIndex],
            task: run.plan
              ? {
                  title: run.plan.title,
                  description: run.plan.description,
                  completionCriteria: run.plan.completionCriteria,
                }
              : undefined,
            lastDecision: run.lastDecision,
            feedback: run.feedback.slice(-20),
          }
        : null,
      device: {
        name: this.device.state.name,
        intensities: this.device.state.intensities,
        limits: this.device.state.limits,
      },
      channels: Object.fromEntries(
        channels.map((channel) => [
          channel,
          {
            enabled: this.config[channel].enabled,
            target: this.config[channel].target,
            waveformId: this.config[channel].waveformId,
            limit: this.device.state.limits[channel],
          },
        ]),
      ),
      waveforms: (run
        ? Object.values(run.waveformSnapshots)
        : this.waves()
      ).map((w) => ({ id: w.id, name: w.name, durationMs: w.durationMs })),
      now: Date.now(),
    };
  }
  private requestDecision(now: number) {
    const run = this.run!;
    if (run.thinking || !run.bounds || now < this.nextAiAt) return;
    const runId = run.id,
      epoch = this.epoch,
      aiEpoch = ++this.aiEpoch,
      version = run.boundsVersion;
    this.aiAbort = new AbortController();
    run.thinking = true;
    this.nextAiAt = now + run.bounds.decisionIntervalSec * 1000;
    this.broadcast(true);
    void this.ai
      .decide(this.profile!, this.aiContext(), this.aiAbort.signal)
      .then((raw) => {
        if (
          !this.run ||
          this.run.id !== runId ||
          this.epoch !== epoch ||
          this.aiEpoch !== aiEpoch ||
          this.run.boundsVersion !== version ||
          this.run.status !== "running" ||
          Date.now() >= this.run.deadlineAt
        )
          return;
        const decision = decisionSchema.parse(raw),
          bounds = this.run.bounds!;
        // A legacy scalar may populate both channels. Only selected adjust
        // channels can carry a target, and rest/finish always carry exact zero.
        for (const c of channels)
          if (decision.action !== "adjust" || !decision.channels.includes(c))
            decision.intensity[c] = 0;
        assert(
          decision.durationSec <= bounds.maxActionSec,
          "AI 单次动作时长超出授权。",
        );
        if (decision.action === "adjust") {
          assert(
            decision.channels.length > 0 &&
              new Set(decision.channels).size === decision.channels.length &&
              decision.channels.every((c) => bounds.channels.includes(c)),
            "AI 使用未授权通道。",
          );
          assert(
            decision.channels.length < 2 || bounds.allowSync,
            "AI 未获得双通道联动权限。",
          );
          assert(
            bounds.waveformIds.includes(decision.waveformId) &&
              decision.channels.every(
                (c) =>
                  decision.intensity[c] >= bounds.minIntensity[c] &&
                  decision.intensity[c] <= bounds.maxIntensity[c],
              ),
            "AI 波形或强度超出授权范围。",
          );
        }
        if (decision.action === "rest")
          assert(bounds.allowRest, "AI 未获得休息控制权限。");
        this.run.lastDecision = decision;
        this.run.thinking = false;
        this.run.feedback.push({
          id: randomUUID(),
          at: Date.now(),
          role: "assistant",
          text: decision.reason,
        });
        this.run.feedback = this.run.feedback.slice(-100);
        this.log(
          "info",
          this.run.owner === "locked-task" ? "上锁任务" : "AI 控制",
          decision.reason,
        );
        if (decision.action === "finish") {
          void this.finish("completed", `AI 判定结束：${decision.reason}`);
          return;
        }
        if (
          decision.stageDurationSec !== undefined &&
          this.run.owner === "locked-task"
        ) {
          const remaining = this.run.deadlineAt - this.run.stageStartedAt;
          assert(
            decision.stageDurationSec * 1000 <= remaining,
            "AI 阶段延时超过最晚截止时间。",
          );
          this.stageDurations.set(
            this.run.stageIndex,
            decision.stageDurationSec,
          );
        }
        if (decision.phaseComplete && this.run.owner === "locked-task")
          this.advanceStage(Date.now());
        else
          this.aiAction = {
            decision,
            expiresAt: Math.min(
              Date.now() + decision.durationSec * 1000,
              this.run.deadlineAt,
            ),
            stageIndex: this.run.stageIndex,
          };
        this.persist();
        this.broadcast(true);
      })
      .catch((error) => {
        if (
          this.run?.id === runId &&
          this.epoch === epoch &&
          this.aiEpoch === aiEpoch &&
          this.run.status === "running"
        )
          void this.finish(
            "faulted",
            `AI 请求或动作校验失败：${error instanceof Error ? error.message : "未知错误"}`,
          );
      })
      .finally(() => {
        if (this.run?.id === runId && this.aiEpoch === aiEpoch) {
          this.run.thinking = false;
          this.broadcast(true);
        }
      });
  }
  private tick() {
    if (this.closed) return;
    const now = Date.now(),
      dt = Math.min((now - this.tickAt) / 1000, 0.5);
    this.tickAt = now;
    if (now - (this.history.at(-1)?.at ?? 0) >= 1000) {
      this.history.push({ at: now, ...this.device.state.intensities });
      if (this.history.length > 180) this.history.shift();
    }
    if (!active(this.run) || this.stopping) {
      this.broadcast();
      return;
    }
    if (now >= this.run!.deadlineAt) {
      void this.finish("completed", "已到达确认的最晚截止时间");
      return;
    }
    if (
      !this.device.state.connected ||
      now - this.device.state.lastSeenAt > 6000
    ) {
      void this.finish("faulted", "设备状态失联或过期");
      return;
    }
    if (this.run!.owner !== "manual" && !this.ai.status.ready) {
      void this.finish(
        "faulted",
        this.ai.status.error || "AI 本地运行时已中断",
      );
      return;
    }
    if (this.run!.status !== "running") {
      this.broadcast();
      return;
    }
    const run = this.run!,
      epoch = this.epoch;
    let desired: Desired;
    if (run.owner === "manual") desired = this.playbackDesired(now);
    else {
      desired =
        run.owner === "locked-task"
          ? this.lockedDesired(now)
          : this.aiAction && this.aiAction.expiresAt > now
            ? this.actionDesired(this.aiAction.decision)
            : this.zeroDesired();
      if (run.status === "running") this.requestDecision(now);
    }
    if (this.stopping || run.status !== "running" || this.epoch !== epoch)
      return;
    for (const channel of channels) {
      const output = desired[channel],
        maximum = this.effectiveLimit(channel);
      if (!this.config[channel].enabled) output.target = 0;
      const authorized = outputLimit(
        this.config,
        { A: 200, B: 200 },
        channel,
        this.synced && run.mode === "single" && run.owner === "manual",
        run.bounds,
      );
      if (
        !Number.isFinite(output.target) ||
        output.target > authorized + 0.001 ||
        output.target < 0
      ) {
        void this.finish("faulted", `${channel} 通道执行目标越界`);
        return;
      }
      output.target = Math.min(output.target, maximum);
      this.levels[channel] = Math.min(this.levels[channel], maximum);
      const rate = Math.min(
        20,
        run.bounds
          ? run.bounds.rampPerSecond[channel]
          : run.mode === "live"
            ? 20
            : this.config[channel].rampPerSecond,
      );
      const difference = output.target - this.levels[channel];
      this.levels[channel] =
        output.target === 0
          ? 0
          : this.levels[channel] +
            Math.sign(difference) * Math.min(Math.abs(difference), rate * dt);
      const target = Math.min(
        maximum,
        Math.floor(this.levels[channel] + 0.0001),
      );
      if (
        !this.intensityBusy[channel] &&
        target !== this.device.state.intensities[channel]
      ) {
        this.intensityBusy[channel] = true;
        void this.device
          .setIntensity(channel, target)
          .catch((error) => {
            if (
              this.epoch === epoch &&
              run.status === "running" &&
              target <= this.effectiveLimit(channel)
            )
              void this.finish("faulted", `强度指令失败：${error.message}`);
          })
          .finally(() => {
            this.intensityBusy[channel] = false;
          });
      }
      if (
        output.target > 0 &&
        now >= this.nextPulse[channel] &&
        !this.pulseBusy[channel]
      ) {
        const wave = run.waveformSnapshots[output.waveformId];
        if (!wave) {
          void this.finish("faulted", "运行引用的波形不存在");
          return;
        }
        if (this.cursorWaves[channel] !== wave.id) {
          this.cursors[channel] = 0;
          this.cursorWaves[channel] = wave.id;
        }
        const remainingFrames = Math.max(
          1,
          Math.min(5, Math.ceil((run.deadlineAt - now) / 100)),
        );
        const frames = Array.from(
          { length: remainingFrames },
          (_, i) =>
            wave.frames[(this.cursors[channel] + i) % wave.frames.length],
        );
        this.cursors[channel] =
          (this.cursors[channel] + remainingFrames) % wave.frames.length;
        this.nextPulse[channel] = now + remainingFrames * 100;
        this.pulseBusy[channel] = true;
        void this.device
          .sendFrames(channel, frames)
          .catch((error) => {
            if (this.epoch === epoch && run.status === "running")
              void this.finish("faulted", `波形指令失败：${error.message}`);
          })
          .finally(() => {
            this.pulseBusy[channel] = false;
          });
      }
    }
    if (now - this.persistedAt >= 1000) {
      this.persistedAt = now;
      this.persist();
    }
    this.broadcast();
  }
  async close() {
    clearInterval(this.timer);
    await this.finish("interrupted", "本地服务关闭");
    this.closed = true;
    this.removeAllListeners();
  }
}
