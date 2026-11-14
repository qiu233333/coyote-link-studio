import { useId } from "react";
import type { Channel } from "../shared/types";
import {
  intensityMultiplierRange,
  type StageIntensityScaling,
} from "./stageIntensityScaling";

export function StageIntensityScale({
  scaling,
  disabled,
}: {
  scaling: StageIntensityScaling;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <section className="stage-intensity-scale" aria-labelledby={`${id}-title`}>
      <div className="stage-intensity-scale-heading">
        <h3 id={`${id}-title`}>全局强度倍率</h3>
        <button
          type="button"
          className="stage-intensity-scale-reset"
          disabled={disabled}
          onClick={() => {
            if (!disabled) scaling.resetMultipliers();
          }}
        >
          恢复 1 倍
        </button>
      </div>
      <details className="inline-details">
        <summary>倍率说明</summary>
        <p id={`${id}-help`}>
          分别缩放 A/B
          各阶段的起始与目标强度，休息阶段保持归零。载入方案、修改强度或增删阶段后，会以当前强度为新的
          1 倍基准。
        </p>
      </details>
      <div className="stage-intensity-scale-channels">
        {(["A", "B"] as Channel[]).map((channel) => (
          <fieldset
            key={channel}
            className={`stage-intensity-scale-channel stage-intensity-scale-${channel.toLowerCase()}`}
            disabled={disabled}
          >
            <legend>{channel} 通道</legend>
            <div className="stage-intensity-scale-inputs">
              <input
                type="range"
                {...intensityMultiplierRange}
                aria-label={`${channel} 通道全局强度倍率滑块`}
                aria-describedby={`${id}-help`}
                value={scaling.multipliers[channel]}
                onChange={(event) => {
                  if (!disabled)
                    scaling.setMultiplier(channel, Number(event.target.value));
                }}
              />
              <input
                type="number"
                {...intensityMultiplierRange}
                inputMode="decimal"
                aria-label={`${channel} 通道全局强度倍率`}
                aria-describedby={`${id}-help${scaling.inputIssues[channel] ? ` ${id}-issue` : ""}`}
                aria-invalid={!!scaling.inputIssues[channel]}
                value={scaling.inputValues[channel]}
                onChange={(event) => {
                  if (!disabled)
                    scaling.setMultiplier(channel, event.target.value);
                }}
              />
              <span>倍</span>
            </div>
            <small>0.1–10 倍 · 步进 0.1</small>
          </fieldset>
        ))}
      </div>
      {scaling.inputIssue && (
        <p id={`${id}-issue`} className="playback-issue" role="alert">
          {scaling.inputIssue}
        </p>
      )}
    </section>
  );
}
