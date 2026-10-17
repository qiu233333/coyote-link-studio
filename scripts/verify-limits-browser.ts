/** Live control acceptance; only an isolated app and simulator are used. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { createApplication } from "../server/app.ts";
import type {
  AppSnapshot,
  Channel,
  TaskPlan,
  Waveform,
} from "../shared/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = resolve(root, "artifacts", "live");
const directory = await mkdtemp(resolve(tmpdir(), "coyote-live-browser-"));
const steps: string[] = [],
  errors: string[] = [],
  allowedErrors: string[] = [],
  screenshots: string[] = [];
const expectedRejections = new Set<string>();
const patches: unknown[] = [];
const pulses: { channel: Channel; frames: string[]; at: number }[] = [];
const mobileTargets: Partial<
  Record<Channel, { numeric: number; slider: number; saved: number }>
> = {};
let stopCalls = 0;
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let baseUrl = "";

async function until(
  label: string,
  predicate: () => Promise<boolean>,
  timeout = 15000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
}
async function api(path: string, body?: unknown, method = "POST") {
  assert.ok(page);
  return page.evaluate(
    async ({ path, body, method }) => {
      const response = await fetch(path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-coyote-request": "1",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, ...(await response.json()) };
    },
    { path, body, method },
  );
}
async function snapshot(): Promise<AppSnapshot> {
  const result = await api("/api/state", undefined, "GET");
  assert.equal(result.ok, true);
  return result.data;
}
async function waitState(
  label: string,
  predicate: (state: AppSnapshot) => boolean,
) {
  let state: AppSnapshot | undefined;
  await until(label, async () => {
    state = await snapshot();
    return predicate(state);
  });
  return state!;
}
function reportDeviceLimits(A: number, B: number) {
  assert.ok(application);
  assert.equal(application.device.state.protocol, "simulator");
  application.device.state.limits = { A, B };
  application.device.state.lastSeenAt = Date.now();
  application.device.emit("state", application.device.state);
  application.controller.broadcast(true);
}
async function navigate(name: string) {
  assert.ok(page);
  await page
    .getByRole("navigation", { name: "主要模块" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await page.locator("h1").filter({ hasText: name }).waitFor();
}
async function checkMax(input: Locator, expected: number) {
  await until(
    `目标 max=${expected}`,
    async () => (await input.getAttribute("max")) === String(expected),
  );
}
async function capture(name: string) {
  assert.ok(page);
  const toast = page.getByRole("button", { name: "关闭提示", exact: true });
  if (await toast.count()) await toast.click();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const path = resolve(artifacts, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  screenshots.push(path);
}
async function checkNoOverflow() {
  assert.ok(page);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 2,
    ),
    false,
    "390px 手机布局不能横向溢出",
  );
}
function watchErrors(target: Page) {
  target.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  target.on("response", (response) => {
    if (response.status() < 400) return;
    const rejection = `${response.status()} ${new URL(response.url()).pathname}`;
    if (expectedRejections.has(rejection))
      allowedErrors.push(`expected ${rejection}`);
    else errors.push(`HTTP ${rejection}`);
  });
  target.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text(),
      path = new URL(message.location().url || baseUrl).pathname;
    if (
      /WebSocket connection.*\/ws.*failed|WebSocket is closed before the connection is established/.test(
        text,
      ) ||
      [...expectedRejections].some(
        (r) => r.endsWith(` ${path}`) && text.includes(r.split(" ")[0]),
      )
    )
      allowedErrors.push(text);
    else errors.push(`console: ${text} (${path})`);
  });
  target.on("requestfailed", (request) => {
    const text = `${request.url()} ${request.failure()?.errorText}`;
    if (/\/ws(?:\?|\s|$)/.test(text)) allowedErrors.push(text);
    else errors.push(`requestfailed: ${text}`);
  });
}

try {
  await mkdir(artifacts, { recursive: true });
  application = await createApplication({
    directory,
    dev: false,
    startAi: false,
  });
  const sendFrames = application.device.sendFrames.bind(application.device);
  application.device.sendFrames = async (channel, frames) => {
    pulses.push({ channel, frames: [...frames], at: Date.now() });
    return sendFrames(channel, frames);
  };
  const stop = application.device.stop.bind(application.device);
  application.device.stop = async () => {
    stopCalls++;
    return stop();
  };
  baseUrl = await application.listen(0);
  assert.notEqual(new URL(baseUrl).port, "3000");
  browser = await chromium.launch({
    executablePath:
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1020 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl && url.protocol !== "data:") {
      errors.push(
        `禁止访问独立验收实例以外的地址：${url.origin}${url.pathname}`,
      );
      await route.abort("blockedbyclient");
      return;
    }
    if (
      url.pathname === "/api/console/live/channels" &&
      route.request().method() === "PATCH"
    ) {
      patches.push(route.request().postDataJSON());
      // Exercise coalescing and input stability while a preceding update is in flight.
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  watchErrors(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /^控制台/ }).waitFor();
  await page.getByRole("button", { name: "连接管理", exact: true }).click();
  const deviceDialog = page.getByRole("dialog", { name: "设备连接管理" });
  await deviceDialog
    .getByRole("button", { name: "模拟设备", exact: true })
    .click();
  await deviceDialog
    .getByRole("button", { name: "建立连接", exact: true })
    .click();
  await waitState(
    "UI 显式建立模拟连接",
    (state) => state.device.connected && state.device.protocol === "simulator",
  );
  reportDeviceLimits(20, 19);
  await deviceDialog.getByText("20 / 19", { exact: true }).waitFor();
  await deviceDialog
    .getByRole("button", { name: "关闭弹窗", exact: true })
    .click();

  const cards = {
    A: page.locator(".channel-a"),
    B: page.locator(".channel-b"),
  };
  const target = (channel: Channel) =>
    cards[channel].getByLabel(`${channel} 通道目标强度`, { exact: true });
  const slider = (channel: Channel) =>
    cards[channel].getByLabel(`${channel} 通道目标强度滑块`, { exact: true });
  const wave = (channel: Channel) =>
    cards[channel].getByLabel(`${channel} 通道波形`, { exact: true });
  const enabled = (channel: Channel) =>
    cards[channel].getByRole("switch", {
      name: `${channel} 通道`,
      exact: true,
    });
  const play = page.getByRole("button", { name: "实时播放控制", exact: true });
  const initial = await snapshot();
  assert.deepEqual(initial.device.intensities, { A: 0, B: 0 });
  assert.equal(initial.run, null);
  for (const channel of ["A", "B"] as Channel[]) {
    const limit = channel === "A" ? 20 : 19;
    await checkMax(target(channel), limit);
    await checkMax(slider(channel), limit);
    const summary = cards[channel].getByLabel(`${channel} 通道上限摘要`, {
      exact: true,
    });
    assert.match(await summary.innerText(), new RegExp(`强度上限\\s*${limit}`));
    assert.ok(
      !/用户设置|有效上限|未授权/.test(await cards[channel].innerText()),
    );
  }
  assert.equal(await page.locator(".single-player").count(), 0);
  assert.equal(
    await page.getByRole("switch", { name: "A / B 同步", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "应用", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByLabel("A 通道强度上限", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByLabel("A 通道变化速率", { exact: true }).count(),
    0,
  );
  const gridBox = await page.locator(".channel-grid").boundingBox();
  const contentBox = await page.locator(".page-content").boundingBox();
  assert.ok(
    gridBox && contentBox && gridBox.width >= contentBox.width * 0.9,
    "双卡应占满主内容宽度",
  );
  await capture("idle-desktop");
  steps.push(
    "模拟设备回传 20/19，双卡分别展示设备强度上限且占满宽度，旧播放器/同步/应用/上限速率表单已移除",
  );

  // A blank numeric draft must survive websocket state refreshes without sending zero.
  await target("A").focus();
  const beforeClear = patches.length;
  await target("A").fill("");
  await page.waitForTimeout(1100);
  assert.equal(await target("A").inputValue(), "");
  assert.equal(patches.length, beforeClear, "删除为暂空不能发送零或修改配置");
  await target("A").pressSequentially("12", { delay: 30 });
  assert.equal(
    await target("A").inputValue(),
    "12",
    "重新输入不能带多余前导 0",
  );
  await waitState(
    "A 数字输入实时保存无需应用",
    (state) => state.channels.A.target === 12,
  );
  const beforeInvalid = patches.length;
  await target("A").fill("21");
  await cards.A.getByText("请输入 0–20 之间的整数。", {
    exact: true,
  }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(
    patches.length,
    beforeInvalid,
    "超出上限的数字草稿不能发送 PATCH",
  );
  assert.equal((await snapshot()).channels.A.target, 12);
  await target("A").blur();
  assert.equal(
    await target("A").inputValue(),
    "12",
    "超限草稿失焦恢复最近已保存值",
  );
  assert.equal(
    await cards.A.locator(".error-inline").count(),
    0,
    "恢复有效值后必须清除超限提示",
  );
  await target("B").focus();
  await target("B").press("ControlOrMeta+A");
  await target("B").press("Backspace");
  assert.equal(await target("B").inputValue(), "");
  await target("B").pressSequentially("9");
  await waitState(
    "B 独立数字输入实时保存",
    (state) => state.channels.B.target === 9,
  );
  await target("B").fill("");
  await target("B").blur();
  assert.equal(await target("B").inputValue(), "9", "空值失焦恢复最近有效值");
  assert.deepEqual((await snapshot()).device.intensities, { A: 0, B: 0 });
  assert.equal((await snapshot()).run, null, "配置热保存不能自动启动");
  steps.push(
    "A/B 数字框允许清空暂存，重输无多余 0；超限草稿不 PATCH，空值/超限失焦恢复并清除提示；保存不自动输出",
  );

  const fixtures: Waveform[] = [];
  for (const [index, frame] of [
    "0A0A0A0A11111111",
    "1414141422222222",
    "1E1E1E1E33333333",
    "2828282844444444",
  ].entries()) {
    const result = await api("/api/waveforms/import", {
      content: [frame],
      name: `实时验收波形 ${index + 1}`,
    });
    assert.equal(result.ok, true);
    fixtures.push(result.data);
  }
  await wave("A").selectOption(fixtures[0].id);
  await wave("B").selectOption(fixtures[1].id);
  await waitState(
    "A/B 分别保存不同波形",
    (state) =>
      state.channels.A.waveformId === fixtures[0].id &&
      state.channels.B.waveformId === fixtures[1].id,
  );
  await cards.A.evaluate((node) => {
    (node as HTMLElement).dataset.acceptanceMount = "same-live-card";
  });
  await slider("A").scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  for (const key of ["End", "Home", ...Array<string>(6).fill("ArrowRight")])
    await slider("A").press(key);
  await waitState(
    "连续滑块输入最后值保存",
    (state) => state.channels.A.target === 6,
  );
  await page.waitForTimeout(500);
  assert.equal(await slider("A").inputValue(), "6");
  assert.equal(await target("A").inputValue(), "6");
  assert.equal(
    await cards.A.getAttribute("data-acceptance-mount"),
    "same-live-card",
    "热更新不得卸载重建卡片",
  );
  assert.ok(
    Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore) <= 2,
    "热更新不能跳动滚动位置",
  );
  await enabled("B").click();
  await waitState("启动前关闭 B", (state) => !state.channels.B.enabled);
  assert.equal((await snapshot()).run, null);
  await play.click();
  await waitState(
    "显式开始 live，仅 A 输出",
    (state) =>
      state.run?.mode === "live" &&
      state.run.status === "running" &&
      state.device.intensities.A === 6 &&
      state.device.intensities.B === 0,
  );
  await until("A 设备收到自己选择的波形", async () =>
    pulses.some(
      (p) => p.channel === "A" && p.frames.includes(fixtures[0].frames[0]),
    ),
  );
  await target("B").fill("7");
  await waitState(
    "关闭的 B 保留热配置目标但不输出",
    (state) =>
      !state.channels.B.enabled &&
      state.channels.B.target === 7 &&
      state.device.intensities.B === 0,
  );
  await enabled("B").click();
  await waitState(
    "运行中启用 B 自动采用此前保存的目标",
    (state) =>
      state.channels.B.enabled &&
      state.device.intensities.A === 6 &&
      state.device.intensities.B === 7,
  );
  await target("B").fill("4");
  await waitState(
    "运行中启用 B 后加入输出",
    (state) =>
      state.channels.B.enabled &&
      state.device.intensities.A === 6 &&
      state.device.intensities.B === 4,
  );
  await until("B 独立波形输出", async () =>
    pulses.some(
      (p) => p.channel === "B" && p.frames.includes(fixtures[1].frames[0]),
    ),
  );
  const changedAt = Date.now();
  await wave("A").selectOption(fixtures[2].id);
  await wave("B").selectOption(fixtures[3].id);
  await target("A").fill("7");
  await target("B").fill("5");
  await waitState(
    "A/B 运行中独立目标热更新",
    (state) =>
      state.device.intensities.A === 7 && state.device.intensities.B === 5,
  );
  await until("运行中 A/B 新波形实际进入设备帧", async () =>
    (["A", "B"] as Channel[]).every((channel, index) =>
      pulses.some(
        (p) =>
          p.at >= changedAt &&
          p.channel === channel &&
          p.frames.includes(fixtures[index + 2].frames[0]),
      ),
    ),
  );
  await capture("running-desktop");
  steps.push(
    "连续滑块保存最终值且卡片/滚动不跳；显式开始后独立 A/B 强度和波形实际输出，运行中可新启用 B 并热改两通道",
  );

  const beforePauseStops = stopCalls;
  await target("A").fill("8");
  assert.equal(
    await play.isDisabled(),
    false,
    "热更新 PATCH 尚未返回时仍应可立即暂停",
  );
  assert.equal(
    await page.getByRole("button", { name: "停止", exact: true }).isDisabled(),
    false,
    "热更新 PATCH 尚未返回时仍应可立即停止",
  );
  await play.click();
  await waitState(
    "暂停清帧归零",
    (state) =>
      state.run?.status === "paused" &&
      !state.stopping &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  assert.ok(stopCalls > beforePauseStops, "暂停必须调用设备 stop 清理队列");
  await waitState(
    "暂停不丢失在途热更新最后值",
    (state) => state.channels.A.target === 8,
  );
  const pausedPulses = pulses.length;
  await enabled("B").click();
  await target("A").fill("8");
  await target("B").fill("3");
  await wave("A").selectOption(fixtures[0].id);
  await waitState(
    "暂停时配置只写不输出",
    (state) =>
      state.channels.A.target === 8 &&
      state.channels.B.target === 3 &&
      !state.channels.B.enabled &&
      state.channels.A.waveformId === fixtures[0].id,
  );
  await enabled("B").click();
  await waitState(
    "暂停中重新启用 B 仍不输出",
    (state) => state.channels.B.enabled && state.device.intensities.B === 0,
  );
  await page.waitForTimeout(700);
  assert.equal(pulses.length, pausedPulses, "暂停不能继续发送波形");
  assert.deepEqual((await snapshot()).device.intensities, { A: 0, B: 0 });
  await play.click();
  await waitState(
    "继续播放采用暂停中修改的配置",
    (state) =>
      state.run?.status === "running" &&
      state.device.intensities.A === 8 &&
      state.device.intensities.B === 3,
  );
  await until("恢复采用暂停中更新的 A 波形", async () =>
    pulses
      .slice(pausedPulses)
      .some(
        (p) => p.channel === "A" && p.frames.includes(fixtures[0].frames[0]),
      ),
  );
  steps.push(
    "暂停调用设备清帧归零，暂停期间热配置不输出，继续播放使用最新独立配置",
  );

  // A ceiling below a future target must clamp live configuration without raising authorization.
  await play.click();
  await waitState(
    "降限准备暂停归零",
    (state) => state.run?.status === "paused" && !state.stopping,
  );
  await target("A").fill("12");
  await target("B").fill("10");
  await waitState(
    "降限前分别保存 12/10",
    (state) => state.channels.A.target === 12 && state.channels.B.target === 10,
  );
  await play.click();
  await waitState(
    "降限前 live 已恢复",
    (state) => state.run?.status === "running",
  );
  reportDeviceLimits(9, 7);
  await checkMax(target("A"), 9);
  await checkMax(target("B"), 7);
  await checkMax(slider("A"), 9);
  await checkMax(slider("B"), 7);
  await waitState(
    "设备降限后目标与输出按独立上限限幅",
    (state) =>
      state.channels.A.target === 9 &&
      state.channels.B.target === 7 &&
      state.device.intensities.A === 9 &&
      state.device.intensities.B === 7 &&
      state.run?.status === "running",
  );
  assert.equal(await target("A").inputValue(), "9");
  assert.equal(await target("B").inputValue(), "7");
  await capture("lowered-limits-desktop");
  reportDeviceLimits(4, 3);
  await waitState(
    "当前回传超过下降上限时停止归零",
    (state) =>
      state.run?.status === "faulted" &&
      !state.stopping &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  await checkMax(target("A"), 4);
  await checkMax(target("B"), 3);
  steps.push(
    "设备 20/19 动态下降时数字框/滑块与目标立即独立限幅；低于已回传输出的下降触发故障归零",
  );

  reportDeviceLimits(20, 19);
  application.ai.status = { ready: true };
  application.ai.decide = async () => ({
    action: "rest",
    channels: [],
    waveformId: "",
    intensity: 0,
    durationSec: 1,
    reason: "独立 live 浏览器验收 fixture",
  });
  application.store.saveSettings({
    baseUrl: `${baseUrl}/unused-fixture`,
    model: "live-browser-fixture",
  });
  const bounds = {
    channels: ["A", "B"] as Channel[],
    waveformIds: fixtures.map((f) => f.id),
    minIntensity: 0,
    maxIntensity: 6,
    rampPerSecond: 2,
    allowSync: true,
    allowRandom: false,
    allowRamp: false,
    allowRest: true,
    maxActionSec: 10,
    durationSec: 60,
    decisionIntervalSec: 15,
    preference: "只用于独立验收",
  };
  assert.equal(
    (await api("/api/ai-control/start", { bounds, requestId: randomUUID() }))
      .ok,
    true,
  );
  await waitState(
    "AI 持有互斥控制权",
    (state) =>
      state.run?.owner === "ai-control" && state.run.status === "running",
  );
  await until("AI 控制时 live 只读", () => target("A").isDisabled());
  expectedRejections.add("409 /api/console/live/channels");
  expectedRejections.add("409 /api/console/live/start");
  assert.equal(
    (
      await api(
        "/api/console/live/channels",
        { channels: { A: { target: 1 } } },
        "PATCH",
      )
    ).status,
    409,
  );
  assert.equal(
    (await api("/api/console/live/start", { requestId: randomUUID() })).status,
    409,
  );
  assert.equal((await api("/api/ai-control/stop", {})).ok, true);
  const plan: TaskPlan = {
    id: randomUUID(),
    version: 1,
    title: "独立 live 锁定验收",
    description: "模拟设备休息",
    completionCriteria: "人工急停",
    createdAt: Date.now(),
    bounds,
    stages: [
      {
        id: randomUUID(),
        name: "休息",
        durationSec: 60,
        gapSec: 0,
        channels: ["A", "B"],
        waveformId: fixtures[0].id,
        intensity: 0,
        startIntensity: 0,
        behavior: "rest",
      },
    ],
  };
  application.store.set("plans", plan.id, plan);
  assert.equal(
    (
      await api(`/api/locked-tasks/${plan.id}/start`, {
        requestId: randomUUID(),
      })
    ).ok,
    true,
  );
  await waitState("真实接口启动锁定任务", (state) => state.locked);
  for (const channel of ["A", "B"] as Channel[]) {
    await until(`${channel} 锁定目标只读`, () => target(channel).isDisabled());
    assert.equal(await wave(channel).isDisabled(), true);
    assert.equal(await enabled(channel).isDisabled(), true);
  }
  assert.equal(await play.isDisabled(), true);
  expectedRejections.add("423 /api/console/live/channels");
  expectedRejections.add("423 /api/console/live/start");
  assert.equal(
    (
      await api(
        "/api/console/live/channels",
        { channels: { B: { enabled: false } } },
        "PATCH",
      )
    ).status,
    423,
  );
  assert.equal(
    (await api("/api/console/live/start", { requestId: randomUUID() })).status,
    423,
  );
  await capture("locked-desktop");
  await page.getByRole("button", { name: /^紧急停止/ }).click();
  await waitState(
    "急停解锁归零",
    (state) =>
      !state.locked &&
      !state.stopping &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  steps.push(
    "AI 控制与 live 互斥，锁定期间目标/波形/启用/播放只读，后端分别 409/423 拒绝，急停解锁",
  );

  await navigate("系统设置");
  for (const [label, value] of [
    ["模型上下文窗口", "4096"],
    ["AI 请求超时", "15"],
  ]) {
    const input = page.getByLabel(label, { exact: true });
    await input.fill("");
    assert.equal(await input.inputValue(), "");
    await input.pressSequentially(value);
    assert.equal(await input.inputValue(), value);
  }
  await navigate("控制台");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileState = await snapshot();
  for (const channel of ["A", "B"] as Channel[]) {
    const numeric = Number(await target(channel).inputValue());
    const range = Number(await slider(channel).inputValue());
    const saved = mobileState.channels[channel].target;
    assert.equal(numeric, saved, `${channel} 手机数字目标应与后端配置一致`);
    assert.equal(range, saved, `${channel} 手机滑块目标应与后端配置一致`);
    mobileTargets[channel] = { numeric, slider: range, saved };
  }
  await capture("mobile");
  await checkNoOverflow();
  assert.equal(await play.isVisible(), true);
  assert.equal(
    await page.getByRole("button", { name: /^紧急停止/ }).isVisible(),
    true,
  );
  steps.push(
    "多个页面的数字框可全删重输且无多余 0，390px 窄屏无溢出，播放控制与急停可见",
  );
  assert.deepEqual(errors, [], "不得出现未预期页面/控制台/网络错误");
  const result = {
    ok: true,
    baseUrl,
    device: "simulator",
    steps,
    screenshots,
    patchCount: patches.length,
    pulseCount: pulses.length,
    stopCalls,
    mobileTargets,
    allowedErrors,
    errors,
  };
  await writeFile(
    resolve(artifacts, "verification.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  if (page && !page.isClosed()) await capture("failure").catch(() => {});
  const result = {
    ok: false,
    baseUrl,
    completedSteps: steps,
    error: error instanceof Error ? error.stack : String(error),
    errors,
    allowedErrors,
    screenshots,
    patchCount: patches.length,
    pulseCount: pulses.length,
    stopCalls,
  };
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    resolve(artifacts, "verification.json"),
    JSON.stringify(result, null, 2),
  );
  console.error(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await application?.close();
  const verified = resolve(directory);
  if (
    verified.startsWith(resolve(tmpdir()) + sep) &&
    basename(verified).startsWith("coyote-live-browser-")
  )
    await rm(verified, { recursive: true, force: true });
}
