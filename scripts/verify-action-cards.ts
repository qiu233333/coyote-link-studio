/** Isolated UI acceptance. Only a temporary database, deterministic AI and simulator. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createApplication } from "../server/app.ts";
import { cardTemplate, type RoleplayPatch } from "../shared/roleplay.ts";
import { DEVICE_STATE_STALE_MS } from "../shared/executionPolicy.ts";

const directory = await mkdtemp(resolve(tmpdir(), "coyote-action-ui-"));
const artifacts = resolve("artifacts/action-cards");
await mkdir(artifacts, { recursive: true });
const app = await createApplication({ directory, startAi: false, dev: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 1800 } });
const errors: string[] = [],
  checks: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Condition timed out");
};
try {
  app.ai.status = { ready: true };
  app.store.saveSettings({
    baseUrl: "http://127.0.0.1:1",
    model: "offline-fixture",
    apiKey: "local-fixture",
  });
  await app.controller.connect({ protocol: "simulator" });
  const waves = app.controller.snapshot().waveforms;
  const bounds = {
    channels: ["A", "B"],
    waveformIds: waves.slice(0, 2).map((w) => w.id),
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 15, B: 12 },
    rampPerSecond: { A: 20, B: 20 },
    allowSync: true,
    allowRamp: true,
    allowRest: true,
  };
  const card = app.roleplay.saveCard(structuredClone(cardTemplate));
  const story = app.roleplay.create({
    cardId: card.id,
    player: { name: "旅人", identity: "探索者", relationship: "同伴" },
    scenario: "蓝灯亮起的海边小屋",
  });
  await app.roleplay.startLink(story.id, bounds, randomUUID());
  let patch: RoleplayPatch = {
    action: "update",
    channels: { A: { target: 4 }, B: { target: 3 } },
  };
  Object.assign(app.ai, {
    story: async () => ({
      narration: "窗外海风轻轻吹过。她放慢脚步，留出适应的时间。",
      dialogue: "我们按照你喜欢的节奏慢慢来。",
      replyOptions: [
        "继续慢慢变化。",
        "我想停下来看看海。",
        "先保持现在的节奏。",
      ],
      storyStateDelta: {},
      control: patch,
      controlReason: "根据你希望慢慢变化的反馈，只调整 A 通道。",
      memory: {
        recentPlot: "海边散步",
        plotBackground: "小屋",
        longPlot: "",
        longDialogue: "",
      },
    }),
  });
  const send = async () => {
    const t = app.roleplay.send(story.id, {
      text: "请慢慢变化",
      requestId: randomUUID(),
    });
    await until(() => app.roleplay.turn(story.id, t.id).status !== "pending");
    assert.equal(app.roleplay.turn(story.id, t.id).status, "completed");
  };
  await send();
  await until(
    () =>
      app.device.state.intensities.A === 4 &&
      app.device.state.intensities.B === 3,
  );
  patch = {
    action: "update",
    channels: { A: { target: 8, rampPerSecond: 0.2 } },
  };
  await send();
  const url = await app.listen(0);
  await page.goto(url);
  await page
    .getByRole("button", { name: "情景演绎", exact: false })
    .first()
    .click();
  await page.locator(".story-list-item").first().click();
  const cards = page.locator(".ai-action-card"),
    latest = cards.last();
  await latest.waitFor();
  assert.equal(await latest.getAttribute("aria-live"), "off");
  assert.equal(
    await latest.locator(".ai-action-details").getAttribute("open"),
    null,
  );
  assert.match(await latest.innerText(), /目标 4 → 8/);
  assert.match(await latest.innerText(), /目标 3 · 不变/);
  await latest.screenshot({
    path: resolve(artifacts, "desktop-collapsed.png"),
  });
  await latest.locator(".ai-action-details > summary").focus();
  await page.keyboard.press("Enter");
  assert.notEqual(
    await latest.locator(".ai-action-details").getAttribute("open"),
    null,
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".ai-action-status").item(1)?.textContent ===
      "正在渐变",
  );
  await latest.screenshot({ path: resolve(artifacts, "desktop-expanded.png") });
  assert.match(await cards.first().innerText(), /历史记录/);
  checks.push(
    "真实服务路径生成动作快照、历史隔离、默认收起、键盘展开、模拟渐变",
  );

  // Reproduce telemetry edge cases as read-only snapshots; the simulator remains isolated.
  const snapshot = app.controller.liveState.bind(app.controller);
  const baseline = structuredClone(snapshot());
  let view = structuredClone(baseline);
  app.controller.liveState = () => view;
  const publish = async () => {
    app.controller.broadcast(true);
    await page.waitForTimeout(250);
  };
  view.device.lastSeenAt = view.run!.lastAction!.at;
  await publish();
  assert.match(await latest.innerText(), /等待设备回传/);
  assert.match(await latest.innerText(), /上次回传（旧值）/);
  await latest.screenshot({ path: resolve(artifacts, "pending.png") });
  view.device.lastSeenAt = Date.now() - DEVICE_STATE_STALE_MS - 100;
  await publish();
  assert.match(await latest.innerText(), /当前状态未确认/);
  await latest.screenshot({ path: resolve(artifacts, "stale.png") });
  view = structuredClone(baseline);
  view.device.lastSeenAt = Date.now();
  view.device.intensities.A = 8;
  view.actionExecution!.evaluatedAt = Date.now();
  view.actionExecution!.channels!.A.ramping = false;
  await publish();
  assert.match(await latest.innerText(), /已到目标强度/);
  checks.push("同毫秒旧回传、过期回传、足够新回传到目标");
  view = structuredClone(baseline);
  view.device.lastSeenAt = Date.now();
  view.actionExecution!.evaluatedAt = Date.now();
  await publish();
  await page.setViewportSize({ width: 390, height: 1000 });
  await latest.scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 390, height: 2000 });
  await latest.screenshot({ path: resolve(artifacts, "mobile-expanded.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.equal(
    await latest.evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
  );
  await latest.locator(".ai-action-details > summary").click();
  await latest.screenshot({ path: resolve(artifacts, "mobile-collapsed.png") });
  checks.push("390px 展开和收起无水平溢出");
  app.controller.liveState = snapshot;
  patch = { action: "rest", channels: ["A"] };
  await send();
  await until(() => app.device.state.intensities.A === 0);
  await page.waitForFunction(
    () => document.querySelector(".ai-action-card:last-of-type") !== null,
  );
  await page.waitForTimeout(1200);
  assert.match(await cards.last().innerText(), /A 归零已确认/);
  await cards
    .last()
    .screenshot({ path: resolve(artifacts, "single-channel-rest.png") });
  patch = { action: "keep" };
  await send();
  await page.waitForTimeout(1200);
  assert.match(await cards.last().innerText(), /沿用当前节奏/);
  await cards.last().locator(".ai-action-details > summary").click();
  assert.match(await cards.last().innerText(), /保持零值/);
  checks.push("真实模拟设备单通道休息及保持零值");
  await app.controller.finish("stopped", "模拟验收结束");
  Object.assign(app.ai, {
    decide: async () => ({
      action: "adjust",
      channels: ["A"],
      waveformId: waves[0].id,
      intensity: { A: 8, B: 0 },
      durationSec: 60,
      reason: "模拟模式逐步调整 A",
    }),
  });
  const aiBounds = {
    ...bounds,
    allowRandom: false,
    maxActionSec: 60,
    durationSec: 300,
    decisionIntervalSec: 15,
    preference: "平稳",
    rampPerSecond: { A: 0.2, B: 1 },
  };
  await app.controller.startAi(aiBounds, randomUUID());
  await until(() => !!app.controller.run?.lastAction);
  await page.setViewportSize({ width: 1512, height: 1800 });
  await page
    .getByRole("button", { name: "AI 控制", exact: false })
    .first()
    .click();
  await page.locator(".ai-action-card").waitFor();
  await page.locator(".ai-action-card .ai-action-details > summary").click();
  await page
    .locator(".ai-action-card")
    .screenshot({ path: resolve(artifacts, "ai-control.png") });
  await app.controller.finish("stopped", "模拟验收切换");
  const id = randomUUID();
  app.store.set("plans", id, {
    id,
    version: 1,
    title: "动作卡模拟任务",
    description: "验收",
    completionCriteria: "计时",
    bounds: aiBounds,
    createdAt: Date.now(),
    stages: [
      {
        id: "stage",
        name: "平稳",
        durationSec: 180,
        gapSec: 0,
        channels: ["A"],
        waveformId: waves[0].id,
        intensity: { A: 8, B: 0 },
        startIntensity: { A: 0, B: 0 },
        behavior: "hold",
      },
    ],
  });
  await app.controller.startTask(id, randomUUID());
  await until(() => !!app.controller.run?.lastAction);
  await page
    .getByRole("button", { name: "AI 上锁任务", exact: false })
    .first()
    .click();
  await page.locator(".ai-action-card").waitFor();
  await page.locator(".ai-action-card .ai-action-details > summary").click();
  await page
    .locator(".ai-action-card")
    .screenshot({ path: resolve(artifacts, "locked-task.png") });
  checks.push("普通 AI 控制与上锁任务经模拟决策显示共用动作卡");
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(artifacts, "report.json"),
    JSON.stringify(
      {
        checks,
        errors,
        directory,
        note: "临时数据库和模拟设备，确定性 AI 桩，遥测边界通过只读状态夹具重现",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
  await app.close();
}
