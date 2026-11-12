import { useEffect, useState } from "react";
import { Activity, ChevronDown } from "lucide-react";
import type { ActionRecord } from "../shared/actionRecord";
import type { AppSnapshot, Channel } from "../shared/types";
import {
  actionCardModel,
  channelChange,
  percent,
  targetChange,
  waveformChange,
} from "./actionCardModel";

export function ActionCard({
  record,
  state,
}: {
  record: ActionRecord;
  state?: AppSnapshot;
}) {
  const [now, setNow] = useState(Date.now);
  const current = state?.actionExecution?.id === record.id;
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current]);
  const view = actionCardModel(record, state, Math.max(now, Date.now()));
  return (
    <section
      className="ai-action-card"
      aria-label="本轮联动动作"
      aria-live="off"
    >
      <div className="ai-action-heading">
        <span>
          <Activity size={15} aria-hidden="true" />
          本轮联动
        </span>
        <span className={`ai-action-status ${view.live ? "live" : ""}`}>
          {view.status}
        </span>
      </div>
      <p className="ai-action-title">{view.title}</p>
      <div className="ai-action-targets">
        {(["A", "B"] as Channel[]).map((c) => (
          <span key={c} className={`action-${c}`}>
            <b>{c}</b> {targetChange(record.channels[c])}
          </span>
        ))}
      </div>
      {record.reason && <p className="ai-action-reason">{record.reason}</p>}
      <details className="ai-action-details">
        <summary>
          <ChevronDown size={14} aria-hidden="true" />
          查看变化详情
        </summary>
        <div className="ai-action-channels">
          {(["A", "B"] as Channel[]).map((c) => {
            const channel = record.channels[c],
              p = channel.after,
              before = channel.before;
            const report = view.report?.[c],
              range = channel.range;
            const delta =
              p?.target !== undefined && before?.target !== undefined
                ? p.target - before.target
                : undefined;
            const mode =
              (delta === 0 && p?.rampPerSecond === before?.rampPerSecond) ||
              record.kind === "keep"
                ? "保持当前节奏"
                : p?.target === 0
                  ? "归零"
                  : p?.rampPerSecond !== undefined
                    ? `渐变速率 ${p.rampPerSecond}/秒`
                    : "—";
            return (
              <div key={c} className={`ai-action-channel action-${c}`}>
                <div className="ai-action-channel-head">
                  <strong>通道 {c}</strong>
                  <span>{channelChange(channel, record.kind)}</span>
                </div>
                <div className="ai-action-values">
                  <div>
                    <strong>{report ?? "—"}</strong>
                    <small>
                      {view.report ? view.reportLabel : "无回传记录"}
                    </small>
                  </div>
                  <span>
                    目标 <b>{p?.target ?? "—"}</b>
                  </span>
                </div>
                {range && (
                  <div className="ai-action-meter" aria-hidden="true">
                    {report !== undefined && (
                      <span
                        style={{ width: `${percent(report, range.max)}%` }}
                      />
                    )}
                    {p?.target !== undefined && (
                      <i style={{ left: `${percent(p.target, range.max)}%` }} />
                    )}
                  </div>
                )}
                <div className="ai-action-scale">
                  <span>0</span>
                  <span>
                    {range
                      ? `${range.source === "authorization" ? "授权" : "设备"}上限 ${range.max}`
                      : "上限未记录"}
                  </span>
                </div>
                {range?.source === "authorization" && (
                  <small>
                    非休息强度范围 {range.min}–{range.max}
                  </small>
                )}
                <p>波形：{waveformChange(channel)}</p>
                <p>变化方式：{mode}</p>
              </div>
            );
          })}
        </div>
        <p className="ai-action-note">{view.note}</p>
        <small>强度回传不代表波形已执行完毕。</small>
        <details className="ai-action-raw">
          <summary>原始记录</summary>
          <pre>{JSON.stringify(record, null, 2)}</pre>
        </details>
      </details>
      <div className="ai-action-time">
        {view.reportLabel} ·{" "}
        {view.report?.at
          ? new Date(view.report.at).toLocaleTimeString("zh-CN", {
              hour12: false,
            })
          : "—"}
      </div>
    </section>
  );
}
