/** Full local UI → HTTP → controller → eve → fixture-provider acceptance. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createApplication } from "../server/app.ts";
import type { AppSnapshot, ControlBounds } from "../shared/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = resolve(root, "artifacts");
const directory = await mkdtemp(resolve(tmpdir(), "coyote-browser-"));
const fixtureKey = "local-browser-fixture-key";
const steps: string[] = [];
const errors: string[] = [];
const allowedErrors: string[] = [];
const fixtureErrors: string[] = [];
const screenshots: string[] = [];
const expectedRejections = new Set<string>();
let providerCalls = 0;
let browser: Browser | undefined;
let activePage: Page | undefined;
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
let baseUrl = "";

function modelContext(messages: { role: string; content: unknown }[]) {
  const text = messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
  const marker = "可用上下文：";
  const index = text.lastIndexOf(marker);
  const start =
    index >= 0 ? index + marker.length : text.lastIndexOf("\n{") + 1;
  return JSON.parse(text.slice(start)) as {
    bounds?: ControlBounds;
    waveforms: { id: string; name: string }[];
    device: { limits?: Record<"A" | "B", number> };
    feedback?: { role: string; text: string }[];
  };
}

const provider = createServer(async (request, response) => {
  try {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    assert.ok(!text.includes(fixtureKey), "凭证不得进入提示词");
    const body = JSON.parse(text);
    providerCalls++;
    const name = body.tools?.[0]?.function?.name;
    let input: unknown;
    if (name === "connection_probe")
      input = {
        token: JSON.stringify(body.messages).match(
          /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/,
        )?.[0],
      };
    else if (name === "submit_task_draft") {
      const context = modelContext(body.messages);
      const waveformId = context.waveforms[0]?.id;
      assert.ok(waveformId, "必须使用当前库中真实波形 ID");
      const maxIntensity = Math.min(6, context.device.limits?.A ?? 200);
      const bounds: ControlBounds = {
        channels: ["A", "B"],
        waveformIds: [waveformId],
        minIntensity: { A: 0, B: 0 },
        maxIntensity: { A: maxIntensity, B: 3 },
        rampPerSecond: { A: 2, B: 3 },
        allowSync: true,
        allowRandom: false,
        allowRamp: true,
        allowRest: true,
        maxActionSec: 10,
        durationSec: 180,
        decisionIntervalSec: 5,
        preference: "平稳渐进，按文字反馈调整",
      };
      input = {
        title: "星涟的平稳约定",
        description: "先适应，再休息。运行边界在确认后冻结，最长三分钟。",
        completionCriteria: "按阶段计时，或根据用户文字反馈确认完成。",
        bounds,
        stages: [
          {
            id: "browser-stage-adapt",
            name: "慢慢适应",
            durationSec: 90,
            gapSec: 0,
            channels: ["A", "B"],
            waveformId,
            intensity: { A: Math.min(4, maxIntensity), B: 2 },
            startIntensity: { A: 0, B: 0 },
            behavior: "hold",
          },
          {
            id: "browser-stage-rest",
            name: "留一点休息",
            durationSec: 30,
            gapSec: 0,
            channels: ["A", "B"],
            waveformId,
            intensity: { A: 0, B: 0 },
            startIntensity: { A: 0, B: 0 },
            behavior: "rest",
          },
        ],
      };
    } else if (name === "submit_decision") {
      const context = modelContext(body.messages);
      const bounds = context.bounds;
      assert.ok(bounds);
      const reduced = context.feedback?.some(
        (item) => item.role === "user" && item.text.includes("降低"),
      );
      input = {
        action: "adjust",
        channels: bounds.allowSync ? bounds.channels : [bounds.channels[0]],
        waveformId: bounds.waveformIds[0],
        intensity: {
          A: bounds.channels.includes("A")
            ? Math.max(
                bounds.minIntensity.A,
                Math.min(reduced ? 2 : 4, bounds.maxIntensity.A),
              )
            : 0,
          B:
            bounds.allowSync && bounds.channels.includes("B")
              ? Math.max(
                  bounds.minIntensity.B,
                  Math.min(reduced ? 1 : 3, bounds.maxIntensity.B),
                )
              : 0,
        },
        durationSec: Math.min(10, bounds.maxActionSec),
        reason: reduced
          ? "收到反馈，已在确认范围内降低目标强度。"
          : "在已确认的边界内，保持平稳的节奏。",
        phaseComplete: false,
      };
    } else assert.ok(!name, `不应出现其他工具：${name}`);
    const message = name
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `browser-call-${providerCalls}`,
              type: "function",
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        }
      : { role: "assistant", content: "连接成功" };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `browser-fixture-${providerCalls}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          { index: 0, message, finish_reason: name ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      }),
    );
  } catch (error) {
    fixtureErrors.push(error instanceof Error ? error.message : String(error));
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "本地验收提供商收到不符合预期的请求" },
      }),
    );
  }
});

async function api(page: Page, path: string, body?: unknown, method = "POST") {
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

async function snapshot(page: Page): Promise<AppSnapshot> {
  const response = await api(page, "/api/state", undefined, "GET");
  assert.equal(response.ok, true);
  return response.data;
}

async function waitState(
  page: Page,
  label: string,
  predicate: (state: AppSnapshot) => boolean,
  timeout = 15000,
) {
  const deadline = Date.now() + timeout;
  let state: AppSnapshot | undefined;
  while (Date.now() < deadline) {
    state = await snapshot(page);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `等待超时：${label}；run=${state?.run?.owner}/${state?.run?.status}；reason=${state?.run?.reason ?? ""}`,
  );
}

async function navigate(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "打开导航", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation", { name: "主要模块" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await page.locator("h1").filter({ hasText: name }).waitFor();
}

async function capture(page: Page, name: string) {
  const closeToast = page.getByRole("button", {
    name: "关闭提示",
    exact: true,
  });
  if (await closeToast.count()) await closeToast.click();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const path = resolve(artifacts, name);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  screenshots.push(path);
}

function watchErrors(page: Page) {
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const location = message.location().url;
    if (
      /WebSocket connection.*\/ws.*failed|WebSocket is closed before the connection is established/.test(
        text,
      ) ||
      (/423/.test(text) &&
        expectedRejections.has(new URL(location || baseUrl).pathname))
    )
      allowedErrors.push(text);
    else errors.push(`console: ${text} (${location})`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const path = new URL(response.url()).pathname;
    if (response.status() === 423 && expectedRejections.has(path))
      allowedErrors.push(`expected 423 ${path}`);
    else errors.push(`HTTP ${response.status()} ${path}`);
  });
  page.on("requestfailed", (request) => {
    const text = `${request.url()} ${request.failure()?.errorText}`;
    if (/\/ws(?:\?|\s|$)/.test(text)) allowedErrors.push(text);
    else errors.push(`requestfailed: ${text}`);
  });
}

try {
  await mkdir(artifacts, { recursive: true });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");
  const aiDirectory = resolve(directory, "eve-runtime");
  await mkdir(aiDirectory);
  application = await createApplication({ directory, aiDirectory, dev: false });
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
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(15000);
  watchErrors(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /^控制台/ }).waitFor();
  await waitState(
    page,
    "eve 运行时就绪",
    (state) => state.aiRuntime.ready,
    120000,
  );
  steps.push("本地应用与独立 eve 运行时实际启动");

  await navigate(page, "系统设置");
  await page
    .getByRole("textbox", { name: "AI Base URL" })
    .fill(`http://127.0.0.1:${providerAddress.port}/v1`);
  await page.getByLabel("AI API Key", { exact: true }).fill(fixtureKey);
  await page
    .getByRole("textbox", { name: "AI 模型名称" })
    .fill("browser-local-fixture");
  await page
    .getByRole("button", { name: "保存并测试连接", exact: true })
    .click();
  await page
    .getByText("聊天与业务工具调用均已通过实际请求测试。", { exact: true })
    .waitFor();
  const configured = await snapshot(page);
  assert.equal(configured.settings.apiKeySet, true);
  assert.ok(!JSON.stringify(configured).includes(fixtureKey));
  await page.getByLabel("AI API Key", { exact: true }).fill("");
  assert.ok(
    !(
      await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      )
    ).includes(fixtureKey),
  );
  await capture(page, "settings.png");
  steps.push("通过真实设置表单保存并测试聊天/工具能力，密钥脱敏");

  await navigate(page, "控制台");
  await page.getByRole("button", { name: "连接管理", exact: true }).click();
  const deviceDialog = page.getByRole("dialog", { name: "设备连接管理" });
  await deviceDialog
    .getByRole("button", { name: "模拟设备", exact: true })
    .click();
  await deviceDialog
    .getByRole("button", { name: "建立连接", exact: true })
    .click();
  await waitState(
    page,
    "显式连接模拟设备",
    (state) => state.device.connected && state.device.protocol === "simulator",
  );
  await deviceDialog
    .getByRole("button", { name: "关闭弹窗", exact: true })
    .click();
  const connected = await snapshot(page);
  const wave = connected.waveforms[0];
  assert.ok(wave);
  await page.getByLabel("A 通道波形", { exact: true }).selectOption(wave.id);
  await page.getByLabel("B 通道波形", { exact: true }).selectOption(wave.id);
  await page.getByLabel("A 通道目标强度", { exact: true }).fill("4");
  await page.getByLabel("B 通道目标强度", { exact: true }).fill("5");
  await waitState(
    page,
    "实时卡片目标保存但未启动",
    (state) =>
      state.channels.A.target === 4 &&
      state.channels.B.target === 5 &&
      !state.run,
  );
  assert.deepEqual((await snapshot(page)).device.intensities, { A: 0, B: 0 });
  await page.getByRole("button", { name: "实时播放控制", exact: true }).click();
  await waitState(
    page,
    "实时双通道非零输出",
    (state) =>
      state.run?.owner === "manual" &&
      state.run.mode === "live" &&
      state.run.status === "running" &&
      state.device.intensities.A === 4 &&
      state.device.intensities.B === 5,
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".intensity-value")].length === 2 &&
      [...document.querySelectorAll(".intensity-value")].every(
        (element) => Number(element.textContent) > 0,
      ),
  );
  await capture(page, "console.png");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await waitState(
    page,
    "手动停止确认归零",
    (state) =>
      state.run?.status === "stopped" &&
      !state.stopping &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  steps.push("UI 显式模拟连接，独立双通道实时目标保存，显式开始输出与停止归零");

  // Exercise the editable forms, HTTP payloads, persisted snapshots and actual
  // simulator telemetry with different A/B values, including A above B's cap.
  application.device.state.limits = { A: 20, B: 19 };
  application.device.state.lastSeenAt = Date.now();
  application.device.emit("state", application.device.state);
  application.controller.broadcast(true);
  await waitState(
    page,
    "独立设备上限回传",
    (state) => state.device.limits.A === 20 && state.device.limits.B === 19,
  );
  const consoleTab = (name: string) =>
    page
      .getByRole("navigation", { name: "控制台功能" })
      .getByRole("button", { name: new RegExp(`^${name}`) });
  const savePreset = async (name: string) => {
    await page.getByRole("button", { name: "保存预设", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "保存方案预设" });
    await dialog
      .getByRole("textbox", { name: "预设名称", exact: true })
      .fill(name);
    await dialog.getByRole("button", { name: "保存预设", exact: true }).click();
    return waitState(page, `预设${name}持久化`, (state) =>
      state.presets.some((preset) => preset.name === name),
    );
  };
  const confirmPlayback = async (buttonName: string) => {
    await page.getByRole("button", { name: buttonName, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认开始播放" });
    assert.ok(!(await dialog.innerText()).includes("[object Object]"));
    await dialog.getByRole("button", { name: "确认开始", exact: true }).click();
  };
  const stopPlayback = async () => {
    await consoleTab("实时控制").click();
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await waitState(
      page,
      "编排停止确认归零",
      (state) =>
        state.run?.status === "stopped" &&
        !state.stopping &&
        state.device.intensities.A === 0 &&
        state.device.intensities.B === 0,
    );
  };

  await consoleTab("播放列表").click();
  const playlistA = page.getByLabel("第 1 项 A 通道目标强度", { exact: true });
  const playlistB = page.getByLabel("第 1 项 B 通道目标强度", { exact: true });
  assert.equal(await playlistA.getAttribute("max"), "20");
  assert.equal(await playlistB.getAttribute("max"), "19");
  await playlistA.fill("20");
  await playlistB.fill("5");
  const listState = await savePreset("A20-B5 独立列表");
  assert.deepEqual(
    listState.presets.find((preset) => preset.name === "A20-B5 独立列表")
      ?.config.stages[0].intensity,
    { A: 20, B: 5 },
  );
  await confirmPlayback("确认并播放");
  await waitState(
    page,
    "列表 A20/B5 独立输出",
    (state) =>
      state.run?.mode === "playlist" &&
      state.device.intensities.A === 20 &&
      state.device.intensities.B === 5,
    20000,
  );
  await capture(page, "playlist-independent.png");
  await stopPlayback();
  steps.push(
    "播放列表 A20/B5 表单独立上限、预设持久化、确认及实际回传，A 不被 B19 压低",
  );

  await consoleTab("阶段编排").click();
  await page
    .getByLabel("第 1 项执行方式", { exact: true })
    .selectOption("ramp");
  await page.getByLabel("第 1 项持续时间", { exact: true }).fill("20");
  await page.getByLabel("第 1 项 A 通道目标强度", { exact: true }).fill("8");
  await page.getByLabel("第 1 项 B 通道目标强度", { exact: true }).fill("3");
  await page.getByLabel("第 1 项 A 通道起始强度", { exact: true }).fill("2");
  await page.getByLabel("第 1 项 B 通道起始强度", { exact: true }).fill("1");
  const stageState = await savePreset("A2-8 B1-3 渐变");
  const savedStage = stageState.presets.find(
    (preset) => preset.name === "A2-8 B1-3 渐变",
  )!.config.stages[0];
  assert.deepEqual(savedStage.startIntensity, { A: 2, B: 1 });
  assert.deepEqual(savedStage.intensity, { A: 8, B: 3 });
  await confirmPlayback("确认并播放");
  await waitState(
    page,
    "A/B 不同渐变输出",
    (state) =>
      state.run?.mode === "stages" &&
      state.device.intensities.A >= 3 &&
      state.device.intensities.B > 0 &&
      state.device.intensities.A > state.device.intensities.B,
  );
  await capture(page, "stages-independent.png");
  await stopPlayback();
  steps.push("阶段表单与保存预设分别保留 A2→8 / B1→3，执行产生不同渐变回传");

  await consoleTab("随机控制").click();
  await page.getByLabel("随机 A 通道最低强度", { exact: true }).fill("7");
  await page.getByLabel("随机 A 通道最高强度", { exact: true }).fill("7");
  await page.getByLabel("随机 B 通道最低强度", { exact: true }).fill("2");
  await page.getByLabel("随机 B 通道最高强度", { exact: true }).fill("2");
  await page.getByLabel("最短单次持续", { exact: true }).fill("20");
  await page.getByLabel("最长单次持续", { exact: true }).fill("20");
  await confirmPlayback("查看并确认");
  await waitState(
    page,
    "随机 A7/B2 逐路范围输出",
    (state) =>
      state.run?.mode === "random" &&
      state.device.intensities.A === 7 &&
      state.device.intensities.B === 2,
  );
  await capture(page, "random-independent.png");
  await stopPlayback();
  steps.push(
    "随机 A7 / B2 独立上下限通过 UI 确认并实际输出，各自范围没有互相覆盖",
  );

  await navigate(page, "AI 控制");
  await page.getByLabel("AI A 通道最高强度", { exact: true }).fill("6");
  await page.getByLabel("AI B 通道最高强度", { exact: true }).fill("3");
  await page.getByLabel("会话最长时间", { exact: true }).fill("180");
  await page.getByLabel("AI 决策间隔", { exact: true }).fill("5");
  await page.getByLabel("AI 单次动作最长时间", { exact: true }).fill("10");
  await page
    .getByRole("button", { name: "确认范围，交给 AI", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "确认 AI 控制范围" })
    .getByRole("button", { name: "开启 AI 控制", exact: true })
    .click();
  await waitState(
    page,
    "AI 自主决策及输出",
    (state) =>
      state.run?.owner === "ai-control" &&
      state.run.status === "running" &&
      Boolean(state.run.lastDecision) &&
      state.device.intensities.A === 4 &&
      state.device.intensities.B === 3,
  );
  await page
    .getByLabel("给 AI 的文字反馈", { exact: true })
    .fill("请降低一些，保持平稳。");
  await page.getByRole("button", { name: "发送反馈", exact: true }).click();
  await waitState(
    page,
    "反馈触发 AI 调整",
    (state) =>
      state.run?.lastDecision?.intensity.A === 2 &&
      state.run.lastDecision.intensity.B === 1 &&
      state.run.feedback.some(
        (item) => item.role === "assistant" && item.text.includes("降低"),
      ),
  );
  await capture(page, "ai-control.png");
  await page.getByRole("button", { name: "暂停控制", exact: true }).click();
  await waitState(
    page,
    "AI 暂停归零",
    (state) =>
      state.run?.status === "paused" &&
      !state.stopping &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  await page.getByLabel("AI A 通道最高强度", { exact: true }).fill("4");
  await page.getByLabel("AI B 通道最高强度", { exact: true }).fill("2");
  await page.getByLabel("会话最长时间", { exact: true }).fill("150");
  await page.getByRole("button", { name: "确认新范围", exact: true }).click();
  await waitState(
    page,
    "新范围版本确认",
    (state) =>
      state.run?.boundsVersion === 2 &&
      state.run.bounds?.maxIntensity.A === 4 &&
      state.run.bounds.maxIntensity.B === 2 &&
      state.run.status === "paused",
  );
  await page.getByRole("button", { name: "继续控制", exact: true }).click();
  await waitState(
    page,
    "恢复新版 AI 范围",
    (state) =>
      state.run?.status === "running" &&
      state.run.boundsVersion === 2 &&
      state.device.intensities.A > 0,
  );
  await page.getByRole("button", { name: "接管为手动", exact: true }).click();
  await waitState(
    page,
    "接管前归零",
    (state) =>
      state.owner === "manual" &&
      state.run?.status === "stopped" &&
      !state.stopping &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  steps.push(
    "独立 AI 控制：范围确认、自主输出、反馈调整、暂停、改范围、恢复与接管",
  );

  await navigate(page, "AI 上锁任务");
  await page
    .getByRole("textbox", { name: "任务需求", exact: true })
    .fill("先平稳适应，再留一点休息，依据我的文字反馈调整，最多三分钟。");
  await page.getByRole("button", { name: "生成任务草稿", exact: true }).click();
  await page.getByRole("textbox", { name: "任务名称", exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "任务名称", exact: true })
    .fill("星涟 · 蓝粉约定");
  await page
    .getByRole("textbox", { name: "任务说明", exact: true })
    .fill("先慢慢适应，再给自己留一点休息。最长三分钟，范围由我确认。");
  await page.getByLabel("AI A 通道最高强度", { exact: true }).fill("6");
  await page.getByLabel("AI B 通道最高强度", { exact: true }).fill("2");
  await page.getByLabel("AI A 通道强度变化速率", { exact: true }).fill("3");
  await page.getByLabel("AI B 通道强度变化速率", { exact: true }).fill("4");
  await page.getByLabel("第 1 项 A 通道目标强度", { exact: true }).fill("5");
  await page.getByLabel("第 1 项 B 通道目标强度", { exact: true }).fill("1");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await waitState(page, "草稿编辑持久化", (state) =>
    state.plans.some(
      (plan) => plan.title === "星涟 · 蓝粉约定" && plan.version >= 2,
    ),
  );
  await page.getByRole("button", { name: "进入上锁确认", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认约定并上锁" })
    .getByRole("button", { name: "确认开启并上锁", exact: true })
    .click();
  const locked = await waitState(
    page,
    "任务已锁定并有设备输出",
    (state) =>
      state.locked &&
      state.run?.owner === "locked-task" &&
      state.device.intensities.A > 0 &&
      state.device.intensities.B > 0,
  );
  assert.equal(locked.run?.plan?.title, "星涟 · 蓝粉约定");
  assert.deepEqual(locked.run?.plan?.stages[0].intensity, { A: 5, B: 1 });
  assert.deepEqual(locked.run?.bounds?.maxIntensity, { A: 6, B: 2 });
  assert.deepEqual(locked.run?.bounds?.rampPerSecond, { A: 3, B: 4 });
  assert.equal(
    await page.getByRole("button", { name: "暂停控制", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "接管为手动", exact: true }).count(),
    0,
  );
  await page
    .getByLabel("给 AI 的文字反馈", { exact: true })
    .fill("保持平稳，我会继续通过文字反馈。");
  await page.getByRole("button", { name: "发送反馈", exact: true }).click();
  await waitState(page, "锁定任务接受反馈", (state) =>
    Boolean(
      state.run?.feedback.some(
        (item) => item.role === "user" && item.text.includes("我会继续"),
      ),
    ),
  );
  await capture(page, "locked-task.png");
  await navigate(page, "控制台");
  assert.equal(
    await page
      .getByRole("button", { name: "连接管理", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.getByLabel("A 通道目标强度", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "实时播放控制", exact: true })
      .isDisabled(),
    true,
  );
  for (const path of ["/api/console/live/channels", "/api/ai-control/pause"]) {
    expectedRejections.add(path);
    const rejected = await api(
      page,
      path,
      path.endsWith("channels") ? { channels: { A: { target: 1 } } } : {},
      path.endsWith("channels") ? "PATCH" : "POST",
    );
    assert.equal(rejected.status, 423, `${path} 必须由后端拒绝`);
  }
  await navigate(page, "系统设置");
  assert.equal(
    await page.getByRole("textbox", { name: "AI Base URL" }).isDisabled(),
    true,
  );
  expectedRejections.add("/api/settings");
  const forbiddenSettings = await api(
    page,
    "/api/settings",
    { model: "forbidden" },
    "PUT",
  );
  assert.equal(forbiddenSettings.status, 423);
  await navigate(page, "AI 上锁任务");
  await page.getByRole("button", { name: /^紧急停止/ }).click();
  await waitState(
    page,
    "上锁急停、解锁及归零确认",
    (state) =>
      !state.locked &&
      state.run?.status === "stopped" &&
      !state.stopping &&
      !state.stopUnconfirmed &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  steps.push("上锁任务：生成、编辑、确认、锁定只读、后端 423、反馈及急停解锁");

  await navigate(page, "控制台");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "console-mobile.png");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 2,
  );
  assert.equal(overflow, false, "移动页面不应横向溢出");
  assert.equal(
    await page.getByRole("button", { name: /^紧急停止/ }).isVisible(),
    true,
  );
  for (const [tabName, imageName] of [
    ["播放列表", "playlist-mobile.png"],
    ["阶段编排", "stages-mobile.png"],
    ["随机控制", "random-mobile.png"],
  ]) {
    await consoleTab(tabName).click();
    if (tabName === "阶段编排")
      await page
        .getByLabel("第 1 项执行方式", { exact: true })
        .selectOption("ramp");
    await capture(page, imageName);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2,
      ),
      false,
      `${tabName}的A/B配置不应横向溢出`,
    );
  }
  await navigate(page, "AI 控制");
  await capture(page, "ai-bounds-mobile.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 2,
    ),
    false,
    "AI A/B独立范围不应横向溢出",
  );
  steps.push("390px 实时/列表/渐变/随机/AI 范围均无横向溢出，急停可见");
  assert.deepEqual(fixtureErrors, [], "模型 fixture 请求必须符合业务协议");
  assert.deepEqual(errors, [], "浏览器不得出现未预期页面、控制台或网络错误");
  const result = {
    ok: true,
    steps,
    providerCalls,
    screenshots,
    allowedErrors,
    errors,
  };
  await writeFile(
    resolve(artifacts, "browser-verification.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  if (activePage && !activePage.isClosed())
    await capture(activePage, "browser-failure.png").catch(() => {});
  const result = {
    ok: false,
    completedSteps: steps,
    error: error instanceof Error ? error.message : String(error),
    errors,
    fixtureErrors,
    allowedErrors,
    providerCalls,
    screenshots,
  };
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    resolve(artifacts, "browser-verification.json"),
    JSON.stringify(result, null, 2),
  );
  console.error(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await application?.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  // The path is generated by mkdtemp; verify it remains under the OS temp root.
  const verified = resolve(directory);
  if (
    verified.startsWith(resolve(tmpdir()) + sep) &&
    basename(verified).startsWith("coyote-browser-")
  )
    await rm(verified, { recursive: true, force: true });
}
