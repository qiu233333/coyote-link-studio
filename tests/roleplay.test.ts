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
  type StoryMessage,
} from "../shared/roleplay.ts";

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
  memory: {
    recentPlot: "进入试炼",
    plotBackground: "城市与试炼馆",
    longPlot: "玩家接受徽章",
    longDialogue: "约定由玩家选择下一步",
  },
  control,
});
async function fixture() {
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
  await controller.connect({ protocol: "simulator" });
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
    f.setReply(async () =>
      answer({ action: "update", channels: { A: { target: 6 } } }),
    );
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
    resolve(answer({ action: "update", channels: { A: { target: 19 } } }));
    await until(
      () => f.service.turn(f.session.id, next.id).status === "completed",
    );
    assert.equal(f.service.turn(f.session.id, old.id).status, "cancelled");
    assert.equal(f.controller.run!.roleplay!.output.A.target, 6);
    assert.equal(f.controller.run!.roleplay!.output.B.target, 4);
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
    for (let i = 1; i <= 130; i++)
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
      };
      assert.equal(ctx.memory.recentDialogue.length, 20);
      assert.match(ctx.memory.longPlot, /线索1/);
      return answer();
    });
    assert.equal((await f.send("回顾线索")).status, "completed");
    assert.ok(summarized >= 5);
    assert.ok(f.service.session(f.session.id).memory.throughSeq >= 111);
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

test("restart marks pending turns interrupted and never schedules old roleplay output", async () => {
  const f = await fixture();
  try {
    await f.service.startLink(f.session.id, f.bounds, randomUUID());
    f.setReply(async () =>
      answer({ action: "update", channels: { A: { target: 8 } } }),
    );
    await f.send();
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
    const ai: AiBridge & StoryAi = {
      status: { ready: true },
      decide: async () => {
        throw Error("must not infer");
      },
      draft: async () => {
        throw Error("must not infer");
      },
      story: async () => {
        throw Error("must not infer");
      },
    };
    const driver = new CoyoteDevice(),
      restarted = new Controller(f.store, driver, ai),
      story = new RoleplayService(f.store, restarted, ai);
    try {
      assert.equal(restarted.run!.status, "interrupted");
      assert.equal(
        story.turn(f.session.id, "pending-restart").status,
        "interrupted",
      );
      tick(restarted);
      assert.equal(driver.state.intensities.A, 0);
      assert.ok(story.export(f.session.id).includes("我接过徽章"));
    } finally {
      await story.close();
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});
