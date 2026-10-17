import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { channelValues } from "../shared/intensity.js";
import type {
  ControlBounds,
  PlaybackConfig,
  TaskPlan,
  Waveform,
} from "../shared/types.js";
import { assert } from "./errors.js";

const channel = z.enum(["A", "B"]);
const intensityValue = z.number().int().min(0).max(200);
const rateValue = z.number().min(0.1).max(20);
// Legacy scalars migrate atomically. New maps must always include both channels;
// never merge a partial map with defaults or another field's previous values.
export const channelIntensitySchema = z.union([
  intensityValue.transform(channelValues),
  z.object({ A: intensityValue, B: intensityValue }).strict(),
]);
export const channelRateSchema = z.union([
  rateValue.transform(channelValues),
  z.object({ A: rateValue, B: rateValue }).strict(),
]);
export const boundsSchema = z
  .object({
    channels: z
      .array(channel)
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length),
    waveformIds: z.array(z.string()).min(1).max(200),
    minIntensity: channelIntensitySchema,
    maxIntensity: channelIntensitySchema,
    rampPerSecond: channelRateSchema,
    allowSync: z.boolean(),
    allowRandom: z.boolean(),
    allowRamp: z.boolean(),
    allowRest: z.boolean(),
    maxActionSec: z.number().min(1).max(300),
    durationSec: z.number().min(1).max(86400),
    decisionIntervalSec: z.number().min(5).max(120),
    preference: z.string().max(4000),
  })
  .refine(
    (b) => b.channels.every((c) => b.maxIntensity[c] >= b.minIntensity[c]),
    "各通道强度上限不能小于下限",
  );
export const stageSchema = z.object({
  id: z.string().max(200),
  name: z.string().min(1).max(200),
  durationSec: z.number().min(0.1).max(86400),
  gapSec: z.number().min(0).max(3600),
  channels: z
    .array(channel)
    .min(1)
    .max(2)
    .refine((v) => new Set(v).size === v.length),
  waveformId: z.string(),
  waveformBId: z.string().optional(),
  intensity: channelIntensitySchema,
  startIntensity: channelIntensitySchema,
  behavior: z.enum(["hold", "ramp", "rest"]),
});
const randomSchema = z
  .object({
    channels: z
      .array(channel)
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length),
    waveformIds: z.array(z.string()).min(1),
    minIntensity: channelIntensitySchema,
    maxIntensity: channelIntensitySchema,
    minIntervalSec: z.number().min(1).max(300),
    maxIntervalSec: z.number().min(1).max(300),
    minDurationSec: z.number().min(0.1).max(300),
    maxDurationSec: z.number().min(0.1).max(300),
    randomWaveform: z.boolean(),
    randomIntensity: z.boolean(),
    randomDuration: z.boolean(),
    seed: z.number().int().min(0).max(4294967295).optional(),
  })
  .refine(
    (r) =>
      r.channels.every((c) => r.maxIntensity[c] >= r.minIntensity[c]) &&
      r.maxIntervalSec >= r.minIntervalSec &&
      r.maxDurationSec >= r.minDurationSec,
    "随机范围的上限不能小于下限",
  );
export const playbackSchema = z
  .object({
    mode: z.enum(["single", "playlist", "stages", "random"]),
    stages: z.array(stageSchema).max(200),
    repeat: z.number().int().min(0).max(10000),
    shuffle: z.boolean(),
    durationSec: z.number().min(0.1).max(86400),
    random: randomSchema.optional(),
    singleTargets: z
      .object({
        A: z.number().int().min(0).max(200).optional(),
        B: z.number().int().min(0).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .refine(
    (p) => (p.mode === "random" ? Boolean(p.random) : p.stages.length > 0),
    "请选择播放内容",
  );
export const planSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  title: z.string().min(1).max(200),
  description: z.string().max(10000),
  completionCriteria: z.string().max(4000),
  bounds: boundsSchema,
  stages: z.array(stageSchema).min(1).max(100),
  createdAt: z.number(),
});
export function parseBounds(input: unknown): ControlBounds {
  return boundsSchema.parse(input);
}
export function parsePlayback(input: unknown): PlaybackConfig {
  return playbackSchema.parse(input);
}
export function parsePlan(input: unknown): TaskPlan {
  return planSchema.parse(input);
}
export function normalizeWaveform(
  input: unknown,
  suggestedName?: string,
  builtin = false,
): Waveform {
  const object =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const frames = Array.isArray(input) ? input : (object.raw ?? object.frames);
  assert(
    Array.isArray(frames) && frames.length > 0 && frames.length <= 100000,
    "波形应包含 1 到 100000 个 V3 帧。",
  );
  const normalized = frames.map((frame, index) => {
    assert(
      typeof frame === "string" && /^[0-9a-fA-F]{16}$/.test(frame),
      `第 ${index + 1} 帧须为 8 字节（16 位）十六进制字符串。`,
    );
    const bytes = Buffer.from(frame, "hex");
    assert(
      [...bytes.subarray(0, 4)].every((v) => v >= 10 && v <= 240) &&
        [...bytes.subarray(4)].every((v) => v <= 100),
      `第 ${index + 1} 帧的频率或幅度超出郊狼 V3 协议范围。`,
    );
    return frame.toUpperCase();
  });
  const label = object.label as { cn?: string; en?: string } | undefined;
  const name = String(
    suggestedName || object.name || label?.cn || label?.en || "导入波形",
  )
    .trim()
    .slice(0, 100);
  const hash = createHash("sha256").update(normalized.join("")).digest("hex");
  return {
    id: randomUUID(),
    name,
    frames: normalized,
    hash,
    builtin,
    favorite: false,
    lastUsedAt: 0,
    durationMs: normalized.length * 100,
  };
}
