/** Isolated browser → API → controller → eve → local provider regression. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createApplication } from "../server/app.ts";
import type { AppSnapshot, ControlBounds, TaskPlan } from "../shared/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(resolve(tmpdir(), "coyote-ai-interruptions-"));
const artifacts = resolve(root, "artifacts", "ai-interruptions");
const fixtureKey = "isolated-interruption-fixture-key";
const steps: string[] = [],
  errors: string[] = [],
  screenshots: string[] = [];
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let baseUrl = "";
let scenario:
  | "normal"
  | "timeout-once"
  | "timeout-always"
  | "invalid"
  | "finish"
  | "phase" = "normal";
let timeoutCount = 0,
  calls = 0,
  cancelledCalls = 0;
let blockState = false,
  blockSocket = false;

function modelContext(messages: { role: string; content: unknown }[]) {
  const prompt = messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
  const marker = "可用上下文：";
  const markerIndex = prompt.lastIndexOf(marker);
  return JSON.parse(
    prompt.slice(
      markerIndex >= 0
        ? markerIndex + marker.length
        : prompt.lastIndexOf("\n{") + 1,
    ),
  ) as {
    bounds: ControlBounds;
    waveforms: { id: string }[];
    run: { owner: string; stageIndex: number };
  };
}
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    assert.ok(
      !raw.includes(fixtureKey),
      "fixture credentials cannot enter prompts",
    );
    const body = JSON.parse(raw);
    const name = body.tools?.[0]?.function?.name;
    calls++;
    let input: unknown;
    if (name === "connection_probe") {
      input = {
        token: JSON.stringify(body.messages).match(
          /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/,
        )?.[0],
      };
    } else if (name === "submit_task_draft") {
      const context = modelContext(body.messages);
      const waveformId = context.waveforms[0].id;
      input = {
        title: "中断回归模拟任务",
        description: "仅临时模拟数据与本地模型桩。",
        completionCriteria: "阶段计时或明确完成反馈。",
        bounds: makeBounds(waveformId, 90),
        stages: [0, 1].map((index) => ({
          id: `fixture-stage-${index}`,
          name: `模拟阶段 ${index + 1}`,
          durationSec: 40,
          gapSec: 0,
          channels: ["A", "B"],
          waveformId,
          intensity: { A: 3, B: 2 },
          startIntensity: { A: 0, B: 0 },
          behavior: "hold",
        })),
      };
    } else if (name === "submit_decision") {
      const feedbackText = JSON.stringify(body.messages);
      const requestedTimeout = /模拟一次慢响应|上锁慢响应模拟/.test(
        feedbackText,
      );
      const requestedFinish = /本地明确结束|完成整个模拟任务/.test(
        feedbackText,
      );
      const requestedPhase = feedbackText.includes("完成当前模拟阶段");
      if (
        scenario === "timeout-always" ||
        (scenario === "timeout-once" &&
          requestedTimeout &&
          timeoutCount++ === 0)
      ) {
        await new Promise<void>((resolveClose) =>
          response.once("close", () => {
            cancelledCalls++;
            resolveClose();
          }),
        );
        return;
      }
      const context = modelContext(body.messages);
      input = {
        action: scenario === "finish" && requestedFinish ? "finish" : "adjust",
        channels: context.bounds.channels,
        waveformId: context.bounds.waveformIds[0],
        intensity:
          scenario === "finish" && requestedFinish
            ? { A: 0, B: 0 }
            : {
                A:
                  scenario === "invalid"
                    ? 201
                    : Math.min(3, context.bounds.maxIntensity.A),
                B: Math.min(2, context.bounds.maxIntensity.B),
              },
        durationSec: 5,
        reason: "本地隔离回归模拟决策",
        phaseComplete:
          scenario === "phase" &&
          requestedPhase &&
          context.run.stageIndex === 0,
      };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `interruption-${calls}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: name
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `call-${calls}`,
                      type: "function",
                      function: { name, arguments: JSON.stringify(input) },
                    },
                  ],
                }
              : { role: "assistant", content: "fixture connected" },
            finish_reason: name ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  } catch (error) {
    errors.push(
      `fixture: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!response.headersSent)
      response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: { message: "local fixture protocol failure" } }),
    );
  }
});

function makeBounds(waveformId: string, durationSec: number): ControlBounds {
  return {
    channels: ["A", "B"],
    waveformIds: [waveformId],
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 6, B: 4 },
    rampPerSecond: { A: 2, B: 3 },
    allowSync: true,
    allowRandom: false,
    allowRamp: true,
    allowRest: true,
    maxActionSec: 10,
    durationSec,
    decisionIntervalSec: 5,
    preference: "本地回归模拟",
  };
}
async function until(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeout = 20000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`等待超时：${label}`);
}
async function api(path: string, body?: unknown, method = "POST") {
  assert.ok(page && baseUrl && new URL(baseUrl).port !== "3000");
  const result = await page.evaluate(
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
  assert.equal(result.ok, true, `${method} ${path}: ${JSON.stringify(result)}`);
  return result.data;
}
function snapshot(): AppSnapshot {
  assert.ok(application);
  return application.controller.snapshot();
}
async function state(
  label: string,
  predicate: (snapshot: AppSnapshot) => boolean,
  timeout?: number,
) {
  await until(label, () => predicate(snapshot()), timeout);
  return snapshot();
}
async function navigate(name: string) {
  assert.ok(page);
  await page
    .getByRole("navigation", { name: "主要模块" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await page.locator("h1").filter({ hasText: name }).waitFor();
}
async function capture(name: string) {
  assert.ok(page);
  const output = resolve(artifacts, `${name}.png`);
  await page.screenshot({
    path: output,
    fullPage: true,
    animations: "disabled",
  });
  screenshots.push(output);
}
async function feedback(text: string) {
  assert.ok(page);
  const input = page.getByLabel("给 AI 的文字反馈", { exact: true });
  await input.fill(text);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        /\/api\/(?:ai-control|locked-tasks)\/feedback$/.test(response.url()) &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "发送反馈", exact: true }).click(),
  ]);
  assert.equal(
    response.status(),
    200,
    "feedback must be accepted by the active mode",
  );
  await until("feedback form acknowledged", () =>
    input.evaluateAll(
      (nodes) =>
        nodes.length === 0 || (nodes[0] as HTMLTextAreaElement).value === "",
    ),
  );
}
async function finished(source: string) {
  await state(source, (s) =>
    Boolean(s.run?.termination?.source === source && !s.stopping),
  );
  assert.deepEqual(snapshot().device.intensities, { A: 0, B: 0 });
  assert.ok(page);
  await page.getByLabel("上次会话结束原因", { exact: true }).waitFor();
}

try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(resolve(directory, "eve-runtime"), { recursive: true });
  await new Promise<void>((resolveListen) =>
    provider.listen(0, "127.0.0.1", resolveListen),
  );
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  application = await createApplication({
    directory,
    aiDirectory: resolve(directory, "eve-runtime"),
    dev: false,
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
    if (url.origin !== baseUrl && url.protocol !== "data:") {
      errors.push(`external browser request: ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
    } else if (blockState && url.pathname === "/api/state")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"ok":false,"error":"模拟浏览器状态读取中断"}',
      });
    else await route.continue();
  });
  await context.routeWebSocket("**/ws", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (!blockSocket) socket.send(message);
    });
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/503|WebSocket.*(?:failed|closed)/.test(message.text())
    )
      errors.push(`console: ${message.text()}`);
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await state("eve ready", (s) => s.aiRuntime.ready, 120000);
  await navigate("系统设置");
  await page
    .getByLabel("AI Base URL", { exact: true })
    .fill(`http://127.0.0.1:${address.port}/v1`);
  await page.getByLabel("AI API Key", { exact: true }).fill(fixtureKey);
  await page
    .getByLabel("AI 模型名称", { exact: true })
    .fill("isolated-interruptions-fixture");
  await page.getByLabel("AI 请求超时", { exact: true }).fill("5");
  await page
    .getByRole("button", { name: "保存并测试连接", exact: true })
    .click();
  await page
    .getByText("聊天与业务工具调用均已通过实际请求测试。", { exact: true })
    .waitFor();
  await api("/api/device/connect", { protocol: "simulator" });
  assert.equal(snapshot().device.protocol, "simulator");
  const wave = snapshot().waveforms[0];
  const bounds = makeBounds(wave.id, 90);
  await navigate("AI 控制");
  await page.getByLabel("AI A 通道最高强度", { exact: true }).fill("6");
  await page.getByLabel("AI B 通道最高强度", { exact: true }).fill("4");
  await page.getByLabel("会话最长时间", { exact: true }).fill("90");
  await page.getByLabel("AI 决策间隔", { exact: true }).fill("5");
  await page.getByLabel("AI 单次动作最长时间", { exact: true }).fill("10");
  await page
    .getByRole("button", { name: "确认范围，交给 AI", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "确认 AI 控制范围" })
    .getByRole("button", { name: "开启 AI 控制", exact: true })
    .click();
  await state(
    "AI output",
    (s) =>
      s.run?.owner === "ai-control" &&
      s.device.intensities.A === 3 &&
      s.device.intensities.B === 2,
  );
  const id = snapshot().run!.id;
  blockSocket = true;
  await page.getByText("轮询同步", { exact: true }).waitFor();
  assert.equal(snapshot().run!.id, id);
  assert.equal(snapshot().run!.status, "running");
  blockState = true;
  await page.getByText("状态同步中断", { exact: true }).waitFor();
  await page.getByText(/浏览器状态同步中断，当前显示上次收到的状态/).waitFor();
  assert.equal(snapshot().run!.status, "running");
  await capture("browser-state-disconnected");
  blockState = false;
  blockSocket = false;
  await page.getByText("实时同步", { exact: true }).waitFor();
  steps.push(
    "实际 WS 半开回退轮询，HTTP 同步也中断时显示旧状态提示；后台 AI 会话持续同一 ID，恢复后同步",
  );

  scenario = "timeout-once";
  timeoutCount = 0;
  await feedback("模拟一次慢响应");
  await page.getByLabel("AI 推理恢复状态", { exact: true }).waitFor();
  assert.equal(snapshot().run!.inferenceRecovery?.code, "AI_TIMEOUT");
  assert.deepEqual(snapshot().device.intensities, { A: 0, B: 0 });
  await page.getByRole("button", { name: "暂停控制", exact: true }).click();
  await state(
    "paused during recovery",
    (s) => s.run?.status === "paused" && !s.stopping,
  );
  await page.getByText("已暂停，恢复控制后重试", { exact: true }).waitFor();
  await capture("timeout-recovery-paused");
  assert.equal(snapshot().run!.status, "paused");
  await page.getByRole("button", { name: "继续控制", exact: true }).click();
  await state(
    "timeout recovered",
    (s) =>
      s.run?.id === id &&
      !s.run.inferenceRecovery &&
      !s.run.thinking &&
      s.device.intensities.A === 3,
  );
  assert.ok(cancelledCalls > 0, "eve abort reaches the local provider");
  scenario = "normal";
  await page.getByRole("button", { name: "暂停控制", exact: true }).click();
  await state(
    "paused zero",
    (s) =>
      s.run?.status === "paused" && !s.stopping && s.device.intensities.A === 0,
  );
  await page.getByLabel("AI B 通道最高强度", { exact: true }).fill("3");
  await page.getByRole("button", { name: "确认新范围", exact: true }).click();
  await state("new bounds", (s) => s.run?.boundsVersion === 2);
  await page.getByRole("button", { name: "继续控制", exact: true }).click();
  await state(
    "resumed",
    (s) => s.run?.status === "running" && s.device.intensities.A === 3,
  );
  for (let i = 0; i < 3; i++) await feedback(`快速反馈 ${i}`);
  await state(
    "latest feedback settled",
    (s) => s.run?.status === "running" && !s.run.thinking,
  );
  scenario = "finish";
  await feedback("本地明确结束");
  await finished("ai-finish");
  await page
    .getByText(/AI 主动判定完成/)
    .first()
    .waitFor();
  await capture("ai-finish");
  steps.push(
    "AI 控制真实 eve 超时分类为 AI_TIMEOUT、归零后有限重试成功；暂停改独立 B 范围与快速反馈后模型主动结束来源可见",
  );

  scenario = "normal";
  await navigate("AI 上锁任务");
  await page
    .getByRole("textbox", { name: "任务需求", exact: true })
    .fill("创建隔离模拟任务");
  await page.getByRole("button", { name: "生成任务草稿", exact: true }).click();
  await page
    .getByRole("button", { name: "进入上锁确认", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "进入上锁确认", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认约定并上锁" })
    .getByRole("button", { name: "确认开启并上锁", exact: true })
    .click();
  await state("locked output", (s) => s.locked && s.device.intensities.A === 3);
  const planId = snapshot().run!.plan!.id;
  const frozen = JSON.stringify(snapshot().run!.plan);
  scenario = "timeout-once";
  timeoutCount = 0;
  await feedback("上锁慢响应模拟");
  await page.getByLabel("AI 推理恢复状态", { exact: true }).waitFor();
  await state(
    "locked timeout recovered",
    (s) =>
      s.locked &&
      !s.run?.inferenceRecovery &&
      !s.run?.thinking &&
      s.device.intensities.A === 3,
  );
  assert.equal(JSON.stringify(snapshot().run!.plan), frozen);
  scenario = "phase";
  await feedback("完成当前模拟阶段");
  await state(
    "stage advanced",
    (s) => s.run?.stageIndex === 1 && s.run.status === "running",
  );
  scenario = "finish";
  await feedback("完成整个模拟任务");
  await finished("ai-finish");
  steps.push(
    "AI 上锁任务真实超时有限恢复仍保持冻结版本；phaseComplete推进阶段而不结束运行，finish结束任务且归零解锁",
  );

  for (const owner of ["ai-control", "locked-task"] as const) {
    scenario = "timeout-always";
    await navigate(owner === "ai-control" ? "AI 控制" : "AI 上锁任务");
    if (owner === "ai-control")
      await api("/api/ai-control/start", { bounds, requestId: randomUUID() });
    else
      await api(`/api/locked-tasks/${planId}/start`, {
        requestId: randomUUID(),
      });
    await finished("ai-inference");
    assert.equal(snapshot().run!.status, "faulted");
    assert.equal(snapshot().run!.termination?.code, "AI_TIMEOUT");
    const failedId = snapshot().run!.id;
    scenario = "normal";
    await new Promise((resolveWait) => setTimeout(resolveWait, 1100));
    assert.equal(snapshot().run!.id, failedId);
    assert.equal(snapshot().run!.status, "faulted");
    await capture(`${owner}-persistent-timeout`);
  }
  steps.push(
    "两种 AI 模式持续真实超时仅有限重试，最终故障来源/AI_TIMEOUT可见，故障后不自动恢复",
  );

  await navigate("AI 控制");
  await api("/api/ai-control/start", {
    bounds: { ...bounds, durationSec: 2 },
    requestId: randomUUID(),
  });
  await finished("deadline");
  await page
    .getByText(/已到最晚截止时间/)
    .first()
    .waitFor();
  scenario = "invalid";
  await api("/api/ai-control/start", { bounds, requestId: randomUUID() });
  await finished("ai-inference");
  assert.equal(snapshot().run!.status, "faulted");
  scenario = "normal";
  await api("/api/ai-control/start", { bounds, requestId: randomUUID() });
  await state("output before disconnect", (s) => s.device.intensities.A === 3);
  await application.device.disconnect();
  await finished("stop-unconfirmed");
  assert.equal(
    snapshot().run!.termination?.triggerSource,
    "device-disconnected",
  );
  assert.equal(snapshot().stopUnconfirmed, true);
  await page.getByText("起因：设备断线", { exact: true }).waitFor();
  await api("/api/device/connect", { protocol: "simulator" });
  await api("/api/ai-control/start", { bounds, requestId: randomUUID() });
  await page.getByRole("button", { name: /^紧急停止/ }).click();
  await finished("emergency");
  steps.push(
    "真实硬截止显示正常完成；异常工具结果故障、模拟设备断线故障、独立急停均显示各自来源",
  );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  await writeFile(
    resolve(artifacts, "verification.json"),
    JSON.stringify(
      {
        ok: true,
        device: "simulator",
        model: "local-http-fixture",
        steps,
        calls,
        cancelledCalls,
        screenshots,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ok: true,
      steps,
      calls,
      cancelledCalls,
      artifacts,
      errors,
    }),
  );
} catch (error) {
  if (page && !page.isClosed()) await capture("failure");
  const failure = {
    ok: false,
    steps,
    error: error instanceof Error ? error.stack : String(error),
    calls,
    cancelledCalls,
    errors,
    screenshots,
    lastRun: application
      ? {
          status: snapshot().run?.status,
          termination: snapshot().run?.termination,
          stopping: snapshot().stopping,
          stopUnconfirmed: snapshot().stopUnconfirmed,
        }
      : undefined,
  };
  await writeFile(
    resolve(artifacts, "verification.json"),
    JSON.stringify(failure, null, 2),
  );
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await application?.close();
  provider.closeAllConnections();
  if (provider.listening)
    await new Promise<void>((resolveClose) =>
      provider.close(() => resolveClose()),
    );
  const verified = resolve(directory);
  if (
    verified.startsWith(resolve(tmpdir()) + sep) &&
    basename(verified).startsWith("coyote-ai-interruptions-")
  )
    await rm(verified, { recursive: true, force: true });
}
