import { useMemo } from "react";
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

export interface ScalingDraft {
  baseline: Pick<Stage, "id" | "intensity" | "startIntensity">[];
  multipliers: ChannelValues;
  inputValues: Record<Channel, string>;
}

export class StageIntensityScalingModel {
  private baseline: Stage[];
  stages: Stage[];
  multipliers = unitMultipliers();
  inputValues = unitInputs();
  inputIssues: Partial<Record<Channel, string>> = {};

  constructor(stages: Stage[], draft?: ScalingDraft) {
    this.stages = cloneStages(stages);
    this.baseline = cloneStages(stages);
    if (!draft) return;
    const baseline = new Map(draft.baseline.map((row) => [row.id, row]));
    if (
      baseline.size !== stages.length ||
      stages.some((stage) => !baseline.has(stage.id)) ||
      channels.some(
        (channel) =>
          parseIntensityMultiplier(draft.multipliers[channel]).value ===
          undefined,
      )
    )
      return;
    const candidate = stages.map((stage) => ({
      ...stage,
      ...baseline.get(stage.id)!,
    }));
    const scaled = scaleStageIntensities(candidate, draft.multipliers);
    if (needsNewBaseline(stages, scaled)) return;
    this.baseline = cloneStages(candidate);
    this.multipliers = { ...draft.multipliers };
    this.inputValues = { ...draft.inputValues };
    for (const channel of channels) {
      const { issue, value } = parseIntensityMultiplier(
        draft.inputValues[channel],
      );
      if (issue) this.inputIssues[channel] = issue;
      else if (value !== this.multipliers[channel])
        this.inputValues[channel] = this.multipliers[channel].toFixed(1);
    }
  }

  snapshot(): ScalingDraft {
    return {
      baseline: this.baseline.map(({ id, intensity, startIntensity }) => ({
        id,
        intensity,
        startIntensity,
      })),
      multipliers: this.multipliers,
      inputValues: this.inputValues,
    };
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
  setStages: (next: Stage[], draft: ScalingDraft) => void,
  draft?: ScalingDraft,
): StageIntensityScaling {
  const model = useMemo(
    () => new StageIntensityScalingModel(stages, draft),
    [stages, draft],
  );
  const commit = (next = model.stages) => setStages(next, model.snapshot());
  return {
    multipliers: model.multipliers,
    inputValues: model.inputValues,
    inputIssues: model.inputIssues,
    inputIssue: model.inputIssue,
    setMultiplier: (channel, input) =>
      commit(model.setMultiplier(channel, input)),
    updateStages: (next) => commit(model.updateStages(next)),
    resetBaseline: (next) => commit(model.resetBaseline(next)),
    resetMultipliers: () => commit(model.resetMultipliers()),
  };
}
