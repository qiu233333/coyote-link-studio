import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { Controller, type AiBridge } from "../server/controller.ts";
import { CoyoteDevice } from "../server/device.ts";
import { RoleplayService, type StoryAi } from "../server/roleplay.ts";
import { AiServiceError } from "../server/ai.ts";
import { extractCharacter } from "../server/characterImport.ts";
import {
  cardTemplate,
  cardSchema,
  fileOf,
  applyOutputPatch,
  emptyMemory,
  replySchema,
  roleplayExecutionLabel,
  type RoleplayReply,
  type RoleplayBounds,
  type RoleplaySession,
  type StoryMessage,
} from "../shared/roleplay.ts";
import {
  emptyStoryState,
  mergeStoryState,
  STORY_ENTITIES_PER_GROUP,
  type StoryStateDelta,
} from "../shared/storyState.ts";

const tick = (c: Controller) => (c as unknown as { tick(): void }).tick();
const flush = () => new Promise<void>((r) => setImmediate(r));
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("wait timed out");
};
const answer = (
  control: RoleplayReply["control"] = { action: "keep" },
): RoleplayReply => ({
  narration: "她推开通往下一幕的门。",
  dialogue: "你准备怎样探索？",
  replyOptions: [
    "我仔细看看手中的徽章。",
    "我跟着你走进下一间屋子。",
    "先等等，能告诉我这里的来历吗？",
  ],
  memory: {
    recentPlot: "进入试炼",
    plotBackground: "城市与试炼馆",
    longPlot: "玩家接受徽章",
    longDialogue: "约定由玩家选择下一步",
  },
  control,
  storyStateDelta: {},
});
async function fixture({ simulate = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "coyote-roleplay-")),
    store = new Store(directory);
  store.saveSettings({
    baseUrl: "http://127.0.0.1:9876/v1",
    model: "fixture",
    apiKey: "private-fixture",
  });
  let respond: StoryAi["story"] = async (op) =>
      op === "summarize" ? answer().memory : answer(),
    calls = 0,
    retries = 0;
  const ai: AiBridge & StoryAi = {
    status: { ready: true },
    decide: async () => {
      throw Error("roleplay must not schedule autonomous decisions");
    },
    draft: async () => {
      throw Error("no draft");
    },
    story: async (...args) => {
      calls++;
      return respond(...args);
    },
  };
  const device = new CoyoteDevice(),
    controller = new Controller(store, device, ai, [
      { name: "波形一", frames: ["0A0A0A0A00000000", "0B0B0B0B10101010"] },
      { name: "波形二", frames: ["0C0C0C0C20202020"] },
    ]);
  if (simulate) await controller.connect({ protocol: "simulator" });
  const waves = controller.snapshot().waveforms;
  const bounds: RoleplayBounds = {
    channels: ["A", "B"],
    waveformIds: waves.map((w) => w.id),
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 20, B: 19 },
    rampPerSecond: { A: 20, B: 20 },
    allowSync: true,
    allowRamp: true,
    allowRest: true,
  };
  const service = new RoleplayService(store, controller, ai, async () => {
    retries++;
    await flush();
  });
  const card = service.saveCard(structuredClone(cardTemplate)),
    session = service.create({
      cardId: card.id,
      player: { name: "旅人", identity: "探索者", relationship: "向导与旅人" },
      scenario: "星城试炼",
    });
  const send = async (text = "我接过徽章") => {
    const turn = service.send(session.id, { text, requestId: randomUUID() });
    await until(() => service.turn(session.id, turn.id).status !== "pending");
    await flush();
    return service.turn(session.id, turn.id);
  };
  return {
    directory,
    store,
    controller,
    device,
    service,
    card,
    session,
    bounds,
    waves,
    send,
    setReply: (fn: StoryAi["story"]) => (respond = fn),
    calls: () => calls,
    retries: () => retries,
    async close() {
      await service.close();
      await controller.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("reply choices are persisted, remain proposals until selected and use the normal idempotent message path", async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.service.messages(f.session.id).items[0].replyOptions,
      undefined,
      "legacy greetings need no migration",
    );
    assert.equal((await f.send()).status, "completed");
    const message = f.service.messages(f.session.id).items.at(-1)!;
    assert.deepEqual(message.replyOptions, answer().replyOptions);
    assert.equal(f.calls(), 1, "options share the narrative request");
    const reopened = new Store(f.directory);
    try {
      assert.deepEqual(
        reopened.get<StoryMessage>(`story-messages:${f.session.id}`, message.id)
          ?.replyOptions,
        answer().replyOptions,
      );
    } finally {
      reopened.close();
    }
    const chosen = message.replyOptions![1];
    f.setReply(async (_op, _profile, context) => {
      const text = JSON.stringify(context);
      assert.ok(
        text.includes(chosen),
        "chosen text is an ordinary player message",
      );
      assert.ok(
        !text.includes(answer().replyOptions[0]),
        "unchosen suggestions are not history or memory",
      );
      return answer();
    });
    const request = { text: chosen, requestId: randomUUID() };
    const first = f.service.send(f.session.id, request);
    assert.equal(f.service.send(f.session.id, request).id, first.id);
    await until(
      () => f.service.turn(f.session.id, first.id).status !== "pending",
    );
    assert.equal(f.service.turn(f.session.id, first.id).status, "completed");
    assert.equal(
      f.service
        .messages(f.session.id)
        .items.filter((m) => m.role === "user" && m.text === chosen).length,
      1,
    );
    assert.equal(f.calls(), 2);
    assert.equal(
      f.controller.isActive(),
      false,
      "suggestions do not start device control",
    );
  } finally {
    await f.close();
  }
});

const openingFacts: StoryStateDelta = {
  scene: {
    chapter: "星城入口",
    location: "试炼馆前厅",
    situation: "向导交给旅人一枚徽章。",
  },
  goals: [
    {
      id: "entry",
      title: "找到入口",
      description: "定位试炼馆内门。",
      status: "active",
    },
  ],
  relationships: [
    {
      id: "guide",
      name: "星涟",
      description: "互相试探",
      reason: "在前厅初次相见。",
    },
  ],
  items: [
    {
      id: "badge",
      name: "银色徽章",
      description: "向导交给旅人的徽章。",
      status: "held",
    },
  ],
  clues: [
    { id: "pattern", content: "徽章上的星纹与门锁相似。", status: "open" },
  ],
};

test("story state rejects illegal transitions and total capacity without mutating confirmed facts", () => {
  const initial = mergeStoryState(emptyStoryState(), openingFacts).facts;
  const terminal = mergeStoryState(initial, {
    goals: [{ id: "entry", status: "completed" }],
    items: [{ id: "badge", status: "used" }],
    clues: [{ id: "pattern", status: "solved" }],
  }).facts;
  const confirmed = structuredClone(terminal);
  for (const delta of [
    { goals: [{ id: "entry", status: "active" }] },
    { items: [{ id: "badge", status: "lost" }] },
    { clues: [{ id: "pattern", status: "open" }] },
    { relationships: [{ id: "guide", description: "信任" }] },
  ] satisfies StoryStateDelta[]) {
    assert.throws(() =>
      mergeStoryState(terminal, {
        ...delta,
        scene: { location: "不得部分更新" },
      }),
    );
    assert.deepEqual(terminal, confirmed);
  }
  const full = {
    ...initial,
    items: Array.from({ length: STORY_ENTITIES_PER_GROUP }, (_, index) => ({
      ...initial.items[0],
      id: `item${index}`,
      name: `物品${index}`,
    })),
  };
  assert.throws(
    () => mergeStoryState(full, { items: openingFacts.items }),
    /上限/,
  );
  assert.equal(mergeStoryState(terminal, {}).facts.items[0].status, "used");
  assert.deepEqual(
    mergeStoryState(terminal, { items: [{ id: "badge", status: "held" }] })
      .facts.items,
    [{ ...terminal.items[0], status: "held" }],
  );
});

test("old pure-text stories initialize from accepted replies and preserve distinct facts and sources", async () => {
  const f = await fixture({ simulate: false });
  try {
    const { storyState: _state, ...legacy } = f.session;
    f.store.set("stories", legacy.id, legacy);
    assert.deepEqual(
      f.service.session(legacy.id).storyState,
      emptyStoryState(),
    );
    assert.equal(
      f.service.messages(legacy.id).items[0].storyChanges,
      undefined,
    );
    assert.equal(f.calls(), 0);
    f.setReply(async () => ({
      ...answer(),
      narration: "前厅里，星涟将银色徽章交给旅人，并指了指带星纹的门锁。",
      storyStateDelta: openingFacts,
    }));
    assert.equal(
      (await f.send("我接受徽章，答应寻找入口。")).status,
      "completed",
    );
    const first = f.service.session(legacy.id).storyState;
    assert.equal(first.version, 1);
    assert.equal(f.calls(), 1);
    const source = f.service.message(legacy.id, first.lastUpdate!.messageId);
    assert.equal(first.updatedAt, source.at);
    assert.equal(source.seq, first.lastUpdate!.seq);
    assert.deepEqual(source.storyChanges, first.lastUpdate!.changes);
    assert.ok(source.storyChanges!.some((change) => change.label === "获得"));
    assert.equal(first.items[0].status, "held");

    f.setReply(async (_op, _profile, context) => {
      const snapshot = context as { storyState: typeof first };
      assert.deepEqual(snapshot.storyState.items, first.items);
      assert.ok(!JSON.stringify(context).includes(source.replyOptions![2]));
      return {
        ...answer(),
        narration: "旅人用徽章打开内门，星涟因此开始信任旅人。",
        storyStateDelta: {
          scene: { situation: "内门已打开。" },
          goals: [{ id: "entry", status: "completed" }],
          relationships: [
            {
              id: "guide",
              description: "初步信任",
              reason: "旅人用徽章打开了内门。",
            },
          ],
          items: [{ id: "badge", status: "used" }],
          clues: [{ id: "pattern", status: "solved" }],
        },
      };
    });
    assert.equal((await f.send("我把徽章对准门锁。")).status, "completed");
    const second = f.service.session(legacy.id).storyState;
    assert.deepEqual(second.scene, {
      ...first.scene,
      situation: "内门已打开。",
    });
    assert.deepEqual(second.goals, [
      { ...first.goals[0], status: "completed" },
    ]);
    assert.equal(second.relationships.length, 1);
    assert.equal(second.relationships[0].description, "初步信任");
    assert.deepEqual(second.items, [{ ...first.items[0], status: "used" }]);
    assert.deepEqual(second.clues, [{ ...first.clues[0], status: "solved" }]);
    assert.deepEqual(
      second.lastUpdate!.changes.map((change) => change.label),
      ["局势变化", "目标完成", "关系变化", "物品已使用", "线索解决"],
    );
    f.setReply(async (_op, _profile, context) => {
      const snapshot = context as { storyState: typeof second };
      assert.deepEqual(snapshot.storyState.items, [
        { id: "badge", name: "银色徽章", status: "used" },
      ]);
      return {
        ...answer(),
        storyStateDelta: {
          scene: { situation: "内门已打开。" },
          items: [{ id: "badge", status: "used" }],
        },
      };
    });
    assert.equal((await f.send("我点点头。")).status, "completed");
    const third = f.service.session(legacy.id).storyState;
    assert.equal(third.version, 3);
    assert.deepEqual(third.lastUpdate!.changes, []);
    assert.deepEqual(third.items, second.items);
    assert.deepEqual(third.goals, second.goals);
    assert.deepEqual(
      f.service.message(legacy.id, source.id).storyChanges,
      first.lastUpdate!.changes,
    );

    const other = f.service.create({
      cardId: f.card.id,
      player: legacy.player,
      scenario: "",
    });
    assert.deepEqual(f.service.session(other.id).storyState, emptyStoryState());
    assert.throws(() => f.service.message(other.id, source.id));
    const reopened = new Store(f.directory);
    try {
      assert.deepEqual(
        reopened.get<RoleplaySession>("stories", legacy.id)?.storyState,
        third,
      );
      assert.deepEqual(
        reopened.get<RoleplaySession>("stories", other.id)?.storyState,
        emptyStoryState(),
      );
    } finally {
      reopened.close();
    }
    assert.equal(f.controller.isActive(), false);
  } finally {
    await f.close();
  }
});

test("invalid deltas use the format retry budget and idempotent acceptance applies only once", async () => {
  const f = await fixture({ simulate: false });
  try {
    const request = {
      text: "我接过徽章",
      requestId: randomUUID(),
      revision: 0,
    };
    let attempts = 0;
    f.setReply(async (_op, _profile, context) => {
      attempts++;
      if (attempts === 1)
        return {
          ...answer(),
          storyStateDelta: { items: [{ id: "badge", status: "held" }] },
        };
      assert.match(
        (context as { responseFormatRepair: string }).responseFormatRepair,
        /storyStateDelta/,
      );
      assert.equal(f.service.session(f.session.id).storyState.version, 0);
      return { ...answer(), storyStateDelta: openingFacts };
    });
    const turn = f.service.send(f.session.id, request);
    assert.equal(f.service.send(f.session.id, request).id, turn.id);
    await until(
      () => f.service.turn(f.session.id, turn.id).status === "completed",
    );
    assert.equal(f.service.send(f.session.id, request).id, turn.id);
    const accepted = f.service.session(f.session.id).storyState;
    assert.equal(accepted.version, 1);
    assert.equal(accepted.items.length, 1);
    assert.equal(attempts, 2);
    assert.equal(
      f.service.messages(f.session.id).items.filter((m) => m.storyChanges)
        .length,
      1,
    );

    f.setReply(async () => ({
      ...answer(),
      storyStateDelta: {
        items: [
          { ...openingFacts.items![0], id: "duplicate", name: "银色 徽章" },
        ],
      },
    }));
    const failed = await f.send("拿起桌上的东西");
    assert.equal(failed.status, "failed");
    assert.equal(failed.formatAttempt, 3);
    assert.deepEqual(f.service.session(f.session.id).storyState, accepted);
    assert.throws(
      () =>
        f.service.send(f.session.id, { ...request, requestId: randomUUID() }),
      /更新/,
    );
  } finally {
    await f.close();
  }
});

test("state and assistant reply roll back together when saving the accepted turn fails", async (t) => {
  const f = await fixture({ simulate: false });
  const original = f.store.set.bind(f.store);
  const write = t.mock.method(
    f.store,
    "set",
    (collection: string, id: string, value: unknown) => {
      if (
        collection === "story-turns" &&
        (value as { status: string }).status === "completed"
      )
        throw Error("fixture write failure");
      return original(collection, id, value);
    },
  );
  try {
    f.setReply(async () => ({ ...answer(), storyStateDelta: openingFacts }));
    assert.equal((await f.send()).status, "failed");
    assert.deepEqual(
      f.service.session(f.session.id).storyState,
      emptyStoryState(),
    );
    assert.equal(
      f.service
        .messages(f.session.id)
        .items.filter((m) => m.role === "assistant").length,
      1,
    );
    assert.equal(f.store.list(`story-nodes:${f.session.id}`).length, 0);
  } finally {
    write.mock.restore();
    await f.close();
  }
});

test("named nodes preserve exact historical context, reply choices and state through later compaction and source deletion", async () => {
  const f = await fixture({ simulate: false });
  const future = "密码是 7319";
  try {
    const sourceId = f.session.id;
    // Existing assistant messages are readable, but cannot be promoted to snapshots.
    const opening = f.service.messages(sourceId).items[0];
    assert.equal(opening.nodeRound, undefined);
    assert.throws(
      () => f.service.branches.save(sourceId, opening.id, { name: "开场" }),
      /没有可用/,
    );
    const oldReply = {
      ...opening,
      id: randomUUID(),
      seq: 2,
      turnId: randomUUID(),
      text: "早期回复",
    };
    f.store.set(`story-messages:${sourceId}`, oldReply.id, oldReply);
    const { completedRounds: _round, ...legacy } = f.session;
    f.store.set("stories", sourceId, legacy);
    for (let i = 0; i < 10; i++)
      assert.equal((await f.send(`我等了片刻 ${i}`)).status, "completed");
    f.setReply(async (op) =>
      op === "summarize"
        ? answer().memory
        : {
            ...answer(),
            narration: "她把徽章交给你。",
            storyStateDelta: openingFacts,
          },
    );
    assert.equal((await f.send()).status, "completed");
    const anchor = f.service.session(sourceId);
    const tip = f.service.messages(sourceId).items.at(-1)!;
    assert.equal(tip.nodeRound, 12);
    assert.ok(anchor.memory.throughSeq > 0);
    const userMessage = f.service.messages(sourceId).items.at(-2)!;
    assert.throws(
      () =>
        f.service.branches.save(sourceId, userMessage.id, { name: "玩家消息" }),
      /没有可用/,
    );

    const bookmark = f.service.branches.save(sourceId, tip.id, {
      name: "收到徽章",
    });
    assert.deepEqual(
      f.service.branches.save(sourceId, tip.id, { name: "重复保存" }),
      bookmark,
    );
    assert.equal(f.service.message(sourceId, tip.id).bookmarked, true);
    f.service.branches.rename(sourceId, tip.id, { name: "银色徽章节点" });
    assert.equal(
      f.service.branches.list(sourceId).items[0].name,
      "银色徽章节点",
    );
    f.service.saveCard(
      {
        ...fileOf(f.card),
        character: { ...f.card.character, name: "后来改名的角色" },
      },
      f.card.id,
    );

    f.setReply(async (op) => {
      const memory = { ...answer().memory, longPlot: future };
      return op === "summarize"
        ? memory
        : {
            ...answer(),
            narration: future,
            memory,
            storyStateDelta: {
              scene: { location: "未来密室", situation: future },
            },
          };
    });
    for (let i = 0; i < 3; i++)
      assert.equal((await f.send(`后续剧情 ${i}`)).status, "completed");
    assert.match(f.service.export(sourceId), /7319/);
    assert.ok(
      f.service.session(sourceId).memory.throughSeq > anchor.memory.throughSeq,
    );
    const calls = f.calls();
    const request = { name: "旧节点分支", requestId: randomUUID() };
    const fork = f.service.branches.fork(sourceId, tip.id, request);
    assert.equal(
      f.service.branches.fork(sourceId, tip.id, request).id,
      fork.id,
    );
    assert.throws(
      () =>
        f.service.branches.fork(sourceId, tip.id, { ...request, name: "冲突" }),
      /内容不一致/,
    );
    const other = f.service.branches.fork(sourceId, tip.id, {
      name: "另一个方向",
      requestId: randomUUID(),
    });
    assert.equal(f.calls(), calls);
    assert.equal(f.service.sessions().length, 3);
    const inherited = f.service.messages(fork.id).items;
    assert.deepEqual(
      inherited.map((m) => m.seq),
      Array.from({ length: tip.seq }, (_, i) => i + 1),
    );
    assert.ok(
      inherited.every(
        (m) =>
          m.sessionId === fork.id &&
          m.id !== m.inheritedFrom?.messageId &&
          !m.turnId,
      ),
    );
    const forkTip = inherited.at(-1)!;
    assert.deepEqual(forkTip.replyOptions, tip.replyOptions);
    assert.equal(forkTip.inheritedFrom?.messageId, tip.id);
    assert.deepEqual(fork.memory, anchor.memory);
    assert.equal(fork.card.character.name, f.card.character.name);
    assert.equal(fork.storyState.lastUpdate!.messageId, forkTip.id);
    assert.equal(
      f.service.message(fork.id, fork.storyState.lastUpdate!.messageId).seq,
      tip.seq,
    );
    assert.deepEqual(fork.storyState.items, anchor.storyState.items);
    assert.equal(fork.turnId, undefined);
    assert.doesNotMatch(f.service.export(fork.id), /7319|后续剧情/);
    f.service.branches.remove(sourceId, tip.id);
    assert.equal(f.service.branches.list(sourceId).items.length, 0);
    assert.equal(f.service.message(sourceId, tip.id).bookmarked, false);
    assert.equal(f.service.sourceAvailable(fork), true);
    f.service.rename(sourceId, "源故事新名称");
    assert.equal(f.service.sourceAvailable(fork), true);
    assert.equal(f.service.session(fork.id).origin?.storyTitle, anchor.title);
    f.service.remove(sourceId);
    assert.equal(f.service.sourceAvailable(fork), false);
    assert.equal(
      f.service.branches.fork(sourceId, tip.id, request).id,
      fork.id,
    );
    const nested = f.service.branches.fork(fork.id, forkTip.id, {
      name: "再次分支",
      requestId: randomUUID(),
    });
    assert.equal(nested.origin!.storyId, fork.id);

    const reopened = new Store(f.directory);
    try {
      assert.deepEqual(
        reopened.get<RoleplaySession>("stories", nested.id),
        nested,
      );
      assert.equal(reopened.list(`story-nodes:${nested.id}`).length, 11);
    } finally {
      reopened.close();
    }
    const continueStory = async (
      story: RoleplaySession,
      text: string,
      location: string,
    ) => {
      f.setReply(async (op, _p, context) => {
        const serialized = JSON.stringify(context);
        assert.doesNotMatch(
          serialized,
          /7319|后续剧情|未来密室|后来改名的角色/,
        );
        assert.ok(
          !serialized.includes(tip.replyOptions![2]),
          "unchosen option must stay out of every context",
        );
        if (op === "summarize") {
          const { throughSeq: _throughSeq, ...memory } = story.memory;
          return memory;
        }
        assert.ok(serialized.includes(text));
        return {
          ...answer(),
          memory: { ...answer().memory, recentPlot: location },
          storyStateDelta: { scene: { location } },
        };
      });
      const turn = f.service.send(story.id, {
        text,
        requestId: randomUUID(),
        revision: 0,
      });
      await until(() => f.service.turn(story.id, turn.id).status !== "pending");
      const result = f.service.turn(story.id, turn.id);
      assert.equal(result.status, "completed", result.error);
    };
    await continueStory(fork, tip.replyOptions![1], "花园");
    await continueStory(other, "我自己决定路线", "钟楼");
    assert.equal(f.service.session(fork.id).memory.recentPlot, "花园");
    assert.equal(f.service.session(other.id).storyState.scene.location, "钟楼");
    assert.equal(f.service.session(fork.id).storyState.scene.location, "花园");
    assert.equal(f.service.messages(fork.id).items.at(-1)?.nodeRound, 13);
  } finally {
    await f.close();
  }
});

test("forks use committed nodes during live generation and do not copy device control or cancelled turns", async () => {
  const f = await fixture();
  try {
    const id = f.session.id;
    await f.service.startLink(id, f.bounds, randomUUID());
    f.setReply(async () =>
      answer({ action: "update", channels: { A: { target: 6 } } }),
    );
    assert.equal((await f.send()).status, "completed");
    const tip = f.service.messages(id).items.at(-1)!;
    const runId = f.controller.run!.id;
    let resolve!: (value: unknown) => void;
    f.setReply(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.service.send(id, {
      text: "尚未回答的消息",
      requestId: randomUUID(),
    });
    await until(() => !!resolve);
    const output = structuredClone(f.controller.run!.roleplay!.output);
    const count = f.calls();
    f.service.branches.save(id, tip.id, { name: "运行中书签" });
    const branch = f.service.branches.fork(id, tip.id, {
      name: "纯文字分支",
      requestId: randomUUID(),
    });
    assert.equal(f.calls(), count);
    assert.equal(f.controller.run!.id, runId);
    assert.equal(f.controller.run!.roleplay!.sessionId, id);
    assert.deepEqual(f.controller.run!.roleplay!.output, output);
    assert.throws(
      () =>
        f.service.send(branch.id, {
          text: "暂时不可发送",
          requestId: randomUUID(),
        }),
      /AI 请求正在处理/,
    );
    const copied = f.service.messages(branch.id).items.at(-1)!;
    assert.equal(copied.seq, tip.seq);
    assert.equal(copied.control, undefined);
    assert.equal(copied.output, undefined);
    assert.equal(copied.turnId, undefined);
    assert.equal(copied.historicalControl?.targets?.A, 6);
    f.service.cancel();
    resolve(answer({ action: "update", channels: { A: { target: 18 } } }));
    await until(() => !f.controller.roleplayBusy);
    assert.equal(f.service.turn(id, pending.id).status, "cancelled");
    assert.equal(f.store.list(`story-nodes:${id}`).length, 1);
    assert.equal(f.controller.run!.roleplay!.output.A.target, 6);
    assert.throws(
      () =>
        f.service.send(branch.id, {
          text: "暂时不可发送",
          requestId: randomUUID(),
        }),
      /其他故事正在联动/,
    );
  } finally {
    await f.close();
  }
});

test("failed branch transactions roll back story, prefix, snapshots and idempotency records", async (t) => {
  const f = await fixture({ simulate: false });
  try {
    assert.equal((await f.send()).status, "completed");
    const tip = f.service.messages(f.session.id).items.at(-1)!;
    const request = { name: "回滚验证", requestId: randomUUID() };
    const original = f.store.set.bind(f.store);
    let rolledBackId = "";
    const write = t.mock.method(
      f.store,
      "set",
      (collection: string, key: string, value: unknown) => {
        if (collection === "story-branch-requests") {
          rolledBackId = (value as { resultId: string }).resultId;
          throw new Error("fixture branch write failure");
        }
        original(collection, key, value);
      },
    );
    try {
      assert.throws(
        () => f.service.branches.fork(f.session.id, tip.id, request),
        /fixture branch write failure/,
      );
    } finally {
      write.mock.restore();
    }
    assert.ok(rolledBackId);
    assert.equal(f.service.sessions().length, 1);
    assert.equal(f.store.list(`story-messages:${rolledBackId}`).length, 0);
    assert.equal(f.store.list(`story-nodes:${rolledBackId}`).length, 0);
    assert.equal(
      f.store.has("story-branch-requests", request.requestId),
      false,
    );
    assert.notEqual(
      f.service.branches.fork(f.session.id, tip.id, request).id,
      rolledBackId,
    );
  } finally {
    await f.close();
  }
});

test("native template is portable and role/authority fields cannot escape the card schema", () => {
  const value = cardSchema.parse(JSON.parse(JSON.stringify(cardTemplate)));
  assert.deepEqual(value, cardTemplate);
  assert.throws(() =>
    cardSchema.parse({ ...value, bounds: { maxIntensity: 200 } }),
  );
  assert.throws(() =>
    cardSchema.parse({
      ...value,
      character: {
        ...value.character,
        avatar: "https://example.com/image.png",
      },
    }),
  );
});
test("third party JSON extraction is local, preserves source, does not treat scripts as executable", () => {
  const source = {
    spec: "chara_card_v2",
    data: {
      name: "向导",
      description: "探索",
      extensions: { script: "do not execute" },
      character_book: { entries: [{ content: "星城" }] },
      avatar: "https://example.com/private.png",
    },
  };
  const parsed = extractCharacter(Buffer.from(JSON.stringify(source)));
  assert.equal((parsed.source as { name: string }).name, "向导");
  assert.equal(parsed.avatar, null);
  assert.ok(parsed.warnings.length >= 2);
  assert.ok(!JSON.stringify(parsed.source).includes("private.png"));
  const native = extractCharacter(Buffer.from(JSON.stringify(cardTemplate)));
  assert.deepEqual(native.native, cardTemplate);
  assert.throws(() =>
    extractCharacter(
      Buffer.from('{"spec":"coyote_roleplay_card","version":99}'),
    ),
  );
});
function crc(bytes: Buffer) {
  let c = -1;
  for (const b of bytes) {
    c ^= b;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const b = Buffer.alloc(data.length + 12);
  b.writeUInt32BE(data.length);
  b.write(type, 4);
  data.copy(b, 8);
  b.writeUInt32BE(crc(b.subarray(4, -4)), b.length - 4);
  return b;
}
function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk(
      "tEXt",
      Buffer.from(
        "chara\0" +
          Buffer.from(JSON.stringify({ name: "V2角色" })).toString("base64"),
      ),
    ),
    chunk(
      "tEXt",
      Buffer.from(
        "ccv3\0" +
          Buffer.from(
            JSON.stringify({
              spec: "chara_card_v3",
              data: { name: "V3角色", personality: "温和" },
            }),
          ).toString("base64"),
      ),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
test("PNG reads embedded V3 before V2, strips metadata from portrait and validates corruption", () => {
  const bytes = png(),
    parsed = extractCharacter(bytes);
  assert.equal((parsed.source as { name: string }).name, "V3角色");
  assert.ok(parsed.avatar?.startsWith("data:image/png;base64,"));
  assert.ok(
    !Buffer.from(parsed.avatar!.split(",")[1], "base64").includes(
      Buffer.from("ccv3"),
    ),
  );
  bytes[40] ^= 1;
  assert.throws(() => extractCharacter(bytes));
});
test("continuous parameter patch is atomic and independent, rest is explicit", () => {
  const bounds: RoleplayBounds = {
    channels: ["A", "B"],
    waveformIds: ["a", "b"],
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 20, B: 19 },
    rampPerSecond: { A: 2, B: 1 },
    allowSync: true,
    allowRamp: true,
    allowRest: true,
  };
  const state = {
    A: { target: 10, waveformId: "a", rampPerSecond: 2 },
    B: { target: 5, waveformId: "b", rampPerSecond: 1 },
  };
  assert.deepEqual(applyOutputPatch(state, { action: "keep" }, bounds), state);
  const next = applyOutputPatch(
    state,
    { action: "update", channels: { A: { target: 12 } } },
    bounds,
  );
  assert.equal(next.A.target, 12);
  assert.deepEqual(next.B, state.B);
  assert.throws(() =>
    applyOutputPatch(
      state,
      { action: "update", channels: { A: { target: 15 }, B: { target: 20 } } },
      bounds,
    ),
  );
  assert.equal(state.A.target, 10);
  assert.equal(
    applyOutputPatch(state, { action: "rest", channels: ["A"] }, bounds).B
      .target,
    5,
  );
  assert.throws(() =>
    applyOutputPatch(
      state,
      { action: "rest", channels: ["A"] },
      { ...bounds, allowRest: false },
    ),
  );
});
test("pure dialogue needs no hardware and card changes do not mutate story snapshots", async () => {
  const f = await fixture();
  try {
    await f.controller.disconnect();
    const t = await f.send();
    assert.equal(t.status, "completed");
    assert.equal(f.controller.run, null);
    const file = fileOf(f.card);
    file.character.name = "已修改";
    f.service.saveCard(file, f.card.id);
    f.service.deleteCard(f.card.id);
    assert.equal(f.service.session(f.session.id).card.character.name, "星涟");
    assert.match(f.service.export(f.session.id), /我接过徽章/);
    assert.equal(
      f.service.session(f.session.id).memory.longDialogue,
      "约定由玩家选择下一步",
    );
  } finally {
    await f.close();
  }
});
test("messages, keep, waveform changes and delayed model responses never reset continuous output", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    assert.equal(f.controller.run!.deadlineAt, null);
    let stops = 0;
    const stop = f.device.stop.bind(f.device);
    f.device.stop = async () => {
      stops++;
      return stop();
    };
    f.setReply(async () =>
      answer({
        action: "update",
        channels: { A: { target: 8 }, B: { target: 5 } },
      }),
    );
    assert.equal((await f.send()).status, "completed");
    for (let i = 0; i < 12; i++) {
      tick(f.controller);
      await new Promise((r) => setTimeout(r, 30));
    }
    const prevB = f.controller.run!.roleplay!.output.B;
    let finish!: (v: unknown) => void;
    f.setReply(() => new Promise((r) => (finish = r)));
    const turn = f.service.send(f.session.id, {
      text: "我观察房间",
      requestId: randomUUID(),
    });
    await until(() => !!finish);
    tick(f.controller);
    assert.equal(f.controller.run!.roleplay!.output.A.target, 8);
    assert.equal(stops, 0);
    finish(answer({ action: "keep" }));
    await until(
      () => f.service.turn(f.session.id, turn.id).status === "completed",
    );
    f.setReply(async () =>
      answer({
        action: "update",
        channels: { A: { waveformId: f.waves[1].id } },
      }),
    );
    await f.send("我走向另一扇门");
    assert.equal(f.controller.run!.roleplay!.output.A.target, 8);
    assert.deepEqual(f.controller.run!.roleplay!.output.B, prevB);
    assert.equal(stops, 0);
    const calls = f.calls();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(f.calls(), calls, "no timer-driven roleplay");
  } finally {
    await f.close();
  }
});

test("linkage records distinguish keeping zero, updating and resting, and preserve optional model explanations", async () => {
  const f = await fixture();
  try {
    const file = fileOf(f.card);
    file.character.linkageStyle =
      "所有互动均为虚构，不涉及现实设备控制或实际硬件操作。";
    f.service.saveCard(file, f.card.id);
    const session = f.service.create({
      cardId: f.card.id,
      player: { name: "玩家", identity: "客人", relationship: "朋友" },
      scenario: "",
    });
    await f.service.startLink(session.id, f.bounds, randomUUID());
    const reason = "玩家希望先保持当前节奏，因此继续保持零输出。";
    f.setReply(async () => ({ ...answer(), controlReason: reason }));
    const turn = f.service.send(session.id, {
      text: "先保持这样，我们继续喝茶。",
      requestId: randomUUID(),
    });
    await until(
      () => f.service.turn(session.id, turn.id).status === "completed",
    );
    const message = f.service.messages(session.id).items.at(-1)!;
    assert.equal(message.controlReason, reason);
    assert.equal(message.execution, "保持原参数，未提交新的强度或波形");
    assert.equal(message.output!.A.target, 0);
    assert.equal(message.output!.B.target, 0);
    assert.equal(f.controller.run!.roleplay!.output.A.target, 0);
    assert.match(
      roleplayExecutionLabel(
        { action: "update", channels: { A: { target: 1 } } },
        true,
      ),
      /参数更新已提交/,
    );
    assert.match(
      roleplayExecutionLabel({ action: "rest", channels: ["A"] }, true),
      /归零休息/,
    );
    assert.equal(
      roleplayExecutionLabel({ action: "keep" }, false),
      "纯文字演绎",
    );
    assert.ok(
      replySchema.safeParse(answer()).success,
      "older replies may omit an explanation",
    );
    assert.ok(
      !replySchema.safeParse({ ...answer(), controlReason: "x".repeat(501) })
        .success,
    );
  } finally {
    await f.close();
  }
});
test("unlimited run crosses days while finite modes keep their explicit deadline", async (t) => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    const now = Date.now() + 3 * 86400000;
    const mock = t.mock.method(Date, "now", () => now);
    f.device.state.lastSeenAt = now;
    tick(f.controller);
    await flush();
    assert.equal(f.controller.run!.status, "running");
    assert.equal(f.controller.run!.deadlineAt, null);
    mock.mock.restore();
  } finally {
    await f.close();
  }
});
test("new messages discard old inference without zero and duplicate messages execute once", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    f.setReply(async () => ({
      ...answer({ action: "update", channels: { A: { target: 6 } } }),
      storyStateDelta: openingFacts,
    }));
    await f.send();
    let resolve!: (v: unknown) => void;
    f.setReply(() => new Promise((r) => (resolve = r)));
    const old = f.service.send(f.session.id, {
      text: "第一回答",
      requestId: randomUUID(),
    });
    await until(() => !!resolve);
    f.setReply(async () =>
      answer({ action: "update", channels: { B: { target: 4 } } }),
    );
    const requestId = randomUUID(),
      next = f.service.send(f.session.id, { text: "第二回答", requestId });
    assert.equal(f.controller.run!.roleplay!.output.A.target, 6);
    resolve({
      ...answer({ action: "update", channels: { A: { target: 19 } } }),
      storyStateDelta: { scene: { location: "过期回复的地点" } },
    });
    await until(
      () => f.service.turn(f.session.id, next.id).status === "completed",
    );
    assert.equal(f.service.turn(f.session.id, old.id).status, "cancelled");
    assert.equal(f.controller.run!.roleplay!.output.A.target, 6);
    assert.equal(f.controller.run!.roleplay!.output.B.target, 4);
    assert.equal(
      f.service.session(f.session.id).storyState.scene.location,
      "试炼馆前厅",
    );
    assert.equal(f.service.session(f.session.id).storyState.version, 2);
    const count = f.calls();
    assert.equal(
      f.service.send(f.session.id, { text: "第二回答", requestId }).id,
      next.id,
    );
    assert.equal(f.calls(), count);
  } finally {
    await f.close();
  }
});
test("transient retries hold output, 20 retries exhaust and stop with confirmation", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    f.setReply(async () =>
      answer({ action: "update", channels: { A: { target: 8 } } }),
    );
    await f.send();
    let calls = 0;
    f.setReply(async () => {
      calls++;
      assert.equal(f.controller.run!.roleplay!.output.A.target, 8);
      throw new AiServiceError("AI_PROVIDER_UNAVAILABLE", "临时不可用");
    });
    const turn = await f.send("继续探索");
    assert.equal(turn.status, "failed");
    assert.equal(calls, 21);
    assert.equal(turn.attempt, 20);
    assert.equal(f.controller.run!.status, "faulted");
    assert.equal(f.controller.stopUnconfirmed, false);
    assert.equal(f.device.state.intensities.A, 0);
  } finally {
    await f.close();
  }
});

test("format errors retry without zero, exhaustion preserves linkage, and resending uses the same run", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    f.setReply(async () =>
      answer({
        action: "update",
        channels: { A: { target: 8 }, B: { target: 5 } },
      }),
    );
    await f.send();
    const runId = f.controller.run!.id;
    let stops = 0,
      failures = 0;
    const original = f.device.stop.bind(f.device);
    f.device.stop = async () => {
      stops++;
      return original();
    };
    f.setReply(async (_op, _profile, context) => {
      assert.equal(f.controller.run!.roleplay!.output.A.target, 8);
      if (failures++ < 2)
        throw new AiServiceError("AI_INVALID_TOOL_RESULT", "结构不兼容");
      assert.ok(
        (context as { responseFormatRepair?: string }).responseFormatRepair,
      );
      return answer();
    });
    const recovered = await f.send();
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.formatAttempt, 2);
    let attempts = 0;
    f.setReply(async () => {
      attempts++;
      throw new AiServiceError("AI_INVALID_TOOL_RESULT", "结构不兼容");
    });
    const failed = await f.send();
    assert.equal(attempts, 4);
    assert.equal(failed.status, "failed");
    assert.equal(failed.formatAttempt, 3);
    assert.match(failed.error!, /联动保持原输出/);
    assert.equal(f.controller.run!.status, "running");
    assert.equal(f.controller.run!.roleplay!.output.B.target, 5);
    f.setReply(async () =>
      answer({ action: "update", channels: { A: { target: 6 } } }),
    );
    assert.equal((await f.send("重新发送")).status, "completed");
    assert.equal(f.controller.run!.id, runId);
    assert.equal(f.controller.run!.roleplay!.output.A.target, 6);
    assert.equal(stops, 0);
  } finally {
    await f.close();
  }
});

test("entering a story can start linked at zero; conflicting or disconnected starts leave no orphan story", async () => {
  const f = await fixture();
  const data = {
    cardId: f.card.id,
    player: { name: "玩家", identity: "客人", relationship: "同伴" },
    scenario: "",
  };
  try {
    const s = await f.service.createWithLink({
      ...data,
      link: { bounds: f.bounds, requestId: randomUUID() },
    });
    assert.equal(f.controller.run!.roleplay!.sessionId, s.id);
    assert.equal(f.controller.run!.roleplay!.output.A.target, 0);
    assert.equal(
      f.calls(),
      0,
      "opening never triggers model or nonzero output",
    );
    const count = f.service.sessions().length;
    await assert.rejects(() =>
      f.service.createWithLink({
        ...data,
        link: { bounds: f.bounds, requestId: randomUUID() },
      }),
    );
    assert.equal(f.service.sessions().length, count);
    await f.controller.stop("roleplay");
    await f.controller.disconnect();
    await assert.rejects(() =>
      f.service.createWithLink({
        ...data,
        link: { bounds: f.bounds, requestId: randomUUID() },
      }),
    );
    assert.equal(f.service.sessions().length, count);
    const text = await f.service.createWithLink(data);
    assert.ok(text.id);
    assert.equal(f.service.sessions().length, count + 1);
  } finally {
    await f.close();
  }
});
test("pause/range/resume cannot replay output; late inference after emergency is discarded", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    f.setReply(async () =>
      answer({ action: "update", channels: { A: { target: 8 } } }),
    );
    await f.send();
    await f.controller.pause("roleplay");
    assert.equal(f.controller.run!.roleplay!.output.A.target, 0);
    await f.controller.changeRoleplayBounds({
      ...f.bounds,
      maxIntensity: { A: 4, B: 3 },
    });
    assert.equal(f.controller.run!.boundsVersion, 2);
    await f.controller.resume("roleplay");
    assert.equal(f.controller.run!.roleplay!.output.A.target, 0);
    let done!: (v: unknown) => void;
    f.setReply(() => new Promise((r) => (done = r)));
    const turn = f.service.send(f.session.id, {
      text: "下一幕",
      requestId: randomUUID(),
    });
    await until(() => !!done);
    await f.controller.emergency();
    done(answer({ action: "update", channels: { A: { target: 4 } } }));
    await flush();
    await flush();
    assert.equal(f.service.turn(f.session.id, turn.id).status, "cancelled");
    assert.equal(f.controller.run!.status, "stopped");
    assert.equal(f.device.state.intensities.A, 0);
  } finally {
    await f.close();
  }
});
test("memory compaction covers old ranges without deleting raw messages and stories remain isolated", async () => {
  const f = await fixture();
  try {
    f.setReply(async () => ({ ...answer(), storyStateDelta: openingFacts }));
    assert.equal((await f.send()).status, "completed");
    for (let i = 4; i <= 130; i++)
      f.store.set(`story-messages:${f.session.id}`, "old" + i, {
        id: "old" + i,
        sessionId: f.session.id,
        seq: i,
        at: i,
        role: i % 2 ? "user" : "assistant",
        text: "线索" + i,
      } satisfies StoryMessage);
    let summarized = 0;
    f.setReply(async (op, _p, context) => {
      if (op === "summarize") {
        summarized++;
        return { ...answer().memory, longPlot: "保留线索1到110" };
      }
      const ctx = context as {
        memory: { recentDialogue: unknown[]; longPlot: string };
        storyState: { scene: { location: string } };
      };
      assert.equal(ctx.memory.recentDialogue.length, 20);
      assert.match(ctx.memory.longPlot, /线索1/);
      assert.equal(ctx.storyState.scene.location, "试炼馆前厅");
      return answer();
    });
    assert.equal((await f.send("回顾线索")).status, "completed");
    assert.equal(
      summarized,
      2,
      "catch-up fills the available context instead of requesting 20 messages at a time",
    );
    assert.ok(f.service.session(f.session.id).memory.throughSeq >= 111);
    assert.equal(
      f.service.session(f.session.id).storyState.items[0].name,
      "银色徽章",
    );
    assert.ok(f.service.export(f.session.id).includes("线索1"));
    const other = f.service.create({
      cardId: f.card.id,
      player: { name: "其他玩家", identity: "", relationship: "" },
      scenario: "别的故事",
    });
    assert.deepEqual(other.memory, {
      ...emptyMemory(),
      plotBackground: f.card.character.worldInfo,
    });
  } finally {
    await f.close();
  }
});

test("out-of-range patch fails atomically, zero confirmation failure blocks reauthorization", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    f.setReply(async () =>
      answer({ action: "update", channels: { A: { target: 8 } } }),
    );
    await f.send();
    f.setReply(async () =>
      answer({
        action: "update",
        channels: { A: { target: 3 }, B: { target: 20 } },
      }),
    );
    const turn = await f.send("不合法的模型结果");
    assert.equal(turn.status, "failed");
    assert.equal(
      f.controller.run!.roleplay!.output.A.target,
      8,
      "the valid half of a rejected patch must never commit",
    );
    assert.equal(f.controller.run!.status, "faulted");
    assert.equal(f.device.state.intensities.A, 0);
    f.device.stop = async () => false;
    await f.controller.emergency();
    assert.equal(f.controller.stopUnconfirmed, true);
    await assert.rejects(
      f.service.startLink(f.session.id, f.bounds, randomUUID()),
      /停止|归零/,
    );
  } finally {
    await f.close();
  }
});

test("paused story can chat but cannot produce output, revision conflicts cannot duplicate turns", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    await f.controller.pause("roleplay");
    assert.equal((await f.send("我想聊聊背景")).status, "completed");
    assert.equal(f.controller.run!.roleplay!.output.A.target, 0);
    const revision = f.service.session(f.session.id).revision;
    assert.throws(
      () =>
        f.service.send(f.session.id, {
          text: "过期标签页",
          requestId: randomUUID(),
          revision: revision - 1,
        }),
      /其他标签页/,
    );
    f.setReply(async () =>
      answer({ action: "update", channels: { A: { target: 1 } } }),
    );
    assert.equal((await f.send("暂停时不能输出")).status, "failed");
    assert.equal(f.device.state.intensities.A, 0);
  } finally {
    await f.close();
  }
});

test("restart preserves bookmarks and branches, marks pending turns interrupted and never replays old output", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    f.setReply(async () => ({
      ...answer({ action: "update", channels: { A: { target: 8 } } }),
      storyStateDelta: openingFacts,
    }));
    await f.send();
    const confirmed = f.service.session(f.session.id).storyState;
    const tip = f.service.messages(f.session.id).items.at(-1)!;
    const bookmark = f.service.branches.save(f.session.id, tip.id, {
      name: "重启后的书签",
    });
    const branch = f.service.branches.fork(f.session.id, tip.id, {
      name: "重启后的分支",
      requestId: randomUUID(),
    });
    const saved = structuredClone(f.controller.run!);
    await f.service.close();
    await f.controller.close();
    f.store.set("runtime", "current", saved);
    f.store.set("story-turns", "pending-restart", {
      id: "pending-restart",
      sessionId: f.session.id,
      requestId: randomUUID(),
      revision: 99,
      status: "pending",
      attempt: 0,
      createdAt: Date.now(),
    });
    let calls = 0;
    const ai: AiBridge & StoryAi = {
      status: { ready: true },
      decide: async () => {
        throw Error("must not infer");
      },
      draft: async () => {
        throw Error("must not infer");
      },
      story: async () => {
        calls++;
        return answer();
      },
    };
    const reopened = new Store(f.directory);
    const driver = new CoyoteDevice(),
      restarted = new Controller(reopened, driver, ai),
      story = new RoleplayService(reopened, restarted, ai);
    try {
      assert.equal(restarted.run!.status, "interrupted");
      assert.equal(
        story.turn(f.session.id, "pending-restart").status,
        "interrupted",
      );
      tick(restarted);
      assert.equal(driver.state.intensities.A, 0);
      assert.ok(story.export(f.session.id).includes("我接过徽章"));
      assert.deepEqual(story.session(f.session.id).storyState, confirmed);
      assert.deepEqual(story.branches.list(f.session.id).items, [bookmark]);
      assert.deepEqual(story.session(branch.id), branch);
      assert.equal(calls, 0);
      const continued = story.send(branch.id, {
        text: "分支继续",
        requestId: randomUUID(),
        revision: 0,
      });
      await until(
        () => story.turn(branch.id, continued.id).status === "completed",
      );
      assert.equal(calls, 1);
      assert.equal(story.messages(branch.id).items.at(-1)?.nodeRound, 2);
      assert.equal(driver.state.intensities.A, 0);
    } finally {
      await story.close();
      await restarted.close();
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
test("action records freeze targets and names, persist with messages and lose live identity on pause", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    f.setReply(async () => ({
      ...answer({ action: "update", channels: { A: { target: 8 } } }),
      controlReason: "只调整 A",
    }));
    assert.equal((await f.send()).status, "completed");
    const message = f.service.messages(f.session.id).items.at(-1)!;
    const r = message.actionRecord!;
    assert.equal(r.channels.A.before!.target, 0);
    assert.equal(r.channels.A.after!.target, 8);
    assert.equal(r.channels.B.after!.target, 0);
    assert.equal(r.channels.B.participating, false);
    assert.equal(r.channels.A.after!.waveformName, f.waves[0].name);
    assert.equal(r.reason, "只调整 A");
    assert.deepEqual(
      f.store.get<StoryMessage>(`story-messages:${f.session.id}`, message.id)!
        .actionRecord,
      r,
    );
    assert.equal(f.controller.snapshot().actionExecution?.id, r.id);
    const frozen = structuredClone(r);
    f.setReply(async () => answer({ action: "rest", channels: ["A"] }));
    assert.equal((await f.send()).status, "completed");
    assert.notEqual(f.controller.snapshot().actionExecution?.id, r.id);
    assert.deepEqual(message.actionRecord, frozen);
    await f.controller.pause("roleplay");
    assert.equal(f.controller.snapshot().actionExecution, undefined);
    await f.controller.resume("roleplay");
    assert.equal(f.controller.snapshot().actionExecution, undefined);
  } finally {
    await f.close();
  }
});
