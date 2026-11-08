/** Isolated HTTP → controller → eve → local provider acceptance; never uses real keys/devices. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const { createApplication } = (await import(
  process.env.COYOTE_VERIFY_APP ?? "../server/app.ts"
)) as typeof import("../server/app.ts");
import {
  cardTemplate,
  type RoleplaySession,
  type RoleplayTurn,
} from "../shared/roleplay.ts";
import type { AppSnapshot } from "../shared/types.ts";

const directory = await mkdtemp(resolve(tmpdir(), "coyote-story-http-"));
const artifacts = resolve("artifacts", "roleplay");
await mkdir(artifacts, { recursive: true });
const deepseek = process.argv.includes("--deepseek"),
  thinking = process.argv.includes("--thinking"),
  serve = process.argv.includes("--serve");
let calls = 0,
  cancelled = 0;
const failures: string[] = [];
const formatCounts = new Map<string, number>();
const memory = {
  recentPlot: "玩家发现星城的试炼入口",
  plotBackground: "星城试炼馆",
  longPlot: "玩家接受徽章，选择探索",
  longDialogue: "向导承诺按玩家节奏推进",
};
const provider = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const c of req) raw += String(c);
    assert.equal(req.headers.authorization, "Bearer local-story-fixture");
    assert.ok(!raw.includes("local-story-fixture"));
    const body = JSON.parse(raw);
    calls++;
    if (deepseek) {
      assert.equal(body.thinking.type, thinking ? "enabled" : "disabled");
      if (thinking) assert.ok(["auto", undefined].includes(body.tool_choice));
    }
    const tool = body.tools?.[0]?.function.name;
    const prompt =
      body.messages.findLast((m: { role: string }) => m.role === "user")
        ?.content ?? "";
    const context = JSON.parse(String(prompt).split("\n").at(-1)!);
    let input: unknown;
    let latest = "";
    if (tool === "submit_character_card")
      input = {
        card: {
          ...cardTemplate,
          character: {
            ...cardTemplate.character,
            name: context.source.name ?? "第三方角色",
          },
        },
        warnings: ["世界书已整理，未知扩展未执行"],
      };
    else if (tool === "submit_story_memory") input = memory;
    else if (tool === "submit_roleplay") {
      const system = body.messages
        .filter((m: { role: string }) => m.role === "system")
        .map((m: { content: string }) => m.content)
        .join("\n");
      assert.ok(system.includes("不需要玩家在剧情中再提"));
      assert.ok(system.includes("首次有效玩家回复后"));
      assert.ok(system.includes("叙事描述不等于撤销这份授权"));
      assert.ok(system.includes("玩家要求保持或休息时尊重其表达"));
      assert.ok(!String(prompt).includes("仅在必要时"));
      assert.ok(body.tools[0].function.parameters.properties.controlReason);
      assert.ok(
        body.tools[0].function.parameters.required.includes("replyOptions"),
      );
      assert.ok(system.includes("玩家点击前没有发生"));
      latest = context.memory.recentDialogue.at(-1)?.text ?? "";
      if (latest === "持续错误") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "temporary unavailable" } }),
        );
        return;
      }
      if (latest.includes("延迟")) {
        res.once("close", () => {
          if (!res.writableEnded) cancelled++;
        });
        await new Promise((r) => setTimeout(r, 1800));
      }
      input = {
        narration: "星涟推开试炼馆的门，一条新的线索出现在你面前。",
        dialogue: "沿着蓝色灯光走，还是先研究手中的徽章？",
        replyOptions: [
          "我沿着蓝色灯光往前走。",
          "我先仔细研究手中的徽章。",
          "先休息一下，和我聊聊试炼馆的来历吧。",
        ],
        memory,
        controlReason: !context.authorization
          ? "当前未授权或已暂停，只推进文字剧情。"
          : latest.includes("保持")
            ? "玩家要求保持当前节奏，本轮保留全部参数。"
            : latest.includes("休息")
              ? "本轮按剧情安排休息。"
              : "根据探索剧情分别调整 A/B 目标，等待设备确认。",
        control: !context.authorization
          ? { action: "keep" }
          : latest.includes("休息")
            ? { action: "rest", channels: ["A", "B"] }
            : latest.includes("保持")
              ? { action: "keep" }
              : {
                  action: "update",
                  channels: {
                    A: {
                      target: Math.min(8, context.authorization.maxIntensity.A),
                    },
                    B: {
                      target: Math.min(4, context.authorization.maxIntensity.B),
                    },
                  },
                },
      };
    } else throw Error("unexpected tool " + tool);
    if (res.destroyed) return;
    const formatCount = formatCounts.get(latest) ?? 0;
    formatCounts.set(latest, formatCount + 1);
    const invalidFormat =
      latest.includes("格式持续错误") ||
      (latest.includes("格式重试") && formatCount < 2);
    const jsonReply = latest.includes("完整JSON");
    const toolCall = {
      id: randomUUID(),
      type: "function",
      function: { name: tool, arguments: JSON.stringify(input) },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: invalidFormat
                ? "这次只返回了普通文字，不能当作结构化控制建议。"
                : jsonReply
                  ? JSON.stringify(input)
                  : null,
              ...(thinking
                ? { reasoning_content: "fixture reasoning not persisted" }
                : {}),
              ...(!invalidFormat && !jsonReply
                ? {
                    tool_calls: latest.includes("重复工具")
                      ? [toolCall, { ...toolCall, id: randomUUID() }]
                      : [toolCall],
                  }
                : {}),
            },
            finish_reason: invalidFormat || jsonReply ? "stop" : "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 300,
          completion_tokens: 200,
          total_tokens: 500,
        },
      }),
    );
  } catch (e) {
    failures.push((e as Error).message);
    res.writeHead(500);
    res.end();
  }
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const port = (provider.address() as { port: number }).port;
const aiDirectory = resolve(directory, "eve");
await mkdir(aiDirectory);
const app = await createApplication({ directory, aiDirectory, dev: false });
const url = await app.listen(0);
const first = await fetch(url + "/api/state");
const cookie = first.headers.get("set-cookie")!.split(";")[0];
async function api<T = unknown>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const r = await fetch(url + path, {
    method,
    headers: {
      "content-type": "application/json",
      "X-Coyote-Request": "1",
      cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const v = await r.json();
  assert.ok(v.ok, `${method} ${path}: ${v.error}`);
  return v.data;
}
const until = async (fn: () => Promise<boolean>, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("acceptance timeout");
};
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((r) => provider.close(() => r()));
  await rm(directory, { recursive: true, force: true });
}
try {
  await until(
    async () => (await api<AppSnapshot>("/api/state")).aiRuntime.ready,
  );
  await api(
    "/api/settings",
    {
      provider: deepseek ? "deepseek" : "openai-compatible",
      deepseekThinking: thinking ? "enabled" : "disabled",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "story-fixture",
      apiKey: "local-story-fixture",
    },
    "PUT",
  );
  const format = await api<{ template: typeof cardTemplate }>(
    "/api/roleplay/card-format",
  );
  assert.deepEqual(format.template, cardTemplate);
  const fixtureCard = structuredClone(cardTemplate);
  fixtureCard.character.linkageStyle =
    "所有互动均为虚构故事，不涉及现实设备控制或实际硬件操作。";
  const card = await api<{ id: string }>("/api/roleplay/cards", fixtureCard);
  const preview = await api<{ card: typeof cardTemplate }>(
    "/api/roleplay/cards/import/convert",
    {
      source: {
        name: "外来向导",
        description: "星城",
        character_book: { entries: [] },
      },
    },
  );
  assert.equal(preview.card.character.name, "外来向导");
  const session = await api<RoleplaySession>("/api/roleplay/sessions", {
    cardId: card.id,
    player: { name: "旅人", identity: "探索者", relationship: "同伴" },
    scenario: "星城",
  });
  const root = `/api/roleplay/sessions/${session.id}`;
  async function send(text: string) {
    const turn = await api<RoleplayTurn>(root + "/messages", {
      text,
      requestId: randomUUID(),
    });
    await until(
      async () =>
        (await api<RoleplayTurn>(root + "/turns/" + turn.id)).status !==
        "pending",
    );
    return api<RoleplayTurn>(root + "/turns/" + turn.id);
  }
  assert.equal((await send("我接过徽章")).status, "completed");
  assert.equal(app.controller.run, null);
  await api("/api/device/connect", { protocol: "simulator" });
  const state = await api<AppSnapshot>("/api/state");
  const bounds = {
    channels: ["A", "B"],
    waveformIds: state.waveforms.slice(0, 2).map((w) => w.id),
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 12, B: 7 },
    rampPerSecond: { A: 20, B: 20 },
    allowSync: true,
    allowRamp: true,
    allowRest: true,
  };
  await api(root + "/link/start", { bounds, requestId: randomUUID() });
  assert.equal((await send("我走进房间")).status, "completed");
  await until(
    async () =>
      (await api<AppSnapshot>("/api/state")).device.intensities.A === 8,
  );
  const initial = await api<AppSnapshot>("/api/state");
  assert.equal(initial.run!.deadlineAt, null);
  assert.equal(initial.device.intensities.B, 4);
  let stops = 0;
  const stop = app.device.stop.bind(app.device);
  app.device.stop = async () => {
    stops++;
    return stop();
  };
  assert.equal((await send("保持，继续研究线索")).status, "completed");
  assert.equal(stops, 0);
  for (const text of [
    "完整JSON回复，继续探索",
    "重复工具回复，继续探索",
    "偶发格式重试，继续探索",
  ]) {
    const t = await send(text);
    assert.equal(t.status, "completed");
    if (text.includes("格式重试")) assert.equal(t.formatAttempt, 2);
    assert.equal(stops, 0);
  }
  const liveId = app.controller.run!.id;
  const malformed = await send("格式持续错误");
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.formatAttempt, 3);
  assert.equal(app.controller.run!.id, liveId);
  assert.equal(app.controller.run!.status, "running");
  assert.equal(stops, 0);
  assert.equal(app.device.state.intensities.A, 8);
  assert.equal((await send("保持，格式错误后重新发送")).status, "completed");
  assert.equal(app.controller.run!.id, liveId);
  const slow = await api<RoleplayTurn>(root + "/messages", {
    text: "延迟回复",
    requestId: randomUUID(),
  });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await api<AppSnapshot>("/api/state")).device.intensities.A, 8);
  const next = await api<RoleplayTurn>(root + "/messages", {
    text: "保持，我改变主意了",
    requestId: randomUUID(),
  });
  await until(
    async () =>
      (await api<RoleplayTurn>(root + "/turns/" + next.id)).status ===
      "completed",
  );
  assert.equal(
    (await api<RoleplayTurn>(root + "/turns/" + slow.id)).status,
    "cancelled",
  );
  assert.equal(stops, 0);
  await api(root + "/link/pause", {});
  assert.equal((await api<AppSnapshot>("/api/state")).device.intensities.A, 0);
  await api(root + "/link/resume", {});
  assert.equal(
    (await api<AppSnapshot>("/api/state")).run!.roleplay!.output.A.target,
    0,
  );
  await send("继续探索");
  const fail = await send("持续错误");
  assert.equal(fail.status, "failed");
  assert.equal(fail.attempt, 20);
  assert.equal((await api<AppSnapshot>("/api/state")).device.intensities.A, 0);
  const report = {
    provider: deepseek ? "deepseek" : "openai-compatible",
    thinking,
    calls,
    cancelled,
    checks: [
      "native template",
      "third-party AI preview",
      "pure dialogue",
      "independent continuous A/B",
      "keep and delayed inference no zero",
      "complete JSON and duplicate tools are recovered",
      "format retries preserve output and resend retains run",
      "cancel and late result",
      "pause and no replay",
      "21 HTTP503 requests then confirmed stop",
    ],
    failures,
  };
  assert.deepEqual(failures, []);
  await writeFile(
    resolve(
      artifacts,
      `http-${deepseek ? "deepseek-" + (thinking ? "on" : "off") : "compatible"}.json`,
    ),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ url, ...report }));
  if (process.argv.includes("--browser")) {
    app.device.state.limits = { A: 41, B: 40 };
    app.device.state.lastSeenAt = Date.now();
    app.device.emit("state", app.device.state);
    app.controller.broadcast(true);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      executablePath:
        process.env.COYOTE_BROWSER_PATH ??
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1512, height: 1000 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (
        m.type() === "error" &&
        !/WebSocket.*failed|WebSocket is closed before/.test(m.text())
      )
        errors.push(m.text());
    });
    try {
      await page.goto(url);
      await page
        .getByRole("navigation", { name: "主要模块" })
        .getByRole("button", { name: /^情景演绎/ })
        .click();
      await page
        .getByRole("button", { name: "角色卡格式", exact: true })
        .click();
      await page
        .getByRole("button", { name: "复制 JSON 模板", exact: true })
        .click();
      await page.getByText("JSON 模板已复制", { exact: true }).waitFor();
      const json = structuredClone(cardTemplate);
      json.character.name = "浏览器向导";
      json.character.linkageStyle = fixtureCard.character.linkageStyle;
      await page
        .getByRole("textbox", { name: "粘贴 JSON 校验" })
        .fill(JSON.stringify(json));
      await page.getByRole("button", { name: "校验并填入编辑器" }).click();
      await page
        .getByRole("button", { name: "保存角色卡", exact: true })
        .click();
      await page
        .locator(".story-card")
        .filter({ hasText: "浏览器向导" })
        .waitFor();
      const third = resolve(artifacts, "third-party.json");
      await writeFile(
        third,
        JSON.stringify({
          spec: "chara_card_v2",
          data: {
            name: "导入浏览器角色",
            description: "星城向导",
            personality: "冷静",
            extensions: { unsupported: true },
          },
        }),
      );
      await page.getByLabel("导入角色卡", { exact: true }).setInputFiles(third);
      await page
        .getByRole("button", { name: "使用 AI 解析", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "角色姓名", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("textbox", { name: "角色姓名", exact: true })
          .inputValue(),
        "导入浏览器角色",
      );
      await page
        .getByRole("button", { name: "保存角色卡", exact: true })
        .click();
      await page
        .locator(".story-card")
        .filter({ hasText: "浏览器向导" })
        .getByRole("button", { name: "开始演绎" })
        .click();
      await page
        .getByRole("textbox", { name: "玩家称呼", exact: true })
        .fill("浏览器旅人");
      assert.ok(
        await page
          .getByRole("checkbox", {
            name: "进入故事时启用设备联动",
            exact: true,
          })
          .isChecked(),
      );
      await page
        .getByRole("checkbox", { name: "进入故事时启用设备联动", exact: true })
        .uncheck();
      await page.getByRole("button", { name: "进入故事", exact: true }).click();
      await page
        .getByRole("textbox", { name: "回复剧情", exact: true })
        .fill("我接过徽章，向她询问下一步");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page
        .locator(".story-message.assistant")
        .filter({ hasText: "蓝色灯光" })
        .waitFor();
      const choices = page.getByRole("group", {
        name: "快捷回复",
        exact: true,
      });
      await choices.waitFor();
      assert.equal(await choices.getByRole("button").count(), 3);
      const choicesBefore = await choices.getByRole("button").allTextContents();
      const beforeChoice = calls;
      await page.reload();
      await page
        .getByRole("navigation", { name: "主要模块" })
        .getByRole("button", { name: /^情景演绎/ })
        .click();
      await page.getByRole("button", { name: /浏览器向导的故事/ }).click();
      await choices.waitFor();
      assert.deepEqual(
        await choices.getByRole("button").allTextContents(),
        choicesBefore,
        "reload restores persisted choices without inference",
      );
      assert.equal(calls, beforeChoice);
      const chosenText = "我沿着蓝色灯光往前走。";
      await choices
        .getByRole("button")
        .first()
        .evaluate((button) => {
          (button as HTMLButtonElement).click();
          (button as HTMLButtonElement).click();
        });
      await until(
        async () => calls === beforeChoice + 1 && !app.controller.roleplayBusy,
      );
      await page
        .locator(".story-message.user")
        .filter({ hasText: chosenText })
        .waitFor();
      assert.equal(
        await page
          .locator(".story-message.user")
          .filter({ hasText: chosenText })
          .count(),
        1,
      );
      await choices.waitFor();
      assert.equal(await choices.getByRole("button").count(), 3);
      for (const width of [375, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await choices.scrollIntoViewIfNeeded();
        assert.ok(await choices.getByRole("button").first().isVisible());
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: resolve(artifacts, `quick-replies-${width}.png`),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1512, height: 1000 });
      await page
        .getByRole("button", { name: "启用设备联动", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "确认持续设备联动",
        exact: true,
      });
      for (const c of ["A", "B"] as const) {
        assert.equal(
          await dialog
            .getByRole("spinbutton", { name: `${c} 最低强度`, exact: true })
            .inputValue(),
          "0",
        );
        assert.equal(
          await dialog
            .getByRole("spinbutton", { name: `${c} 最高强度`, exact: true })
            .inputValue(),
          String(app.device.state.limits[c]),
        );
        assert.equal(
          await dialog
            .getByRole("spinbutton", { name: `${c} 最大变化速率`, exact: true })
            .inputValue(),
          "5",
        );
      }
      assert.equal(
        await dialog.locator(".wave-check input").count(),
        app.controller.snapshot().waveforms.length,
      );
      for (const check of await dialog.getByRole("checkbox").all())
        assert.ok(
          await check.isChecked(),
          "channels, every waveform and permissions default to selected",
        );
      await page.screenshot({
        path: resolve(artifacts, "roleplay-link-defaults.png"),
        fullPage: true,
        animations: "disabled",
      });
      await dialog
        .getByRole("spinbutton", { name: "A 最高强度", exact: true })
        .fill("12");
      await dialog
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
      await page
        .getByRole("button", { name: "启用设备联动", exact: true })
        .click();
      assert.equal(
        await dialog
          .getByRole("spinbutton", { name: "A 最高强度", exact: true })
          .inputValue(),
        "41",
        "new authorization reads fresh defaults instead of a cancelled form",
      );
      await page
        .getByRole("spinbutton", { name: "A 最高强度", exact: true })
        .fill("12");
      await page
        .getByRole("spinbutton", { name: "A 最高强度", exact: true })
        .blur();
      await page
        .getByRole("spinbutton", { name: "B 最高强度", exact: true })
        .fill("7");
      await page
        .getByRole("spinbutton", { name: "B 最高强度", exact: true })
        .blur();
      await page
        .getByRole("button", {
          name: "确认授权，等待下一条玩家回复",
          exact: true,
        })
        .click();
      await page.getByText("持续联动中", { exact: true }).waitFor();
      await page.getByRole("button", { name: "修改范围", exact: true }).click();
      const existing = page.getByRole("dialog", {
        name: "修改演绎授权范围",
        exact: true,
      });
      assert.equal(
        await existing
          .getByRole("spinbutton", { name: "A 最高强度", exact: true })
          .inputValue(),
        "12",
      );
      assert.equal(
        await existing
          .getByRole("spinbutton", { name: "B 最高强度", exact: true })
          .inputValue(),
        "7",
      );
      await existing
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "回复剧情", exact: true })
        .fill("先保持这样，我想继续聊天。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const heldZero = page
        .locator(".story-message.assistant")
        .filter({
          has: page.getByText("保持原参数，未提交新的强度或波形", {
            exact: true,
          }),
        })
        .last();
      await heldZero.waitFor();
      await heldZero.locator("summary").click();
      await heldZero
        .getByText("keep 只保留原参数；原目标为 0 时会继续保持零输出。", {
          exact: true,
        })
        .waitFor();
      await heldZero
        .getByText("联动说明：玩家要求保持当前节奏，本轮保留全部参数。", {
          exact: true,
        })
        .waitFor();
      assert.equal(app.controller.run!.roleplay!.output.A.target, 0);
      assert.equal(app.controller.run!.roleplay!.output.B.target, 0);
      await page
        .getByRole("textbox", { name: "回复剧情", exact: true })
        .fill("我沿着灯光前进");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await until(
        async () =>
          app.device.state.intensities.A === 8 &&
          app.device.state.intensities.B === 4,
      );
      const updated = page
        .locator(".story-message.assistant")
        .filter({
          has: page.getByText("参数更新已提交，设备实际强度以回传为准", {
            exact: true,
          }),
        })
        .last();
      await updated.waitFor();
      await updated.locator("summary").click();
      await updated
        .getByText("联动说明：根据探索剧情分别调整 A/B 目标，等待设备确认。", {
          exact: true,
        })
        .waitFor();
      await page.getByText("设备详情与授权范围", { exact: true }).click();
      await page.screenshot({
        path: resolve(artifacts, "roleplay-desktop.png"),
        fullPage: true,
        animations: "disabled",
      });
      for (const width of [375, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({
          path: resolve(artifacts, `roleplay-mobile-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
        assert.ok(
          await page
            .getByRole("button", { name: "紧急停止", exact: true })
            .isVisible(),
        );
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
          "窄屏不应横向溢出",
        );
        await page.screenshot({
          path: resolve(artifacts, `roleplay-mobile-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
      await page.setViewportSize({ width: 1512, height: 1000 });
      await page
        .getByRole("navigation", { name: "主要模块" })
        .getByRole("button", { name: /^控制台/ })
        .click();
      await page
        .getByRole("button", { name: "进入 情景演绎", exact: true })
        .click();
      await page.getByText("持续联动中", { exact: true }).waitFor();
      assert.equal(app.controller.run!.roleplay!.output.A.target, 8);
      await page.reload();
      await page
        .getByRole("navigation", { name: "主要模块" })
        .getByRole("button", { name: /^情景演绎/ })
        .click();
      await page.getByRole("button", { name: /浏览器向导的故事/ }).click();
      await page.getByText("持续联动中", { exact: true }).waitFor();
      assert.equal(app.controller.run!.roleplay!.output.A.target, 8);
      await page.getByRole("button", { name: "暂停输出", exact: true }).click();
      await until(async () => app.device.state.intensities.A === 0);
      await page.getByRole("button", { name: "恢复联动", exact: true }).click();
      assert.equal(app.controller.run!.roleplay!.output.A.target, 0);
      await page.getByRole("button", { name: "结束联动", exact: true }).click();
      await page
        .getByRole("button", { name: "启用设备联动", exact: true })
        .waitFor();
      const beforeOpening = calls;
      await page
        .locator(".story-card")
        .filter({ hasText: "浏览器向导" })
        .getByRole("button", { name: "开始演绎", exact: true })
        .click();
      assert.ok(
        await page
          .getByRole("checkbox", {
            name: "进入故事时启用设备联动",
            exact: true,
          })
          .isChecked(),
      );
      await page.getByRole("button", { name: "进入故事", exact: true }).click();
      await page.getByText("持续联动中", { exact: true }).waitFor();
      assert.equal(calls, beforeOpening, "linked opening does not call AI");
      assert.equal(app.controller.run!.roleplay!.output.A.target, 0);
      const newRun = app.controller.run!.id;
      const input = page.getByRole("textbox", {
        name: "回复剧情",
        exact: true,
      });
      await input.fill("第一行");
      await input.press("Shift+Enter");
      assert.equal(await input.inputValue(), "第一行\n");
      const beforeIme = calls;
      await input.dispatchEvent("compositionstart");
      await input.press("Enter");
      assert.equal(calls, beforeIme, "IME confirmation must not send");
      await input.dispatchEvent("compositionend");
      await input.fill("回车发送剧情\n第二行");
      await input.press("Enter");
      await until(
        async () =>
          app.device.state.intensities.A === 8 &&
          app.device.state.intensities.B === 4,
      );
      const activeStory = app.controller.run!.roleplay!.sessionId;
      assert.ok(
        app.roleplay
          .messages(activeStory)
          .items.some(
            (m) => m.role === "user" && m.text === "回车发送剧情\n第二行",
          ),
      );
      const beforeFormat = stops;
      await input.fill("浏览器格式持续错误");
      await input.press("Enter");
      await page.getByText(/本轮回复格式在 3 次自动重试后/).waitFor();
      assert.equal(app.controller.run!.id, newRun);
      assert.equal(app.controller.run!.status, "running");
      assert.equal(app.device.state.intensities.A, 8);
      assert.equal(stops, beforeFormat);
      await input.fill("保持，浏览器重发继续");
      await input.press("Enter");
      await until(async () =>
        app.roleplay
          .messages(activeStory)
          .items.some(
            (m) => m.role === "user" && m.text === "保持，浏览器重发继续",
          ),
      );
      await until(async () => !app.controller.roleplayBusy);
      assert.equal(app.controller.run!.id, newRun);
      await page.getByRole("button", { name: "结束联动", exact: true }).click();
      assert.deepEqual(errors, []);
      const browserReport = {
        checks: [
          "copy native template",
          "native JSON editor/save",
          "third-party upload/AI parse/preview/save",
          "create story and pure dialogue",
          "three contextual quick replies, reload persistence, one-click send without double submission and narrow screens",
          "authorize A/B",
          "new link defaults to all channels/waves/permissions, 0-device limits and 5/s",
          "cancelled new link restores defaults on reopening",
          "editing an active link preserves confirmed bounds",
          "keep at zero is explicit and preserves zero",
          "model control explanation and update record",
          "continuous output",
          "375/390 responsive with fixed emergency",
          "reload restores true state",
          "pause/resume no replay",
          "stop",
          "new story starts linked without a second enable action",
          "Enter sends, Shift+Enter inserts newline and IME confirmation does not send",
          "format exhaustion and resend leave continuous device linkage active",
        ],
        errors,
      };
      await writeFile(
        resolve(
          artifacts,
          `browser-${deepseek ? (thinking ? "deepseek-on" : "deepseek-off") : "compatible"}.json`,
        ),
        JSON.stringify(browserReport, null, 2),
      );
      console.log(JSON.stringify(browserReport));
    } finally {
      await browser.close();
    }
  }
  if (serve) {
    await app.controller.emergency();
    console.log("ROLEPLAY_BROWSER_FIXTURE=" + url);
    await new Promise<void>((r) => {
      process.once("SIGINT", r);
      process.once("SIGTERM", r);
    });
  }
} finally {
  await cleanup();
}
