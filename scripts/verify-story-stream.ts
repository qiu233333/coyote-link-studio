/** pnpm exec tsx scripts/verify-story-stream.ts [built checkout] [--accept] */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import { chromium, type Page } from "playwright";
import type { createApplication as CreateApplication } from "../server/app.ts";
import { cardTemplate, type StoryMessage } from "../shared/roleplay.ts";

const root = resolve(process.argv[2] ?? ".");
const accept = process.argv.includes("--accept");
const { createApplication } = (await import(
  pathToFileURL(join(root, "server/app.ts")).href
)) as { createApplication: typeof CreateApplication };
const directory = await mkdtemp(join(tmpdir(), "coyote-story-stream-"));
const calls: {
  name: string;
  at: number;
  first?: number;
  end?: number;
  stream: boolean;
  messages?: number[];
}[] = [];
const errors: string[] = [];
let mode: "normal" | "complete" | "unsupported" | "format" | "transport" =
  "normal";
let marker = "长廊里的第一句";
let hold = 0;
let target = 4;
const memory = {
  recentPlot: "试炼馆",
  plotBackground: "保留世界设定",
  longPlot: "保留未解决线索和约定",
  longDialogue: "记得玩家约定",
};
const provider = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(req.headers.authorization, "Bearer isolated-story-stream-key");
    const name: string = body.tools[0].function.name;
    const user = body.messages.findLast(
      (m: { role: string }) => m.role === "user",
    ).content;
    const context = JSON.parse(user.slice(user.indexOf("\n") + 1));
    const isArchive = name === "submit_story_memory";
    const call: (typeof calls)[number] = {
      name,
      at: performance.now(),
      stream: body.stream === true,
      ...(isArchive && {
        messages: context.messages.map((m: { seq: number }) => m.seq),
      }),
    };
    calls.push(call);
    const scenario = mode;
    if (!isArchive && scenario === "format") mode = "normal";
    if (!isArchive && scenario === "transport") {
      mode = "normal";
      await wait(100);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture unavailable" } }));
      call.end = performance.now();
      return;
    }
    if (!isArchive && scenario === "unsupported" && body.stream) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            param: "stream",
            code: "unsupported_parameter",
            message: "stream is not supported",
          },
        }),
      );
      call.end = performance.now();
      return;
    }
    const args = isArchive
      ? memory
      : {
          narration:
            (scenario === "format" ? "上次失败预览" : marker) +
            "：“灯亮了”\n下一行 🌙",
          dialogue: "她说：继续向前。",
          replyOptions:
            scenario === "format"
              ? ["同一句", "同一句", "重复"]
              : ["继续前进", "查看灯光", "在原地等待"],
          storyStateDelta: { scene: { location: "有灯的长廊" } },
          memory,
          control: context.authorization
            ? { action: "update", channels: { A: { target } } }
            : { action: "keep" },
          controlReason: "PRIVATE_CONTROL_REASON",
        };
    const input = JSON.stringify(args).replace("🌙", "\\uD83C\\uDF19");
    const toolCall = {
      id: "call_fixture",
      type: "function",
      function: { name, arguments: input },
    };
    const envelope = { id: "chatcmpl-fixture", model: "fixture", created: 1 };
    const started = performance.now();
    const at = async (ms: number) =>
      wait(Math.max(0, ms - (performance.now() - started)));
    if (body.stream && scenario !== "complete") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.flushHeaders();
      const send = (delta: unknown, reason: string | null = null) => {
        if (res.destroyed) return;
        const data = Buffer.from(
          "data: " +
            JSON.stringify({
              ...envelope,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta, finish_reason: reason }],
            }) +
            "\n\n",
        );
        const byte = data.findIndex((value) => value >= 0xe0);
        if (byte !== -1) {
          res.write(data.subarray(0, byte + 1));
          res.write(data.subarray(byte + 1));
        } else res.write(data);
      };
      await at(90);
      send({ role: "assistant", reasoning_content: "PRIVATE_MODEL_REASONING" });
      const split = input.indexOf("：“");
      const first = split > 0 ? input.slice(0, split) : input.slice(0, 20);
      await at(150);
      call.first = performance.now();
      send({
        tool_calls: [
          { ...toolCall, index: 0, function: { name, arguments: first } },
        ],
      });
      const rest = input.slice(first.length);
      const bounds = [3, 11, 18, 36, 80, rest.length];
      let previous = 0;
      for (const [i, boundary] of bounds.entries()) {
        await at(225 + 90 * i);
        if (res.destroyed) return;
        send({
          tool_calls: [
            {
              index: 0,
              function: { arguments: rest.slice(previous, boundary) },
            },
          ],
        });
        previous = boundary;
      }
      await at(isArchive ? 350 : 970 + hold);
      send({}, "tool_calls");
      res.end("data: [DONE]\n\n");
    } else {
      await at(isArchive ? 350 : 970);
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...envelope,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "PRIVATE_MODEL_REASONING",
                tool_calls: [toolCall],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
    }
    call.end = performance.now();
  } catch (error) {
    errors.push(String(error));
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
const providerPort = (provider.address() as { port: number }).port;
const aiDirectory = join(directory, "eve");
await mkdir(aiDirectory);
const app = await createApplication({ directory, aiDirectory });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1450, height: 1000 },
});
context.setDefaultTimeout(15000);
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const checks: string[] = [];
let txKind: "archive" | "reply" | undefined;
const commits: { kind: "archive" | "reply"; start: number; end: number }[] = [];
const set = app.store.set.bind(app.store);
app.store.set = (collection, id, value) => {
  if (collection.startsWith("story-archive:")) txKind = "archive";
  if (
    collection === "story-turns" &&
    (value as { status: string }).status === "completed"
  )
    txKind = "reply";
  set(collection, id, value);
};
const transaction = app.store.transaction.bind(app.store);
app.store.transaction = <T>(fn: () => T) => {
  txKind = undefined;
  const start = performance.now();
  const result = transaction(fn);
  if (txKind) commits.push({ kind: txKind, start, end: performance.now() });
  return result;
};
const nav = (p: Page) =>
  p
    .getByRole("button", { name: /^情景演绎/ })
    .first()
    .click();
async function open(p: Page, title: string) {
  await p.locator(".story-list-item").filter({ hasText: title }).click();
  await p
    .locator(".story-chat-heading h2")
    .getByText(title, { exact: true })
    .waitFor();
}
const round = () =>
  page.locator(".story-messages article:not(.story-preview-message)");
const preview = page.locator(".story-preview-message");
const input = page.getByRole("textbox", { name: "回复剧情" });
async function until(
  label: string,
  test: () => boolean | Promise<boolean>,
  ms = 15000,
) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await test()) return;
    await wait(30);
  }
  throw new Error(label);
}
const ms = (x: number) => Math.round(x);

try {
  const url = await app.listen(0);
  app.store.saveSettings({
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: "isolated-story-stream-key",
    model: "fixture",
  });
  await until("eve did not start", () => app.ai.status.ready);
  const card = app.roleplay.saveCard(structuredClone(cardTemplate));
  const make = (title: string) =>
    app.roleplay.create({
      title,
      cardId: card.id,
      player: { name: "旅人", identity: "访客", relationship: "同行" },
      scenario: "走过试炼馆",
    });
  const short = make("短篇测量"),
    long = make("长篇测量");
  const first =
    app.store.storyTail?.(long.id) ??
    app.roleplay.messages(long.id).items.at(-1)?.seq ??
    0;
  for (let seq = first + 1; seq <= 130; seq++) {
    const message: StoryMessage = {
      id: `fixture-${seq}`,
      seq,
      sessionId: long.id,
      role: seq % 2 ? "assistant" : "user",
      text: `历史消息 ${seq}。保留未解决线索和约定。`,
      at: seq,
    };
    app.store.set(`story-messages:${long.id}`, message.id, message);
  }
  await page.goto(url);
  await nav(page);
  await open(page, "短篇测量");
  const devtools = await context.newCDPSession(page);
  await devtools.send("Network.enable");
  const scoped = new Set<string>();
  const matches = (url: string) =>
    url.includes(`/api/roleplay/sessions/${short.id}`);
  let measureIdle = false,
    idleRequests = 0,
    idleBytes = 0;
  devtools.on("Network.requestWillBeSent", (e) => {
    if (e.request.method === "GET" && matches(e.request.url)) {
      scoped.add(e.requestId);
      if (measureIdle) idleRequests++;
    }
  });
  devtools.on("Network.dataReceived", (e) => {
    if (measureIdle && scoped.has(e.requestId)) idleBytes += e.dataLength;
  });
  // Reopen after instrumentation so the long-lived event response is counted.
  await page.reload();
  if (!(await page.locator(".story-chat-heading h2").isVisible())) {
    await page
      .locator(".story-chat-heading h2")
      .getByText("短篇测量", { exact: true })
      .waitFor();
  }
  await wait(500);
  measureIdle = true;
  const idleWindowMs = 9000;
  await wait(idleWindowMs);
  measureIdle = false;

  async function measureTurn(label: string, id: string) {
    const callStart = calls.length,
      commitStart = commits.length;
    marker = label;
    await input.fill("我向前走。");
    const sent = performance.now();
    const phases: { attempt: number; phase: string; atMs: number }[] = [];
    const detach = app.roleplay.feed?.subscribe(id, ({ progress }) => {
      if (!progress) return;
      const old = phases.at(-1);
      if (old?.phase === progress.phase && old.attempt === progress.attemptId)
        return;
      phases.push({
        attempt: progress.attemptId,
        phase: progress.phase,
        atMs: ms(performance.now() - sent),
      });
    });
    await input.press("Enter");
    await page
      .locator(".story-messages")
      .getByText(label, { exact: false })
      .first()
      .waitFor();
    const visible = performance.now();
    const previewFirst = await preview
      .getByText(label, { exact: false })
      .isVisible();
    if (accept && mode === "normal") assert.equal(previewFirst, true);
    await round().getByText(label, { exact: false }).last().waitFor();
    await until("committed reply missing", () =>
      commits.slice(commitStart).some((c) => c.kind === "reply"),
    );
    const shown = performance.now();
    detach?.();
    const commit = commits.slice(commitStart).find((c) => c.kind === "reply")!;
    const used = calls.slice(callStart);
    const main = used.findLast((c) => c.name === "submit_roleplay")!;
    assert.equal(app.roleplay.session(id).id, id);
    assert.equal(await preview.count(), 0);
    return {
      firstVisibleMs: ms(visible - sent),
      previewFirst,
      committedMs: ms(commit.end - sent),
      finalVisibleMs: ms(shown - sent),
      summaryCalls: used.filter((c) => c.name === "submit_story_memory").length,
      replyCalls: used.filter((c) => c.name === "submit_roleplay").length,
      summaryModelMs: ms(
        used
          .filter((c) => c.name === "submit_story_memory")
          .reduce((n, c) => n + ((c.end ?? c.at) - c.at), 0),
      ),
      generationModelMs: ms((main.end ?? main.at) - main.at),
      validationAndBridgeMs: ms(commit.start - (main.end ?? main.at)),
      commitMs: Number((commit.end - commit.start).toFixed(2)),
      archiveRanges: used.flatMap((c) =>
        c.messages ? [[c.messages[0], c.messages.at(-1)]] : [],
      ),
      ...(phases.length && { phases }),
    };
  }
  const shortMetrics = await measureTurn("短篇实测正文", short.id);
  await open(page, "长篇测量");
  const longMetrics = await measureTurn("长篇实测正文", long.id);
  const throughSeq = app.roleplay.session(long.id).memory.throughSeq;
  assert.equal(throughSeq, 111);
  assert.match(
    app.roleplay.export(long.id),
    /历史消息 2。保留未解决线索和约定/,
  );
  assert.match(app.roleplay.session(long.id).memory.longPlot, /未解决线索/);
  checks.push("短篇无摘要；长篇归档连续，保留原文、关键记忆与正式剧情状态");
  if (accept) {
    assert.equal(idleRequests, 0);
    assert.equal(shortMetrics.replyCalls, 1);
    assert.equal(shortMetrics.summaryCalls, 0);
    assert.equal(longMetrics.summaryCalls, 2);
    assert.ok(shortMetrics.firstVisibleMs < shortMetrics.committedMs - 200);
    await page.getByText("地点 · 有灯的长廊", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("group", { name: "快捷回复" })
        .getByRole("button")
        .count(),
      3,
    );
    const box = page.locator(".story-messages");
    await box.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.getByRole("button", { name: "返回最新剧情" }).waitFor();
    marker = "长篇后续不抢滚动";
    await input.fill("我继续看旧消息。");
    await input.press("Enter");
    await preview
      .getByText(marker, { exact: false })
      .waitFor({ state: "attached" });
    assert.ok(await box.evaluate((node) => node.scrollTop < 40));
    await input.fill("等待时另写的草稿");
    await round()
      .getByText(marker, { exact: false })
      .waitFor({ state: "attached" });
    assert.equal(await input.inputValue(), "等待时另写的草稿");
    assert.ok(await box.evaluate((node) => node.scrollTop < 40));
    await page.getByText("有新消息", { exact: true }).waitFor();
    await page.getByRole("button", { name: "返回最新剧情" }).click();
    assert.ok(
      await box.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight < 50,
      ),
    );
    const latest = app.roleplay.messages(long.id).items.at(-1)!;
    app.roleplay.branches.save(long.id, latest.id, { name: "其他页书签" });
    await round().last().getByRole("button", { name: "已存档" }).waitFor();
    await page.getByRole("button", { name: "剧情存档", exact: true }).click();
    await page.getByText("其他页书签", { exact: true }).waitFor();
    app.roleplay.branches.rename(long.id, latest.id, {
      name: "其他页已重命名",
    });
    await page.getByText("其他页已重命名", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    const branch = app.roleplay.branches.fork(long.id, latest.id, {
      name: "本地分支",
      requestId: crypto.randomUUID(),
    });
    assert.deepEqual(branch.memory, app.roleplay.session(long.id).memory);
    assert.match(app.roleplay.export(branch.id), /历史消息 2/);
    checks.push(
      "长篇阅读不抢滚动、回复保留新输入、书签跨页更新、分支沿用节点冻结记忆",
    );
    await open(page, "短篇测量");
    mode = "complete";
    const full = await measureTurn("完整回退正文", short.id);
    assert.equal(full.replyCalls, 1);
    assert.equal(full.previewFirst, false);
    mode = "normal";
    checks.push(
      "真实 provider SSE 在完成前显示正文；忽略 stream 的服务单请求完成回退",
    );
    await app.controller.connect({ protocol: "simulator" });
    const wave = app.controller.snapshot().waveforms[0].id;
    await app.roleplay.startLink(
      short.id,
      {
        channels: ["A"],
        waveformIds: [wave],
        minIntensity: { A: 0, B: 0 },
        maxIntensity: { A: 12, B: 0 },
        rampPerSecond: { A: 10, B: 10 },
        allowSync: false,
        allowRamp: true,
        allowRest: true,
      },
      crypto.randomUUID(),
    );
    mode = "format";
    marker = "格式恢复后的正文";
    const before = app.roleplay.messages(short.id).items.length;
    await input.fill("请再走一段。");
    await input.press("Enter");
    await preview.getByText("上次失败预览", { exact: false }).waitFor();
    assert.doesNotMatch(
      await preview.innerText(),
      /PRIVATE_|isolated-story-stream-key/,
    );
    assert.equal(app.controller.run?.roleplay?.output.A.target, 0);
    assert.equal(app.roleplay.messages(short.id).items.length, before + 1);
    await page.getByText(/正在调整回复格式/).waitFor();
    await preview.getByText("格式恢复后的正文", { exact: false }).waitFor();
    assert.equal(
      await preview.getByText("上次失败预览", { exact: false }).count(),
      0,
    );
    assert.equal(app.controller.run?.roleplay?.output.A.target, 0);
    await round().getByText(marker, { exact: false }).waitFor();
    assert.equal(app.controller.run?.roleplay?.output.A.target, 4);
    assert.equal(app.roleplay.messages(short.id).items.length, before + 2);
    assert.doesNotMatch(
      await page.locator(".story-messages").innerText(),
      /PRIVATE_MODEL_REASONING|isolated-story-stream-key/,
    );
    mode = "transport";
    target = 7;
    marker = "传输重试后的正文";
    await input.fill("继续等一次。");
    await input.press("Enter");
    await page.getByText(/模型暂时不可用，正在重试/).waitFor();
    assert.equal(app.controller.run?.roleplay?.output.A.target, 4);
    await round().getByText(marker, { exact: false }).waitFor();
    assert.equal(app.controller.run?.roleplay?.output.A.target, 7);

    hold = 2200;
    marker = "取消前的临时正文";
    const beforeCancel = app.roleplay.messages(short.id).items.length;
    target = 9;
    await input.fill("刷新和取消这一轮。");
    await input.press("Enter");
    await preview.getByText(marker, { exact: false }).waitFor();
    await page.reload();
    await preview.getByText(marker, { exact: false }).waitFor();
    assert.equal(app.controller.run?.roleplay?.output.A.target, 7);
    await page.getByRole("button", { name: "取消生成" }).click();
    await preview.getByText("未完成的生成预览", { exact: true }).waitFor();
    assert.equal(app.controller.run?.roleplay?.output.A.target, 7);
    assert.equal(
      app.roleplay.messages(short.id).items.length,
      beforeCancel + 1,
    );
    hold = 0;
    marker = "手动重试正式正文";
    await page.getByRole("button", { name: "重试本轮" }).click();
    await round().getByText(marker, { exact: false }).waitFor();
    assert.equal(
      app.roleplay.messages(short.id).items.length,
      beforeCancel + 2,
    );
    assert.equal(app.controller.run?.roleplay?.output.A.target, 9);
    checks.push(
      "格式与传输重试、刷新恢复预览、取消和手动重试不重写玩家消息；提交前设备目标不变",
    );
    hold = 2200;
    marker = "会被替换的临时正文";
    const beforeReplace = app.roleplay.messages(short.id).items.length;
    await input.fill("我先试一句。");
    await input.press("Enter");
    await preview.getByText(marker, { exact: false }).waitFor();
    hold = 0;
    marker = "替换后的正式正文";
    await input.fill("改成这句。");
    await input.press("Enter");
    await round().getByText(marker, { exact: false }).waitFor();
    assert.equal(
      await round().getByText("会被替换的临时正文", { exact: false }).count(),
      0,
    );
    assert.equal(
      app.roleplay.messages(short.id).items.length,
      beforeReplace + 3,
    );
    checks.push("新玩家消息可替代在途轮次，旧预览和结果均未提交");
    await app.controller.stop("roleplay");

    const block = (route: import("playwright").Route) => route.abort();
    await page.route("**/events", block);
    await page.reload();
    await input.waitFor();
    marker = "轮询回退正式正文";
    await input.fill("没有事件通道也要恢复。");
    await input.press("Enter");
    await round().getByText(marker, { exact: false }).waitFor();
    await page.unroute("**/events", block);
    await page.reload();
    await round().getByText(marker, { exact: false }).waitFor();
    assert.equal(await round().getByText(marker, { exact: false }).count(), 1);
    mode = "unsupported";
    const rejected = await measureTurn("拒绝流式后完整返回", short.id);
    assert.equal(rejected.previewFirst, false);
    assert.equal(rejected.replyCalls, 2);
    const cached = await measureTurn("缓存完整输出能力", short.id);
    assert.equal(cached.replyCalls, 1);
    checks.push(
      "事件通道断开时游标轮询，恢复后无重复；明确拒绝流式时回退并缓存能力",
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        idleWindowMs,
        idleRequests,
        idleBytes,
        shortMetrics,
        longMetrics,
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await app.close();
  await new Promise<void>((done) => provider.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
