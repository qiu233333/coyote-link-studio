import { z } from "zod";
import type { Channel, ChannelValues } from "./types.js";

export const CARD_SPEC = "coyote_roleplay_card" as const;
export const MAX_CARD_BYTES = 20 * 1024 * 1024;
const prose = z.string().max(32000);
export const characterSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    avatar: z
      .string()
      .max(14000000)
      .nullable()
      .default(null)
      .refine(
        (v) =>
          v === null ||
          /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v),
        "头像须为内嵌 PNG/JPEG/WebP",
      ),
    description: prose.default(""),
    background: prose.default(""),
    personality: prose.default(""),
    speakingStyle: prose.default(""),
    scenario: prose.default(""),
    firstMessage: prose.default(""),
    alternateGreetings: z.array(prose).max(30).default([]),
    exampleDialogue: prose.default(""),
    worldInfo: prose.default(""),
    linkageStyle: prose.default(""),
  })
  .strict();
export const cardSchema = z
  .object({
    spec: z.literal(CARD_SPEC),
    version: z.literal(1),
    character: characterSchema,
    tags: z.array(z.string().max(100)).max(50).default([]),
    creator: z.string().max(200).default(""),
  })
  .strict();
export type CardFile = z.infer<typeof cardSchema>;
export type CharacterCard = CardFile & { id: string; updatedAt: number };
const values = z
  .object({
    A: z.number().int().min(0).max(200),
    B: z.number().int().min(0).max(200),
  })
  .strict();
export const roleplayBoundsSchema = z
  .object({
    channels: z
      .array(z.enum(["A", "B"]))
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length),
    waveformIds: z.array(z.string().min(1)).min(1).max(300),
    minIntensity: values,
    maxIntensity: values,
    rampPerSecond: z
      .object({
        A: z.number().min(0.1).max(20),
        B: z.number().min(0.1).max(20),
      })
      .strict(),
    allowSync: z.boolean(),
    allowRest: z.boolean(),
    allowRamp: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const c of v.channels)
      if (v.minIntensity[c] > v.maxIntensity[c])
        ctx.addIssue({
          code: "custom",
          path: ["minIntensity", c],
          message: "最低强度超过最高强度",
        });
  });
export type RoleplayBounds = z.infer<typeof roleplayBoundsSchema>;
export interface RoleplayOutputState {
  A: { target: number; waveformId: string; rampPerSecond: number };
  B: { target: number; waveformId: string; rampPerSecond: number };
}
const patch = z
  .object({
    target: z.number().int().min(0).max(200).optional(),
    waveformId: z.string().min(1).optional(),
    rampPerSecond: z.number().min(0.1).max(20).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "补丁不能为空");
export const outputPatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z
    .object({
      action: z.literal("update"),
      channels: z
        .object({ A: patch.optional(), B: patch.optional() })
        .strict()
        .refine((v) => !!v.A || !!v.B, "请选择修改通道"),
    })
    .strict(),
  z
    .object({
      action: z.literal("rest"),
      channels: z
        .array(z.enum(["A", "B"]))
        .min(1)
        .max(2),
    })
    .strict(),
]);
export type RoleplayPatch = z.infer<typeof outputPatchSchema>;
export const memorySchema = z
  .object({
    recentPlot: z.string().max(6000),
    plotBackground: z.string().max(8000),
    longPlot: z.string().max(8000),
    longDialogue: z.string().max(6000),
  })
  .strict();
export type StoryMemory = z.infer<typeof memorySchema> & { throughSeq: number };
export const replySchema = z
  .object({
    narration: z.string().max(12000),
    dialogue: z.string().max(12000),
    memory: memorySchema,
    control: outputPatchSchema,
    controlReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine(
    (v) => !!(v.narration.trim() || v.dialogue.trim()),
    "剧情回复不能为空",
  );
export type RoleplayReply = z.infer<typeof replySchema>;
export interface RoleplaySession {
  id: string;
  title: string;
  card: CharacterCard;
  player: { name: string; identity: string; relationship: string };
  scenario: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  memory: StoryMemory;
  turnId?: string;
}
export interface StoryMessage {
  id: string;
  sessionId: string;
  seq: number;
  at: number;
  role: "user" | "assistant";
  text: string;
  narration?: string;
  turnId?: string;
  control?: RoleplayPatch;
  output?: RoleplayOutputState;
  execution?: string;
  controlReason?: string;
}
export interface RoleplayTurn {
  id: string;
  sessionId: string;
  requestId: string;
  revision: number;
  status: "pending" | "completed" | "cancelled" | "failed" | "interrupted";
  attempt: number;
  error?: string;
  createdAt: number;
}
export interface RoleplayLink {
  sessionId: string;
  bounds: RoleplayBounds;
  output: RoleplayOutputState;
}
export const emptyMemory = (): StoryMemory => ({
  recentPlot: "",
  plotBackground: "",
  longPlot: "",
  longDialogue: "",
  throughSeq: 0,
});
export const cardTemplate: CardFile = {
  spec: CARD_SPEC,
  version: 1,
  character: {
    name: "星涟",
    avatar: null,
    description: "探索未知世界的向导",
    background: "熟悉这座城市的秘密",
    personality: "冷静、好奇",
    speakingStyle: "自然中文，简洁台词与适当动作描写",
    scenario: "玩家来到夜间开放的试炼馆",
    firstMessage: "星涟递来徽章：准备从哪里开始？",
    alternateGreetings: [],
    exampleDialogue:
      "{{user}}：这里有什么规则？\n{{char}}：先告诉我，你想尝试怎样的挑战。",
    worldInfo: "试炼分为探索、挑战与休息",
    linkageStyle: "随剧情平缓递进，穿插休息",
  },
  tags: ["探索"],
  creator: "",
};
export const cardFields = Object.keys(characterSchema.shape);
export const cardInstructions = `请制作一个 JSON 角色卡，严格遵循下方示例的 spec、version 和字段名，不添加设备权限、密钥、脚本、外部链接或实际硬件指令。avatar 可为 null，其余资料按要求创作。只返回 JSON。\n${JSON.stringify(cardTemplate, null, 2)}`;
export function fileOf(card: CharacterCard): CardFile {
  const { spec, version, character, tags, creator } = card;
  return { spec, version, character, tags, creator };
}
export function substitute(text: string, character: string, user: string) {
  return text
    .replace(/\{\{char\}\}/gi, () => character)
    .replace(/\{\{user\}\}/gi, () => user);
}
export function roleplayExecutionLabel(
  control: RoleplayPatch,
  linked: boolean,
) {
  if (!linked) return "纯文字演绎";
  if (control.action === "keep") return "保持原参数，未提交新的强度或波形";
  if (control.action === "rest")
    return "归零休息目标已提交，设备实际强度以回传为准";
  return "参数更新已提交，设备实际强度以回传为准";
}
export function applyOutputPatch(
  current: RoleplayOutputState,
  raw: unknown,
  bounds: RoleplayBounds,
): RoleplayOutputState {
  const change = outputPatchSchema.parse(raw),
    next = structuredClone(current);
  if (change.action === "rest") {
    if (!bounds.allowRest) throw new Error("未授权归零休息");
    for (const c of change.channels) {
      if (!bounds.channels.includes(c)) throw new Error("通道未授权");
      next[c].target = 0;
    }
  }
  if (change.action === "update")
    for (const c of ["A", "B"] as Channel[]) {
      const item = change.channels[c];
      if (!item) continue;
      if (!bounds.channels.includes(c)) throw new Error("通道未授权");
      if (item.rampPerSecond !== undefined && !bounds.allowRamp)
        throw new Error("未授权调整变化速率");
      next[c] = { ...next[c], ...item };
      if (item.target === 0 && !bounds.allowRest)
        throw new Error("未授权归零休息");
    }
  for (const c of ["A", "B"] as Channel[]) {
    const v = next[c];
    if (!bounds.channels.includes(c)) {
      if (v.target !== 0) throw new Error("未授权通道必须归零");
      continue;
    }
    if (
      v.target > bounds.maxIntensity[c] ||
      (v.target > 0 && v.target < bounds.minIntensity[c])
    )
      throw new Error(`${c} 强度超出授权`);
    if (!bounds.waveformIds.includes(v.waveformId))
      throw new Error(`${c} 波形未授权`);
    if (v.rampPerSecond > bounds.rampPerSecond[c])
      throw new Error(`${c} 变化速率超出授权`);
  }
  if (!bounds.allowSync && next.A.target > 0 && next.B.target > 0)
    throw new Error("未授权双通道同时输出");
  return next;
}
