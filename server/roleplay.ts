import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AiProfile } from "../shared/types.js";
import {
  cardSchema,
  cardTemplate,
  cardFields,
  cardInstructions,
  emptyMemory,
  fileOf,
  memorySchema,
  replySchema,
  substitute,
  roleplayExecutionLabel,
  type CharacterCard,
  type RoleplaySession,
  type RoleplayTurn,
  type StoryMessage,
} from "../shared/roleplay.js";
import { AI_MAX_RECOVERY_ATTEMPTS } from "../shared/executionPolicy.js";
import { AiServiceError } from "./ai.js";
import { Controller } from "./controller.js";
import { Store } from "./store.js";
import { assert } from "./errors.js";
import { extractCharacter } from "./characterImport.js";

export interface StoryAi {
  status: { ready: boolean };
  readonly busy?: boolean;
  story(
    operation: "roleplay" | "card" | "summarize",
    profile: AiProfile,
    context: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
const title = z.string().trim().min(1).max(100);
const playerSchema = z
  .object({
    name: title,
    identity: z.string().max(6000),
    relationship: z.string().max(6000),
  })
  .strict();
type Work = {
  abort: AbortController;
  promise: Promise<unknown>;
  turn?: RoleplayTurn;
};
const wait = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error("已取消"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 1000);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
export class RoleplayService {
  private work?: Work;
  private closed = false;
  private recovery = { runId: "", attempt: 0 };
  constructor(
    private store: Store,
    private controller: Controller,
    private ai: StoryAi,
    private retryWait: (signal: AbortSignal) => Promise<void> = wait,
  ) {
    for (const turn of store.list<RoleplayTurn>("story-turns"))
      if (turn.status === "pending") {
        turn.status = "interrupted";
        turn.error = "服务重启，本轮已中断，不会重放输出";
        store.set("story-turns", turn.id, turn);
      }
    controller.on("roleplay-cancel", this.cancel);
    controller.roleplaySummary = () => ({
      activeSessionId: controller.run?.roleplay?.sessionId,
      turn: this.work?.turn,
    });
  }
  cancel = () => {
    const work = this.work;
    if (!work) return;
    work.abort.abort();
    if (work.turn?.status === "pending") {
      work.turn.status = "cancelled";
      this.store.set("story-turns", work.turn.id, work.turn);
    }
    this.controller.broadcast(true);
  };
  async close() {
    this.closed = true;
    this.cancel();
    await this.work?.promise.catch(() => undefined);
    this.controller.off("roleplay-cancel", this.cancel);
  }
  format() {
    return {
      template: cardTemplate,
      fields: cardFields,
      instructions: cardInstructions,
    };
  }
  cards() {
    return this.store.list<CharacterCard>("characters");
  }
  saveCard(input: unknown, id: string = randomUUID()) {
    this.controller.assertUnlocked();
    const card = { ...cardSchema.parse(input), id, updatedAt: Date.now() };
    this.store.set("characters", id, card);
    return card;
  }
  card(id: string) {
    const card = this.store.get<CharacterCard>("characters", id);
    assert(card, "角色不存在", "NOT_FOUND", 404);
    return card;
  }
  deleteCard(id: string) {
    this.controller.assertUnlocked();
    this.card(id);
    this.store.delete("characters", id);
  }
  copyCard(id: string) {
    const data = fileOf(this.card(id));
    data.character.name += " 副本";
    return this.saveCard(data);
  }
  extract(bytes: Buffer) {
    return extractCharacter(bytes);
  }
  private available() {
    assert(!this.closed, "服务已关闭");
    this.controller.assertUnlocked();
    assert(this.ai.status.ready, "AI 运行时尚未就绪", "AI_BUSY", 409);
    assert(
      !this.controller.isActive() || this.controller.run?.owner === "roleplay",
      "请先停止其他控制模式",
      "OWNER_CONFLICT",
      409,
    );
    assert(!this.controller.stopping, "设备正在清理", "CONTROLLER_BUSY", 409);
    const p = this.store.profile();
    assert(p.baseUrl && p.model, "请先配置系统 AI");
    return p;
  }
  async convert(source: unknown) {
    const profile = this.available();
    assert(
      !this.work && !this.ai.busy,
      "AI 正在处理，请稍后解析",
      "AI_BUSY",
      409,
    );
    assert(JSON.stringify(source).length <= 131072, "资料过大，请精简后重试");
    const unit: Work = {
      abort: new AbortController(),
      promise: Promise.resolve(),
    };
    this.work = unit;
    this.controller.roleplayBusy = true;
    unit.promise = this.ai.story(
      "card",
      profile,
      { source, template: cardTemplate },
      unit.abort.signal,
    );
    try {
      const raw = await unit.promise;
      assert(!unit.abort.signal.aborted, "角色解析已取消");
      return z
        .object({
          card: cardSchema,
          warnings: z.array(z.string().max(2000)).max(50),
        })
        .strict()
        .parse(raw);
    } finally {
      if (this.work === unit) {
        this.work = undefined;
        this.controller.roleplayBusy = false;
      }
    }
  }
  sessions() {
    return this.store
      .list<RoleplaySession>("stories")
      .map((s) => ({
        id: s.id,
        title: s.title,
        characterName: s.card.character.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        revision: s.revision,
        turnId: s.turnId,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  session(id: string) {
    const s = this.store.get<RoleplaySession>("stories", id);
    assert(s, "故事不存在", "NOT_FOUND", 404);
    return s;
  }
  create(input: unknown) {
    this.controller.assertUnlocked();
    const v = z
      .object({
        cardId: z.string(),
        title: title.optional(),
        player: playerSchema,
        scenario: z.string().max(16000),
        greetingIndex: z.number().int().min(0).max(30).optional(),
      })
      .strict()
      .parse(input);
    const card = this.card(v.cardId),
      now = Date.now(),
      id = randomUUID();
    const session: RoleplaySession = {
      id,
      title: v.title ?? card.character.name + "的故事",
      card: structuredClone(card),
      player: v.player,
      scenario: v.scenario || card.character.scenario,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      memory: emptyMemory(),
    };
    session.memory.plotBackground = card.character.worldInfo;
    const greeting =
      [card.character.firstMessage, ...card.character.alternateGreetings][
        v.greetingIndex ?? 0
      ] ?? "";
    this.store.transaction(() => {
      this.store.set("stories", id, session);
      if (greeting)
        this.addMessage(session, {
          role: "assistant",
          text: substitute(greeting, card.character.name, v.player.name),
        });
    });
    return session;
  }
  rename(id: string, value: unknown) {
    this.controller.assertUnlocked();
    const s = this.session(id);
    s.title = title.parse(value);
    s.updatedAt = Date.now();
    this.store.set("stories", id, s);
    return s;
  }
  remove(id: string) {
    this.controller.assertUnlocked();
    this.session(id);
    assert(
      !(
        this.controller.isActive() &&
        this.controller.run?.roleplay?.sessionId === id
      ),
      "先停止本故事的设备联动",
    );
    assert(this.work?.turn?.sessionId !== id, "先等待或取消生成");
    this.store.transaction(() => {
      this.store.delete("stories", id);
      this.store.clear(`story-messages:${id}`);
      this.store.clear(`story-archive:${id}`);
      this.store.clear(`story-requests:${id}`);
      for (const t of this.store.list<RoleplayTurn>("story-turns"))
        if (t.sessionId === id) this.store.delete("story-turns", t.id);
    });
  }
  messages(id: string, before?: number) {
    this.session(id);
    const p = this.store.page<StoryMessage>(`story-messages:${id}`, 50, before);
    return { items: p.items.reverse(), cursor: p.cursor };
  }
  export(id: string) {
    const s = this.session(id),
      all: StoryMessage[] = [];
    let cursor: number | undefined;
    do {
      const p = this.store.page<StoryMessage>(
        `story-messages:${id}`,
        100,
        cursor,
      );
      all.unshift(...p.items.reverse());
      cursor = p.items.length === 100 ? p.cursor : undefined;
    } while (cursor);
    return (
      `${s.title}\n角色：${s.card.character.name}\n玩家：${s.player.name}\n\n` +
      all
        .map(
          (m) =>
            `${m.role === "user" ? s.player.name : s.card.character.name}：${m.narration ? m.narration + "\n" : ""}${m.text}${m.execution ? "\n[" + m.execution + "]" : ""}`,
        )
        .join("\n\n")
    );
  }
  private addMessage(
    s: RoleplaySession,
    item: Omit<StoryMessage, "id" | "seq" | "sessionId" | "at">,
  ) {
    const last = this.store.page<StoryMessage>(`story-messages:${s.id}`, 1)
      .items[0];
    const m: StoryMessage = {
      ...item,
      id: randomUUID(),
      seq: (last?.seq ?? 0) + 1,
      sessionId: s.id,
      at: Date.now(),
    };
    this.store.set(`story-messages:${s.id}`, m.id, m);
    return m;
  }
  turn(id: string, turnId: string) {
    this.session(id);
    const t = this.store.get<RoleplayTurn>("story-turns", turnId);
    assert(t?.sessionId === id, "轮次不存在", "NOT_FOUND", 404);
    return t;
  }
  async startLink(id: string, bounds: unknown, requestId: string) {
    this.session(id);
    this.available();
    await this.controller.startRoleplay(id, bounds, requestId);
  }
  link(id: string) {
    this.session(id);
    assert(
      this.controller.run?.roleplay?.sessionId === id &&
        this.controller.isActive(),
      "当前故事未持有设备",
      "OWNER_CONFLICT",
      409,
    );
  }
  send(id: string, raw: unknown) {
    const input = z
      .object({
        text: z.string().trim().min(1).max(8000),
        requestId: z.string().uuid(),
        revision: z.number().int().optional(),
      })
      .strict()
      .parse(raw);
    const s = this.session(id),
      previous = this.store.get<{ turnId: string; text: string }>(
        `story-requests:${id}`,
        input.requestId,
      );
    if (previous) {
      assert(
        previous.text === input.text,
        "重复请求内容不一致",
        "DUPLICATE_REQUEST",
        409,
      );
      return this.turn(id, previous.turnId);
    }
    const profile = this.available();
    assert(
      !this.work || this.work.turn?.sessionId === id,
      "另一项 AI 请求正在处理",
      "AI_BUSY",
      409,
    );
    assert(this.work || !this.ai.busy, "AI 正在处理其他请求", "AI_BUSY", 409);
    assert(
      !this.controller.isActive() ||
        this.controller.run?.roleplay?.sessionId === id,
      "其他故事正在联动",
      "OWNER_CONFLICT",
      409,
    );
    if (input.revision !== undefined)
      assert(
        input.revision === s.revision,
        "故事已在其他标签页更新，请刷新",
        "STORY_CONFLICT",
        409,
      );
    const old = this.work;
    this.cancel();
    s.revision++;
    s.updatedAt = Date.now();
    const turn: RoleplayTurn = {
      id: randomUUID(),
      sessionId: id,
      requestId: input.requestId,
      revision: s.revision,
      status: "pending",
      attempt:
        this.controller.run?.id === this.recovery.runId
          ? this.recovery.attempt
          : 0,
      createdAt: Date.now(),
    };
    s.turnId = turn.id;
    this.store.transaction(() => {
      this.addMessage(s, { role: "user", text: input.text, turnId: turn.id });
      this.store.set("stories", id, s);
      this.store.set("story-turns", turn.id, turn);
      this.store.set(`story-requests:${id}`, input.requestId, {
        turnId: turn.id,
        text: input.text,
      });
    });
    const unit: Work = {
      abort: new AbortController(),
      promise: Promise.resolve(),
      turn,
    };
    this.work = unit;
    this.controller.roleplayBusy = true;
    // Capture the authorization before waiting for cancellation. Resume/new bounds
    // can never turn a pure-text request into an output command.
    const run = this.controller.run,
      link =
        run?.owner === "roleplay" && run.status === "running"
          ? { id: run.id, version: run.boundsVersion }
          : null;
    unit.promise = (async () => {
      try {
        await old?.promise;
        if (unit.abort.signal.aborted) return;
        await this.generate(s, unit, profile, link);
      } catch (error) {
        if (unit.abort.signal.aborted) return;
        turn.status = "failed";
        turn.error = this.store.redact(
          error instanceof Error ? error.message : "演绎失败",
        );
        this.store.set("story-turns", turn.id, turn);
        if (
          link &&
          this.controller.run?.id === link.id &&
          this.controller.isActive()
        )
          await this.controller.finish(
            "faulted",
            turn.error,
            "ai-inference",
            error instanceof AiServiceError
              ? error.code
              : "AI_INVALID_DECISION",
          );
      } finally {
        if (this.work === unit) {
          this.work = undefined;
          this.controller.roleplayBusy = false;
        }
        this.controller.broadcast(true);
      }
    })();
    this.controller.broadcast(true);
    return turn;
  }
  private async generate(
    s: RoleplaySession,
    unit: Work,
    profile: AiProfile,
    link: { id: string; version: number } | null,
  ) {
    const signal = unit.abort.signal,
      turn = unit.turn!;
    const valid = () =>
      !signal.aborted &&
      this.work === unit &&
      this.session(s.id).revision === turn.revision;
    const request = async (
      operation: "roleplay" | "summarize",
      context: unknown,
    ): Promise<unknown> => {
      for (;;) {
        signal.throwIfAborted();
        try {
          return await this.ai.story(operation, profile, context, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          if (!(
            link &&
            error instanceof AiServiceError &&
            error.retryable &&
            turn.attempt < AI_MAX_RECOVERY_ATTEMPTS
          ))
            throw error;
          turn.attempt++;
          if (link) this.recovery = { runId: link.id, attempt: turn.attempt };
          this.store.set("story-turns", turn.id, turn);
          this.controller.broadcast(true);
          await this.retryWait(signal);
        }
      }
    };
    let recent = this.store
      .page<StoryMessage>(`story-messages:${s.id}`, 100)
      .items.reverse();
    const budget = Math.max(1024, (profile.contextWindow - 6000) * 1.5);
    // Fold old messages into archival ranges before each turn. Full text stays
    // in SQLite; the model receives only compact memory and recent dialogue.
    const fixed = () => ({
      roleAndPlayer: {
        character: { ...s.card.character, avatar: undefined },
        player: s.player,
      },
      recentPlot: s.memory.recentPlot,
      recentDialogue: recent.map((m) => ({
        seq: m.seq,
        role: m.role,
        text: m.text,
        narration: m.narration,
      })),
      plotBackground: s.memory.plotBackground,
      longPlot: s.memory.longPlot,
      longDialogue: s.memory.longDialogue,
      scenario: s.scenario,
    });
    let keep = 20;
    recent = recent.slice(-keep);
    while (keep > 1 && JSON.stringify(fixed()).length > budget * 0.8) {
      keep = Math.ceil(keep / 2);
      recent = recent.slice(-keep);
    }
    const cutoff = recent.slice(-keep)[0]?.seq ?? 1;
    for (;;) {
      let older = this.store.storyRange<StoryMessage>(
        `story-messages:${s.id}`,
        s.memory.throughSeq,
        cutoff,
        20,
      );
      if (!older.length) break;
      const compactContext = () => ({
        memory: s.memory,
        messages: older.map((m) => ({
          seq: m.seq,
          role: m.role,
          text: m.text,
          narration: m.narration,
        })),
      });
      while (
        older.length > 1 &&
        JSON.stringify(compactContext()).length > budget
      )
        older = older.slice(0, Math.ceil(older.length / 2));
      assert(
        JSON.stringify(compactContext()).length <= budget,
        "摘要上下文超过模型窗口，请增加上下文窗口",
        "AI_CONTEXT_TOO_LARGE",
      );
      const memory = memorySchema.parse(
        await request("summarize", compactContext()),
      );
      if (!valid()) return;
      const throughSeq = older.at(-1)!.seq;
      this.store.transaction(() => {
        this.store.set(`story-archive:${s.id}`, String(throughSeq), {
          fromSeq: older[0].seq,
          throughSeq,
          memory,
          at: Date.now(),
        });
        s.memory = { ...memory, throughSeq };
        s.title = this.session(s.id).title;
        this.store.set("stories", s.id, s);
      });
    }
    recent = recent.slice(-keep);
    const current = this.controller.run;
    const authorized = !!(
      link &&
      current?.id === link.id &&
      current.boundsVersion === link.version &&
      current.status === "running"
    );
    const context = {
      memory: fixed(),
      authorization: authorized ? current!.roleplay!.bounds : null,
      output: authorized ? current!.roleplay!.output : null,
      device: {
        intensities: this.controller.device.state.intensities,
        limits: this.controller.device.state.limits,
      },
      waveforms: authorized
        ? Object.values(current!.waveformSnapshots).map((w) => ({
            id: w.id,
            name: w.name,
          }))
        : [],
    };
    assert(
      JSON.stringify(context).length <= budget,
      "角色与剧情上下文超过模型窗口，请精简设定或增加上下文窗口",
      "AI_CONTEXT_TOO_LARGE",
    );
    const reply = replySchema.parse(await request("roleplay", context));
    if (!valid()) return;
    if (!authorized)
      assert(
        reply.control.action === "keep",
        "纯文字或暂停状态不能改变设备输出",
      );
    const now = Date.now();
    this.store.transaction(() => {
      const output = authorized
        ? this.controller.applyRoleplay(link!.id, link!.version, reply.control)
        : undefined;
      s.memory = { ...reply.memory, throughSeq: s.memory.throughSeq };
      s.updatedAt = now;
      s.title = this.session(s.id).title;
      turn.status = "completed";
      if (link) this.recovery = { runId: link.id, attempt: 0 };
      this.addMessage(s, {
        role: "assistant",
        text: substitute(reply.dialogue, s.card.character.name, s.player.name),
        narration: substitute(
          reply.narration,
          s.card.character.name,
          s.player.name,
        ),
        turnId: turn.id,
        control: reply.control,
        controlReason: reply.controlReason,
        output,
        execution: roleplayExecutionLabel(reply.control, authorized),
      });
      this.store.set("stories", s.id, s);
      this.store.set("story-turns", turn.id, turn);
    });
  }
}
