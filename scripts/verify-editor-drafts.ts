/** Local browser acceptance using a temporary SQLite database and simulator. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Locator, type Page } from "playwright";
import { createApplication } from "../server/app.ts";
import { cardTemplate } from "../shared/roleplay.ts";
import type {
  ApiEnvelope,
  ControlBounds,
  Stage,
  TaskPlan,
} from "../shared/types.ts";

const dir = await mkdtemp(join(tmpdir(), "coyote-draft-browser-"));
const app = await createApplication({
  directory: dir,
  startAi: false,
  dev: true,
});
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1500, height: 1050 },
});
context.setDefaultTimeout(9000);
const page = await context.newPage();
const errors: string[] = [],
  writes: string[] = [],
  checks: string[] = [];
function observe(p: Page) {
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => {
    if (r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/"))
      writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
}
observe(page);
const nav = (p: Page, name: string) =>
  p
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .first()
    .click();
const button = (name: string) =>
  page.getByRole("button", { name, exact: true });
const field = (name: string) =>
  page
    .getByLabel(name, { exact: true })
    .and(page.locator("input, select, textarea"));
async function until(
  message: string,
  predicate: () => boolean | Promise<boolean>,
) {
  for (let i = 0; i < 160; i++) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(message);
}
async function value(locator: Locator, expected: string) {
  await locator.waitFor();
  await until(
    `expected ${expected}, got ${await locator.inputValue()}`,
    async () => (await locator.inputValue()) === expected,
  );
}
async function api<T>(p: Page, path: string, method: string, body: unknown) {
  const envelope = (await p.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Coyote-Request": "1",
        },
        body: JSON.stringify(body),
      });
      return response.json();
    },
    { path, method, body },
  )) as ApiEnvelope<T>;
  assert.ok(envelope.ok, envelope.error);
  return envelope.data!;
}
const saved = (p = page) =>
  p.getByText("本地草稿已保存", { exact: true }).first().waitFor();
const readDraft = (key: string) =>
  page.evaluate((key) => localStorage.getItem(key), key);
const key = (name: string) => `coyote:draft:${app.store.draftScope}:${name}`;
const stageName = (i: number) => field(`第 ${i} 项名称`);
const strength = (i: number, c: "A" | "B") =>
  field(`第 ${i} 项 ${c} 通道目标强度`);
const ratio = (c: "A" | "B") => field(`${c} 通道全局强度倍率`);
const changeStory = async (title: string) => {
  await page.locator(".story-list-item").filter({ hasText: title }).click();
  await page
    .locator(".story-chat-heading")
    .getByRole("heading", { name: title, exact: true })
    .waitFor();
};
const input = field("回复剧情");
let releaseStory: (() => void) | undefined;
try {
  const url = await app.listen(0);
  app.ai.status = { ready: true };
  app.store.saveSettings({
    baseUrl: "http://127.0.0.1:1/v1",
    model: "local-fixture",
  });
  await app.controller.connect({ protocol: "simulator" });
  const wave = app.controller.importWaveform(
    ["0A0A0A0A0B0B0B0B"],
    "草稿引用波形",
  );
  const alternate = app.controller
    .snapshot()
    .waveforms.find((w) => w.id !== wave.id)!;
  const bounds: ControlBounds = {
    channels: ["A", "B"],
    waveformIds: [alternate.id],
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 12, B: 12 },
    rampPerSecond: { A: 3, B: 3 },
    allowSync: true,
    allowRandom: false,
    allowRamp: true,
    allowRest: true,
    maxActionSec: 5,
    durationSec: 120,
    decisionIntervalSec: 8,
    preference: "",
  };
  const stage: Stage = {
    id: "local-stage",
    name: "模型桩阶段",
    durationSec: 40,
    gapSec: 0,
    channels: ["A", "B"],
    waveformId: alternate.id,
    intensity: { A: 0, B: 0 },
    startIntensity: { A: 0, B: 0 },
    behavior: "hold",
  };
  app.ai.draft = async () => ({
    id: "fixture",
    version: 1,
    title: "模型桩任务",
    description: "任务说明",
    completionCriteria: "计时",
    bounds,
    stages: [stage],
    createdAt: 1,
  });
  app.ai.decide = async () => ({
    action: "adjust",
    channels: ["A", "B"],
    waveformId: alternate.id,
    intensity: { A: 0, B: 0 },
    durationSec: 5,
    reason: "本地模拟",
  });
  const card = app.roleplay.saveCard(structuredClone(cardTemplate));
  const stories = ["草稿故事 A", "草稿故事 B"].map((title) =>
    app.roleplay.create({
      title,
      cardId: card.id,
      player: { name: "旅人", identity: "访客", relationship: "友人" },
      scenario: "本地验证",
    }),
  );
  let storyResult: "ok" | "fail" | "wait" = "ok";
  app.ai.story = async () => {
    if (storyResult === "fail") throw new Error("模拟发送失败");
    if (storyResult === "wait")
      await new Promise<void>((resolve) => {
        releaseStory = resolve;
      });
    return {
      narration: "星涟抬手示意。",
      dialogue: "我们继续吧。",
      replyOptions: ["走过去", "先问一下", "等一会儿"],
      storyStateDelta: {},
      control: { action: "keep" },
      memory: {
        recentPlot: "见面",
        plotBackground: "房间",
        longPlot: "",
        longDialogue: "",
      },
    };
  };
  await page.goto(url);
  await nav(page, "阶段编排");
  for (let i = 1; i < 8; i++) await page.locator(".add-stage").click();
  for (let i = 1; i <= 8; i++) {
    await stageName(i).fill(`阶段 ${i}`);
    await field(`第 ${i} 项持续时间`).fill(String(i + 10));
    await strength(i, "A").fill("2");
    await strength(i, "B").fill("3");
  }
  await field("第 8 项执行方式").selectOption("ramp");
  await field("第 8 项 A 通道起始强度").fill("1");
  await page
    .locator(".stage-row")
    .nth(7)
    .getByLabel("选择波形", { exact: true })
    .selectOption(wave.id);
  await button("上移第 8 项").click();
  await ratio("A").fill("2");
  await ratio("B").fill("1.5");
  await field("方案重复次数").fill("3");
  await field("方案最长总时长").fill("500");
  await button("保存预设").click();
  await field("预设名称").fill("未完成预设名");
  await page.keyboard.press("Escape");

  await nav(page, "波形库");
  await nav(page, "系统设置");
  await nav(page, "控制台");
  await field("搜索波形").waitFor();
  await nav(page, "阶段编排");
  await value(stageName(7), "阶段 8");
  await value(field("第 7 项持续时间"), "18");
  await value(field("第 7 项 A 通道起始强度"), "2");
  await value(field("第 7 项执行方式"), "ramp");
  await value(
    page.locator(".stage-row").nth(6).getByLabel("选择波形", { exact: true }),
    wave.id,
  );
  assert.equal(await page.locator(".stage-row").count(), 8);
  await value(ratio("B"), "1.5");
  await value(strength(7, "B"), "5");
  await page.reload();
  await value(ratio("A"), "2");
  await ratio("A").fill("3");
  await value(strength(7, "A"), "6");
  await value(field("第 7 项 A 通道起始强度"), "3");
  await value(field("方案重复次数"), "3");
  await value(field("方案最长总时长"), "500");
  await button("保存预设").click();
  await value(field("预设名称"), "未完成预设名");
  await page.keyboard.press("Escape");
  await nav(page, "播放列表");
  await stageName(1).fill("独立播放列表");
  await field("第 1 项间隔时间").fill("7");
  await nav(page, "随机控制");
  await field("随机总运行时间").fill("444");
  await nav(page, "阶段编排");
  await value(stageName(7), "阶段 8");
  await nav(page, "播放列表");
  await value(stageName(1), "独立播放列表");
  await value(field("第 1 项间隔时间"), "7");
  await nav(page, "随机控制");
  await value(field("随机总运行时间"), "444");
  await nav(page, "阶段编排");
  const reopened = await context.newPage();
  observe(reopened);
  await reopened.goto(url);
  await value(reopened.getByLabel("第 7 项名称", { exact: true }), "阶段 8");
  await reopened.close();
  assert.deepEqual(writes, [], "切页、刷新和重新打开不得发送控制请求");
  checks.push(
    "8 阶段与顺序、波形、起始/目标、持续时间、倍率基准、预设名称及三个独立控制台草稿",
  );

  await button("保存预设").click();
  const rejectPreset = (route: import("playwright").Route) =>
    route.fulfill({
      status: 400,
      json: { ok: false, error: "模拟预设保存失败" },
    });
  await page.route("**/api/presets", rejectPreset);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存预设" })
    .click();
  await page.getByText("模拟预设保存失败", { exact: true }).waitFor();
  await value(field("预设名称"), "未完成预设名");
  await page.unroute("**/api/presets", rejectPreset);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存预设" })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await stageName(1).fill("准备被覆盖");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /^未完成预设名/ }).click();
  await value(stageName(1), "准备被覆盖");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^未完成预设名/ }).click();
  await value(stageName(1), "阶段 1");
  await value(ratio("A"), "1.0");
  const limits = { ...app.device.state.limits };
  app.device.state.limits = { ...limits, A: 4 };
  app.device.emit("state", app.device.state);
  await page
    .getByText(/A 通道.*(超过|超出).*4/)
    .first()
    .waitFor();
  await value(strength(7, "A"), "6");
  assert.equal(await button("确认并播放").isDisabled(), true);
  app.device.state.limits = limits;
  app.device.emit("state", app.device.state);
  app.controller.deleteWaveform(wave.id);
  await page
    .getByText("波形已删除或不可用", { exact: true })
    .first()
    .waitFor({ state: "attached" });
  await value(
    page.locator(".stage-row").nth(6).getByLabel("选择波形", { exact: true }),
    wave.id,
  );
  assert.equal(await button("确认并播放").isDisabled(), true);
  await button("丢弃方案草稿").click();
  assert.equal(await page.locator(".stage-row").count(), 1);
  assert.equal(app.controller.snapshot().presets.length, 1);
  checks.push(
    "正式保存失败保留输入，成功建立基准；覆盖确认、缺失波形和仅丢弃本地内容",
  );

  await nav(page, "情景演绎");
  await changeStory("草稿故事 A");
  await input.fill("A 未发");
  await changeStory("草稿故事 B");
  await input.fill("B 未发");
  await page.reload();
  await value(input, "B 未发");
  await changeStory("草稿故事 A");
  await value(input, "A 未发");
  storyResult = "fail";
  await input.press("Enter");
  await page.getByText(/模拟发送失败.*输入仍可重新发送/).waitFor();
  await value(input, "A 未发");
  storyResult = "wait";
  await input.press("Enter");
  await until(
    "model request did not reach the local stub",
    () => !!releaseStory,
  );
  await input.fill("上一轮等待时新输入");
  releaseStory!();
  await page.getByText("我们继续吧。", { exact: true }).waitFor();
  await value(input, "上一轮等待时新输入");
  const beforeIme = writes.length;
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await input.dispatchEvent("compositionend");
  assert.equal(writes.length, beforeIme);
  await input.fill("确认重新打开后也能清理");
  await input.press("Shift+Enter");
  assert.ok((await input.inputValue()).includes("\n"));
  storyResult = "wait";
  releaseStory = undefined;
  await input.press("Enter");
  await until(
    "model request did not reach the local stub before reload",
    () => !!releaseStory,
  );
  const sentBeforeReload = JSON.parse(
    (await readDraft(key(`story:${stories[0].id}`))) ?? "{}",
  );
  assert.ok(
    sentBeforeReload.value?.sent?.requestId,
    "立即发送后刷新也应保留已发送草稿的请求 ID",
  );
  await page.reload();
  await input.waitFor();
  releaseStory!();
  await value(input, "");
  await changeStory("草稿故事 B");
  await value(input, "B 未发");
  await page.getByText("故事管理", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".story-toolbar")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await until(
    "deleted story draft remains",
    async () =>
      JSON.parse((await readDraft(key(`story:${stories[1].id}`))) ?? "{}")
        .deleted === true,
  );
  checks.push(
    "故事 A/B 独立、发送失败保留、成功清空、迟到成功不清除新输入、删除对应草稿",
  );

  await nav(page, "系统设置");
  await field("AI 模型名称").fill("本地模型设置草稿");
  await field("AI API Key").fill("never-store-this-fixture-key");
  await saved();
  assert.doesNotMatch(
    (await readDraft(key("settings")))!,
    /never-store|apiKey/,
  );
  await page.reload();
  await value(field("AI 模型名称"), "本地模型设置草稿");
  await value(field("AI API Key"), "");
  const second = await context.newPage();
  observe(second);
  await second.goto(url);
  await second
    .getByLabel("AI 模型名称", { exact: true })
    .fill("另一个标签页的设置草稿");
  await saved(second);
  await page.getByText(/其他标签页已更新此草稿/).waitFor();
  await field("AI 模型名称").fill("旧标签页继续打字");
  assert.match((await readDraft(key("settings")))!, /另一个标签页/);
  await button("载入其他标签页版本").click();
  await value(field("AI 模型名称"), "另一个标签页的设置草稿");
  await api(second, "/api/settings", "PUT", { model: "后台正式设置" });
  await page.getByText(/后台设置已更新/).waitFor();
  await value(field("AI 模型名称"), "另一个标签页的设置草稿");
  await button("载入后台设置").click();
  await value(field("AI 模型名称"), "后台正式设置");
  await second.close();
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(":settings"))
        throw new DOMException("full", "QuotaExceededError");
      set.call(this, key, value);
    };
  });
  await field("AI 模型名称").fill("容量不足时仍可编辑");
  await page.getByText(/本地保存失败/).waitFor();
  await value(field("AI 模型名称"), "容量不足时仍可编辑");
  await page.evaluate((key) => localStorage.removeItem(key), key("settings"));
  await page.reload();
  await field("AI 模型名称").waitFor();
  await page.evaluate(
    (key) => localStorage.setItem(key, "{broken"),
    key("settings"),
  );
  await page.reload();
  await page.getByText(/本地草稿已损坏/).waitFor();
  await value(field("AI 模型名称"), "后台正式设置");
  await button("丢弃设置草稿").click();
  assert.equal(await readDraft(key("settings")), null);
  checks.push(
    "设置保留普通字段、不保存凭证，双标签页冲突、后台版本变化、存储失败和损坏提示",
  );

  await nav(page, "AI 上锁任务");
  await field("任务需求").fill("独立新建需求");
  await button("生成任务草稿").click();
  await field("任务名称").fill("本地未保存的任务");
  await button("进入上锁确认").click();
  const beforeTaskReload = writes.length;
  await page.reload();
  await page.getByRole("dialog", { name: "确认约定并上锁" }).waitFor();
  assert.equal(writes.length, beforeTaskReload);
  await button("返回修改").click();
  await value(field("任务需求"), "独立新建需求");
  await value(field("任务名称"), "本地未保存的任务");
  const firstTask = app.controller.snapshot().plans[0];
  const updated = await api<TaskPlan>(
    page,
    `/api/locked-tasks/${firstTask.id}`,
    "PATCH",
    {
      plan: { ...firstTask, title: "后台更新的任务" },
      expectedVersion: firstTask.version,
    },
  );
  assert.equal(updated.version, firstTask.version + 1);
  await page.getByText(/后台任务已更新/).waitFor();
  await value(field("任务名称"), "本地未保存的任务");
  page.once("dialog", (dialog) => dialog.accept());
  await button("保留本地任务修改").click();
  await button("保存草稿").click();
  await until(
    "正式任务保存未生效",
    () => app.controller.snapshot().plans[0].title === "本地未保存的任务",
  );
  await button("重新生成任务草稿").click();
  await value(field("任务名称"), "模型桩任务");
  await field("任务名称").fill("另一任务的编辑");
  await page.getByRole("button", { name: /^本地未保存的任务/ }).click();
  await value(field("任务名称"), "本地未保存的任务");
  const disposable = app.controller
    .snapshot()
    .plans.find((p) => p.id !== firstTask.id)!;
  const deletePath = `**/api/locked-tasks/${disposable.id}`;
  const rejectDelete = (route: import("playwright").Route) =>
    route.fulfill({
      status: 409,
      json: { ok: false, error: "模拟任务删除失败" },
    });
  await page.route(deletePath, rejectDelete);
  page.once("dialog", (dialog) => dialog.accept());
  await button(`删除任务 ${disposable.title}`).click();
  await page.getByText("模拟任务删除失败", { exact: true }).waitFor();
  assert.match(
    (await readDraft(key(`task:${disposable.id}`)))!,
    /另一任务的编辑/,
  );
  await page.unroute(deletePath, rejectDelete);
  page.once("dialog", (dialog) => dialog.accept());
  await button(`删除任务 ${disposable.title}`).click();
  await until(
    "deleted task draft remains",
    async () =>
      JSON.parse((await readDraft(key(`task:${disposable.id}`))) ?? "{}")
        .deleted === true,
  );
  checks.push(
    "新建需求和各任务独立、确认步骤恢复、后台版本冲突、正式保存和删除清理",
  );

  await nav(page, "AI 控制");
  await field("控制偏好").fill("AI 独立偏好");
  await nav(page, "系统设置");
  await nav(page, "AI 控制");
  await value(field("控制偏好"), "AI 独立偏好");
  await app.controller.startAi(bounds, crypto.randomUUID());
  const beforeRunningReload = writes.length;
  await page.reload();
  await value(field("控制偏好"), "AI 独立偏好");
  assert.equal(app.controller.run?.status, "running");
  assert.equal(writes.length, beforeRunningReload);
  await app.controller.pause("ai-control");
  await page.getByText("查看后台已确认的授权范围", { exact: true }).waitFor();
  await field("给 AI 的文字反馈").fill("反馈尚未发送");
  const beforePausedReload = writes.length;
  await page.reload();
  await value(field("给 AI 的文字反馈"), "反馈尚未发送");
  await value(field("控制偏好"), "AI 独立偏好");
  assert.equal(app.controller.run?.status, "paused");
  assert.equal(writes.length, beforePausedReload);
  assert.deepEqual(app.device.state.intensities, { A: 0, B: 0 });
  await app.controller.stop("ai-control");
  await app.controller.startTask(firstTask.id, crypto.randomUUID());
  await nav(page, "AI 上锁任务");
  const beforeLockedReload = writes.length;
  await page.reload();
  await page.getByText("上锁任务执行中", { exact: true }).waitFor();
  assert.equal(app.controller.isLocked(), true);
  assert.equal(writes.length, beforeLockedReload);
  const stop = app.device.stop.bind(app.device);
  app.device.stop = async () => {
    await stop();
    return false;
  };
  await app.controller.emergency();
  const beforeFaultReload = writes.length;
  await page.reload();
  await page.getByText("停止未确认", { exact: true }).waitFor();
  assert.equal(app.controller.stopUnconfirmed, true);
  assert.equal(writes.length, beforeFaultReload);
  app.device.stop = stop;
  checks.push(
    "AI 授权与草稿分离，偏好与反馈恢复；暂停、运行锁定和停止未确认状态保持后台权威",
  );
  assert.deepEqual(errors, []);
  await mkdir("artifacts/editor-drafts", { recursive: true });
  await writeFile(
    "artifacts/editor-drafts/report.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(checks.join("\n"));
} finally {
  releaseStory?.();
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
