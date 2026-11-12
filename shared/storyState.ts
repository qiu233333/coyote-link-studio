import { z } from "zod";

export const STORY_ENTITIES_PER_GROUP = 24;
const MAX_UPDATES = 12;
const id = z
  .string()
  .max(48)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const name = z.string().trim().min(1).max(100);
const description = z.string().trim().min(1).max(320);

export const goalStatusLabels = {
  active: "进行中",
  completed: "已完成",
  abandoned: "已放弃",
} as const;
export const itemStatusLabels = {
  held: "持有",
  used: "已使用",
  handedOver: "已交出",
  lost: "已失去",
} as const;
export const clueStatusLabels = { open: "未解", solved: "已解" } as const;

const sceneSchema = z.strictObject({
  chapter: name.nullable(),
  location: name.nullable(),
  situation: description.nullable(),
});
const goalSchema = z.strictObject({
  id,
  title: name,
  description,
  status: z.enum(["active", "completed", "abandoned"]),
});
const relationshipSchema = z.strictObject({
  id,
  name,
  description,
  reason: description,
});
const itemSchema = z.strictObject({
  id,
  name,
  description,
  status: z.enum(["held", "used", "handedOver", "lost"]),
});
const clueSchema = z.strictObject({
  id,
  content: description,
  status: z.enum(["open", "solved"]),
});

const updates = <T extends { id: string }>(entry: z.ZodType<T>) =>
  z
    .array(entry)
    .max(MAX_UPDATES)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.id)).size === entries.length,
      "同组更新不能重复使用 ID",
    );

export const storyStateDeltaSchema = z
  .strictObject({
    scene: sceneSchema.partial().optional(),
    goals: updates(goalSchema.partial().required({ id: true })).optional(),
    relationships: updates(
      relationshipSchema.partial().required({ id: true }),
    ).optional(),
    items: updates(itemSchema.partial().required({ id: true })).optional(),
    clues: updates(clueSchema.partial().required({ id: true })).optional(),
  })
  .refine(
    (delta) =>
      (delta.goals?.length ?? 0) +
        (delta.relationships?.length ?? 0) +
        (delta.items?.length ?? 0) +
        (delta.clues?.length ?? 0) <=
      MAX_UPDATES,
    "每轮最多更新 12 个实体",
  )
  .describe(
    "剧情状态增量。无变化用 {}，省略的字段保留，已有实体沿用 storyState 中的 ID。",
  );

export type StoryStateDelta = z.infer<typeof storyStateDeltaSchema>;
type Scene = z.infer<typeof sceneSchema>;
export interface StoryFacts {
  scene: Scene;
  goals: z.infer<typeof goalSchema>[];
  relationships: z.infer<typeof relationshipSchema>[];
  items: z.infer<typeof itemSchema>[];
  clues: z.infer<typeof clueSchema>[];
}
export interface StoryChange {
  label: string;
  detail: string;
}
export interface StorySource {
  messageId: string;
  seq: number;
}
export interface StoryState extends StoryFacts {
  version: number;
  updatedAt: number | null;
  lastUpdate: (StorySource & { changes: StoryChange[] }) | null;
}
export const emptyStoryState = (): StoryState => ({
  scene: { chapter: null, location: null, situation: null },
  goals: [],
  relationships: [],
  items: [],
  clues: [],
  version: 0,
  updatedAt: null,
  lastUpdate: null,
});

export function storyFactsForPrompt(state: StoryState) {
  return {
    scene: state.scene,
    goals: state.goals.map((goal) =>
      goal.status === "active"
        ? goal
        : { id: goal.id, title: goal.title, status: goal.status },
    ),
    relationships: state.relationships,
    items: state.items.map((item) =>
      item.status === "held"
        ? item
        : { id: item.id, name: item.name, status: item.status },
    ),
    clues: state.clues.map((clue) =>
      clue.status === "open"
        ? clue
        : { ...clue, content: clue.content.slice(0, 80) },
    ),
  };
}

function mergeEntries<T extends { id: string }>(
  existing: T[],
  patches: (Partial<T> & { id: string })[] | undefined,
  schema: z.ZodType<T>,
  identity: (entry: T) => string,
  describeChange: (before: T | undefined, after: T) => StoryChange,
  changes: StoryChange[],
) {
  if (!patches?.length) return existing;
  const entries = new Map(existing.map((entry) => [entry.id, entry]));
  for (const patch of patches) {
    const before = entries.get(patch.id);
    const after = schema.parse({ ...before, ...patch });
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push(describeChange(before, after));
    entries.set(after.id, after);
  }
  if (entries.size > STORY_ENTITIES_PER_GROUP)
    throw new Error("剧情状态条目超过组上限");
  const names = new Set(
    [...entries.values()].map((entry) =>
      identity(entry).normalize("NFKC").replace(/\s+/gu, "").toLowerCase(),
    ),
  );
  if (names.size !== entries.size) throw new Error("同一剧情实体须沿用已有 ID");
  return [...entries.values()];
}

export function mergeStoryState(state: StoryFacts, delta: StoryStateDelta) {
  const changes: StoryChange[] = [];
  const scene = { ...state.scene, ...delta.scene };
  const sceneLabels = {
    chapter: "章节",
    location: "地点",
    situation: "局势",
  } as const;
  for (const key of ["chapter", "location", "situation"] as const)
    if (scene[key] !== state.scene[key])
      changes.push({
        label: sceneLabels[key] + "变化",
        detail: scene[key] ?? "尚未明确",
      });
  const goals = mergeEntries(
    state.goals,
    delta.goals,
    goalSchema,
    (goal) => goal.title,
    (before, after) => {
      if (
        before &&
        before.status !== "active" &&
        after.status !== before.status
      )
        throw new Error("已结束的目标不能改回其他状态");
      const label =
        after.status !== before?.status && after.status !== "active"
          ? after.status === "completed"
            ? "目标完成"
            : "目标放弃"
          : before
            ? "目标更新"
            : "新目标";
      return { label, detail: `${after.title} · ${after.description}` };
    },
    changes,
  );
  const relationships = mergeEntries(
    state.relationships,
    delta.relationships,
    relationshipSchema,
    (relation) => relation.name,
    (before, after) => {
      if (
        before &&
        before.description !== after.description &&
        before.reason === after.reason
      )
        throw new Error("关系变化需提供本次变化原因");
      return {
        label: before
          ? before.description === after.description
            ? "关系更新"
            : "关系变化"
          : "关系记录",
        detail: `${after.name} · ${after.description} · ${after.reason}`,
      };
    },
    changes,
  );
  const items = mergeEntries(
    state.items,
    delta.items,
    itemSchema,
    (item) => item.name,
    (before, after) => {
      if (
        before &&
        before.status !== "held" &&
        after.status !== "held" &&
        before.status !== after.status
      )
        throw new Error("未持有的物品须重新取得后才能使用、交出或失去");
      const label =
        before?.status === after.status
          ? "物品更新"
          : after.status === "held"
            ? "获得"
            : "物品" + itemStatusLabels[after.status];
      return { label, detail: `${after.name} · ${after.description}` };
    },
    changes,
  );
  const clues = mergeEntries(
    state.clues,
    delta.clues,
    clueSchema,
    (clue) => clue.content,
    (before, after) => {
      if (before?.status === "solved" && after.status !== "solved")
        throw new Error("已解线索不能改回未解");
      return {
        label:
          after.status === "solved" && before?.status !== "solved"
            ? "线索解决"
            : before
              ? "线索更新"
              : "发现线索",
        detail: after.content,
      };
    },
    changes,
  );
  return { facts: { scene, goals, relationships, items, clues }, changes };
}
