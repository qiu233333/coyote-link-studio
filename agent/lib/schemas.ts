import { z } from "zod";
import type {
  AiDecision,
  ControlBounds,
  TaskPlan,
} from "../../shared/types.ts";

export const profileSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(16384),
  apiKeySet: z.boolean().optional(),
  contextWindow: z.number().int().min(1024).max(2_000_000),
  timeoutSec: z.number().min(2).max(180),
});

const channelsSchema = z
  .array(z.enum(["A", "B"]))
  .min(1)
  .max(2)
  .refine((list) => new Set(list).size === list.length);
const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const boundsSchema = z
  .object({
    channels: channelsSchema,
    waveformIds: z.array(boundedText(200)).min(1).max(200),
    minIntensity: z.number().int().min(0).max(200),
    maxIntensity: z.number().int().min(0).max(200),
    rampPerSecond: z.number().min(0.1).max(20),
    allowSync: z.boolean(),
    allowRandom: z.boolean(),
    allowRamp: z.boolean(),
    allowRest: z.boolean(),
    maxActionSec: z.number().min(1).max(300),
    durationSec: z.number().min(1).max(86400),
    decisionIntervalSec: z.number().min(5).max(120),
    preference: z.string().max(4000),
  })
  .strict()
  .refine(
    (bounds) => bounds.minIntensity <= bounds.maxIntensity,
    "强度范围无效",
  );

export const decisionSchema = z
  .object({
    action: z.enum(["adjust", "rest", "finish"]),
    channels: channelsSchema,
    waveformId: boundedText(200),
    intensity: z.number().int().min(0).max(200),
    durationSec: z.number().min(1).max(3600),
    reason: boundedText(800),
    phaseComplete: z.boolean().optional(),
    stageDurationSec: z.number().min(1).max(86400).optional(),
  })
  .strict();

const stageSchema = z
  .object({
    id: boundedText(100),
    name: boundedText(100),
    durationSec: z.number().min(1).max(86400),
    gapSec: z.number().min(0).max(3600),
    channels: channelsSchema,
    waveformId: boundedText(200),
    waveformBId: boundedText(200).optional(),
    intensity: z.number().int().min(0).max(200),
    startIntensity: z.number().int().min(0).max(200),
    behavior: z.enum(["hold", "ramp", "rest"]),
  })
  .strict();

export const draftSchema = z
  .object({
    title: boundedText(100),
    description: boundedText(4000),
    completionCriteria: boundedText(2000),
    bounds: boundsSchema,
    stages: z.array(stageSchema).min(1).max(50),
  })
  .strict();

type Dict = Record<string, unknown>;
export function dictionary(value: unknown): Dict {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : {};
}

export function decisionBounds(context: unknown): ControlBounds {
  const data = dictionary(context);
  return boundsSchema.parse(
    data.bounds ??
      dictionary(data.run).bounds ??
      dictionary(dictionary(data.run).plan).bounds,
  );
}

export function validateDecision(value: unknown, context: unknown): AiDecision {
  const decision = decisionSchema.parse(value);
  const bounds = decisionBounds(context);
  if (decision.channels.some((channel) => !bounds.channels.includes(channel)))
    throw new Error("通道未授权");
  if (decision.channels.length > 1 && !bounds.allowSync)
    throw new Error("未授权双通道同步");
  if (!bounds.waveformIds.includes(decision.waveformId))
    throw new Error("波形未授权");
  if (decision.durationSec > bounds.maxActionSec)
    throw new Error("动作时间越界");
  if (
    decision.action === "adjust" &&
    (decision.intensity < bounds.minIntensity ||
      decision.intensity > bounds.maxIntensity)
  )
    throw new Error("强度越界");
  if (decision.action === "rest" && !bounds.allowRest)
    throw new Error("未授权休息");
  if (decision.action !== "adjust" && decision.intensity !== 0)
    throw new Error("休息与结束必须归零");
  if (
    decision.stageDurationSec !== undefined &&
    decision.stageDurationSec > bounds.durationSec
  )
    throw new Error("阶段时长越界");
  return decision;
}

export function availableWaveforms(
  context: unknown,
): { id: string; name: string }[] {
  const data = dictionary(context);
  const snapshots = dictionary(dictionary(data.run).waveformSnapshots);
  const values = Array.isArray(data.waveforms)
    ? data.waveforms
    : Object.values(snapshots);
  return values
    .map(dictionary)
    .filter((item) => typeof item.id === "string")
    .map((item) => ({
      id: String(item.id),
      name: String(item.name ?? item.id),
    }));
}

export function validateDraft(
  value: unknown,
  context: unknown,
): Omit<TaskPlan, "id" | "version" | "createdAt"> {
  const draft = draftSchema.parse(value);
  const known = new Set(availableWaveforms(context).map((item) => item.id));
  if (!known.size || draft.bounds.waveformIds.some((id) => !known.has(id)))
    throw new Error("任务包含不存在的波形");
  const data = dictionary(context);
  const configs = dictionary(data.channels);
  const deviceLimits = dictionary(dictionary(data.device).limits);
  const requestedBounds = data.bounds ? boundsSchema.parse(data.bounds) : null;
  for (const channel of draft.bounds.channels) {
    const config = dictionary(configs[channel]);
    const limit = Number(config.limit ?? requestedBounds?.maxIntensity ?? 0);
    const effectiveLimit = Math.min(
      limit,
      Number(deviceLimits[channel] ?? limit),
    );
    if (
      !Number.isFinite(effectiveLimit) ||
      draft.bounds.maxIntensity > effectiveLimit
    )
      throw new Error("草稿超过用户或设备通道上限");
    if (requestedBounds && !requestedBounds.channels.includes(channel))
      throw new Error("草稿包含未授权通道");
  }
  if (
    requestedBounds &&
    (draft.bounds.maxIntensity > requestedBounds.maxIntensity ||
      draft.bounds.minIntensity < requestedBounds.minIntensity ||
      draft.bounds.durationSec > requestedBounds.durationSec ||
      draft.bounds.waveformIds.some(
        (id) => !requestedBounds.waveformIds.includes(id),
      ))
  )
    throw new Error("草稿扩张了用户设置的范围");
  if (
    requestedBounds &&
    (draft.bounds.maxActionSec > requestedBounds.maxActionSec ||
      draft.bounds.rampPerSecond > requestedBounds.rampPerSecond ||
      (["allowSync", "allowRandom", "allowRamp", "allowRest"] as const).some(
        (flag) => draft.bounds[flag] && !requestedBounds[flag],
      ))
  )
    throw new Error("草稿扩张了授权行为");
  if (draft.bounds.maxActionSec > draft.bounds.durationSec)
    throw new Error("动作时长超过任务总时长");
  let total = 0;
  for (const stage of draft.stages) {
    if (
      stage.channels.some(
        (channel) => !draft.bounds.channels.includes(channel),
      ) ||
      !draft.bounds.waveformIds.includes(stage.waveformId) ||
      (stage.waveformBId &&
        !draft.bounds.waveformIds.includes(stage.waveformBId))
    )
      throw new Error("阶段超出任务授权范围");
    if (
      stage.intensity > draft.bounds.maxIntensity ||
      stage.startIntensity > draft.bounds.maxIntensity
    )
      throw new Error("阶段超过强度上限");
    if (stage.channels.length > 1 && !draft.bounds.allowSync)
      throw new Error("阶段双通道同步未授权");
    if (
      stage.behavior === "rest" &&
      (!draft.bounds.allowRest ||
        stage.intensity !== 0 ||
        stage.startIntensity !== 0)
    )
      throw new Error("休息阶段无效");
    if (stage.behavior === "ramp" && !draft.bounds.allowRamp)
      throw new Error("阶段渐变未授权");
    if (
      stage.behavior !== "rest" &&
      stage.intensity < draft.bounds.minIntensity
    )
      throw new Error("阶段低于授权下限");
    total += stage.durationSec + stage.gapSec;
  }
  if (total > draft.bounds.durationSec)
    throw new Error("阶段总时间超过最晚截止时间");
  return draft;
}
