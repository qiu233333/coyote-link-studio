import { useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Cable,
  ChevronRight,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  GripVertical,
  Heart,
  History,
  Import,
  Layers3,
  ListMusic,
  Minus,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Shuffle,
  SkipForward,
  SlidersHorizontal,
  Square,
  Timer,
  Trash2,
  Unplug,
  Waves,
  Wifi,
  X,
} from "lucide-react";
import type {
  AppSnapshot,
  Channel,
  ChannelConfig,
  ControlBounds,
  PlaybackConfig,
  Protocol,
  RandomConfig,
  Stage,
  Waveform,
} from "../shared/types";
import {
  type Action,
  clockTime,
  duration,
  isActive,
  ownerNames,
  requestId,
  timeLeft,
} from "./api";
import {
  playbackChannelsLimit,
  playbackConfigIssue,
  stageDraftIssue,
} from "./playbackLimits";
import { StageIntensityScale } from "./StageIntensityScale";
import { useStageIntensityScaling } from "./stageIntensityScaling";
import { useLiveChannels } from "./useLiveChannels";
import { MAX_WAVEFORM_FILE_BYTES } from "../shared/waveformImport";
import {
  WaveMetadata,
  Badge,
  Card,
  ChannelChips,
  Empty,
  Field,
  IconButton,
  Modal,
  NumberInput,
  Toggle,
  WaveGraph,
  WaveSelect,
  defaultStage,
} from "./ui";

type ConsoleProps = {
  state: AppSnapshot;
  action: Action;
  pending: boolean;
  onNavigateAI: () => void;
};
const tabs = [
  { id: "live", label: "实时控制", icon: SlidersHorizontal },
  { id: "waves", label: "波形库", icon: Waves },
  { id: "playlist", label: "播放列表", icon: ListMusic },
  { id: "stages", label: "阶段编排", icon: Layers3 },
  { id: "random", label: "随机控制", icon: Shuffle },
  { id: "logs", label: "运行记录", icon: History },
] as const;
type Tab = (typeof tabs)[number]["id"];

export default function ConsolePage({
  state,
  action,
  pending,
  onNavigateAI,
}: ConsoleProps) {
  const [tab, setTab] = useState<Tab>("live");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [confirmConfig, setConfirmConfig] = useState<PlaybackConfig | null>(
    null,
  );
  const active = isActive(state);
  const otherOwner = active && state.owner !== "manual";
  const blocked =
    state.locked || otherOwner || state.stopping || state.stopUnconfirmed;
  const canPlay = !blocked && state.device.connected;
  const running = active && state.owner === "manual";
  const liveActive = running && state.run?.mode === "live";
  const otherManualMode = running && !liveActive;
  const { patch: patchLive, pending: pendingChannels } =
    useLiveChannels(action);
  const liveChannels = (["A", "B"] as Channel[]).filter(
    (channel) =>
      pendingChannels[channel]?.enabled ?? state.channels[channel].enabled,
  );
  const missingWave = liveChannels.filter(
    (channel) =>
      !state.waveforms.some(
        (wave) =>
          wave.id ===
          (pendingChannels[channel]?.waveformId ??
            state.channels[channel].waveformId),
      ),
  );
  const liveIssue = state.locked
    ? "任务锁定中，实时控制仅可查看。"
    : otherOwner
      ? "其他控制方正在运行，请先停止并接管为手动。"
      : state.stopping
        ? "设备正在停止，请等待归零确认。"
        : state.stopUnconfirmed
          ? "设备停止尚未确认，请重新连接并清理。"
          : !state.device.connected
            ? "连接设备后即可开始实时播放。"
            : otherManualMode
              ? "其他播放模式正在运行，请先停止后使用实时控制。"
              : !liveChannels.length
                ? "请先启用至少一个通道。"
                : missingWave.length
                  ? `请先为 ${missingWave.join(" / ")} 通道选择波形。`
                  : null;
  const confirmationIssue = confirmConfig
    ? playbackConfigIssue(state, confirmConfig)
    : null;

  return (
    <div className="page-content">
      <div className="section-title">
        <div>
          <span className="eyebrow">YOUR PERSONAL CONTROL SPACE</span>
          <h1>
            控制台<span className="title-dot">.</span>
          </h1>
          <p>连接设备，让每一次变化都恰到好处。</p>
        </div>
        <button
          className="button secondary"
          onClick={() => setConnectionOpen(true)}
          disabled={state.locked}
        >
          <Cable size={16} />
          连接管理
          <ChevronRight size={14} />
        </button>
      </div>
      <section className="connection-strip glass-card">
        <div className="device-orb">
          <Radio size={24} />
        </div>
        <div className="connection-primary">
          <strong>
            {state.device.connected
              ? state.device.name || "郊狼已连接"
              : "等待连接你的郊狼"}
          </strong>
          <span>
            {state.device.protocol === "simulator"
              ? "模拟设备 · 不产生真实输出"
              : `${state.device.protocol.toUpperCase()} 协议 · ${state.device.connected ? "设备已就绪" : "扫码配对后开始控制"}`}
          </span>
        </div>
        <div className="connection-steps">
          <span
            className={state.device.relayStatus === "connected" ? "online" : ""}
          >
            <i />
            中继
          </span>
          <span className={state.device.appStatus === "paired" ? "online" : ""}>
            <i />
            APP
          </span>
          <span className={state.device.connected ? "online" : ""}>
            <i />
            设备
          </span>
        </div>
        <div className="connection-metric">
          <span>当前控制方</span>
          <strong>{active ? ownerNames[state.owner] : "待机"}</strong>
        </div>
        <div className="connection-metric latency">
          <span>连接延迟</span>
          <strong>
            {state.device.latencyMs == null
              ? "—"
              : `${state.device.latencyMs} ms`}
          </strong>
        </div>
        <button
          className="text-button"
          onClick={() => setConnectionOpen(true)}
          disabled={state.locked}
        >
          {state.device.connected ? "查看连接" : "连接设备"}
          <ChevronRight size={14} />
        </button>
      </section>
      {otherOwner && (
        <div className={`notice ${state.locked ? "notice-pink" : ""}`}>
          <ShieldCheck size={18} />
          <span>
            {state.locked
              ? "任务锁定中。控制台仅可查看，文字反馈和紧急停止始终可用。"
              : "AI 正在控制设备。你可以查看状态，或先停止 AI 后接管。"}
          </span>
          <button className="text-button" onClick={onNavigateAI}>
            进入 {state.locked ? "上锁任务" : "AI 控制"}
            <ChevronRight size={14} />
          </button>
          {!state.locked && (
            <button
              className="button small secondary"
              disabled={pending}
              onClick={() =>
                void action(
                  "/api/console/takeover",
                  {},
                  "POST",
                  "已停止 AI 并切回控制台",
                )
              }
            >
              接管为手动
            </button>
          )}
        </div>
      )}
      <nav className="console-tabs" aria-label="控制台功能">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={16} />
            {item.label}
            {item.id === "waves" && (
              <span className="tab-count">{state.waveforms.length}</span>
            )}
          </button>
        ))}
      </nav>
      {tab === "live" && (
        <>
          <div className="live-layout live-controls">
            <div>
              <div className="subsection-heading">
                <h2>
                  <Activity size={18} />
                  双通道控制
                </h2>
                <button
                  className="button primary live-play-button"
                  aria-label="实时播放控制"
                  disabled={
                    liveActive && state.run?.status === "running"
                      ? blocked
                      : pending ||
                        Object.keys(pendingChannels).length > 0 ||
                        !!liveIssue
                  }
                  onClick={() =>
                    void action(
                      liveActive && state.run?.status === "running"
                        ? "/api/console/pause"
                        : "/api/console/live/start",
                      liveActive && state.run?.status === "running"
                        ? {}
                        : { requestId: requestId() },
                    )
                  }
                >
                  {liveActive && state.run?.status === "running" ? (
                    <Pause size={16} />
                  ) : (
                    <Play size={16} />
                  )}
                  {liveActive
                    ? state.run?.status === "paused"
                      ? "继续播放"
                      : "暂停播放"
                    : "开始播放"}
                </button>
              </div>
              <div className="channel-grid">
                {(["A", "B"] as Channel[]).map((channel) => (
                  <ChannelCard
                    key={channel}
                    channel={channel}
                    state={state}
                    disabled={
                      blocked || otherManualMode || !state.device.connected
                    }
                    pendingConfig={pendingChannels[channel]}
                    onPatch={(part) => patchLive({ [channel]: part })}
                  />
                ))}
              </div>
              <div className="help-line">
                <ShieldCheck size={14} />
                <span>
                  A / B
                  独立控制，强度上限随设备回传更新。播放时修改立即生效，暂停时只更新设置。
                </span>
              </div>
              {liveIssue && (
                <p className="playback-issue" role="status">
                  {liveIssue}
                </p>
              )}
            </div>
          </div>
          <div className="live-bottom">
            <Monitor state={state} />
            <Card
              title="正在运行"
              eyebrow="NOW PLAYING"
              icon={<Play size={17} />}
              className="now-playing"
            >
              <RunPlayer state={state} action={action} pending={pending} />
              <div className="quick-waves">
                <span className="muted small-text">探索波形</span>
                {state.waveforms.slice(0, 2).map((w) => (
                  <button key={w.id} onClick={() => setTab("waves")}>
                    <span className="mini-wave">
                      <Waves size={17} />
                    </span>
                    <span>
                      <strong>{w.name}</strong>
                      <small>
                        {(w.durationMs / 1000).toFixed(1)}s · {w.frames.length}{" "}
                        帧
                      </small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
            </Card>
          </div>
        </>
      )}
      {tab === "waves" && (
        <WaveLibrary
          state={state}
          action={action}
          disabled={blocked || pending}
        />
      )}
      {(tab === "playlist" || tab === "stages") && (
        <SequenceEditor
          key={tab}
          mode={tab}
          state={state}
          action={action}
          disabled={blocked || running || pending}
          canPlay={canPlay && !pending && !running}
          onPlay={setConfirmConfig}
        />
      )}
      {tab === "random" && (
        <RandomPanel
          state={state}
          disabled={blocked || running || pending}
          canPlay={canPlay && !pending && !running}
          onPlay={setConfirmConfig}
        />
      )}
      {tab === "logs" && <LogsPanel state={state} />}
      {connectionOpen && (
        <Modal title="设备连接管理" onClose={() => setConnectionOpen(false)}>
          <DevicePanel
            state={state}
            action={action}
            disabled={state.locked || pending || active}
          />
        </Modal>
      )}
      {confirmConfig && (
        <Modal title="确认开始播放" onClose={() => setConfirmConfig(null)}>
          <div className="notice">
            <ShieldCheck size={18} />
            <span>请确认设备和通道设置。开始后可随时暂停或停止。</span>
          </div>
          <div className="review-grid">
            <div>
              <span>模式</span>
              <strong>
                {
                  {
                    single: "单波形",
                    playlist: "播放列表",
                    stages: "阶段编排",
                    random: "受限随机",
                  }[confirmConfig.mode]
                }
              </strong>
            </div>
            <div>
              <span>最长运行</span>
              <strong>{duration(confirmConfig.durationSec)}</strong>
            </div>
            <div>
              <span>A 通道强度上限</span>
              <strong>{state.device.limits.A}</strong>
            </div>
            <div>
              <span>B 通道强度上限</span>
              <strong>{state.device.limits.B}</strong>
            </div>
          </div>
          <p className="field-hint">
            强度上限由设备回传，所选通道均受各自上限约束。
          </p>
          {confirmConfig.random && (
            <p className="muted">
              {confirmConfig.random.channels
                .map(
                  (channel) =>
                    `${channel} 强度 ${confirmConfig.random!.minIntensity[channel]}–${confirmConfig.random!.maxIntensity[channel]}`,
                )
                .join(" · ")}{" "}
              · {confirmConfig.random.waveformIds.length} 个授权波形 · 每{" "}
              {confirmConfig.random.minIntervalSec}–
              {confirmConfig.random.maxIntervalSec} 秒变化
            </p>
          )}
          {!confirmConfig.random && (
            <div
              className="playback-stage-review"
              aria-label="播放阶段强度确认"
            >
              {confirmConfig.stages.map((stage) => (
                <p key={stage.id}>
                  <strong>{stage.name}</strong>
                  {" · "}
                  {stage.behavior === "rest"
                    ? "归零休息"
                    : stage.channels
                        .map(
                          (channel) =>
                            `${channel} ${stage.behavior === "ramp" ? `${stage.startIntensity[channel]} → ` : ""}${stage.intensity[channel]}`,
                        )
                        .join(" · ")}
                </p>
              ))}
            </div>
          )}
          {confirmationIssue && (
            <p className="playback-issue" role="status">
              {confirmationIssue}
            </p>
          )}
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setConfirmConfig(null)}
            >
              返回修改
            </button>
            <button
              className="button primary"
              disabled={!canPlay || pending || active || !!confirmationIssue}
              onClick={async () => {
                const result = await action("/api/console/play", {
                  config: confirmConfig,
                  requestId: requestId(),
                });
                if (result !== undefined) {
                  setConfirmConfig(null);
                  setTab("live");
                }
              }}
            >
              <Play size={16} />
              确认开始
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DevicePanel({
  state,
  action,
  disabled,
}: {
  state: AppSnapshot;
  action: Action;
  disabled: boolean;
}) {
  const [protocol, setProtocol] = useState<Protocol>(state.device.protocol);
  const [relayUrl, setRelayUrl] = useState("");
  const connected = state.device.relayStatus === "connected";
  return (
    <div className="device-panel">
      <Field label="连接协议">
        <div className="segmented">
          {(["v4", "v3", "simulator"] as Protocol[]).map((p) => (
            <button
              key={p}
              className={protocol === p ? "active" : ""}
              onClick={() => setProtocol(p)}
              disabled={disabled}
            >
              {p === "simulator" ? "模拟设备" : p.toUpperCase()}
            </button>
          ))}
        </div>
      </Field>
      <Field
        label="中继地址（可选）"
        hint="留空使用官方中继。模拟模式不会连接真实设备。"
      >
        <input
          aria-label="中继地址"
          value={relayUrl}
          onChange={(e) => setRelayUrl(e.target.value)}
          placeholder={
            protocol === "v3" ? "wss://ws.dungeon-lab.cn/" : "使用协议默认中继"
          }
          disabled={disabled}
        />
      </Field>
      <div className="button-row">
        <button
          className="button primary"
          disabled={disabled}
          onClick={() =>
            void action("/api/device/connect", {
              protocol,
              ...(relayUrl ? { relayUrl } : {}),
            })
          }
        >
          <Wifi size={16} />
          {connected ? "重新配对" : "建立连接"}
        </button>
        <button
          className="button secondary"
          disabled={disabled || state.device.relayStatus === "disconnected"}
          onClick={() => void action("/api/device/disconnect", {})}
        >
          <Unplug size={16} />
          断开
        </button>
      </div>
      {disabled && <p className="field-hint">当前运行结束后才能修改连接。</p>}
      {state.device.qrUrl && (
        <div className="pairing">
          <div className="qr-frame">
            <img src={state.device.qrUrl} alt="官方 APP 配对二维码" />
          </div>
          <strong>用郊狼官方 APP 扫码配对</strong>
          {state.device.pairingUrl && (
            <a href={state.device.pairingUrl} target="_blank" rel="noreferrer">
              打开配对链接
            </a>
          )}
        </div>
      )}
      {state.device.devices.length > 0 && (
        <Field label="选择目标设备">
          <select
            aria-label="选择目标设备"
            value={`${state.device.clientId || ""}:${state.device.slotId || ""}`}
            disabled={disabled}
            onChange={(e) => {
              const selected = state.device.devices.find(
                (d) => `${d.clientId}:${d.slotId}` === e.target.value,
              );
              if (selected)
                void action("/api/device/select", {
                  clientId: selected.clientId,
                  slotId: selected.slotId,
                });
            }}
          >
            <option value="">选择设备</option>
            {state.device.devices.map((d) => (
              <option
                key={`${d.clientId}:${d.slotId}`}
                value={`${d.clientId}:${d.slotId}`}
              >
                {d.name} · {d.type}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="device-details">
        <span>
          中继<strong>{state.device.relayStatus}</strong>
        </span>
        <span>
          APP<strong>{state.device.appStatus}</strong>
        </span>
        <span>
          最近更新
          <strong>
            {state.device.lastSeenAt ? clockTime(state.device.lastSeenAt) : "—"}
          </strong>
        </span>
        <span>
          设备上限 A / B
          <strong>
            {state.device.limits.A} / {state.device.limits.B}
          </strong>
        </span>
      </div>
      {state.device.error && (
        <p className="error-inline">{state.device.error}</p>
      )}
    </div>
  );
}

type LiveChannelPatch = Partial<
  Pick<ChannelConfig, "enabled" | "target" | "waveformId">
>;

function ChannelCard({
  channel,
  state,
  disabled,
  pendingConfig,
  onPatch,
}: {
  channel: Channel;
  state: AppSnapshot;
  disabled: boolean;
  pendingConfig?: LiveChannelPatch;
  onPatch: (part: LiveChannelPatch) => void;
}) {
  const config = { ...state.channels[channel], ...pendingConfig };
  const wave = state.waveforms.find((w) => w.id === config.waveformId);
  const deviceLimit = state.device.limits[channel];
  const [invalidTarget, setInvalidTarget] = useState(false);
  const updateTarget = (target: number) => {
    const valid =
      Number.isInteger(target) && target >= 0 && target <= deviceLimit;
    setInvalidTarget(!valid);
    if (valid) onPatch({ target });
  };
  return (
    <Card className={`channel-card channel-${channel.toLowerCase()}`}>
      <div className="channel-heading">
        <div className="channel-name">
          <span className="channel-letter">{channel}</span>
          <div>
            <strong>通道 {channel}</strong>
            <small>{config.enabled ? "已启用" : "已关闭"}</small>
          </div>
        </div>
        <Toggle
          label={`${channel} 通道`}
          checked={config.enabled}
          disabled={disabled}
          onChange={(enabled) => onPatch({ enabled })}
        />
      </div>
      <div className="intensity-display">
        <span className="intensity-value">
          {state.device.intensities[channel].toString().padStart(2, "0")}
        </span>
        <div>
          <span>设备强度</span>
          <small>目标 {config.target}</small>
        </div>
        <span
          className={`signal-indicator ${state.device.connected ? "on" : ""}`}
        >
          <Activity size={17} />
        </span>
      </div>
      <div className="channel-cap" aria-label={`${channel} 通道上限摘要`}>
        <span>强度上限</span>
        <strong>{deviceLimit}</strong>
      </div>
      <div className="channel-wave">
        <WaveGraph
          frames={wave?.frames || []}
          color={channel === "A" ? "blue" : "pink"}
        />
      </div>
      <Field label="目标强度">
        <div className="range-control">
          <IconButton
            label={`${channel} 通道减少强度`}
            disabled={disabled || config.target <= 0}
            onClick={() => updateTarget(Math.max(0, config.target - 1))}
          >
            <Minus size={16} />
          </IconButton>
          <input
            aria-label={`${channel} 通道目标强度滑块`}
            type="range"
            min={0}
            max={deviceLimit}
            value={Math.min(config.target, deviceLimit)}
            disabled={disabled || deviceLimit <= 0}
            onChange={(e) => updateTarget(Number(e.target.value))}
          />
          <IconButton
            label={`${channel} 通道增加强度`}
            disabled={disabled || config.target >= deviceLimit}
            onClick={() => updateTarget(config.target + 1)}
          >
            <Plus size={16} />
          </IconButton>
        </div>
        <div className="range-labels">
          <span>0</span>
          <span>{deviceLimit}</span>
        </div>
        <div className="target-number">
          <NumberInput
            label={`${channel} 通道目标强度`}
            value={config.target}
            max={deviceLimit}
            disabled={disabled}
            onChange={updateTarget}
            onBlur={() => setInvalidTarget(false)}
          />
          <button
            className="text-button muted"
            disabled={disabled}
            onClick={() => updateTarget(0)}
          >
            归零
          </button>
        </div>
        {invalidTarget && (
          <span className="error-inline">
            请输入 0–{deviceLimit} 之间的整数。
          </span>
        )}
      </Field>
      <Field label="当前波形">
        <WaveSelect
          label={`${channel} 通道波形`}
          value={config.waveformId}
          waveforms={state.waveforms}
          disabled={disabled}
          onChange={(waveformId) => {
            if (waveformId) onPatch({ waveformId });
          }}
        />
      </Field>
    </Card>
  );
}

function PlaybackLimitSummary({
  state,
  channels,
  label,
}: {
  state: AppSnapshot;
  channels: Channel[];
  label: string;
}) {
  const limits = playbackChannelsLimit(state, channels);
  return (
    <p className="playback-limit-summary" aria-label={label}>
      {channels.length
        ? channels.map((channel) => (
            <span key={channel}>
              {channel} 通道强度上限 <strong>{limits.limits[channel]}</strong>
              {"　"}
            </span>
          ))
        : "未选择通道"}
      {channels.length > 1 && " · 各通道独立限制"}
    </p>
  );
}

function RunPlayer({
  state,
  action,
  pending,
}: {
  state: AppSnapshot;
  action: Action;
  pending: boolean;
}) {
  const run = state.run;
  if (!run || !isActive(state))
    return (
      <div className="idle-player">
        <span className="idle-play">
          <Play size={24} />
        </span>
        <strong>留一点空间，等待下一段节奏</strong>
        <p>设置通道强度和波形，开始下一段节奏</p>
      </div>
    );
  const own = state.owner === "manual";
  const names: Record<string, string> = {
    live: "实时控制",
    single: "单波形",
    playlist: "播放列表",
    stages: "阶段编排",
    random: "受限随机",
  };
  return (
    <div className="running-player">
      <div className="running-title">
        <Badge dot color={run.status === "paused" ? "gray" : "blue"}>
          {run.status === "paused" ? "已暂停" : "运行中"}
        </Badge>
        <strong>{names[run.mode] || ownerNames[run.owner]}</strong>
        <span>{duration(timeLeft(run.deadlineAt))}</span>
      </div>
      <div className="progress-track">
        <i
          style={{
            width: `${Math.min(100, Math.max(0, ((Date.now() - run.startedAt) / (run.deadlineAt - run.startedAt)) * 100))}%`,
          }}
        />
      </div>
      <p className="muted">
        {run.mode === "live" ? (
          "A / B 独立播放 · 参数实时更新"
        ) : (
          <>
            阶段 {run.stageIndex + 1} ·{" "}
            {run.playback?.stages[run.stageIndex]?.name ||
              run.plan?.stages[run.stageIndex]?.name ||
              "自主控制"}
          </>
        )}
      </p>
      {own && (
        <div className="button-row">
          {run.mode !== "live" && (
            <button
              className="button secondary"
              disabled={pending}
              onClick={() =>
                void action(
                  `/api/console/${run.status === "paused" ? "resume" : "pause"}`,
                  {},
                )
              }
            >
              {run.status === "paused" ? (
                <Play size={16} />
              ) : (
                <Pause size={16} />
              )}
              {run.status === "paused" ? "恢复" : "暂停"}
            </button>
          )}
          {run.mode === "playlist" && (
            <IconButton
              label="下一条目"
              disabled={pending}
              onClick={() => void action("/api/console/next", {})}
            >
              <SkipForward size={17} />
            </IconButton>
          )}
          <button
            className="button secondary"
            disabled={
              run.mode === "live" ? state.stopping || state.locked : pending
            }
            onClick={() => void action("/api/console/stop", {})}
          >
            <Square size={15} />
            停止
          </button>
        </div>
      )}
    </div>
  );
}

export function Monitor({ state }: { state: AppSnapshot }) {
  const points = state.history.slice(-80);
  const maximum = Math.max(10, ...points.flatMap((p) => [p.A, p.B]));
  const line = (channel: Channel) =>
    points
      .map(
        (p, i) =>
          `${(i / Math.max(1, points.length - 1)) * 620},${130 - (p[channel] / maximum) * 112}`,
      )
      .join(" ");
  return (
    <Card
      title="实时强度"
      eyebrow="LIVE MONITOR"
      icon={<Activity size={17} />}
      className="monitor-card"
      actions={
        <div className="chart-legend">
          <span>
            <i className="blue" />
            通道 A
          </span>
          <span>
            <i className="pink" />
            通道 B
          </span>
        </div>
      }
    >
      <div className="monitor-chart">
        <div className="chart-y">
          <span>{maximum}</span>
          <span>{Math.round(maximum / 2)}</span>
          <span>0</span>
        </div>
        <svg
          viewBox="0 0 620 145"
          preserveAspectRatio="none"
          role="img"
          aria-label="A/B 通道强度变化曲线"
        >
          <path d="M0 18H620M0 74H620M0 130H620" className="chart-grid" />
          <polyline points={line("A")} className="line-a" />
          <polyline points={line("B")} className="line-b" />
        </svg>
      </div>
      <div className="chart-x">
        <span>{points.length ? clockTime(points[0].at) : "等待数据"}</span>
        <span>实时</span>
      </div>
      <div className="monitor-footer">
        <span>
          <i
            className={`status-dot ${state.device.connected ? "online" : ""}`}
          />
          {state.device.connected ? "状态持续同步中" : "设备连接后显示实时曲线"}
        </span>
        <span>强度单位 · 设备反馈</span>
      </div>
    </Card>
  );
}

function WaveLibrary({
  state,
  action,
  disabled,
}: {
  state: AppSnapshot;
  action: Action;
  disabled: boolean;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [preview, setPreview] = useState<Waveform | null>(null);
  const [rename, setRename] = useState<Waveform | null>(null);
  const [newName, setNewName] = useState("");
  const [localError, setLocalError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  let waves = state.waveforms.filter(
    (w) =>
      w.name.toLowerCase().includes(search.toLowerCase()) &&
      (filter !== "favorite" || w.favorite),
  );
  if (filter === "recent")
    waves = [...waves].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const importFile = async (file?: File) => {
    if (!file || disabled) return;
    setLocalError("");
    try {
      if (file.size > MAX_WAVEFORM_FILE_BYTES)
        throw new Error("波形文件不能超过 5 MB，请缩小后重试。");
      if (!/\.(json|pulse)$/i.test(file.name))
        throw new Error("请选择 .json 或 APP 导出的 .pulse 波形文件。");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw new Error(
          "文件不是有效的 UTF-8 文本；请从 APP 重新导出 .pulse，或选择 UTF-8 JSON 文件。暂不支持压缩或二进制文件。",
        );
      }
      const format = /\.pulse$/i.test(file.name) ? "pulse" : "json";
      let content: unknown = text;
      if (format === "json") {
        try {
          content = JSON.parse(text);
        } catch {
          throw new Error(
            "JSON 格式错误，请检查文件是否完整；APP 导出的文本波形请保留 .pulse 扩展名。",
          );
        }
      }
      const hasName =
        format === "json" &&
        content !== null &&
        typeof content === "object" &&
        ("name" in content || "label" in content);
      const filename = file.name.replace(/\.(json|pulse)$/i, "");
      if (!hasName && filename.length > 100)
        throw new Error("波形名称最多 100 字，请缩短文件名后重新导入。");
      await action(
        "/api/waveforms/import",
        {
          content,
          format,
          name: hasName ? undefined : filename,
        },
        "POST",
        "波形已导入",
      );
    } catch (e) {
      setLocalError((e as Error).message);
    }
    if (fileRef.current) fileRef.current.value = "";
  };
  const exportWave = (w: Waveform) => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ label: w.name, raw: w.frames }, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${w.name}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div
      className="wave-library"
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length > 1) {
          setLocalError("请每次导入一个 .json 或 .pulse 文件。");
          return;
        }
        void importFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="library-toolbar">
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索波形"
            placeholder="寻找喜欢的波形…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <IconButton label="清除搜索" onClick={() => setSearch("")}>
              <X size={14} />
            </IconButton>
          )}
        </div>
        <div className="segmented">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            全部波形
          </button>
          <button
            className={filter === "favorite" ? "active" : ""}
            onClick={() => setFilter("favorite")}
          >
            我的收藏
          </button>
          <button
            className={filter === "recent" ? "active" : ""}
            onClick={() => setFilter("recent")}
          >
            最近使用
          </button>
        </div>
        <button
          className="button primary"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          <Import size={16} />
          导入波形
        </button>
        <input
          className="sr-only"
          type="file"
          ref={fileRef}
          accept="application/json,.json,.pulse"
          disabled={disabled}
          onChange={(e) => void importFile(e.target.files?.[0])}
        />
      </div>
      <p className="small-text muted">
        支持 JSON 与 APP 3.4.4 文本
        .pulse（固定频率）。仅导入频率、相对幅度和节奏，APP
        附加参数不修改设备设置。
      </p>
      {localError && <p className="error-inline">{localError}</p>}
      {dragging && (
        <div className="drop-overlay">
          <FileJson size={42} />
          <strong>放开以导入 JSON / .pulse 波形</strong>
        </div>
      )}
      <div className="wave-library-grid">
        {waves.map((w, index) => (
          <Card
            key={w.id}
            className={`wave-tile ${index % 2 ? "pink-tile" : ""}`}
          >
            <div className="wave-tile-top">
              <span className="wave-tile-icon">
                <Waves size={20} />
              </span>
              <Badge color={w.builtin ? "blue" : "pink"}>
                {w.builtin ? "内置" : "自定义"}
              </Badge>
              <IconButton
                label={`${w.favorite ? "取消收藏" : "收藏"} ${w.name}`}
                disabled={disabled}
                onClick={() =>
                  void action(
                    `/api/waveforms/${w.id}`,
                    { favorite: !w.favorite },
                    "PATCH",
                  )
                }
              >
                <Heart size={17} fill={w.favorite ? "currentColor" : "none"} />
              </IconButton>
            </div>
            <button
              className="wave-preview-button"
              onClick={() => setPreview(w)}
            >
              <h3>{w.name}</h3>
              <WaveGraph
                frames={w.frames}
                color={index % 2 ? "pink" : "blue"}
              />
              <div className="wave-meta">
                <span>{w.frames.length} 帧</span>
                <span>{(w.durationMs / 1000).toFixed(1)} 秒</span>
                <span>
                  预览
                  <ChevronRight size={12} />
                </span>
              </div>
            </button>
            <div className="wave-tile-actions">
              <span className="small-text muted">应用到</span>
              {(["A", "B"] as Channel[]).map((ch) => (
                <button
                  key={ch}
                  className="choice-chip"
                  disabled={disabled}
                  onClick={() =>
                    void action(
                      "/api/console/channels",
                      { channels: { [ch]: { waveformId: w.id } } },
                      "PATCH",
                      `已应用到 ${ch} 通道`,
                    )
                  }
                >
                  {ch}
                </button>
              ))}
              <button
                className="choice-chip"
                disabled={disabled}
                onClick={() =>
                  void action(
                    "/api/console/channels",
                    {
                      channels: {
                        A: { waveformId: w.id },
                        B: { waveformId: w.id },
                      },
                    },
                    "PATCH",
                    "已应用到双通道",
                  )
                }
              >
                双通道
              </button>
              <IconButton
                label={`导出 ${w.name}`}
                onClick={() => exportWave(w)}
              >
                <Download size={15} />
              </IconButton>
            </div>
          </Card>
        ))}
      </div>
      {!waves.length && (
        <Empty title="这里还没有波形">
          调整搜索条件，或导入一份 JSON / .pulse 波形。
        </Empty>
      )}
      <div className="import-help">
        <FileJson size={21} />
        <div>
          <strong>把喜欢的波形放进来</strong>
          <p>
            支持 JSON 与固定频率 .pulse · 每次拖入一个文件，最多 5 MB ·
            导入前自动校验
          </p>
        </div>
      </div>
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)}>
          <WaveGraph frames={preview.frames} />
          <WaveMetadata waveform={preview} />
          {preview.importNote && (
            <p className="small-text muted">{preview.importNote}</p>
          )}
          <div className="review-grid">
            <div>
              <span>帧数</span>
              <strong>{preview.frames.length}</strong>
            </div>
            <div>
              <span>原始时长</span>
              <strong>{(preview.durationMs / 1000).toFixed(1)}s</strong>
            </div>
          </div>
          <p className="field-hint">
            曲线展示波形相对幅度。实际输出同时受通道强度与设备上限影响。
          </p>
          <div className="raw-frames">
            {preview.frames.slice(0, 8).map((f, i) => (
              <code key={i}>{f}</code>
            ))}
            {preview.frames.length > 8 && (
              <span>… 另有 {preview.frames.length - 8} 帧</span>
            )}
          </div>
          <div className="button-row">
            <button
              className="button secondary"
              onClick={() => exportWave(preview)}
            >
              <Download size={16} />
              导出
            </button>
            <button
              className="button secondary"
              disabled={disabled}
              onClick={() => {
                setNewName(preview.name);
                setRename(preview);
                setPreview(null);
              }}
            >
              <Pencil size={16} />
              重命名
            </button>
            <button
              className="button danger-soft"
              disabled={disabled || preview.builtin}
              title={preview.builtin ? "内置波形不能删除" : undefined}
              onClick={async () => {
                if (confirm(`确定删除“${preview.name}”？`)) {
                  await action(
                    `/api/waveforms/${preview.id}`,
                    undefined,
                    "DELETE",
                  );
                  setPreview(null);
                }
              }}
            >
              <Trash2 size={16} />
              删除
            </button>
          </div>
        </Modal>
      )}
      {rename && (
        <Modal title="重命名波形" onClose={() => setRename(null)}>
          <Field label="波形名称">
            <input
              aria-label="波形名称"
              value={newName}
              maxLength={80}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </Field>
          <button
            className="button primary full"
            disabled={disabled || !newName.trim()}
            onClick={async () => {
              const result = await action(
                `/api/waveforms/${rename.id}`,
                { name: newName.trim() },
                "PATCH",
              );
              if (result !== undefined) setRename(null);
            }}
          >
            保存名称
          </button>
        </Modal>
      )}
    </div>
  );
}

export function StageEditor({
  stages,
  setStages,
  waves,
  disabled,
  mode = "stages",
  state,
  bounds,
}: {
  stages: Stage[];
  setStages: (stages: Stage[]) => void;
  waves: Waveform[];
  disabled: boolean;
  mode?: "stages" | "playlist";
  state?: AppSnapshot;
  bounds?: ControlBounds;
}) {
  const dragIndex = useRef<number | null>(null);
  const patch = (index: number, changes: Partial<Stage>) =>
    setStages(stages.map((s, i) => (i === index ? { ...s, ...changes } : s)));
  const move = (index: number, to: number) => {
    if (disabled || to < 0 || to >= stages.length) return;
    const next = [...stages];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    setStages(next);
  };
  return (
    <div className="stage-editor">
      {stages.map((stage, index) => (
        <div
          className="stage-row glass-card"
          key={stage.id}
          draggable={!disabled}
          onDragStart={() => {
            dragIndex.current = index;
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (dragIndex.current !== null) move(dragIndex.current, index);
            dragIndex.current = null;
          }}
        >
          <div className="stage-row-header">
            <GripVertical size={17} className="muted" />
            <span className="stage-index">
              {String(index + 1).padStart(2, "0")}
            </span>
            <input
              aria-label={`第 ${index + 1} 项名称`}
              value={stage.name}
              onChange={(e) => patch(index, { name: e.target.value })}
              disabled={disabled}
            />
            <div className="stage-row-tools">
              <IconButton
                label={`上移第 ${index + 1} 项`}
                disabled={disabled || index === 0}
                onClick={() => move(index, index - 1)}
              >
                <ArrowUp size={14} />
              </IconButton>
              <IconButton
                label={`下移第 ${index + 1} 项`}
                disabled={disabled || index === stages.length - 1}
                onClick={() => move(index, index + 1)}
              >
                <ArrowDown size={14} />
              </IconButton>
              <IconButton
                label={`复制第 ${index + 1} 项`}
                disabled={disabled}
                onClick={() => {
                  const next = [...stages];
                  next.splice(index + 1, 0, {
                    ...stage,
                    id: crypto.randomUUID(),
                    name: `${stage.name} 副本`,
                  });
                  setStages(next);
                }}
              >
                <Copy size={14} />
              </IconButton>
              <IconButton
                label={`删除第 ${index + 1} 项`}
                disabled={disabled}
                onClick={() => setStages(stages.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          </div>
          <fieldset className="plain-fieldset" disabled={disabled}>
            <div className="form-grid stage-grid">
              <Field label="输出通道">
                <ChannelChips
                  value={stage.channels}
                  onChange={(channels) => patch(index, { channels })}
                  disabled={disabled}
                />
              </Field>
              <Field label="持续 / 秒">
                <NumberInput
                  label={`第 ${index + 1} 项持续时间`}
                  value={stage.durationSec}
                  min={0.1}
                  step={0.1}
                  max={86400}
                  onChange={(durationSec) => patch(index, { durationSec })}
                />
              </Field>
              <Field label={mode === "stages" ? "执行方式" : "间隔 / 秒"}>
                {mode === "stages" ? (
                  <select
                    aria-label={`第 ${index + 1} 项执行方式`}
                    value={stage.behavior}
                    onChange={(e) =>
                      patch(index, {
                        behavior: e.target.value as Stage["behavior"],
                        ...(e.target.value === "rest"
                          ? {
                              intensity: { A: 0, B: 0 },
                              startIntensity: { A: 0, B: 0 },
                            }
                          : {}),
                      })
                    }
                  >
                    <option value="hold">保持输出</option>
                    <option value="ramp">强度渐变</option>
                    <option value="rest">归零休息</option>
                  </select>
                ) : (
                  <NumberInput
                    label={`第 ${index + 1} 项间隔时间`}
                    value={stage.gapSec}
                    max={3600}
                    onChange={(gapSec) => patch(index, { gapSec })}
                  />
                )}
              </Field>
            </div>
            <div className="per-channel-settings stage-channel-settings">
              {(["A", "B"] as Channel[]).map((channel) => {
                const selected = stage.channels.includes(channel);
                const maximum = Math.min(
                  state?.device.limits[channel] ?? 200,
                  bounds?.maxIntensity[channel] ?? 200,
                );
                return (
                  <fieldset
                    key={channel}
                    className={`channel-settings channel-settings-${channel.toLowerCase()}`}
                    disabled={
                      disabled || !selected || stage.behavior === "rest"
                    }
                    aria-label={`第 ${index + 1} 项 ${channel} 通道强度`}
                  >
                    <legend>
                      通道 {channel}
                      {!selected
                        ? " · 未选择"
                        : stage.behavior === "rest"
                          ? " · 归零休息"
                          : ""}
                    </legend>
                    <div className="form-grid">
                      {stage.behavior === "ramp" && (
                        <Field label="起始强度">
                          <NumberInput
                            label={`第 ${index + 1} 项 ${channel} 通道起始强度`}
                            value={stage.startIntensity[channel]}
                            max={maximum}
                            onChange={(value) =>
                              patch(index, {
                                startIntensity: {
                                  ...stage.startIntensity,
                                  [channel]: value,
                                },
                              })
                            }
                          />
                        </Field>
                      )}
                      <Field label="目标强度">
                        <NumberInput
                          label={`第 ${index + 1} 项 ${channel} 通道目标强度`}
                          value={
                            stage.behavior === "rest"
                              ? 0
                              : stage.intensity[channel]
                          }
                          max={maximum}
                          onChange={(value) =>
                            patch(index, {
                              intensity: {
                                ...stage.intensity,
                                [channel]: value,
                              },
                            })
                          }
                        />
                      </Field>
                    </div>
                    {selected && (
                      <p className="field-hint">
                        {bounds
                          ? `授权 ${bounds.minIntensity[channel]}–${bounds.maxIntensity[channel]} · `
                          : ""}
                        强度上限 {maximum}
                      </p>
                    )}
                  </fieldset>
                );
              })}
            </div>
            <div className="form-grid stage-waves">
              <Field label="A / 默认波形">
                <WaveSelect
                  value={stage.waveformId}
                  onChange={(waveformId) => patch(index, { waveformId })}
                  waveforms={waves}
                  disabled={disabled || stage.behavior === "rest"}
                />
              </Field>
              <Field label="B 通道波形">
                <WaveSelect
                  label={`第 ${index + 1} 项 B 通道波形`}
                  value={stage.waveformBId || stage.waveformId}
                  onChange={(waveformBId) => patch(index, { waveformBId })}
                  waveforms={waves}
                  disabled={disabled || stage.behavior === "rest"}
                />
              </Field>
            </div>
          </fieldset>
          {state && stage.behavior !== "rest" && (
            <PlaybackLimitSummary
              state={state}
              channels={stage.channels}
              label={`第 ${index + 1} 项上限说明`}
            />
          )}
        </div>
      ))}
      <button
        className="add-stage"
        disabled={disabled}
        onClick={() =>
          setStages([
            ...stages,
            defaultStage(waves[0]?.id || "", stages.length),
          ])
        }
      >
        <Plus size={17} />
        添加{mode === "playlist" ? "条目" : "阶段"}
      </button>
    </div>
  );
}

function SequenceEditor({
  mode,
  state,
  action,
  disabled,
  canPlay,
  onPlay,
}: {
  mode: "playlist" | "stages";
  state: AppSnapshot;
  action: Action;
  disabled: boolean;
  canPlay: boolean;
  onPlay: (config: PlaybackConfig) => void;
}) {
  const [stages, setStages] = useState<Stage[]>([
    defaultStage(state.waveforms[0]?.id || "", 0),
  ]);
  const [repeat, setRepeat] = useState(1);
  const [shuffle, setShuffle] = useState(false);
  const [durationSec, setDurationSec] = useState(600);
  const [presetName, setPresetName] = useState("");
  const [showSave, setShowSave] = useState(false);
  const scaling = useStageIntensityScaling(stages, setStages);
  const config: PlaybackConfig = { mode, stages, repeat, shuffle, durationSec };
  const draftIssue =
    mode === "stages"
      ? scaling.inputIssue || stageDraftIssue(state, stages)
      : null;
  const issue = draftIssue || playbackConfigIssue(state, config);
  const presets = state.presets.filter((p) => p.config.mode === mode);
  const total = stages.reduce((sum, s) => sum + s.durationSec + s.gapSec, 0);
  return (
    <div className="editor-layout">
      <div>
        <div className="subsection-heading">
          <div>
            <h2>
              {mode === "playlist" ? (
                <ListMusic size={19} />
              ) : (
                <Layers3 size={19} />
              )}
              {mode === "playlist" ? "编排喜欢的节奏" : "把时间交给每一个阶段"}
            </h2>
            <p className="muted">
              拖动调整顺序 · {stages.length}{" "}
              {mode === "playlist" ? "个条目" : "个阶段"} · 一轮{" "}
              {duration(total)}
            </p>
          </div>
          <button
            className="button secondary small"
            disabled={disabled || !stages.length || !!draftIssue}
            onClick={() => setShowSave(true)}
          >
            <Save size={15} />
            保存预设
          </button>
        </div>
        {mode === "stages" && (
          <StageIntensityScale scaling={scaling} disabled={disabled} />
        )}
        <div className="stage-timeline">
          {stages.map((s, i) => (
            <div
              key={s.id}
              className={s.behavior === "rest" ? "rest" : ""}
              style={{ flex: Math.max(1, s.durationSec) }}
              title={`${s.name} · ${s.durationSec}s`}
            >
              <span>{i + 1}</span>
              <small>{s.durationSec}s</small>
            </div>
          ))}
        </div>
        <StageEditor
          stages={stages}
          setStages={mode === "stages" ? scaling.updateStages : setStages}
          waves={state.waveforms}
          disabled={disabled}
          mode={mode}
          state={state}
        />
      </div>
      <div className="editor-sidebar">
        <Card title="播放设置" icon={<Timer size={17} />}>
          <Field label="重复次数">
            <NumberInput
              label="方案重复次数"
              value={repeat}
              min={1}
              max={1000}
              onChange={setRepeat}
              disabled={disabled}
            />
          </Field>
          <Field
            label="最长总时长 / 秒"
            hint="到达此时间即停止，即使列表尚未完成。"
          >
            <NumberInput
              label="方案最长总时长"
              value={durationSec}
              min={1}
              max={86400}
              onChange={setDurationSec}
              disabled={disabled}
            />
          </Field>
          {mode === "playlist" && (
            <Toggle
              label="随机排列条目"
              checked={shuffle}
              onChange={setShuffle}
              disabled={disabled}
            />
          )}
          <div className="summary-line">
            <span>预计最长</span>
            <strong>{duration(Math.min(total * repeat, durationSec))}</strong>
          </div>
          <button
            className="button primary full"
            disabled={!canPlay || !stages.length || !!issue}
            onClick={() => onPlay(config)}
          >
            <Play size={16} />
            确认并播放
          </button>
          {issue && (
            <p className="playback-issue" role="status">
              {issue}
            </p>
          )}
        </Card>
        <Card title="我的预设" icon={<FolderOpen size={17} />}>
          {presets.length ? (
            <div className="preset-list">
              {presets.map((p) => (
                <div key={p.id}>
                  <button
                    disabled={disabled}
                    onClick={() => {
                      const loadedStages = structuredClone(p.config.stages).map(
                        (s) => ({ ...s, id: crypto.randomUUID() }),
                      );
                      if (mode === "stages")
                        scaling.resetBaseline(loadedStages);
                      else setStages(loadedStages);
                      setRepeat(p.config.repeat);
                      setShuffle(p.config.shuffle);
                      setDurationSec(p.config.durationSec);
                    }}
                  >
                    <strong>{p.name}</strong>
                    <small>{p.config.stages.length} 项 · 点击载入</small>
                  </button>
                  <IconButton
                    label={`删除预设 ${p.name}`}
                    disabled={disabled}
                    onClick={() => {
                      if (confirm(`确定删除预设“${p.name}”？`))
                        void action(
                          `/api/presets/${p.id}`,
                          undefined,
                          "DELETE",
                        );
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">保存一个方案，下次一键载入。</p>
          )}
        </Card>
      </div>
      {showSave && (
        <Modal title="保存方案预设" onClose={() => setShowSave(false)}>
          <Field label="预设名称">
            <input
              aria-label="预设名称"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              maxLength={80}
              autoFocus
            />
          </Field>
          <button
            className="button primary full"
            disabled={!presetName.trim() || disabled || !!draftIssue}
            onClick={async () => {
              if (disabled || draftIssue) return;
              const result = await action(
                "/api/presets",
                { name: presetName.trim(), config },
                "POST",
                "预设已保存",
              );
              if (result !== undefined) setShowSave(false);
            }}
          >
            <Save size={16} />
            保存预设
          </button>
          {draftIssue && (
            <p className="playback-issue" role="status">
              {draftIssue}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

function RandomPanel({
  state,
  disabled,
  canPlay,
  onPlay,
}: {
  state: AppSnapshot;
  disabled: boolean;
  canPlay: boolean;
  onPlay: (config: PlaybackConfig) => void;
}) {
  const [config, setConfig] = useState<RandomConfig>({
    channels: ["A", "B"],
    waveformIds: state.waveforms.slice(0, 3).map((w) => w.id),
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 10, B: 10 },
    minIntervalSec: 5,
    maxIntervalSec: 15,
    minDurationSec: 2,
    maxDurationSec: 5,
    randomWaveform: true,
    randomIntensity: true,
    randomDuration: false,
  });
  const [total, setTotal] = useState(300);
  const patch = (p: Partial<RandomConfig>) =>
    setConfig((current) => ({ ...current, ...p }));
  const limits = playbackChannelsLimit(state, config.channels);
  const playback: PlaybackConfig = {
    mode: "random",
    random: config,
    stages: [],
    repeat: 1,
    shuffle: false,
    durationSec: total,
  };
  const issue = playbackConfigIssue(state, playback);
  return (
    <div className="editor-layout">
      <Card
        title="一点未知，也在你的范围之内"
        eyebrow="BOUNDED RANDOM"
        icon={<Shuffle size={20} />}
      >
        <p className="muted">先划定边界，再让波形与强度带来恰好的变化。</p>
        <fieldset className="plain-fieldset" disabled={disabled}>
          <Field label="参与通道">
            <ChannelChips
              value={config.channels}
              onChange={(channels) => patch({ channels })}
              disabled={disabled}
            />
          </Field>
          <PlaybackLimitSummary
            state={state}
            channels={config.channels}
            label="随机播放上限说明"
          />
          <Field label="可选波形">
            <div className="wave-checks">
              {state.waveforms.map((w) => (
                <label
                  className={`wave-check ${config.waveformIds.includes(w.id) ? "selected" : ""}`}
                  key={w.id}
                >
                  <input
                    type="checkbox"
                    checked={config.waveformIds.includes(w.id)}
                    onChange={(e) =>
                      patch({
                        waveformIds: e.target.checked
                          ? [...config.waveformIds, w.id]
                          : config.waveformIds.filter((id) => id !== w.id),
                      })
                    }
                  />
                  {w.name}
                </label>
              ))}
            </div>
          </Field>
          <div className="per-channel-settings random-channel-settings">
            {(["A", "B"] as Channel[]).map((channel) => (
              <fieldset
                key={channel}
                className={`channel-settings channel-settings-${channel.toLowerCase()}`}
                disabled={disabled || !config.channels.includes(channel)}
                aria-label={`随机 ${channel} 通道强度范围`}
              >
                <legend>
                  通道 {channel}
                  {!config.channels.includes(channel) ? " · 未选择" : ""}
                </legend>
                <div className="form-grid">
                  <Field label="最低强度">
                    <NumberInput
                      label={`随机 ${channel} 通道最低强度`}
                      value={config.minIntensity[channel]}
                      max={Math.min(
                        config.maxIntensity[channel],
                        limits.limits[channel],
                      )}
                      onChange={(value) =>
                        patch({
                          minIntensity: {
                            ...config.minIntensity,
                            [channel]: value,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="最高强度">
                    <NumberInput
                      label={`随机 ${channel} 通道最高强度`}
                      value={config.maxIntensity[channel]}
                      min={config.minIntensity[channel]}
                      max={limits.limits[channel]}
                      onChange={(value) =>
                        patch({
                          maxIntensity: {
                            ...config.maxIntensity,
                            [channel]: value,
                          },
                        })
                      }
                    />
                  </Field>
                </div>
              </fieldset>
            ))}
          </div>
          <div className="form-grid">
            <Field label="最短变化间隔 / 秒">
              <NumberInput
                label="最短变化间隔"
                value={config.minIntervalSec}
                min={1}
                max={3600}
                onChange={(minIntervalSec) => patch({ minIntervalSec })}
              />
            </Field>
            <Field label="最长变化间隔 / 秒">
              <NumberInput
                label="最长变化间隔"
                value={config.maxIntervalSec}
                min={1}
                max={3600}
                onChange={(maxIntervalSec) => patch({ maxIntervalSec })}
              />
            </Field>
            <Field label="最短单次持续 / 秒">
              <NumberInput
                label="最短单次持续"
                value={config.minDurationSec}
                min={1}
                max={3600}
                onChange={(minDurationSec) => patch({ minDurationSec })}
              />
            </Field>
            <Field label="最长单次持续 / 秒">
              <NumberInput
                label="最长单次持续"
                value={config.maxDurationSec}
                min={1}
                max={3600}
                onChange={(maxDurationSec) => patch({ maxDurationSec })}
              />
            </Field>
          </div>
          <div className="toggle-grid">
            <Toggle
              label="随机波形"
              checked={config.randomWaveform}
              onChange={(randomWaveform) => patch({ randomWaveform })}
              disabled={disabled}
            />
            <Toggle
              label="随机强度"
              checked={config.randomIntensity}
              onChange={(randomIntensity) => patch({ randomIntensity })}
              disabled={disabled}
            />
            <Toggle
              label="随机持续时间"
              checked={config.randomDuration}
              onChange={(randomDuration) => patch({ randomDuration })}
              disabled={disabled}
            />
          </div>
        </fieldset>
      </Card>
      <Card
        title="运行摘要"
        icon={<ShieldCheck size={18} />}
        className="editor-sidebar"
      >
        <div className="random-illustration">
          <Shuffle size={44} />
          <i />
          <i />
        </div>
        {config.channels.map((channel) => (
          <div className="summary-line" key={channel}>
            <span>{channel} 通道强度范围</span>
            <strong>
              {config.minIntensity[channel]}–{config.maxIntensity[channel]}
            </strong>
          </div>
        ))}
        <div className="summary-line">
          <span>授权波形</span>
          <strong>{config.waveformIds.length} 个</strong>
        </div>
        <div className="summary-line">
          <span>变化间隔</span>
          <strong>
            {config.minIntervalSec}–{config.maxIntervalSec}s
          </strong>
        </div>
        <Field label="总运行时间 / 秒">
          <NumberInput
            label="随机总运行时间"
            value={total}
            min={1}
            max={86400}
            onChange={setTotal}
            disabled={disabled}
          />
        </Field>
        <p className="field-hint">
          每个随机目标都经过通道上限与渐变校验，截止后自动停止。
        </p>
        <button
          className="button primary full"
          disabled={!canPlay || !!issue}
          onClick={() => onPlay(playback)}
        >
          <Shuffle size={16} />
          查看并确认
        </button>
        {issue && (
          <p className="playback-issue" role="status">
            {issue}
          </p>
        )}
      </Card>
    </div>
  );
}

function LogsPanel({ state }: { state: AppSnapshot }) {
  const [source, setSource] = useState("all");
  const [level, setLevel] = useState("all");
  const [channel, setChannel] = useState("all");
  const [since, setSince] = useState("");
  const sources = [...new Set(state.logs.map((l) => l.source))];
  const logs = state.logs
    .filter(
      (l) =>
        (source === "all" || l.source === source) &&
        (level === "all" || l.level === level) &&
        (channel === "all" || l.channel === channel) &&
        (!since || l.at >= new Date(since).getTime()),
    )
    .slice()
    .reverse();
  return (
    <Card
      title="每一步，都有迹可循"
      eyebrow="ACTIVITY HISTORY"
      icon={<History size={19} />}
    >
      <div className="log-filters">
        <select
          aria-label="筛选日志来源"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="all">全部来源</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选日志级别"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="all">全部级别</option>
          <option value="info">信息</option>
          <option value="warning">警告</option>
          <option value="error">错误</option>
        </select>
        <select
          aria-label="筛选日志通道"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        >
          <option value="all">全部通道</option>
          <option value="A">通道 A</option>
          <option value="B">通道 B</option>
        </select>
        <input
          aria-label="日志开始时间"
          type="datetime-local"
          value={since}
          onChange={(e) => setSince(e.target.value)}
        />
      </div>
      {logs.length ? (
        <div className="log-table">
          <div className="log-table-heading">
            <span>时间</span>
            <span>来源</span>
            <span>记录</span>
            <span>状态</span>
          </div>
          {logs.map((l) => (
            <div className="log-row" key={l.id}>
              <time>{clockTime(l.at)}</time>
              <span>
                {l.source}
                {l.channel ? ` · ${l.channel}` : ""}
              </span>
              <p>{l.message}</p>
              <Badge
                color={
                  l.level === "error"
                    ? "red"
                    : l.level === "warning"
                      ? "pink"
                      : "gray"
                }
              >
                {l.level === "error"
                  ? "错误"
                  : l.level === "warning"
                    ? "提醒"
                    : "信息"}
              </Badge>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="还没有符合条件的记录">
          设备操作与 AI 调整会出现在这里。
        </Empty>
      )}
    </Card>
  );
}
