import { z } from "zod";
import type { Decoder } from "./draftStore";

export const decode =
  <T>(schema: z.ZodType<T>): Decoder<T> =>
  (value) => {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  };
const text = z.string();
const num = z.number();
const values = z.object({ A: num, B: num });
const channels = z.array(z.enum(["A", "B"])).max(2);
const waveformIds = z.array(text).max(5000);
// Drafts validate shape, including temporarily incomplete inputs. Submission
// still uses the existing device checks and API validation.
const stage = z.object({
  id: text,
  name: text,
  durationSec: num,
  gapSec: num,
  channels,
  waveformId: text,
  waveformBId: text.optional(),
  intensity: values,
  startIntensity: values,
  behavior: z.enum(["hold", "ramp", "rest"]),
});
const stages = z
  .array(stage)
  .max(200)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length);
const scaling = z.object({
  baseline: z
    .array(stage.pick({ id: true, intensity: true, startIntensity: true }))
    .max(200),
  multipliers: values,
  inputValues: z.object({ A: text, B: text }),
});
export const sequenceDraft = decode(
  z.object({
    stages,
    repeat: num,
    shuffle: z.boolean(),
    durationSec: num,
    presetName: text,
    presetId: text.optional(),
    dirty: z.boolean(),
    scaling: scaling.optional(),
  }),
);
const random = z.object({
  channels,
  waveformIds,
  minIntensity: values,
  maxIntensity: values,
  minIntervalSec: num,
  maxIntervalSec: num,
  minDurationSec: num,
  maxDurationSec: num,
  randomWaveform: z.boolean(),
  randomIntensity: z.boolean(),
  randomDuration: z.boolean(),
  seed: num.optional(),
});
export const randomDraft = decode(z.object({ config: random, total: num }));
const bounds = z.object({
  channels,
  waveformIds,
  minIntensity: values,
  maxIntensity: values,
  rampPerSecond: values,
  allowSync: z.boolean(),
  allowRandom: z.boolean(),
  allowRamp: z.boolean(),
  allowRest: z.boolean(),
  maxActionSec: num,
  durationSec: num,
  decisionIntervalSec: num,
  preference: text,
});
export const rangeDraft = decode(z.object({ bounds, base: text }));
export const taskDraft = decode(
  z.object({
    plan: z.object({
      id: text,
      version: num,
      title: text,
      description: text,
      completionCriteria: text,
      bounds,
      stages,
      createdAt: num,
    }),
    baseVersion: num,
    dirty: z.boolean(),
    step: z.union([z.literal(1), z.literal(2)]),
    scaling: scaling.optional(),
  }),
);
export const textDraft = decode(text);
export const storyInputDraft = decode(
  z.object({
    text,
    editId: text,
    sent: z.object({ requestId: text, turnId: text.optional() }).optional(),
  }),
);
export const settingsDraft = decode(
  z.object({
    fields: z.object({
      provider: z.enum(["openai-compatible", "deepseek"]).optional(),
      deepseekThinking: z.enum(["enabled", "disabled"]).optional(),
      baseUrl: text.transform((url) =>
        url.split(/[?#]/, 1)[0].replace(/^(https?:\/\/)?[^/]*@/i, "$1"),
      ),
      model: text,
      contextWindow: num,
      timeoutSec: num,
      draftTimeoutSec: num.optional(),
    }),
    base: text,
  }),
);
