import { EventEmitter } from "node:events";
import QRCode from "qrcode";
import {
  COYOTE_WAVEFORMS,
  DglabSocket,
  DGLAB_SOCKET_VERSION,
  DGLAB_SOCKET_STATE,
  V3Channel,
  V4Channel,
  type DglabSocketV3Client,
  type DglabSocketV4Client,
  type V4DeviceInfo,
  type V4DevicesGetResult,
} from "dglab-kit";
import type {
  Channel,
  DeviceDriver,
  DeviceState,
  Protocol,
} from "../shared/types.js";

export const DEFAULT_RELAY = {
  v4: "wss://trex.dungeon-lab.cn/v4",
  v3: "wss://ws.dungeon-lab.cn/",
};
const RPC_TIMEOUT = 1_000;
const FRESH_MS = 5_000;
const CHANNELS: Channel[] = ["A", "B"];
const key = (client: string, slot: string) => `${client}\u0000${slot}`;
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function initial(protocol: Protocol = "v4"): DeviceState {
  return {
    protocol,
    relayStatus: "disconnected",
    appStatus: "disconnected",
    connected: false,
    name: "尚未连接设备",
    devices: [],
    intensities: { A: 0, B: 0 },
    limits: { A: 0, B: 0 },
    lastSeenAt: 0,
    canConfirmZero: false,
  };
}

/** Official SDK data only: each frame is 100 ms, compatible with Coyote 3. */
export function getBuiltinWaveforms(): { name: string; frames: string[] }[] {
  return Object.values(COYOTE_WAVEFORMS).map((w) => ({
    name: w.label.cn,
    frames: [...w.raw],
  }));
}

function merge(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...current };
  for (const [k, v] of Object.entries(patch))
    result[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? merge(record(current[k]), record(v))
        : v;
  return result;
}

/** Real outputs require fresh APP telemetry; simulator is explicitly selected by the user. */
export class CoyoteDevice extends EventEmitter implements DeviceDriver {
  state = initial();
  private socket?: DglabSocketV3Client | DglabSocketV4Client;
  private devices = new Map<string, V4DeviceInfo>();
  private timer?: ReturnType<typeof setInterval>;
  private epoch = 0;
  private polling = false;
  private pollGeneration = 0;
  private stopping = false;
  private stopPromise?: Promise<boolean>;
  private hadDeviceSession = false;
  private stopCertified = false;
  private stopFailed = false;
  private failedReports: Record<Channel, number> = { A: 0, B: 0 };
  private outputRevision = 0;
  private outputsInFlight = 0;
  private reportSequence = 0;
  private reported: Record<Channel, number> = { A: 0, B: 0 };
  private reportedAt: Record<Channel, number> = { A: 0, B: 0 };
  private reportedOutput: Record<Channel, number> = { A: -1, B: -1 };
  private lane: Record<Channel, Promise<unknown>> = {
    A: Promise.resolve(),
    B: Promise.resolve(),
  };

  private publish() {
    this.emit("state", this.state);
  }
  private fault(message: string) {
    this.state.connected = false;
    this.state.canConfirmZero = false;
    this.state.error = message;
    this.publish();
  }
  private reportIntensities(props: Record<string, unknown>) {
    for (const channel of CHANNELS) {
      const value = props[`intensity${channel}`];
      if (!number(value)) continue;
      this.reported[channel] = ++this.reportSequence;
      this.reportedAt[channel] = Date.now();
      this.reportedOutput[channel] = this.outputRevision;
      if (value !== 0) this.stopCertified = false;
    }
    // Slot metadata and one-channel patches cannot refresh the other channel.
    this.state.lastSeenAt = Math.min(this.reportedAt.A, this.reportedAt.B);
  }
  private beginOutput() {
    ++this.outputRevision;
    this.stopCertified = false;
  }
  private invalidateTelemetry() {
    this.stopCertified = false;
    this.reportedAt = { A: 0, B: 0 };
    this.reportedOutput = { A: -1, B: -1 };
    this.state.lastSeenAt = 0;
    this.state.connected = false;
    this.state.canConfirmZero = false;
  }
  private identifyV3Session(clientId: string) {
    // Pairing already establishes a real session; initial UI zeros are not proof.
    this.hadDeviceSession = true;
    this.state.clientId = clientId;
    this.state.slotId = "v3-coyote";
    this.state.error = "等待设备强度回传";
  }

  async connect(options: {
    protocol: Protocol;
    relayUrl?: string;
  }): Promise<void> {
    if (!["v4", "v3", "simulator"].includes(options.protocol))
      throw new Error("不支持的设备协议");
    await this.disconnect();
    if (this.stopCertified) {
      this.hadDeviceSession = false;
      this.stopFailed = false;
    }
    this.stopCertified = false;
    this.reported = { A: 0, B: 0 };
    this.reportedAt = { A: 0, B: 0 };
    this.reportedOutput = { A: -1, B: -1 };
    const connectionEpoch = ++this.epoch;
    this.state = initial(options.protocol);
    this.state.relayStatus = "connecting";
    this.publish();
    if (options.protocol === "simulator") {
      this.state = {
        ...initial("simulator"),
        relayStatus: "connected",
        appStatus: "paired",
        connected: true,
        name: "模拟郊狼 · 不连接实体设备",
        clientId: "simulator",
        slotId: "coyote-sim",
        devices: [
          {
            clientId: "simulator",
            slotId: "coyote-sim",
            name: "模拟郊狼",
            type: "COYOTE_030",
          },
        ],
        limits: { A: 200, B: 200 },
        lastSeenAt: Date.now(),
        latencyMs: 0,
        canConfirmZero: true,
      };
      this.timer = setInterval(() => {
        this.state.lastSeenAt = Date.now();
        this.publish();
      }, 1_000);
      this.timer.unref();
      this.publish();
      return;
    }
    let relay: URL;
    try {
      relay = new URL(
        options.relayUrl?.trim() || DEFAULT_RELAY[options.protocol],
      );
      if (
        !["ws:", "wss:"].includes(relay.protocol) ||
        relay.username ||
        relay.password
      )
        throw new Error();
      // A controller endpoint must not contain another controller's pairing query.
      relay.searchParams.delete("tid");
      relay.searchParams.delete("targetId");
    } catch {
      this.state.relayStatus = "fault";
      this.fault("中继地址必须是有效的 ws:// 或 wss:// URL");
      throw new Error(this.state.error);
    }
    const socket = new DglabSocket({
      url: relay.toString(),
      connectTimeout: 8_000,
      responseTimeout: RPC_TIMEOUT,
      version:
        options.protocol === "v3"
          ? DGLAB_SOCKET_VERSION.V3
          : DGLAB_SOCKET_VERSION.V4,
    });
    this.socket = socket;
    const current = () =>
      this.socket === socket && this.epoch === connectionEpoch;
    // Output epochs change on stop; connection identity remains valid afterwards.
    const active = () => this.socket === socket;
    socket.on("state", (state) => {
      if (!active()) return;
      if (
        state === DGLAB_SOCKET_STATE.WaitingForPeer ||
        state === DGLAB_SOCKET_STATE.Paired
      ) {
        const appStatus =
          state === DGLAB_SOCKET_STATE.Paired ? "paired" : "waiting";
        if (
          state === DGLAB_SOCKET_STATE.Paired &&
          this.state.appStatus !== appStatus
        )
          this.invalidateTelemetry();
        this.state.relayStatus = "connected";
        this.state.appStatus = appStatus;
        if (
          state === DGLAB_SOCKET_STATE.Paired &&
          this.state.protocol === "v3"
        ) {
          const clientId = (socket as DglabSocketV3Client).pairedClientId;
          if (clientId) this.identifyV3Session(clientId);
        }
      } else if (
        state === DGLAB_SOCKET_STATE.Disconnected ||
        state === DGLAB_SOCKET_STATE.Idle
      ) {
        this.state.relayStatus = "disconnected";
        this.state.appStatus = "disconnected";
        this.state.connected = false;
        this.state.canConfirmZero = false;
      }
      this.publish();
    });
    socket.on("error", (error) => {
      if (active()) {
        this.state.relayStatus = "fault";
        this.fault(error instanceof Error ? error.message : "中继协议错误");
      }
    });
    socket.on("close", () => {
      if (active()) {
        this.state.relayStatus = "disconnected";
        this.state.appStatus = "disconnected";
        this.fault("中继连接已断开");
      }
    });
    socket.on("client-attached", (clientId) => {
      if (!active()) return;
      this.invalidateTelemetry();
      this.state.appStatus = "paired";
      if (this.state.protocol === "v3") {
        this.identifyV3Session(
          (socket as DglabSocketV3Client).pairedClientId ?? clientId,
        );
      }
      this.publish();
      if (this.state.protocol === "v4")
        void this.refresh(clientId).catch((error) => this.fault(String(error)));
    });
    socket.on("client-disconnected", (clientId) => {
      if (!active()) return;
      for (const [k, device] of this.devices)
        if (k.startsWith(`${clientId}\u0000`)) this.devices.delete(k);
      this.updateDeviceList();
      if (this.state.clientId === clientId) {
        this.state.appStatus = "disconnected";
        this.fault("APP 已断开");
      }
    });
    socket.on("devices", (devices, clientId) => {
      if (!active() || this.state.protocol !== "v4") return;
      this.acceptDevices(
        clientId,
        devices.filter((d): d is V4DeviceInfo => "slotId" in d),
        false,
      );
    });
    socket.on("device", (event, clientId) => {
      if (!active() || this.state.protocol !== "v4" || !("slotId" in event))
        return;
      const k = key(clientId, event.slotId);
      if (event.removed) {
        this.devices.delete(k);
        this.updateDeviceList();
        if (
          this.state.clientId === clientId &&
          this.state.slotId === event.slotId
        ) {
          this.stopCertified = false;
          this.fault("所选设备已被移除");
        }
        return;
      }
      const previous = this.devices.get(k);
      if (!previous && (!event.type || !event.name)) return;
      const next = merge(
        record(previous),
        record(event),
      ) as unknown as V4DeviceInfo;
      this.devices.set(k, next);
      this.updateDeviceList();
      if (
        this.state.clientId === clientId &&
        this.state.slotId === event.slotId
      )
        this.applyDevice(next, record(event.props));
    });
    socket.on("data", (data, clientId) => {
      if (!active()) return;
      if (this.state.protocol === "v3") {
        if (typeof data === "string")
          this.acceptV3(
            data,
            clientId || (socket as DglabSocketV3Client).pairedClientId,
          );
        return;
      }
      const payload = record(data);
      const source =
        payload.ev === "devices.snapshot" ? payload : record(payload.result);
      if (clientId && Array.isArray(source.devices))
        this.acceptDevices(clientId, source.devices as V4DeviceInfo[], true);
    });
    try {
      const { targetId } = await socket.connect();
      if (!current()) throw new Error("连接操作已取消");
      this.state.targetId = targetId;
      const appSocket = new URL(relay);
      if (options.protocol === "v4")
        appSocket.searchParams.set("tid", targetId);
      else
        appSocket.pathname = `${appSocket.pathname.replace(/\/$/, "")}/${encodeURIComponent(targetId)}`;
      this.state.pairingUrl = `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(appSocket.toString())}`;
      this.state.qrUrl = await QRCode.toDataURL(this.state.pairingUrl, {
        margin: 2,
        width: 288,
        errorCorrectionLevel: "M",
      });
      if (!current()) return;
      this.timer = setInterval(() => void this.heartbeat(), 1_000);
      this.timer.unref();
      this.publish();
    } catch (error) {
      if (active()) {
        this.state.relayStatus = "fault";
        this.fault(error instanceof Error ? error.message : "连接失败");
        socket.destroy();
        this.socket = undefined;
      }
      throw error;
    }
  }

  private updateDeviceList() {
    this.state.devices = [...this.devices]
      .filter(([, d]) => d.type === "COYOTE_030")
      .map(([k, d]) => ({
        clientId: k.split("\u0000")[0]!,
        slotId: d.slotId,
        name: d.name,
        type: d.type,
      }));
    this.publish();
  }
  private acceptDevices(
    clientId: string,
    devices: V4DeviceInfo[],
    fresh: boolean,
  ) {
    const selected = devices.find(
      (d) => d.slotId === this.state.slotId && clientId === this.state.clientId,
    );
    for (const [k] of this.devices)
      if (k.startsWith(`${clientId}\u0000`)) this.devices.delete(k);
    for (const device of devices)
      this.devices.set(key(clientId, device.slotId), device);
    this.updateDeviceList();
    if (selected)
      this.applyDevice(selected, fresh ? record(selected.props) : undefined);
    else if (this.state.clientId === clientId && this.state.slotId) {
      this.stopCertified = false;
      this.fault("所选设备不在 APP 当前设备列表中");
    }
  }
  private applyDevice(
    device: V4DeviceInfo,
    reportedProps?: Record<string, unknown>,
  ) {
    const props = record(device.props);
    const slot = record(device.slotState);
    this.state.name = device.name;
    for (const channel of CHANNELS) {
      const value = props[`intensity${channel}`];
      const limit = record(slot[`channel${channel}`]).intensityMax;
      this.state.limits[channel] = number(limit)
        ? Math.min(200, Math.floor(limit))
        : 0;
      if (number(value)) this.state.intensities[channel] = Math.floor(value);
    }
    const telemetry = number(props.intensityA) && number(props.intensityB);
    if (reportedProps) this.reportIntensities(reportedProps);
    const fault =
      slot.hasDevice !== true ||
      props.connectState === "disconnected" ||
      props.channelAStatus === 3 ||
      props.channelBStatus === 3;
    if (fault) this.stopCertified = false;
    this.state.connected =
      !fault &&
      telemetry &&
      this.state.relayStatus === "connected" &&
      this.state.appStatus === "paired";
    this.state.canConfirmZero =
      this.state.connected && Date.now() - this.state.lastSeenAt < FRESH_MS;
    this.state.error = fault
      ? "设备未连接或通道故障"
      : !telemetry
        ? "等待设备强度回传"
        : undefined;
    this.publish();
  }
  private acceptV3(message: string, clientId?: string) {
    const match = /^strength-(\d+)\+(\d+)\+(\d+)\+(\d+)$/.exec(message);
    if (!match || !clientId) return;
    this.hadDeviceSession = true;
    this.state.clientId = clientId;
    this.state.slotId = "v3-coyote";
    this.state.devices = [
      {
        clientId,
        slotId: "v3-coyote",
        name: "郊狼 3 · V3 兼容模式",
        type: "COYOTE_030",
      },
    ];
    this.state.name = this.state.devices[0]!.name;
    this.state.intensities = { A: Number(match[1]), B: Number(match[2]) };
    this.state.limits = {
      A: Math.min(200, Number(match[3])),
      B: Math.min(200, Number(match[4])),
    };
    this.reportIntensities({
      intensityA: this.state.intensities.A,
      intensityB: this.state.intensities.B,
    });
    this.state.connected =
      this.state.relayStatus === "connected" &&
      this.state.appStatus === "paired";
    this.state.canConfirmZero = this.state.connected;
    this.state.error = undefined;
    this.publish();
  }
  private async refresh(clientId: string) {
    const socket = this.socket as DglabSocketV4Client | undefined;
    if (!socket) return;
    const start = Date.now();
    const result = await socket.send<
      { t: string; m: string },
      V4DevicesGetResult
    >(clientId, { t: "req", m: "devices.get" }, { timeout: RPC_TIMEOUT });
    if (this.socket === socket) this.state.latencyMs = Date.now() - start;
    return result;
  }
  private async heartbeat() {
    if (this.polling || !this.socket) return;
    const socket = this.socket,
      epoch = this.epoch;
    const current = () => this.socket === socket && this.epoch === epoch;
    if (this.state.protocol === "v4" && this.state.clientId) {
      const pollGeneration = ++this.pollGeneration;
      this.polling = true;
      try {
        await this.refresh(this.state.clientId);
      } catch (error) {
        if (current())
          this.fault(
            error instanceof Error ? error.message : "APP 状态获取失败",
          );
      } finally {
        if (this.pollGeneration === pollGeneration) this.polling = false;
      }
    }
    if (
      current() &&
      this.state.connected &&
      Date.now() - this.state.lastSeenAt > FRESH_MS
    )
      this.fault("设备状态已过期，请重新连接");
  }

  async selectDevice(clientId: string, slotId: string): Promise<void> {
    if (this.stopping) throw new Error("设备正在停止");
    if (this.state.protocol === "simulator") {
      if (clientId !== "simulator" || slotId !== "coyote-sim")
        throw new Error("模拟设备不存在");
      return;
    }
    if (this.state.protocol === "v3") {
      if (
        clientId !==
          (this.socket as DglabSocketV3Client | undefined)?.pairedClientId ||
        slotId !== "v3-coyote"
      )
        throw new Error("V3 仅支持当前已配对设备");
      return;
    }
    const device = this.devices.get(key(clientId, slotId));
    if (!device) throw new Error("设备不存在，请刷新设备列表");
    if (device.type !== "COYOTE_030")
      throw new Error("本版本波形仅兼容 COYOTE_030 郊狼 3");
    this.state.clientId = clientId;
    this.state.slotId = slotId;
    this.hadDeviceSession = true;
    this.stopCertified = false;
    this.reportedAt = { A: 0, B: 0 };
    this.reportedOutput = { A: -1, B: -1 };
    this.state.lastSeenAt = 0;
    this.applyDevice(device);
    await this.refresh(clientId);
  }
  private assertReady() {
    if (this.stopping) throw new Error("设备正在停止");
    if (!this.state.connected || Date.now() - this.state.lastSeenAt > FRESH_MS)
      throw new Error("设备未连接或状态已过期");
  }
  private waitReported(
    predicate: () => boolean,
    after: Partial<Record<Channel, number>>,
    timeout = RPC_TIMEOUT,
  ): Promise<boolean> {
    const confirmed = () =>
      CHANNELS.every(
        (channel) =>
          after[channel] === undefined ||
          this.reported[channel] > after[channel]!,
      ) && predicate();
    if (confirmed()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const listener = () => {
        if (confirmed()) finish(true);
      };
      const timer = setTimeout(() => finish(false), timeout);
      const finish = (result: boolean) => {
        clearTimeout(timer);
        this.off("state", listener);
        resolve(result);
      };
      this.on("state", listener);
    });
  }
  async setIntensity(channel: Channel, target: number): Promise<void> {
    if (
      !CHANNELS.includes(channel) ||
      !Number.isInteger(target) ||
      target < 0 ||
      target > this.state.limits[channel]
    )
      throw new Error("目标强度超出设备范围");
    this.assertReady();
    const epoch = this.epoch;
    const job = this.lane[channel]
      .catch(() => {})
      .then(async () => {
        if (epoch !== this.epoch) throw new Error("动作已被停止操作废弃");
        this.assertReady();
        // Telemetry can lower a ceiling while this command waits for its lane.
        if (target > this.state.limits[channel])
          throw new Error("目标强度超出设备当前范围，已废弃排队指令");
        if (this.state.protocol === "simulator") {
          this.state.intensities[channel] = target;
          this.state.lastSeenAt = Date.now();
          this.publish();
          return;
        }
        if (target === this.state.intensities[channel]) return;
        const after = { [channel]: this.reported[channel] };
        this.beginOutput();
        ++this.outputsInFlight;
        try {
          if (this.state.protocol === "v4") {
            const socket = this.socket as DglabSocketV4Client;
            const c = channel === "A" ? V4Channel.A : V4Channel.B;
            const { clientId, slotId } = this.state;
            if (target === 0)
              await socket.resetIntensity(clientId!, slotId!, c, {
                timeout: RPC_TIMEOUT,
              });
            else
              await socket.addIntensity(
                clientId!,
                slotId!,
                c,
                target - this.state.intensities[channel],
                { timeout: RPC_TIMEOUT },
              );
            if (epoch !== this.epoch) throw new Error("动作已被停止操作废弃");
            await this.refresh(clientId!);
          } else
            (this.socket as DglabSocketV3Client).setStrength(
              channel === "A" ? V3Channel.A : V3Channel.B,
              target,
            );
          const confirmed = await this.waitReported(
            () =>
              this.state.connected &&
              this.state.intensities[channel] === target,
            after,
          );
          if (epoch !== this.epoch) throw new Error("动作已被停止操作废弃");
          if (!confirmed) throw new Error("强度回传未确认，指令未自动重试");
        } finally {
          --this.outputsInFlight;
        }
      });
    this.lane[channel] = job;
    return job;
  }
  async sendFrames(channel: Channel, frames: string[]): Promise<void> {
    this.assertReady();
    if (
      !CHANNELS.includes(channel) ||
      !Array.isArray(frames) ||
      frames.length < 1 ||
      frames.length > 5 ||
      frames.some((f) => !/^[0-9a-f]{16}$/i.test(f))
    )
      throw new Error("单次仅允许 1–5 个郊狼 3 帧（最多 500ms）");
    if (this.state.protocol === "simulator") return;
    // Pulses do not raise strength, but queued frames still require clearing.
    this.stopCertified = false;
    if (this.state.protocol === "v4") {
      await (this.socket as DglabSocketV4Client).sendPulse(
        this.state.clientId!,
        this.state.slotId!,
        channel === "A" ? V4Channel.A : V4Channel.B,
        frames.length * 100,
        frames,
        { timeout: RPC_TIMEOUT, version: 3, immediate: true },
      );
    } else
      (this.socket as DglabSocketV3Client).sendPulse({
        channel,
        time: frames.length / 10,
        data: frames,
      });
  }

  stop(): Promise<boolean> {
    if (this.stopPromise) return this.stopPromise;
    ++this.epoch;
    this.stopping = true;
    this.stopPromise = this.performStop().finally(() => {
      this.stopping = false;
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }
  private async performStop(): Promise<boolean> {
    if (this.state.protocol === "simulator" && this.state.connected) {
      this.state.intensities = { A: 0, B: 0 };
      this.state.lastSeenAt = Date.now();
      this.publish();
      this.stopCertified = true;
      this.stopFailed = false;
      return true;
    }
    // This certificate comes only from a completed stop, and every subsequent
    // output command or nonzero device report invalidates it. It survives a
    // later disconnect without inventing new physical readings.
    if (this.stopCertified) return true;
    if (!this.hadDeviceSession && !this.state.clientId && !this.state.slotId)
      return true;
    const socket = this.socket;
    if (
      !socket ||
      this.state.appStatus !== "paired" ||
      !this.state.clientId ||
      !this.state.slotId
    ) {
      this.stopFailed = true;
      this.failedReports = { ...this.reported };
      this.state.canConfirmZero = false;
      this.state.error = `停止未确认：${!socket || this.state.relayStatus !== "connected" ? "中继已断开" : this.state.appStatus !== "paired" ? "APP 未配对或已断开" : "所选设备身份缺失"}；请在官方 APP 确认 A/B 均为 0 后重新连接并重试停止`;
      this.publish();
      return false;
    }
    const after = { ...this.reported };
    let v4Confirmed: boolean | undefined;
    const reusableV3Zero =
      this.state.connected &&
      this.state.canConfirmZero &&
      Date.now() - this.state.lastSeenAt < FRESH_MS &&
      this.state.intensities.A === 0 &&
      this.state.intensities.B === 0 &&
      CHANNELS.every((c) => this.reportedOutput[c] === this.outputRevision) &&
      this.outputsInFlight === 0 &&
      (!this.stopFailed ||
        CHANNELS.every((c) => this.reported[c] > this.failedReports[c]));
    let stage = "清队列确认";
    try {
      if (this.state.protocol === "v4") {
        const v4 = socket as DglabSocketV4Client;
        const { clientId, slotId } = this.state;
        // Clear must be acknowledged before zeros are enqueued; otherwise clear can cancel zeros.
        await v4.send(
          clientId!,
          { t: "req", m: "device.op.clear", data: { s: slotId } },
          { timeout: RPC_TIMEOUT },
        );
        stage = "A 通道归零确认";
        await v4.resetIntensity(clientId!, slotId!, V4Channel.A, {
          timeout: RPC_TIMEOUT,
        });
        stage = "B 通道归零确认";
        await v4.resetIntensity(clientId!, slotId!, V4Channel.B, {
          timeout: RPC_TIMEOUT,
        });
        stage = "归零状态查询";
        const result = await this.refresh(clientId!);
        const selected = result?.devices?.find(
          (device) => device.slotId === slotId,
        );
        const props = record(record(selected).props);
        // Correlate evidence with this query, issued only after both reset
        // ACKs. A delayed heartbeat response or unrelated patch is not proof.
        v4Confirmed =
          this.socket === socket &&
          this.state.clientId === clientId &&
          this.state.slotId === slotId &&
          this.state.connected &&
          props.intensityA === 0 &&
          props.intensityB === 0 &&
          this.state.intensities.A === 0 &&
          this.state.intensities.B === 0;
      } else {
        stage = "发送 V3 清队列与归零命令";
        const v3 = socket as DglabSocketV3Client;
        // Legacy V3 has no clear RPC ACK or telemetry query. An unchanged zero
        // may produce no new strength event. Only reuse actual fresh dual-zero
        // telemetry when no strength command has been issued since that report.
        v3.clearPulse(V3Channel.A);
        v3.clearPulse(V3Channel.B);
        v3.setStrength(V3Channel.A, 0);
        v3.setStrength(V3Channel.B, 0);
      }
      const confirmed =
        v4Confirmed ??
        (reusableV3Zero ||
          (await this.waitReported(
            () =>
              this.socket === socket &&
              this.state.connected &&
              this.state.intensities.A === 0 &&
              this.state.intensities.B === 0,
            after,
          )));
      this.stopCertified = confirmed;
      this.stopFailed = !confirmed;
      if (!confirmed) {
        this.failedReports = { ...this.reported };
        this.state.canConfirmZero = false;
        this.state.error =
          this.state.protocol === "v4"
            ? "停止未确认：停止后的设备查询未回传所选设备双通道归零状态"
            : "停止未确认：未收到设备双通道归零回传；V3 无查询和清队列确认接口，请在官方 APP 检查 A/B 并重新连接后重试";
        this.publish();
      }
      return confirmed;
    } catch (error) {
      this.stopCertified = false;
      this.stopFailed = true;
      this.failedReports = { ...this.reported };
      this.state.canConfirmZero = false;
      this.state.error = `停止未确认：${stage}失败（${error instanceof Error ? error.message : "APP 无响应"}）；请在官方 APP 检查 A/B 强度后重试停止`;
      this.publish();
      return false;
    }
  }
  async disconnect(): Promise<void> {
    if (
      this.socket ||
      (this.state.protocol === "simulator" && this.state.connected)
    )
      await this.stop();
    ++this.epoch;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.devices.clear();
    ++this.pollGeneration;
    this.polling = false;
    // Preserve last physical readings, rather than falsely reporting disconnected hardware as zero.
    this.state = {
      ...this.state,
      relayStatus: "disconnected",
      appStatus: "disconnected",
      connected: false,
      devices: [],
      canConfirmZero: false,
      qrUrl: undefined,
      pairingUrl: undefined,
    };
    this.publish();
  }
  async dispose() {
    await this.disconnect();
    this.removeAllListeners();
  }
}
