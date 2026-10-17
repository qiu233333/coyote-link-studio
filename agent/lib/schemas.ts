import { z } from "zod";
import type {
  AiDecision,
  Channel,
  ChannelValues,
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

const channels = ["A", "B"] as const;
const channelsSchema = z
  .array(z.enum(channels))
  .min(1)
  .max(2)
  .refine((list) => new Set(list).size === list.length);
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const intensity = z.number().int().min(0).max(200);
const rate = z.number().min(0.1).max(20);
const valuesSchema = (a: z.ZodNumber, b: z.ZodNumber = a) =>
  z.object({ A: a, B: b }).strict();
const intensitySchema = valuesSchema(intensity);
const rateSchema = valuesSchema(rate);

export const boundsSchema = z
  .object({
    channels: channelsSchema,
    waveformIds: z.array(boundedText(200)).min(1).max(200),
    minIntensity: intensitySchema,
    maxIntensity: intensitySchema,
    rampPerSecond: rateSchema,
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
    (bounds) =>
      bounds.channels.every(
        (channel) =>
          bounds.minIntensity[channel] <= bounds.maxIntensity[channel],
      ),
    "A/B 各通道强度范围必须分别有效",
  );

export const decisionSchema = z
  .object({
    action: z.enum(["adjust", "rest", "finish"]),
    channels: channelsSchema,
    waveformId: boundedText(200),
    intensity: intensitySchema,
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
    intensity: intensitySchema,
    startIntensity: intensitySchema,
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

// Compatibility is limited to incoming saved context. New model tool output
// must contain both keys and never accepts a scalar intensity.
export function contextBounds(value: unknown): ControlBounds {
  const data = dictionary(value);
  const legacyPair = (input: unknown) =>
    typeof input === "number" ? { A: input, B: input } : input;
  return boundsSchema.parse({
    ...data,
    minIntensity: legacyPair(data.minIntensity),
    maxIntensity: legacyPair(data.maxIntensity),
    rampPerSecond: legacyPair(data.rampPerSecond),
  });
}

export function decisionBounds(context: unknown): ControlBounds {
  const data = dictionary(context);
  return contextBounds(
    data.bounds ??
      dictionary(data.run).bounds ??
      dictionary(dictionary(data.run).plan).bounds,
  );
}

export function deviceCaps(context: unknown): ChannelValues {
  const data = dictionary(context);
  const deviceLimits = dictionary(dictionary(data.device).limits);
  const configured = dictionary(data.channels);
  const cap = (channel: Channel) => {
    // Deprecated user limit is a fallback only when no device report exists.
    const value = Number(
      deviceLimits[channel] ?? dictionary(configured[channel]).limit ?? 0,
    );
    if (!Number.isFinite(value) || value < 0 || value > 200)
      throw new Error(`通道 ${channel} 的设备上限无效`);
    return Math.floor(value);
  };
  return { A: cap("A"), B: cap("B") };
}

function boundedCaps(context: unknown, bounds: ControlBounds): ChannelValues {
  const data = dictionary(context);
  const hasCaps = "limits" in dictionary(data.device) || "channels" in data;
  const reported = hasCaps ? deviceCaps(context) : bounds.maxIntensity;
  return {
    A: Math.min(bounds.maxIntensity.A, reported.A),
    B: Math.min(bounds.maxIntensity.B, reported.B),
  };
}

export function decisionToolSchema(context: unknown) {
  const bounds = decisionBounds(context);
  const caps = boundedCaps(context, bounds);
  return decisionSchema.extend({
    channels: z
      .array(z.enum(bounds.channels as [Channel, ...Channel[]]))
      .min(1)
      .max(bounds.allowSync ? bounds.channels.length : 1)
      .refine((list) => new Set(list).size === list.length),
    waveformId: z.enum(bounds.waveformIds as [string, ...string[]]),
    intensity: valuesSchema(
      intensity.max(bounds.channels.includes("A") ? caps.A : 0),
      intensity.max(bounds.channels.includes("B") ? caps.B : 0),
    ),
    durationSec: z.number().min(1).max(bounds.maxActionSec),
  });
}

export function validateDecision(value: unknown, context: unknown): AiDecision {
  const decision = decisionToolSchema(context).parse(value);
  const bounds = decisionBounds(context);
  if (decision.channels.some((channel) => !bounds.channels.includes(channel)))
    throw new Error("通道未授权");
  if (decision.channels.length > 1 && !bounds.allowSync)
    throw new Error("未授权双通道联动");
  for (const channel of channels) {
    if (
      !decision.channels.includes(channel) &&
      decision.intensity[channel] !== 0
    )
      throw new Error(`未选通道 ${channel} 的强度必须为 0`);
    if (
      decision.action === "adjust" &&
      decision.channels.includes(channel) &&
      decision.intensity[channel] < bounds.minIntensity[channel]
    )
      throw new Error(`通道 ${channel} 强度低于授权下限`);
    if (decision.action !== "adjust" && decision.intensity[channel] !== 0)
      throw new Error("休息与结束的 A/B 通道必须全部归零");
  }
  if (decision.action === "rest" && !bounds.allowRest)
    throw new Error("未授权休息");
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

export function draftToolSchema(context: unknown) {
  const data = dictionary(context);
  const requested = data.bounds ? contextBounds(data.bounds) : null;
  const caps = requested
    ? boundedCaps(context, requested)
    : deviceCaps(context);
  const allowed = requested?.channels ?? [...channels];
  const selectedChannels = z
    .array(z.enum(allowed as [Channel, ...Channel[]]))
    .min(1)
    .max(2)
    .refine((list) => new Set(list).size === list.length);
  const maxSchema = valuesSchema(
    intensity.max(allowed.includes("A") ? caps.A : 200),
    intensity.max(allowed.includes("B") ? caps.B : 200),
  );
  const stage = stageSchema.extend({
    channels: selectedChannels,
    intensity: maxSchema,
    startIntensity: maxSchema,
  });
  return draftSchema.extend({
    bounds: boundsSchema.safeExtend({
      channels: selectedChannels,
      maxIntensity: maxSchema,
      rampPerSecond: requested
        ? valuesSchema(
            rate.max(allowed.includes("A") ? requested.rampPerSecond.A : 20),
            rate.max(allowed.includes("B") ? requested.rampPerSecond.B : 20),
          )
        : rateSchema,
      durationSec: z
        .number()
        .min(1)
        .max(requested?.durationSec ?? 86400),
      maxActionSec: z
        .number()
        .min(1)
        .max(requested?.maxActionSec ?? 300),
    }),
    stages: z.array(stage).min(1).max(50),
  });
}

export function validateDraft(
  value: unknown,
  context: unknown,
): Omit<TaskPlan, "id" | "version" | "createdAt"> {
  const draft = draftToolSchema(context).parse(value);
  const known = new Set(availableWaveforms(context).map((item) => item.id));
  if (!known.size || draft.bounds.waveformIds.some((id) => !known.has(id)))
    throw new Error("任务包含不存在的波形");
  const data = dictionary(context);
  const requested = data.bounds ? contextBounds(data.bounds) : null;
  for (const channel of draft.bounds.channels) {
    if (requested && !requested.channels.includes(channel))
      throw new Error("草稿包含未授权通道");
    if (
      requested &&
      (draft.bounds.maxIntensity[channel] > requested.maxIntensity[channel] ||
        draft.bounds.minIntensity[channel] < requested.minIntensity[channel] ||
        draft.bounds.rampPerSecond[channel] > requested.rampPerSecond[channel])
    )
      throw new Error(`草稿扩张了通道 ${channel} 的授权范围`);
  }
  if (
    requested &&
    (draft.bounds.durationSec > requested.durationSec ||
      draft.bounds.waveformIds.some(
        (id) => !requested.waveformIds.includes(id),
      ))
  )
    throw new Error("草稿扩张了用户设置的范围");
  if (
    requested &&
    (draft.bounds.maxActionSec > requested.maxActionSec ||
      (["allowSync", "allowRandom", "allowRamp", "allowRest"] as const).some(
        (flag) => draft.bounds[flag] && !requested[flag],
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
    if (stage.channels.length > 1 && !draft.bounds.allowSync)
      throw new Error("阶段双通道联动未授权");
    for (const channel of channels) {
      const start = stage.startIntensity[channel],
        target = stage.intensity[channel];
      if (
        (!stage.channels.includes(channel) || stage.behavior === "rest") &&
        (start !== 0 || target !== 0)
      )
        throw new Error("休息阶段及未选通道的强度必须为 0");
      if (!stage.channels.includes(channel)) continue;
      if (
        target > draft.bounds.maxIntensity[channel] ||
        start > draft.bounds.maxIntensity[channel]
      )
        throw new Error(`阶段超过通道 ${channel} 强度上限`);
      if (
        stage.behavior !== "rest" &&
        (target < draft.bounds.minIntensity[channel] ||
          (stage.behavior === "ramp" &&
            start < draft.bounds.minIntensity[channel]))
      )
        throw new Error(`阶段低于通道 ${channel} 授权下限`);
    }
    if (stage.behavior === "rest" && !draft.bounds.allowRest)
      throw new Error("休息阶段未授权");
    if (stage.behavior === "ramp" && !draft.bounds.allowRamp)
      throw new Error("阶段渐变未授权");
    total += stage.durationSec + stage.gapSec;
  }
  if (total > draft.bounds.durationSec)
    throw new Error("阶段总时间超过最晚截止时间");
  return draft;
}
