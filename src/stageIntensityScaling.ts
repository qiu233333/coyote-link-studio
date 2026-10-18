import { useCallback, useRef, useState } from "react";
import type { Channel, ChannelValues, Stage } from "../shared/types";

export const intensityMultiplierRange = { min: 0.1, max: 10, step: 0.1 };

const channels: Channel[] = ["A", "B"];
const unitMultipliers = (): ChannelValues => ({ A: 1, B: 1 });
const unitInputs = (): Record<Channel, string> => ({ A: "1.0", B: "1.0" });

function cloneStages(stages: Stage[]): Stage[] {
  return stages.map((stage) => ({
    ...stage,
    channels: [...stage.channels],
    intensity:
      stage.behavior === "rest" ? { A: 0, B: 0 } : { ...stage.intensity },
    startIntensity:
      stage.behavior === "rest" ? { A: 0, B: 0 } : { ...stage.startIntensity },
  }));
}

export function parseIntensityMultiplier(input: string | number): {
  value?: number;
  issue?: string;
} {
  const numeric = typeof input === "string" ? Number(input.trim()) : input;
  const stepped = Math.round(numeric * 10) / 10;
  if (
    (typeof input === "string" && !input.trim()) ||
    !Number.isFinite(numeric) ||
    numeric < intensityMultiplierRange.min ||
    numeric > intensityMultiplierRange.max ||
    Math.abs(numeric - stepped) > 1e-9
  ) {
    return { issue: "请输入 0.1–10 之间的倍率（步进 0.1）" };
  }
  return { value: stepped };
}

/** Always calculate from the explicit draft baseline, without capping device limits. */
export function scaleStageIntensities(
  baseline: Stage[],
  multipliers: ChannelValues,
): Stage[] {
  return cloneStages(baseline).map((stage) => ({
    ...stage,
    intensity: {
      A: Math.round(stage.intensity.A * multipliers.A),
      B: Math.round(stage.intensity.B * multipliers.B),
    },
    startIntensity: {
      A: Math.round(stage.startIntensity.A * multipliers.A),
      B: Math.round(stage.startIntensity.B * multipliers.B),
    },
  }));
}

function needsNewBaseline(current: Stage[], next: Stage[]): boolean {
  if (current.length !== next.length) return true;
  const previous = new Map(current.map((stage) => [stage.id, stage]));
  return next.some((stage) => {
    const old = previous.get(stage.id);
    return (
      !old ||
      (old.behavior === "rest") !== (stage.behavior === "rest") ||
      channels.some(
        (channel) =>
          old.intensity[channel] !== stage.intensity[channel] ||
          old.startIntensity[channel] !== stage.startIntensity[channel],
      )
    );
  });
}

/** Local editor state only: persist `stages`, never the baseline or multipliers. */
export class StageIntensityScalingModel {
  private baseline: Stage[];
  stages: Stage[];
  multipliers = unitMultipliers();
  inputValues = unitInputs();
  inputIssues: Partial<Record<Channel, string>> = {};

  constructor(stages: Stage[]) {
    this.stages = cloneStages(stages);
    this.baseline = cloneStages(stages);
  }

  get inputIssue(): string | undefined {
    return (
      channels
        .filter((channel) => this.inputIssues[channel])
        .map((channel) => `${channel} 通道倍率：${this.inputIssues[channel]}`)
        .join("；") || undefined
    );
  }

  setMultiplier(channel: Channel, input: string | number): Stage[] | undefined {
    this.inputValues = {
      ...this.inputValues,
      [channel]: typeof input === "number" ? input.toFixed(1) : input,
    };
    const parsed = parseIntensityMultiplier(input);
    this.inputIssues = { ...this.inputIssues, [channel]: parsed.issue };
    if (parsed.value === undefined) return undefined;
    this.multipliers = { ...this.multipliers, [channel]: parsed.value };
    this.stages = scaleStageIntensities(this.baseline, this.multipliers);
    return this.stages;
  }

  updateStages(next: Stage[]): Stage[] {
    const normalized = cloneStages(next);
    if (needsNewBaseline(this.stages, normalized)) {
      return this.resetBaseline(normalized);
    }
    // Keep metadata and stage order current while preserving each original intensity.
    const baselineById = new Map(
      this.baseline.map((stage) => [stage.id, stage]),
    );
    this.baseline = normalized.map((stage) => ({
      ...stage,
      intensity: { ...baselineById.get(stage.id)!.intensity },
      startIntensity: { ...baselineById.get(stage.id)!.startIntensity },
    }));
    this.stages = normalized;
    return this.stages;
  }

  resetBaseline(next = this.stages): Stage[] {
    this.baseline = cloneStages(next);
    this.stages = cloneStages(next);
    this.multipliers = unitMultipliers();
    this.inputValues = unitInputs();
    this.inputIssues = {};
    return this.stages;
  }

  resetMultipliers(): Stage[] {
    this.multipliers = unitMultipliers();
    this.inputValues = unitInputs();
    this.inputIssues = {};
    this.stages = scaleStageIntensities(this.baseline, this.multipliers);
    return this.stages;
  }
}

export interface StageIntensityScaling {
  multipliers: ChannelValues;
  inputValues: Record<Channel, string>;
  inputIssues: Partial<Record<Channel, string>>;
  inputIssue: string | undefined;
  setMultiplier: (channel: Channel, input: string | number) => void;
  updateStages: (next: Stage[]) => void;
  resetBaseline: (next?: Stage[]) => void;
  resetMultipliers: () => void;
}

export function useStageIntensityScaling(
  stages: Stage[],
  setStages: (next: Stage[]) => void,
): StageIntensityScaling {
  const modelRef = useRef<StageIntensityScalingModel | null>(null);
  if (!modelRef.current)
    modelRef.current = new StageIntensityScalingModel(stages);
  const model = modelRef.current;
  const setter = useRef(setStages);
  setter.current = setStages;
  const [, render] = useState(0);
  const commit = useCallback((next?: Stage[]) => {
    if (next) setter.current(next);
    render((version) => version + 1);
  }, []);
  const setMultiplier = useCallback(
    (channel: Channel, input: string | number) =>
      commit(model.setMultiplier(channel, input)),
    [commit, model],
  );
  const updateStages = useCallback(
    (next: Stage[]) => commit(model.updateStages(next)),
    [commit, model],
  );
  const resetBaseline = useCallback(
    (next?: Stage[]) => commit(model.resetBaseline(next)),
    [commit, model],
  );
  const resetMultipliers = useCallback(
    () => commit(model.resetMultipliers()),
    [commit, model],
  );
  return {
    multipliers: model.multipliers,
    inputValues: model.inputValues,
    inputIssues: model.inputIssues,
    inputIssue: model.inputIssue,
    setMultiplier,
    updateStages,
    resetBaseline,
    resetMultipliers,
  };
}
