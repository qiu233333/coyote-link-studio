/** Limit authorization acceptance; only an isolated app and simulator are used. */
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
  PlaybackConfig,
  TaskPlan,
} from "../shared/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = resolve(root, "artifacts", "limits");
const directory = await mkdtemp(resolve(tmpdir(), "coyote-limits-browser-"));
const steps: string[] = [];
const errors: string[] = [];
const allowedErrors: string[] = [];
const screenshots: string[] = [];
const expectedRejections = new Set<string>();
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let baseUrl = "";

async function until(
  label: string,
  predicate: () => Promise<boolean>,
  timeout = 10000,
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

/** This replaces simulator telemetry in this process; it never exposes a debug API. */
function reportDeviceLimits(A: number, B: number) {
  assert.ok(application);
  assert.equal(application.device.state.protocol, "simulator");
  application.device.state.limits = { A, B };
  application.device.state.lastSeenAt = Date.now();
  application.device.emit("state", application.device.state);
  application.controller.broadcast(true);
}

async function checkMax(input: Locator, expected: number) {
  await until(
    `播放器 max=${expected}`,
    async () => (await input.getAttribute("max")) === String(expected),
  );
}

async function expectDisabled(control: Locator, label: string) {
  await until(`${label} 禁用`, () => control.isDisabled());
}

async function expectEnabled(control: Locator, label: string) {
  await until(`${label} 可用`, async () => !(await control.isDisabled()));
}

async function capture(name: string) {
  assert.ok(page);
  const closeToast = page.getByRole("button", {
    name: "关闭提示",
    exact: true,
  });
  if (await closeToast.count()) await closeToast.click();
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
    const text = message.text();
    const path = new URL(message.location().url || baseUrl).pathname;
    if (
      /WebSocket connection.*\/ws.*failed|WebSocket is closed before the connection is established/.test(
        text,
      ) ||
      [...expectedRejections].some(
        (rejection) =>
          rejection.endsWith(` ${path}`) &&
          text.includes(rejection.split(" ")[0]),
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
  // No eve worker, real relay, external provider, persistent workspace data, or fixed port.
  application = await createApplication({
    directory,
    dev: false,
    startAi: false,
  });
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
    if (url.origin === baseUrl || url.protocol === "data:")
      await route.continue();
    else {
      errors.push(
        `禁止访问独立验收实例以外的地址：${url.origin}${url.pathname}`,
      );
      await route.abort("blockedbyclient");
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
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
  const player = page.locator(".single-player");
  const target = player.getByLabel("播放器目标强度", { exact: true });
  const playerIssue = player.getByRole("status");
  const start = player.getByRole("button", { name: "开始播放", exact: true });
  const summary = (channel: Channel) =>
    cards[channel].getByLabel(`${channel} 通道上限摘要`, { exact: true });
  const setChannels = async (channels: Channel[]) => {
    for (const channel of ["A", "B"] as Channel[]) {
      const chip = player.getByRole("button", {
        name: `通道 ${channel}`,
        exact: true,
      });
      if (
        (await chip.getAttribute("aria-pressed")) !==
        String(channels.includes(channel))
      )
        await chip.click();
    }
  };
  const checkSummary = async (
    channel: Channel,
    device: number,
    user: number,
    effective: number,
  ) => {
    await until(
      `${channel} 三种上限 ${device}/${user}/${effective}`,
      async () => {
        const text = await summary(channel).innerText();
        return (
          new RegExp(`设备上限\\s*${device}(?:\\D|$)`).test(text) &&
          new RegExp(`用户设置上限\\s*${user}(?:\\D|$)`).test(text) &&
          new RegExp(`有效上限\\s*${effective}(?:\\D|$)`).test(text)
        );
      },
    );
  };
  await checkSummary("A", 20, 0, 0);
  await checkSummary("B", 19, 0, 0);
  await page.getByText("尚未授权非零输出", { exact: false }).first().waitFor();
  await checkMax(target, 0);
  await expectDisabled(start, "未设置上限的开始按钮");
  await playerIssue
    .filter({ hasText: /用户上限为 0.*明确保存上限后播放/ })
    .waitFor();
  const fresh = await snapshot();
  assert.deepEqual(
    { A: fresh.channels.A.limit, B: fresh.channels.B.limit },
    { A: 0, B: 0 },
  );
  assert.deepEqual(fresh.device.intensities, { A: 0, B: 0 });
  assert.equal(fresh.run, null);
  await capture("unconfigured-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("unconfigured-mobile");
  await checkNoOverflow();
  await page.setViewportSize({ width: 1512, height: 1020 });
  steps.push(
    "模拟回传设备上限 20/19，用户授权仍为 0，三种上限与配置入口可见，非零播放禁用",
  );

  const waveformId = fresh.waveforms[0]?.id;
  assert.ok(waveformId);
  const forbidden: PlaybackConfig = {
    mode: "single",
    repeat: 1,
    shuffle: false,
    durationSec: 60,
    singleTargets: { A: 1, B: 1 },
    stages: [
      {
        id: randomUUID(),
        name: "未授权拒绝",
        durationSec: 60,
        gapSec: 0,
        channels: ["A", "B"],
        waveformId,
        intensity: 1,
        startIntensity: 0,
        behavior: "hold",
      },
    ],
  };
  expectedRejections.add("400 /api/console/play");
  const denied = await api("/api/console/play", {
    config: forbidden,
    requestId: randomUUID(),
  });
  assert.equal(denied.status, 400);
  assert.equal((await snapshot()).run, null);
  steps.push("绕过 UI 请求非零播放也被后端拒绝，未创建运行");

  await cards.A.getByRole("button", {
    name: "A 通道采用设备上限并保存",
    exact: true,
  }).click();
  await waitState(
    "明确采用 A 设备上限",
    (state) => state.channels.A.limit === 20 && state.channels.B.limit === 0,
  );
  const limitB = cards.B.getByLabel("B 通道强度上限", { exact: true });
  await limitB.fill("11");
  assert.equal(
    (await snapshot()).channels.B.limit,
    0,
    "输入而未保存不得扩大授权",
  );
  await expectDisabled(start, "B 尚未保存的开始按钮");
  await cards.B.getByRole("button", {
    name: "保存 B 通道上限",
    exact: true,
  }).click();
  await waitState(
    "保存较低 B 用户上限",
    (state) => state.channels.B.limit === 11,
  );
  await checkSummary("A", 20, 20, 20);
  await checkSummary("B", 19, 11, 11);
  assert.deepEqual(
    (await snapshot()).device.intensities,
    { A: 0, B: 0 },
    "保存授权本身不能启动输出",
  );
  await checkMax(target, 11);
  await target.fill("12");
  await expectDisabled(start, "目标超出双通道最低上限");
  await playerIssue.filter({ hasText: /超过所选通道有效上限 11/ }).waitFor();
  await target.fill("9");
  await expectEnabled(start, "保存上限后的开始按钮");
  await setChannels(["A"]);
  await checkMax(target, 20);
  await target.fill("15");
  await expectEnabled(start, "单选 A 使用 A 上限");
  await setChannels(["A", "B"]);
  await checkMax(target, 11);
  await expectDisabled(start, "改为双选后原超限目标禁止启动");
  await target.fill("9");
  steps.push(
    "采用 A 设备上限与显式保存较低 B 上限均不自动输出；播放器按单选/双选取有效上限",
  );

  const sync = page.getByRole("switch", { name: "A / B 同步", exact: true });
  await sync.click();
  await waitState("开启同步", (state) => state.synced);
  await setChannels(["A"]);
  await expectDisabled(start, "同步时缺少 B 通道");
  await playerIssue.filter({ hasText: /同步需要同时选择两个通道/ }).waitFor();
  await setChannels(["A", "B"]);
  await checkMax(target, 11);
  await expectEnabled(start, "同步双选且未超限");
  await sync.click();
  await waitState("关闭同步", (state) => !state.synced);
  await cards.B.getByRole("switch", { name: "B 通道", exact: true }).click();
  await waitState("关闭 B", (state) => !state.channels.B.enabled);
  await expectDisabled(start, "播放器选择已关闭 B 通道");
  await playerIssue.filter({ hasText: /B 通道未启用/ }).waitFor();
  await setChannels(["A"]);
  await checkMax(target, 20);
  await expectEnabled(start, "未同步时只选已启用 A");
  await cards.B.getByRole("switch", { name: "B 通道", exact: true }).click();
  await waitState("启用 B", (state) => state.channels.B.enabled);
  await setChannels(["A", "B"]);
  await sync.click();
  await waitState("恢复同步", (state) => state.synced);
  steps.push(
    "同步要求双通道选中且启用并取低值，禁用通道无法参与播放，单通道独立播放可用",
  );

  await player
    .getByLabel("单波形播放方式", { exact: true })
    .selectOption("timed");
  await player.getByLabel("持续时间", { exact: true }).fill("60");
  await target.fill("9");
  await start.click();
  const confirm = page.getByRole("dialog", { name: "确认开始播放" });
  const confirmStart = confirm.getByRole("button", {
    name: "确认开始",
    exact: true,
  });
  await expectEnabled(confirmStart, "有效上限内的确认按钮");
  reportDeviceLimits(20, 6);
  await expectDisabled(confirmStart, "确认弹窗打开后设备上限下降");
  assert.equal((await snapshot()).run, null);
  reportDeviceLimits(20, 19);
  await expectEnabled(confirmStart, "设备上限恢复后的确认按钮");
  await confirm.getByRole("button", { name: "返回修改", exact: true }).click();
  steps.push("确认弹窗保持实时校验，上限下降时禁止确认启动");

  for (const channel of ["A", "B"] as Channel[]) {
    const rate = cards[channel].getByLabel(`${channel} 通道变化速率`, {
      exact: true,
    });
    if (!(await rate.count()))
      await cards[channel]
        .getByRole("button", { name: /强度上限与变化速率/ })
        .click();
    await rate.fill("20");
    await cards[channel]
      .getByRole("button", {
        name: `保存 ${channel} 通道变化速率`,
        exact: true,
      })
      .click();
    await waitState(
      `${channel} 变化速率保存`,
      (state) => state.channels[channel].rampPerSecond === 20,
    );
  }
  await start.click();
  await confirmStart.click();
  await waitState(
    "明确确认后双通道非零输出",
    (state) =>
      state.run?.status === "running" &&
      state.device.intensities.A > 0 &&
      state.device.intensities.B > 0,
  );
  for (const channel of ["A", "B"] as Channel[]) {
    await expectDisabled(
      cards[channel].getByLabel(`${channel} 通道强度上限`, { exact: true }),
      `${channel} 运行中上限`,
    );
    await expectDisabled(
      cards[channel].getByLabel(`${channel} 通道变化速率`, { exact: true }),
      `${channel} 运行中速率`,
    );
    await expectDisabled(
      cards[channel].getByRole("button", {
        name: `保存 ${channel} 通道上限`,
        exact: true,
      }),
      `${channel} 运行中保存上限`,
    );
  }
  expectedRejections.add("409 /api/console/channels");
  for (const patch of [{ limit: 19 }, { rampPerSecond: 1 }]) {
    const rejected = await api(
      "/api/console/channels",
      { channels: { A: patch } },
      "PATCH",
    );
    assert.equal(rejected.status, 409);
  }
  const immutable = await snapshot();
  assert.equal(immutable.channels.A.limit, 20);
  assert.equal(immutable.channels.A.rampPerSecond, 20);
  await capture("running-desktop");
  steps.push(
    "确认后才出现模拟输出，运行期间上限/速率在 UI 禁改且后端 409 拒绝",
  );

  // Lower a future target while reported output is still below it: clamp and continue.
  // Resetting via pause/resume provides a deterministic zero start before telemetry changes.
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await waitState(
    "暂停归零",
    (state) =>
      state.run?.status === "paused" &&
      !state.stopping &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  for (const channel of ["A", "B"] as Channel[]) {
    await expectDisabled(
      cards[channel].getByLabel(`${channel} 通道强度上限`, { exact: true }),
      `${channel} 暂停中上限`,
    );
    await expectDisabled(
      cards[channel].getByLabel(`${channel} 通道变化速率`, { exact: true }),
      `${channel} 暂停中速率`,
    );
  }
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  const resumed = await waitState(
    "恢复运行后实时降低设备上限",
    (state) => state.run?.status === "running",
  );
  assert.ok(
    resumed.device.intensities.A <= 7 && resumed.device.intensities.B <= 7,
    "本场景须在当前输出仍低于新上限时上报，以单独验证未来目标动态限幅",
  );
  reportDeviceLimits(8, 7);
  await waitState(
    "同步运行按下降后的低值动态限幅",
    (state) =>
      state.run?.status === "running" &&
      state.device.intensities.A === 7 &&
      state.device.intensities.B === 7,
  );
  await checkSummary("A", 8, 20, 7);
  await checkSummary("B", 7, 11, 7);
  await checkMax(target, 7);
  const clamped = await snapshot();
  assert.deepEqual(
    { A: clamped.channels.A.limit, B: clamped.channels.B.limit },
    { A: 20, B: 11 },
    "回传下降不能改写用户授权",
  );
  await capture("lowered-limits-desktop");
  reportDeviceLimits(4, 3);
  await waitState(
    "回传输出已超新上限时故障停止并归零",
    (state) =>
      state.run?.status === "faulted" &&
      !state.stopping &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  await checkMax(target, 3);
  await expectDisabled(start, "设备上限下降后原目标不能再次启动");
  steps.push(
    "低于未来目标的设备上限动态限幅且同步取低值；低于已回传输出时故障归零，用户授权不变",
  );

  reportDeviceLimits(20, 19);
  // A local in-process AI bridge exercises actual task start/lock checks without an external provider.
  application.ai.status = { ready: true };
  application.ai.decide = async () => ({
    action: "rest",
    channels: [],
    waveformId: "",
    intensity: 0,
    durationSec: 1,
    reason: "独立上限验收 fixture，保持休息",
  });
  application.store.saveSettings({
    baseUrl: `${baseUrl}/unused-fixture`,
    model: "limits-browser-fixture",
  });
  const plan: TaskPlan = {
    id: randomUUID(),
    version: 1,
    title: "独立上限锁定验收",
    description: "模拟设备休息阶段",
    completionCriteria: "人工急停",
    createdAt: Date.now(),
    bounds: {
      channels: ["A", "B"],
      waveformIds: [waveformId],
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
      preference: "只用于本地浏览器锁定验收",
    },
    stages: [
      {
        id: randomUUID(),
        name: "休息",
        durationSec: 60,
        gapSec: 0,
        channels: ["A", "B"],
        waveformId,
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
  await waitState(
    "通过真实接口启动锁定任务",
    (state) => state.locked && state.run?.owner === "locked-task",
  );
  for (const channel of ["A", "B"] as Channel[]) {
    await expectDisabled(
      cards[channel].getByLabel(`${channel} 通道强度上限`, { exact: true }),
      `${channel} 锁定上限`,
    );
    await expectDisabled(
      cards[channel].getByLabel(`${channel} 通道变化速率`, { exact: true }),
      `${channel} 锁定速率`,
    );
  }
  await expectDisabled(sync, "锁定同步开关");
  await expectDisabled(target, "锁定播放器强度");
  await expectDisabled(start, "锁定播放器开始按钮");
  expectedRejections.add("423 /api/console/channels");
  for (const patch of [{ limit: 19 }, { rampPerSecond: 1 }]) {
    assert.equal(
      (await api("/api/console/channels", { channels: { A: patch } }, "PATCH"))
        .status,
      423,
    );
  }
  await capture("locked-desktop");
  await page.getByRole("button", { name: /^紧急停止/ }).click();
  await waitState(
    "急停解除锁定并归零",
    (state) =>
      !state.locked &&
      !state.stopping &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  steps.push(
    "真正锁定任务期间上限/速率只读且后端 423 拒绝，紧急停止正常解锁归零",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await capture("configured-mobile");
  await checkNoOverflow();
  assert.equal(
    await page.getByRole("button", { name: /^紧急停止/ }).isVisible(),
    true,
  );
  steps.push("未配置与已配置状态在 390px 窄屏均无横向溢出，紧急停止可见");
  assert.deepEqual(errors, [], "浏览器不得出现未预期页面、网络或控制台错误");
  const result = {
    ok: true,
    baseUrl,
    device: "simulator",
    steps,
    screenshots,
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
    basename(verified).startsWith("coyote-limits-browser-")
  )
    await rm(verified, { recursive: true, force: true });
}
