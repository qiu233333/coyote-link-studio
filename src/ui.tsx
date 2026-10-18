import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronDown, LoaderCircle, Sparkles, X } from "lucide-react";
import type {
  Channel,
  ChannelValues,
  ControlBounds,
  Stage,
  Waveform,
} from "../shared/types";

export function IconButton({
  children,
  label,
  onClick,
  disabled,
  danger = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${danger ? "danger-soft" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Card({
  children,
  className = "",
  title,
  eyebrow,
  icon,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  eyebrow?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={`glass-card ${className}`}>
      {title && (
        <div className="card-heading">
          <div className="card-title-wrap">
            {icon && <span className="card-icon">{icon}</span>}
            <div>
              {eyebrow && <span className="eyebrow">{eyebrow}</span>}
              <h2>{title}</h2>
            </div>
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`field ${className}`} role="group" aria-labelledby={id}>
      <label id={id}>{label}</label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`toggle-wrap ${checked ? "checked" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle">
        <span />
      </span>
      <span>{label}</span>
    </button>
  );
}
export function Badge({
  children,
  color = "blue",
  dot = false,
}: {
  children: ReactNode;
  color?: string;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge-${color}`}>
      {dot && <i />}
      {children}
    </span>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-orb">
        <Sparkles size={23} />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
export function LoadingButton({
  busy,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} disabled={props.disabled || busy}>
      {busy && <LoaderCircle className="spin" size={16} />}
      {children}
    </button>
  );
}
export function Avatar({
  size = "medium",
}: {
  size?: "small" | "medium" | "large";
}) {
  const [missing, setMissing] = useState(false);
  return (
    <span className={`assistant-avatar avatar-${size}`}>
      {missing ? (
        <Sparkles />
      ) : (
        <img
          src="/assistant-avatar.jpg"
          alt="星涟，银白发红眼、佩戴黑色蝴蝶结的二次元助手"
          onError={() => setMissing(true)}
        />
      )}
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ) || [],
      );
    (focusable()[0] || dialog)?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0],
          last = elements.at(-1);
        if (!first) {
          event.preventDefault();
          dialog?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="modal glass-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="card-heading">
          <h2>{title}</h2>
          <IconButton label="关闭弹窗" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </section>
    </div>
  );
}
export function NumberInput({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  label,
  disabled,
  onBlur,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  disabled?: boolean;
  onBlur?: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current || disabled) setDraft(String(value));
    else if (max !== undefined)
      setDraft((current) =>
        Number(current) > max && value <= max ? String(value) : current,
      );
  }, [value, max, disabled]);
  return (
    <input
      aria-label={label}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        // Empty text is an editing state, never an implicit command to output 0.
        // Reconcile with the latest committed/optimistic value on leaving it.
        setDraft(String(value));
        onBlur?.();
      }}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (text.trim() === "") return;
        const n = Number(text);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}
export function WaveSelect({
  value,
  onChange,
  waveforms,
  disabled,
  label = "选择波形",
}: {
  value: string;
  onChange: (id: string) => void;
  waveforms: Waveform[];
  disabled?: boolean;
  label?: string;
}) {
  return (
    <span className="select-wrap">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">选择波形</option>
        {waveforms.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <ChevronDown size={14} />
    </span>
  );
}
export function ChannelChips({
  value,
  onChange,
  disabled,
}: {
  value: Channel[];
  onChange: (channels: Channel[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="chip-row">
      {(["A", "B"] as Channel[]).map((ch) => (
        <button
          key={ch}
          type="button"
          className={`choice-chip ${value.includes(ch) ? "selected" : ""}`}
          aria-pressed={value.includes(ch)}
          disabled={disabled}
          onClick={() =>
            onChange(
              value.includes(ch)
                ? value.filter((x) => x !== ch)
                : [...value, ch],
            )
          }
        >
          {value.includes(ch) && <Check size={13} />}通道 {ch}
        </button>
      ))}
    </div>
  );
}
export const defaultBounds = (waves: Waveform[]): ControlBounds => ({
  channels: ["A", "B"],
  waveformIds: waves.slice(0, 3).map((w) => w.id),
  minIntensity: { A: 0, B: 0 },
  maxIntensity: { A: 10, B: 10 },
  rampPerSecond: { A: 2, B: 2 },
  allowSync: true,
  allowRandom: false,
  allowRamp: true,
  allowRest: true,
  maxActionSec: 15,
  durationSec: 600,
  decisionIntervalSec: 15,
  preference: "平稳、缓慢变化，适当安排休息。",
});
export const defaultStage = (waveformId: string, index = 0): Stage => ({
  id: crypto.randomUUID(),
  name: `阶段 ${index + 1}`,
  durationSec: 30,
  gapSec: 0,
  channels: ["A", "B"],
  waveformId,
  intensity: { A: 5, B: 5 },
  startIntensity: { A: 0, B: 0 },
  behavior: "hold",
});

export function BoundsEditor({
  bounds,
  onChange,
  waves,
  disabled = false,
  deviceLimits,
}: {
  bounds: ControlBounds;
  onChange: (b: ControlBounds) => void;
  waves: Waveform[];
  disabled?: boolean;
  deviceLimits?: ChannelValues;
}) {
  const patch = (value: Partial<ControlBounds>) =>
    onChange({ ...bounds, ...value });
  return (
    <fieldset className="bounds-editor plain-fieldset" disabled={disabled}>
      <div className="form-grid">
        <Field label="授权通道">
          <ChannelChips
            value={bounds.channels}
            onChange={(channels) => patch({ channels })}
            disabled={disabled}
          />
        </Field>
        <Field label="会话最长时间 / 秒">
          <NumberInput
            label="会话最长时间"
            value={bounds.durationSec}
            min={5}
            max={86400}
            onChange={(durationSec) => patch({ durationSec })}
          />
        </Field>
      </div>
      <Field label="允许使用的波形" hint="AI 仅能从勾选的波形中选择。">
        <div className="wave-checks">
          {waves.map((w) => (
            <label
              key={w.id}
              className={`wave-check ${bounds.waveformIds.includes(w.id) ? "selected" : ""}`}
            >
              <input
                type="checkbox"
                checked={bounds.waveformIds.includes(w.id)}
                onChange={(e) =>
                  patch({
                    waveformIds: e.target.checked
                      ? [...bounds.waveformIds, w.id]
                      : bounds.waveformIds.filter((id) => id !== w.id),
                  })
                }
              />
              {w.name}
            </label>
          ))}
        </div>
      </Field>
      <div className="per-channel-settings ai-channel-settings">
        {(["A", "B"] as Channel[]).map((channel) => (
          <fieldset
            key={channel}
            className={`channel-settings channel-settings-${channel.toLowerCase()}`}
            disabled={disabled || !bounds.channels.includes(channel)}
            aria-label={`AI ${channel} 通道强度范围`}
          >
            <legend>
              通道 {channel}
              {!bounds.channels.includes(channel) ? " · 未授权" : ""}
            </legend>
            <div className="form-grid three">
              <Field label="最低强度">
                <NumberInput
                  label={`AI ${channel} 通道最低强度`}
                  value={bounds.minIntensity[channel]}
                  max={deviceLimits?.[channel] ?? 200}
                  onChange={(value) =>
                    patch({
                      minIntensity: {
                        ...bounds.minIntensity,
                        [channel]: value,
                      },
                    })
                  }
                />
              </Field>
              <Field label="最高强度">
                <NumberInput
                  label={`AI ${channel} 通道最高强度`}
                  value={bounds.maxIntensity[channel]}
                  max={deviceLimits?.[channel] ?? 200}
                  onChange={(value) =>
                    patch({
                      maxIntensity: {
                        ...bounds.maxIntensity,
                        [channel]: value,
                      },
                    })
                  }
                />
              </Field>
              <Field label="变化速率 / 每秒">
                <NumberInput
                  label={`AI ${channel} 通道强度变化速率`}
                  value={bounds.rampPerSecond[channel]}
                  min={0.1}
                  step={0.1}
                  max={20}
                  onChange={(value) =>
                    patch({
                      rampPerSecond: {
                        ...bounds.rampPerSecond,
                        [channel]: value,
                      },
                    })
                  }
                />
              </Field>
            </div>
            {deviceLimits && (
              <p className="field-hint">
                设备 {channel} 通道强度上限 {deviceLimits[channel]}
              </p>
            )}
          </fieldset>
        ))}
      </div>
      <div className="form-grid">
        <Field label="决策间隔 / 秒">
          <NumberInput
            label="AI 决策间隔"
            value={bounds.decisionIntervalSec}
            min={5}
            max={120}
            onChange={(decisionIntervalSec) => patch({ decisionIntervalSec })}
          />
        </Field>
        <Field label="单次动作最长 / 秒">
          <NumberInput
            label="AI 单次动作最长时间"
            value={bounds.maxActionSec}
            min={1}
            max={120}
            onChange={(maxActionSec) => patch({ maxActionSec })}
          />
        </Field>
      </div>
      <div className="toggle-grid">
        <Toggle
          label="允许双通道联动"
          checked={bounds.allowSync}
          onChange={(allowSync) => patch({ allowSync })}
          disabled={disabled}
        />
        <Toggle
          label="允许随机切换"
          checked={bounds.allowRandom}
          onChange={(allowRandom) => patch({ allowRandom })}
          disabled={disabled}
        />
        <Toggle
          label="允许强度渐变"
          checked={bounds.allowRamp}
          onChange={(allowRamp) => patch({ allowRamp })}
          disabled={disabled}
        />
        <Toggle
          label="允许归零休息"
          checked={bounds.allowRest}
          onChange={(allowRest) => patch({ allowRest })}
          disabled={disabled}
        />
      </div>
      <Field label="控制偏好">
        <textarea
          aria-label="控制偏好"
          rows={3}
          value={bounds.preference}
          onChange={(e) => patch({ preference: e.target.value })}
          placeholder="告诉星涟你希望怎样安排变化…"
        />
      </Field>
    </fieldset>
  );
}

export function WaveGraph({
  frames,
  color = "blue",
  compact = false,
}: {
  frames: string[];
  color?: "blue" | "pink";
  compact?: boolean;
}) {
  const points = useMemo(() => {
    const total = frames.length * 4;
    const count = Math.min(100, total);
    const values = Array.from({ length: count }, (_, i) => {
      const offset = Math.floor((i * total) / Math.max(1, count));
      const frame = frames[Math.floor(offset / 4)];
      return frame && /^[0-9a-f]{16}$/i.test(frame)
        ? Math.min(
            100,
            parseInt(
              frame.slice(8 + (offset % 4) * 2, 10 + (offset % 4) * 2),
              16,
            ),
          )
        : 0;
    });
    return (values.length > 1 ? values : [0, 0])
      .map(
        (v, i, a) =>
          `${((i * 300) / (a.length - 1)).toFixed(1)},${(65 - (v / 100) * 52).toFixed(1)}`,
      )
      .join(" ");
  }, [frames]);
  const id = useId().replaceAll(":", "");
  return (
    <svg
      className={`wave-graph ${compact ? "compact" : ""} ${color}`}
      viewBox="0 0 300 76"
      preserveAspectRatio="none"
      role="img"
      aria-label="波形相对幅度预览"
    >
      <defs>
        <linearGradient id={`wave-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity=".22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0 22H300M0 45H300M0 66H300" className="graph-grid" />
      <polygon points={`0,76 ${points} 300,76`} fill={`url(#wave-${id})`} />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function WaveMetadata({ waveform }: { waveform: Waveform }) {
  const range = useMemo(() => {
    let minFrequency = 255,
      maxFrequency = 0,
      minAmplitude = 100,
      maxAmplitude = 0;
    for (const frame of waveform.frames) {
      if (!/^[0-9a-f]{16}$/i.test(frame)) continue;
      for (let offset = 0; offset < 16; offset += 2) {
        const value = parseInt(frame.slice(offset, offset + 2), 16);
        if (offset < 8) {
          minFrequency = Math.min(minFrequency, value);
          maxFrequency = Math.max(maxFrequency, value);
        } else {
          minAmplitude = Math.min(minAmplitude, value);
          maxAmplitude = Math.max(maxAmplitude, value);
        }
      }
    }
    return { minFrequency, maxFrequency, minAmplitude, maxAmplitude };
  }, [waveform.frames]);
  return (
    <div className="wave-metadata">
      <span>
        频率编码{" "}
        <strong>
          {range.minFrequency}–{range.maxFrequency}
        </strong>
      </span>
      <span>
        相对幅度{" "}
        <strong>
          {range.minAmplitude}–{range.maxAmplitude} / 100
        </strong>
      </span>
    </div>
  );
}
