/** Isolated draft-scaling acceptance: temporary store, local model and simulator. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createApplication } from "../server/app.ts";
import type {
  AppSnapshot,
  Channel,
  ControlBounds,
  PlaybackConfig,
  Stage,
  TaskPlan,
} from "../shared/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = resolve(root, "artifacts", "intensity-scaling");
const directory = await mkdtemp(resolve(tmpdir(), "coyote-scaling-browser-"));
const fixtureKey = "isolated-scaling-fixture-key";
const steps: string[] = [],
  errors: string[] = [],
  allowedErrors: string[] = [];
const fixtureErrors: string[] = [],
  screenshots: string[] = [];
const outputWrites: unknown[] = [],
  requests: string[] = [];
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
let browser: Browser | undefined, page: Page | undefined;
let baseUrl = "",
  providerCalls = 0,
  draftCalls = 0,
  decisionCalls = 0,
  fixtureStages: Stage[] = [];
let fixtureBounds: ControlBounds;

const provider = createServer(async (request, response) => {
  try {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    assert.ok(!text.includes(fixtureKey), "本地凭证不得进入提示词");
    const body = JSON.parse(text);
    const name = body.tools?.[0]?.function?.name;
    assert.ok(
      name === "submit_task_draft" || name === "submit_decision",
      "本专项只允许草稿生成和锁定后决策请求",
    );
    providerCalls++;
    if (name === "submit_task_draft") draftCalls++;
    else decisionCalls++;
    const input =
      name === "submit_task_draft"
        ? {
            title: "倍率验收 AI 原始草稿",
            description: "临时双通道草稿，仅供模拟设备验收。",
            completionCriteria: "阶段计时完成或人工急停。",
            bounds: fixtureBounds,
            stages: fixtureStages,
          }
        : {
            action: "rest",
            channels: fixtureBounds.channels,
            waveformId: fixtureBounds.waveformIds[0],
            intensity: { A: 0, B: 0 },
            durationSec: 10,
            reason: "本地模型桩在已确认边界内安排归零休息。",
            phaseComplete: false,
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `scaling-fixture-${providerCalls}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `scaling-call-${providerCalls}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(input) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      }),
    );
  } catch (error) {
    fixtureErrors.push(error instanceof Error ? error.message : String(error));
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: { message: "本地倍率模型桩请求不符合预期" } }),
    );
  }
});

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
  timeout = 15000,
) {
  let state: AppSnapshot | undefined;
  await until(
    label,
    async () => {
      state = await snapshot();
      return predicate(state);
    },
    timeout,
  );
  return state!;
}
async function navigate(name: string) {
  assert.ok(page);
  const menu = page.getByRole("button", { name: "打开导航", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation", { name: "主要模块" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await page.locator("h1").filter({ hasText: name }).waitFor();
}
async function consoleStages() {
  assert.ok(page);
  await navigate("控制台");
  await page
    .getByRole("navigation", { name: "控制台功能" })
    .getByRole("button", { name: /^阶段编排/ })
    .click();
}
function reportLimits(A: number, B: number) {
  assert.ok(application);
  assert.equal(application.device.state.protocol, "simulator");
  application.device.state.limits = { A, B };
  application.device.state.lastSeenAt = Date.now();
  application.device.emit("state", application.device.state);
  application.controller.broadcast(true);
}
const number = (channel: Channel) =>
  page!.getByLabel(`${channel} 通道全局强度倍率`, { exact: true });
const slider = (channel: Channel) =>
  page!.getByLabel(`${channel} 通道全局强度倍率滑块`, { exact: true });
const target = (index: number, channel: Channel) =>
  page!.getByLabel(`第 ${index} 项 ${channel} 通道目标强度`, { exact: true });
const start = (index: number, channel: Channel) =>
  page!.getByLabel(`第 ${index} 项 ${channel} 通道起始强度`, { exact: true });
async function scale(channel: Channel, value: number) {
  await number(channel).fill(String(value));
  await number(channel).blur();
  await until(
    `${channel} 数字框与滑块同步为 ${value}`,
    async () =>
      Number(await number(channel).inputValue()) === value &&
      Number(await slider(channel).inputValue()) === value,
  );
}
async function multipliers(A = 1, B = 1) {
  for (const channel of ["A", "B"] as Channel[]) {
    const expected = channel === "A" ? A : B;
    assert.equal(
      Number(await number(channel).inputValue()),
      expected,
      `${channel} 倍率`,
    );
    assert.equal(
      Number(await slider(channel).inputValue()),
      expected,
      `${channel} 滑块`,
    );
  }
}
async function values(A: [number, number], B: [number, number], index = 1) {
  await until(
    `第 ${index} 阶段 ${A.join("→")}/${B.join("→")}`,
    async () =>
      Number(await start(index, "A").inputValue()) === A[0] &&
      Number(await target(index, "A").inputValue()) === A[1] &&
      Number(await start(index, "B").inputValue()) === B[0] &&
      Number(await target(index, "B").inputValue()) === B[1],
  );
}
async function zeroStages() {
  await values([0, 0], [0, 0], 2);
  for (const channel of ["A", "B"] as Channel[])
    assert.equal(
      await target(3, channel).inputValue(),
      "0",
      "休息阶段保持归零",
    );
}
async function capture(name: string) {
  assert.ok(page);
  await page
    .getByRole("button", { name: "关闭提示", exact: true })
    .evaluateAll((nodes) =>
      nodes.forEach((node) => (node as HTMLButtonElement).click()),
    );
  const path = resolve(artifacts, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  screenshots.push(path);
}
async function idleUnchanged(writes: number) {
  const state = await snapshot();
  assert.ok(
    !state.run || !["running", "paused"].includes(state.run.status),
    "编辑草稿不得自动开始",
  );
  assert.deepEqual(state.device.intensities, { A: 0, B: 0 });
  assert.equal(
    outputWrites.length,
    writes,
    "草稿编辑、保存和载入不得发送设备命令",
  );
}
function withoutIds(stages: Stage[]) {
  return stages.map(({ id: _id, ...stage }) => stage);
}

type Editor = {
  name: string;
  load: () => Promise<void>;
  save: (suffix: string) => Promise<Stage[]>;
  saveButton: () => ReturnType<Page["getByRole"]>;
  confirmButton: () => ReturnType<Page["getByRole"]>;
  issue: RegExp;
};

async function exercise(editor: Editor) {
  assert.ok(page);
  const writes = outputWrites.length;
  await editor.load();
  await page
    .getByRole("heading", { name: "全局强度倍率", exact: true })
    .waitFor();
  await multipliers();
  for (const channel of ["A", "B"] as Channel[]) {
    for (const input of [number(channel), slider(channel)]) {
      assert.equal(await input.getAttribute("min"), "0.1");
      assert.equal(await input.getAttribute("max"), "10");
      assert.equal(await input.getAttribute("step"), "0.1");
    }
  }
  await scale("A", 0.5);
  await values([2, 4], [2, 5]);
  await scale("A", 2);
  await values([6, 14], [2, 5]);
  await scale("A", 1);
  await values([3, 7], [2, 5]);
  await scale("B", 0.5);
  await values([3, 7], [1, 3]);
  await scale("B", 2);
  await values([3, 7], [4, 10]);
  await scale("B", 1);
  await values([3, 7], [2, 5]);
  await zeroStages();
  await scale("A", 0.1);
  await values([0, 1], [2, 5]);
  await slider("A").press("End");
  await multipliers(10, 1);
  await values([30, 70], [2, 5]);
  assert.equal(await editor.saveButton().isDisabled(), true, "A 超限禁止保存");
  assert.equal(
    await editor.confirmButton().isDisabled(),
    true,
    "A 超限禁止确认/播放",
  );
  await page
    .getByRole("status")
    .filter({ hasText: editor.issue })
    .first()
    .waitFor();
  await scale("A", 1);
  await scale("B", 10);
  await values([3, 7], [20, 50]);
  assert.equal(
    await editor.saveButton().isDisabled(),
    true,
    "B 独立超限禁止保存",
  );
  assert.equal(
    await editor.confirmButton().isDisabled(),
    true,
    "B 独立超限禁止确认/播放",
  );
  await scale("B", 1);
  for (const invalid of ["0", "10.1", ""]) {
    await number("A").fill(invalid);
    await page
      .getByRole("alert")
      .filter({ hasText: /0\.1.*10/ })
      .first()
      .waitFor();
    assert.equal(
      await editor.saveButton().isDisabled(),
      true,
      "非法倍率禁止保存",
    );
    assert.equal(
      await editor.confirmButton().isDisabled(),
      true,
      "非法倍率禁止确认/播放",
    );
    await values([3, 7], [2, 5]);
    await scale("A", 1);
  }
  await scale("A", 0.5);
  await scale("B", 2);
  const saved = await editor.save("缩放后保存");
  const expected = structuredClone(fixtureStages);
  expected[0].startIntensity = { A: 2, B: 4 };
  expected[0].intensity = { A: 4, B: 10 };
  assert.deepEqual(
    withoutIds(saved),
    withoutIds(expected),
    "缩放同时保留时长、间隔、波形、通道和休息",
  );
  await multipliers(0.5, 2);
  await idleUnchanged(writes);
  steps.push(
    `${editor.name}：A/B 独立同时缩放起点和目标；零值/休息不变；0.5→2→1 无累计取整；0.1–10 边界与非法倍率/超限阻止动作`,
  );

  await editor.load();
  await multipliers();
  await values([3, 7], [2, 5]);
  await scale("A", 0.5);
  await scale("B", 2);
  await target(1, "A").fill("6");
  await target(1, "A").blur();
  await multipliers();
  await values([2, 6], [4, 10]);
  await scale("A", 2);
  await values([4, 12], [4, 10]);
  await page.getByRole("button", { name: "恢复 1 倍", exact: true }).click();
  await multipliers();
  await values([2, 6], [4, 10]);
  await scale("A", 0.5);
  await scale("B", 0.5);
  await page.getByRole("button", { name: "复制第 1 项", exact: true }).click();
  await multipliers();
  await values([1, 3], [2, 5]);
  await values([1, 3], [2, 5], 2);
  await scale("A", 2);
  await values([2, 6], [2, 5]);
  await values([2, 6], [2, 5], 2);
  await page.getByRole("button", { name: "删除第 2 项", exact: true }).click();
  await multipliers();
  await values([2, 6], [2, 5]);
  await scale("A", 2);
  await page.getByRole("button", { name: "添加阶段", exact: true }).click();
  await multipliers();
  await values([4, 12], [2, 5]);
  await page
    .getByLabel("第 4 项执行方式", { exact: true })
    .selectOption("ramp");
  await target(4, "A").fill("4");
  await target(4, "A").blur();
  await scale("A", 0.5);
  await values([2, 6], [2, 5]);
  await values([0, 2], [0, 5], 4);
  await page.getByRole("button", { name: "恢复 1 倍", exact: true }).click();
  await values([4, 12], [2, 5]);
  await values([0, 4], [0, 5], 4);
  const operationsSaved = await editor.save("阶段操作");
  assert.equal(operationsSaved.length, 4);
  assert.deepEqual(operationsSaved[1].intensity, { A: 0, B: 0 });
  assert.deepEqual(operationsSaved[2].intensity, { A: 0, B: 0 });
  await idleUnchanged(writes);
  steps.push(
    `${editor.name}：手动强度编辑、复制、删除、添加后双方倍率回 1；现值成为基准，新增阶段参与后续缩放，重置恢复当前基准`,
  );

  await editor.load();
  await scale("A", 0.5);
  await scale("B", 0.5);
  await start(1, "B").fill("2");
  await start(1, "B").blur();
  await multipliers();
  await values([2, 4], [2, 3]);
  await scale("A", 2);
  await values([4, 8], [2, 3]);
  await page.getByRole("button", { name: "恢复 1 倍", exact: true }).click();
  await values([2, 4], [2, 3]);
  await editor.load();
  await target(1, "A").fill("3");
  await target(1, "A").blur();
  await target(1, "B").fill("4");
  await target(1, "B").blur();
  await scale("A", 0.1);
  await scale("B", 0.1);
  await values([0, 0], [0, 0]);
  await page
    .getByLabel("第 1 项执行方式", { exact: true })
    .selectOption("rest");
  await multipliers();
  await page
    .getByLabel("第 1 项执行方式", { exact: true })
    .selectOption("ramp");
  await page.getByRole("button", { name: "恢复 1 倍", exact: true }).click();
  await multipliers();
  await values([0, 0], [0, 0]);
  await idleUnchanged(writes);
  steps.push(
    `${editor.name}：手改起始强度建立新基准；取整后全零阶段切为休息再切回渐变，恢复 1 倍不会复活旧强度`,
  );

  await editor.load();
  await page.setViewportSize({ width: 375, height: 812 });
  for (const channel of ["A", "B"] as Channel[]) {
    await slider(channel).scrollIntoViewIfNeeded();
    const box = await slider(channel).boundingBox();
    assert.ok(
      box && box.width >= 80 && box.x >= 0 && box.x + box.width <= 376,
      "375px 滑块可操作且在屏幕内",
    );
    await slider(channel).press("Home");
    assert.equal(Number(await number(channel).inputValue()), 0.1);
    await number(channel).fill("1.5");
    await number(channel).blur();
    assert.equal(Number(await slider(channel).inputValue()), 1.5);
    const numericBox = await number(channel).boundingBox();
    assert.ok(
      numericBox &&
        numericBox.width >= 45 &&
        numericBox.x >= 0 &&
        numericBox.x + numericBox.width <= 376,
      "375px 数值框可操作且在屏幕内",
    );
    await scale(channel, 1);
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 2,
    ),
    false,
    "375px 页面无横向溢出",
  );
  await values([3, 7], [2, 5]);
  await capture(`${editor.name}-375px`);
  await page.setViewportSize({ width: 1512, height: 1020 });
  await idleUnchanged(writes);
  steps.push(
    `${editor.name}：375px 双通道滑块键盘与数值输入同步可用，页面无横向溢出`,
  );
}

try {
  await mkdir(artifacts, { recursive: true });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const aiDirectory = resolve(directory, "eve-runtime");
  await mkdir(aiDirectory);
  application = await createApplication({ directory, aiDirectory, dev: false });
  for (const method of ["setIntensity", "sendFrames"] as const) {
    if (method === "setIntensity") {
      const original = application.device.setIntensity.bind(application.device);
      application.device.setIntensity = async (channel, value) => {
        outputWrites.push({ channel, value });
        return original(channel, value);
      };
    } else {
      const original = application.device.sendFrames.bind(application.device);
      application.device.sendFrames = async (channel, frames) => {
        outputWrites.push({ channel, frames: [...frames] });
        return original(channel, frames);
      };
    }
  }
  baseUrl = await application.listen(0);
  assert.notEqual(new URL(baseUrl).port, "3000");
  browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
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
      errors.push(`禁止访问独立验收实例之外：${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (!["GET", "HEAD"].includes(route.request().method()))
      requests.push(`${route.request().method()} ${url.pathname}`);
    await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      /WebSocket connection.*\/ws.*failed|WebSocket is closed before the connection is established/.test(
        message.text(),
      )
    )
      allowedErrors.push(message.text());
    else errors.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(
        `HTTP ${response.status()} ${new URL(response.url()).pathname}`,
      );
  });
  page.on("requestfailed", (request) => {
    const message = `${request.url()} ${request.failure()?.errorText}`;
    if (/\/ws(?:\?|\s|$)/.test(message)) allowedErrors.push(message);
    else errors.push(`requestfailed: ${message}`);
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await waitState(
    "独立 eve 运行时就绪",
    (state) => state.aiRuntime.ready,
    120000,
  );
  assert.equal(
    (
      await api(
        "/api/settings",
        {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: fixtureKey,
          model: "local-scaling-fixture",
        },
        "PUT",
      )
    ).ok,
    true,
  );
  await page.getByRole("button", { name: "连接管理", exact: true }).click();
  const connection = page.getByRole("dialog", { name: "设备连接管理" });
  await connection
    .getByRole("button", { name: "模拟设备", exact: true })
    .click();
  await connection
    .getByRole("button", { name: "建立连接", exact: true })
    .click();
  await waitState(
    "显式模拟连接",
    (state) => state.device.connected && state.device.protocol === "simulator",
  );
  await connection
    .getByRole("button", { name: "关闭弹窗", exact: true })
    .click();
  reportLimits(20, 12);
  const state = await snapshot(),
    wave = state.waveforms[0],
    waveB = state.waveforms[1] || wave;
  fixtureStages = [
    {
      id: "scaling-ramp",
      name: "非整半数渐变",
      durationSec: 45,
      gapSec: 2,
      channels: ["A", "B"],
      waveformId: wave.id,
      waveformBId: waveB.id,
      intensity: { A: 7, B: 5 },
      startIntensity: { A: 3, B: 2 },
      behavior: "ramp",
    },
    {
      id: "scaling-zero",
      name: "零强度渐变",
      durationSec: 15,
      gapSec: 0,
      channels: ["A", "B"],
      waveformId: wave.id,
      intensity: { A: 0, B: 0 },
      startIntensity: { A: 0, B: 0 },
      behavior: "ramp",
    },
    {
      id: "scaling-rest",
      name: "归零休息",
      durationSec: 15,
      gapSec: 0,
      channels: ["A", "B"],
      waveformId: wave.id,
      intensity: { A: 0, B: 0 },
      startIntensity: { A: 0, B: 0 },
      behavior: "rest",
    },
  ];
  fixtureBounds = {
    channels: ["A", "B"],
    waveformIds: [...new Set([wave.id, waveB.id])],
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 16, B: 10 },
    rampPerSecond: { A: 2, B: 3 },
    allowSync: true,
    allowRandom: false,
    allowRamp: true,
    allowRest: true,
    maxActionSec: 10,
    durationSec: 180,
    decisionIntervalSec: 5,
    preference: "只用于隔离倍率验证",
  };
  const fixtureConfig: PlaybackConfig = {
    mode: "stages",
    stages: fixtureStages,
    repeat: 1,
    shuffle: false,
    durationSec: 180,
  };
  assert.equal(
    (
      await api("/api/presets", {
        name: "倍率验收控制台原始预设",
        config: fixtureConfig,
      })
    ).ok,
    true,
  );
  let savedPresetName = "",
    savedPlan: TaskPlan | undefined;
  const loadPreset = async (name: string) => {
    await page!.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  };
  const consoleEditor: Editor = {
    name: "console",
    load: async () => {
      await consoleStages();
      await loadPreset("倍率验收控制台原始预设");
    },
    saveButton: () =>
      page!.getByRole("button", { name: "保存预设", exact: true }),
    confirmButton: () =>
      page!.getByRole("button", { name: "确认并播放", exact: true }),
    issue: /通道.*(上限|强度须)/,
    save: async (suffix) => {
      savedPresetName = `倍率验收控制台-${suffix}`;
      await page!
        .getByRole("button", { name: "保存预设", exact: true })
        .click();
      const modal = page!.getByRole("dialog", { name: "保存方案预设" });
      await modal
        .getByRole("textbox", { name: "预设名称", exact: true })
        .fill(savedPresetName);
      await modal
        .getByRole("button", { name: "保存预设", exact: true })
        .click();
      const saved = await waitState("缩放预设保存", (state) =>
        state.presets.some((preset) => preset.name === savedPresetName),
      );
      const config = saved.presets.find(
        (preset) => preset.name === savedPresetName,
      )!.config;
      assert.deepEqual(
        Object.keys(config).sort(),
        Object.keys(fixtureConfig).sort(),
        "预设不保存倍率 metadata",
      );
      return config.stages;
    },
  };
  await exercise(consoleEditor);
  await consoleEditor.load();
  await scale("A", 0.5);
  await scale("B", 2);
  await consoleEditor.save("重新载入");
  await scale("A", 2);
  await loadPreset(savedPresetName);
  await multipliers();
  await values([2, 4], [4, 10]);
  await scale("A", 2);
  await values([4, 8], [4, 10]);
  await scale("A", 1);
  await values([2, 4], [4, 10]);
  steps.push(
    "控制台：保存值载入后倍率回 1，后续倍率以载入值为基准，无二次应用",
  );

  await navigate("AI 上锁任务");
  await page
    .getByRole("textbox", { name: "任务需求", exact: true })
    .fill("仅用于模拟验收的双通道渐变、零值与休息草稿。");
  await page.getByRole("button", { name: "生成任务草稿", exact: true }).click();
  await page.getByRole("textbox", { name: "任务名称", exact: true }).waitFor();
  const initialPlan = (await snapshot()).plans.find(
    (plan) => plan.title === "倍率验收 AI 原始草稿",
  );
  assert.ok(initialPlan);
  // Keep a second persisted original: the normal save operation updates its own ID.
  const originalPlan: TaskPlan = {
    ...structuredClone(initialPlan),
    id: "scaling-original-preserved",
    title: "倍率验收 AI 保留原稿",
  };
  application.store.set("plans", originalPlan.id, originalPlan);
  application.controller.broadcast(true);
  const aiEditor: Editor = {
    name: "locked-task",
    load: async () => {
      await navigate("AI 上锁任务");
      await page!
        .getByRole("button", { name: /^倍率验收 AI 保留原稿/ })
        .click();
    },
    saveButton: () =>
      page!.getByRole("button", { name: "保存草稿", exact: true }),
    confirmButton: () =>
      page!.getByRole("button", { name: "进入上锁确认", exact: true }),
    issue: /通道.*(授权|上限|强度须)/,
    save: async (suffix) => {
      const title = `倍率验收 AI-${suffix}`;
      await page!
        .getByRole("textbox", { name: "任务名称", exact: true })
        .fill(title);
      await page!
        .getByRole("button", { name: "保存草稿", exact: true })
        .click();
      const saved = await waitState("缩放草稿保存", (state) =>
        state.plans.some((plan) => plan.title === title),
      );
      savedPlan = saved.plans.find((plan) => plan.title === title)!;
      assert.deepEqual(
        savedPlan.bounds,
        fixtureBounds,
        "倍率不得扩大授权、速率或时长",
      );
      assert.deepEqual(
        Object.keys(savedPlan).sort(),
        Object.keys(originalPlan).sort(),
        "草稿不保存倍率 metadata",
      );
      return savedPlan.stages;
    },
  };
  // load() needs an immutable original even after saving the selected draft.
  const loadOriginal = aiEditor.load;
  aiEditor.load = async () => {
    application!.store.set("plans", originalPlan.id, originalPlan);
    application!.controller.broadcast(true);
    await loadOriginal();
  };
  await exercise(aiEditor);
  await aiEditor.load();
  await scale("A", 0.5);
  await scale("B", 2);
  await aiEditor.save("重新载入");
  assert.ok(savedPlan);
  await scale("A", 2);
  await page.getByRole("button", { name: /^倍率验收 AI-重新载入/ }).click();
  await multipliers();
  await values([2, 4], [4, 10]);
  await scale("A", 2);
  await values([4, 8], [4, 10]);
  await scale("A", 1);
  await values([2, 4], [4, 10]);
  steps.push(
    "AI：真实 eve 草稿生成，保存后重新载入倍率回 1，无二次缩放，授权、速率、时长不变",
  );

  await consoleEditor.load();
  await consoleEditor.confirmButton().click();
  const playbackReview = page.getByRole("dialog", { name: "确认开始播放" });
  reportLimits(6, 12);
  await until("确认弹窗动态上限复检", () =>
    playbackReview
      .getByRole("button", { name: "确认开始", exact: true })
      .isDisabled(),
  );
  reportLimits(20, 12);
  await until(
    "确认弹窗上限恢复",
    async () =>
      !(await playbackReview
        .getByRole("button", { name: "确认开始", exact: true })
        .isDisabled()),
  );
  await playbackReview
    .getByRole("button", { name: "确认开始", exact: true })
    .click();
  await waitState(
    "仅显式确认才启动模拟阶段",
    (state) => state.run?.mode === "stages" && state.run.status === "running",
  );
  await consoleStages();
  for (const channel of ["A", "B"] as Channel[]) {
    assert.equal(await number(channel).isDisabled(), true, "运行时倍率只读");
    assert.equal(await slider(channel).isDisabled(), true, "运行时滑块只读");
  }
  await navigate("AI 上锁任务");
  // Page-local draft state may remount, so selecting saved drafts must itself be disabled.
  assert.equal(
    await page
      .getByRole("button", { name: /^倍率验收 AI/ })
      .first()
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: /^紧急停止/ }).click();
  await waitState(
    "停止阶段并归零",
    (state) =>
      !state.stopping &&
      state.run?.status === "stopped" &&
      state.device.intensities.A === 0 &&
      state.device.intensities.B === 0,
  );
  await aiEditor.load();
  await scale("A", 2);
  await aiEditor.confirmButton().click();
  const lockReview = page.getByRole("dialog", { name: "确认约定并上锁" });
  reportLimits(10, 12);
  await until("上锁确认动态上限复检", () =>
    lockReview
      .getByRole("button", { name: "确认开启并上锁", exact: true })
      .isDisabled(),
  );
  reportLimits(20, 12);
  await until(
    "上锁确认上限恢复",
    async () =>
      !(await lockReview
        .getByRole("button", { name: "确认开启并上锁", exact: true })
        .isDisabled()),
  );
  await lockReview
    .getByRole("button", { name: "确认开启并上锁", exact: true })
    .click();
  const locked = await waitState(
    "锁定任务启动",
    (state) => state.locked && state.run?.status === "running",
  );
  assert.deepEqual(locked.run?.plan?.stages[0].intensity, { A: 14, B: 5 });
  assert.deepEqual(locked.run?.plan?.stages[0].startIntensity, { A: 6, B: 2 });
  assert.deepEqual(locked.run?.bounds, fixtureBounds);
  await waitState(
    "锁定后本地模型休息决策实际生效",
    (state) => state.locked && state.run?.lastDecision?.action === "rest",
  );
  assert.equal(await number("A").count(), 0, "上锁后编辑任务入口隐藏");
  await consoleStages();
  for (const channel of ["A", "B"] as Channel[]) {
    assert.equal(
      await number(channel).isDisabled(),
      true,
      "上锁时控制台倍率只读",
    );
    assert.equal(
      await slider(channel).isDisabled(),
      true,
      "上锁时控制台滑块只读",
    );
  }
  assert.equal(await consoleEditor.saveButton().isDisabled(), true);
  assert.equal(await consoleEditor.confirmButton().isDisabled(), true);
  await capture("locked-readonly");
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
    "运行时/上锁时倍率与阶段不可编辑；两种确认弹窗动态复检上限；显式启动后保存缩放后的整数值，授权不变，急停解锁归零",
  );
  assert.equal(draftCalls, 1, "只有一次本地模型草稿请求");
  assert.ok(decisionCalls >= 1, "锁定后的实际决策由本地模型桩处理");
  assert.deepEqual(fixtureErrors, []);
  assert.deepEqual(errors, [], "无未预期页面、控制台和网络错误");
  const result = {
    ok: true,
    baseUrl,
    device: "simulator",
    providerCalls,
    draftCalls,
    decisionCalls,
    steps,
    screenshots,
    outputWriteCount: outputWrites.length,
    requests,
    allowedErrors,
    errors,
    fixtureErrors,
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
    fixtureErrors,
    screenshots,
    requests,
    providerCalls,
    draftCalls,
    decisionCalls,
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
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  const verified = resolve(directory);
  if (
    verified.startsWith(resolve(tmpdir()) + sep) &&
    basename(verified).startsWith("coyote-scaling-browser-")
  )
    await rm(verified, { recursive: true, force: true });
}
