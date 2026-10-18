/** Isolated file chooser → HTTP → store → preview acceptance. No AI worker. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createApplication } from "../server/app.ts";
import type {
  AppSnapshot,
  Channel,
  TaskPlan,
  Waveform,
} from "../shared/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = resolve(root, "artifacts", "pulse-import");
const directory = await mkdtemp(resolve(tmpdir(), "coyote-pulse-browser-"));
const steps: string[] = [],
  errors: string[] = [],
  allowedErrors: string[] = [];
const screenshots: string[] = [],
  importRequests: unknown[] = [];
const outputWrites: unknown[] = [];
const expectedRejections = new Set<string>();
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
let browser: Browser | undefined, page: Page | undefined;
let baseUrl = "";

type Fixture = { name: string; buffer: Buffer; mimeType: string };
type ExpectedWave = {
  name: string;
  frames: string[];
  durationMs: number;
  pulseImport?: {
    sourceDurationMs: number;
    paddingMs: number;
    frequencyInterpolation: "period-ms-linear";
  };
};

async function until(
  label: string,
  predicate: () => Promise<boolean>,
  timeout = 15000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
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

async function choose(fixture: Fixture) {
  assert.ok(page);
  // Exercise the visible import button and the native chooser event.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入波形", exact: true }).click();
  await (await chooser).setFiles(fixture);
}

async function drop(fixture: Fixture) {
  assert.ok(page);
  // A browser File and DataTransfer exercise the same DOM drop event as a file
  // dragged from Explorer; do not call the component or API directly.
  const dataTransfer = await page.evaluateHandle(
    ({ name, base64, mimeType }) => {
      const bytes = Uint8Array.from(atob(base64), (character) =>
        character.charCodeAt(0),
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: mimeType }));
      return transfer;
    },
    {
      name: fixture.name,
      base64: fixture.buffer.toString("base64"),
      mimeType: fixture.mimeType,
    },
  );
  try {
    await page
      .locator(".wave-library")
      .dispatchEvent("dragover", { dataTransfer });
    await page.locator(".wave-library").dispatchEvent("drop", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

async function capture(name: string) {
  assert.ok(page);
  await page
    .getByRole("button", { name: "关闭提示", exact: true })
    .evaluateAll((buttons) => {
      for (const button of buttons) (button as HTMLButtonElement).click();
    });
  const path = resolve(artifacts, `${name}.png`);
  const hasDialog = await page.getByRole("dialog").count();
  if (!hasDialog)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path, fullPage: !hasDialog, animations: "disabled" });
  screenshots.push(path);
}

async function unchanged(waves: Waveform[], writeCount: number) {
  const state = await snapshot();
  assert.deepEqual(state.waveforms, waves, "拒绝的导入不得写入或改名波形");
  assert.deepEqual(state.device.intensities, { A: 0, B: 0 });
  assert.equal(outputWrites.length, writeCount, "导入和预览不得发送设备命令");
}

async function idle(writeCount: number) {
  const state = await snapshot();
  assert.equal(state.run, null, "导入和预览不得自动开始播放或接管控制");
  assert.equal(state.owner, "manual");
  assert.deepEqual(state.device.intensities, { A: 0, B: 0 });
  assert.equal(outputWrites.length, writeCount, "导入和预览不得发送设备命令");
}

async function imported(
  expected:
    ExpectedWave | (Omit<ExpectedWave, "frames"> & { frameCount: number }),
) {
  const state = await waitState(`导入 ${expected.name}`, (state) =>
    state.waveforms.some((wave) => wave.name === expected.name),
  );
  const wave = state.waveforms.find((wave) => wave.name === expected.name)!;
  if ("frames" in expected)
    assert.deepEqual(
      wave.frames,
      expected.frames,
      "转换后的 V3 帧、节奏和相对幅度必须准确",
    );
  const frameCount =
    "frames" in expected ? expected.frames.length : expected.frameCount;
  assert.equal(wave.frames.length, frameCount);
  assert.equal(wave.durationMs, expected.durationMs);
  if (expected.pulseImport)
    assert.deepEqual(wave.pulseImport, expected.pulseImport);
  else if (wave.pulseImport)
    assert.deepEqual(wave.pulseImport, {
      sourceDurationMs: expected.durationMs,
      paddingMs: 0,
      frequencyInterpolation: "period-ms-linear",
    });
  assert.equal(wave.builtin, false);
  assert.ok(application);
  assert.deepEqual(
    application.store.get<Waveform>("waveforms", wave.id),
    wave,
    "UI 导入必须实际持久化",
  );
  assert.ok(page);
  const tile = page.locator(".wave-tile").filter({
    has: page.getByRole("heading", { name: expected.name, exact: true }),
  });
  await tile.getByText(`${frameCount} 帧`, { exact: true }).waitFor();
  await tile
    .getByText(`${(expected.durationMs / 1000).toFixed(1)} 秒`, { exact: true })
    .waitFor();
  await tile.locator(".wave-preview-button").click();
  const dialog = page.getByRole("dialog", { name: expected.name, exact: true });
  await dialog.getByRole("img", { name: "波形相对幅度预览" }).waitFor();
  const points = await dialog
    .getByRole("img", { name: "波形相对幅度预览" })
    .locator("polyline")
    .getAttribute("points");
  assert.ok(points && points.split(" ").length >= 2, "预览必须生成波形曲线");
  const metadata = dialog.locator(".review-grid > div");
  assert.equal(
    await metadata.filter({ hasText: "帧数" }).locator("strong").innerText(),
    String(frameCount),
  );
  assert.equal(
    await metadata
      .filter({ hasText: wave.pulseImport ? "实际时长" : "原始时长" })
      .locator("strong")
      .innerText(),
    `${(expected.durationMs / 1000).toFixed(1)}s`,
  );
  if (wave.pulseImport) {
    assert.equal(
      await metadata
        .filter({ hasText: "源文件时长" })
        .locator("strong")
        .innerText(),
      `${(wave.pulseImport.sourceDurationMs / 1000).toFixed(3)}s`,
    );
    assert.equal(
      await metadata
        .filter({ hasText: "末尾补静音" })
        .locator("strong")
        .innerText(),
      `${wave.pulseImport.paddingMs}ms`,
    );
  }
  for (const frame of wave.frames.slice(0, 8))
    await dialog.locator("code").filter({ hasText: frame }).first().waitFor();
  if (wave.importNote)
    await dialog.getByText(wave.importNote, { exact: true }).waitFor();
  if (page.viewportSize()!.width < 600) {
    const box = await dialog.boundingBox();
    assert.ok(
      box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width + 2,
      "窄屏预览弹窗必须完整显示在屏幕内",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 2,
      ),
      false,
      "窄屏预览无横向溢出",
    );
  }
  await capture(
    `preview-${wave.hash.slice(0, 12)}-${page.viewportSize()!.width}px`,
  );
  await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  return wave;
}

async function expectFileError(
  fixture: Fixture,
  expected: RegExp,
  method: "choose" | "drop" = "choose",
) {
  assert.ok(page);
  const previous = (await snapshot()).waveforms;
  const writes = outputWrites.length;
  await page
    .getByRole("button", { name: "关闭提示", exact: true })
    .evaluateAll((buttons) => {
      for (const button of buttons) (button as HTMLButtonElement).click();
    });
  await (method === "choose" ? choose(fixture) : drop(fixture));
  await until(`显示 ${fixture.name} 的错误`, async () => {
    const messages = await page!
      .locator(".error-inline, .toast-error")
      .allInnerTexts();
    return messages.some((message) => expected.test(message));
  });
  await unchanged(previous, writes);
  await idle(writes);
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
        (rejection) =>
          rejection.endsWith(` ${path}`) &&
          text.includes(rejection.split(" ")[0]),
      )
    )
      allowedErrors.push(text);
    else errors.push(`console: ${text} (${path})`);
  });
  target.on("requestfailed", (request) => {
    const message = `${request.url()} ${request.failure()?.errorText}`;
    if (/\/ws(?:\?|\s|$)/.test(message)) allowedErrors.push(message);
    else errors.push(`requestfailed: ${message}`);
  });
}

try {
  await mkdir(artifacts, { recursive: true });
  // The fixture and independent expectation are derived from the documented
  // format. Keep the original .pulse bytes intact for both browser entry paths.
  const fixturePath = resolve(
    root,
    "tests",
    "fixtures",
    "pulse",
    "minimal.pulse",
  );
  const expected = JSON.parse(
    await readFile(
      resolve(root, "tests", "fixtures", "pulse", "minimal.expected.json"),
      "utf8",
    ),
  ) as ExpectedWave;
  const pulse: Fixture = {
    name: `${expected.name}.pulse`,
    buffer: await readFile(fixturePath),
    mimeType: "application/octet-stream",
  };
  application = await createApplication({
    directory,
    startAi: false,
    dev: false,
  });
  const setIntensity = application.device.setIntensity.bind(application.device);
  application.device.setIntensity = async (channel, value) => {
    assert.equal(application!.device.state.protocol, "simulator");
    outputWrites.push({ channel, value });
    return setIntensity(channel, value);
  };
  const sendFrames = application.device.sendFrames.bind(application.device);
  application.device.sendFrames = async (channel, frames) => {
    assert.equal(application!.device.state.protocol, "simulator");
    outputWrites.push({ channel, frames: [...frames] });
    return sendFrames(channel, frames);
  };
  const stop = application.device.stop.bind(application.device);
  application.device.stop = async () => {
    if (application!.device.state.connected)
      assert.equal(application!.device.state.protocol, "simulator");
    outputWrites.push({ stop: true });
    return stop();
  };
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
    acceptDownloads: true,
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !== baseUrl &&
      url.protocol !== "data:" &&
      url.protocol !== "blob:"
    ) {
      errors.push(
        `禁止访问独立验收实例以外的地址：${url.origin}${url.pathname}`,
      );
      await route.abort("blockedbyclient");
      return;
    }
    if (
      url.pathname === "/api/waveforms/import" &&
      route.request().method() === "POST"
    )
      importRequests.push(route.request().postDataJSON());
    await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  watchErrors(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /^控制台/ }).waitFor();
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
  await page
    .getByRole("navigation", { name: "控制台功能" })
    .getByRole("button", { name: /^波形库/ })
    .click();
  const accept = await page
    .locator(".wave-library input[type=file]")
    .getAttribute("accept");
  assert.ok(
    accept?.includes(".pulse") && accept.includes(".json"),
    "文件选择器必须提供 JSON 和 pulse 文件",
  );
  const writes = outputWrites.length;
  const initial = (await snapshot()).waveforms;
  steps.push("临时数据库、startAi:false、随机端口和 UI 显式模拟设备连接");

  await choose(pulse);
  const first = await imported(expected);
  assert.match(
    first.importNote ?? "",
    /附加参数.*未应用/,
    "APP 未公开参数的处理必须在预览中透明说明",
  );
  assert.equal((await snapshot()).waveforms.length, initial.length + 1);
  assert.equal(importRequests.length, 1, "文件选择必须进入导入 API");
  const successfulPayload = importRequests[0];
  await idle(writes);
  steps.push(
    "真实文件选择 .pulse：保留文件名称、完整帧、节奏、原始时长与预览，实际持久化且无自动输出",
  );

  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: `导出 ${expected.name}`, exact: true })
    .click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), `${expected.name}.json`);
  const downloadPath = resolve(directory, "exported.json");
  await download.saveAs(downloadPath);
  const exported = JSON.parse(await readFile(downloadPath, "utf8"));
  assert.deepEqual(exported.raw, expected.frames);
  assert.equal(
    typeof exported.label === "string"
      ? exported.label
      : exported.label.cn || exported.label.en,
    expected.name,
  );
  await idle(writes);
  steps.push("导入后的导出仍为 JSON，名称和帧内容准确");

  expectedRejections.add("409 /api/waveforms/import");
  await expectFileError(pulse, /已存在|重复/, "drop");
  assert.equal(importRequests.length, 2, "重复的拖放也必须通过后端去重");
  assert.equal(
    (await api(`/api/waveforms/${first.id}`, undefined, "DELETE")).ok,
    true,
  );
  await waitState(
    "删除临时波形后可重新拖放",
    (state) => !state.waveforms.some((wave) => wave.id === first.id),
  );
  await drop(pulse);
  const wave = await imported(expected);
  assert.notEqual(wave.id, first.id);
  await idle(writes);
  steps.push(
    "DOM File/DataTransfer 实际拖放 .pulse 成功；重复文件由内容哈希拒绝并保持原记录",
  );

  const legacy: ExpectedWave = {
    name: "原 JSON 导入回归",
    frames: ["0A141E283C281400", "323C46503228140A"],
    durationMs: 200,
  };
  await choose({
    name: "legacy-original.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ label: { cn: legacy.name }, raw: legacy.frames }),
    ),
  });
  await imported(legacy);
  await idle(writes);
  steps.push("旧 label/raw JSON 文件选择与预览回归通过，内嵌名称得到保留");

  expectedRejections.add("400 /api/waveforms/import");
  expectedRejections.add("413 /api/waveforms/import");
  // The expectations below are handwritten byte sequences. They deliberately
  // do not call the production parser/encoder to calculate their oracle.
  // Two edit points repeated twice give four endpoint-inclusive periods:
  // mode 2: 10,12,14,16; mode 3: 10,16,10,16; mode 4: 10,10,16,16 ms.
  const conversions: Array<{ text: string; expected: ExpectedWave }> = [
    {
      text: "Dungeonlab+pulse:0,1,8=0,6,3,2,1/20-1,40-1",
      expected: {
        name: "节内频率渐变",
        frames: [
          "0A0A0A0A14141414",
          "0C0C0C0C28282828",
          "0E0E0E0E14141414",
          "1010101028282828",
        ],
        durationMs: 400,
      },
    },
    {
      text: "Dungeonlab+pulse:0,1,8=0,6,3,3,1/20-1,40-1",
      expected: {
        name: "元内频率渐变",
        frames: [
          "0A0A0A0A14141414",
          "1010101028282828",
          "0A0A0A0A14141414",
          "1010101028282828",
        ],
        durationMs: 400,
      },
    },
    {
      text: "Dungeonlab+pulse:0,1,8=0,6,3,4,1/20-1,40-1",
      expected: {
        name: "元间频率渐变",
        frames: [
          "0A0A0A0A14141414",
          "0A0A0A0A28282828",
          "1010101014141414",
          "1010101028282828",
        ],
        durationMs: 400,
      },
    },
    {
      text: "Dungeonlab+pulse:0,4,8=0,6,0,3,1/20-1,40-1,60-1",
      expected: {
        name: "渐变末尾补25ms",
        frames: ["0A0D100A14283C00"],
        durationMs: 100,
        pulseImport: {
          sourceDurationMs: 75,
          paddingMs: 25,
          frequencyInterpolation: "period-ms-linear",
        },
      },
    },
    {
      text: "Dungeonlab+pulse:0,4,8=0,20,1,1,1/20-1,40-1",
      expected: {
        name: "末尾补50ms",
        frames: ["0A0A0A0A14280000"],
        durationMs: 100,
        pulseImport: {
          sourceDurationMs: 50,
          paddingMs: 50,
          frequencyInterpolation: "period-ms-linear",
        },
      },
    },
    {
      text: "Dungeonlab+pulse:0,4,8=0,20,0,1,1/20-1,40-1,60-1,80-1,100-1",
      expected: {
        name: "末尾补75ms",
        frames: ["0A0A0A0A14283C50", "0A0A0A0A64000000"],
        durationMs: 200,
        pulseImport: {
          sourceDurationMs: 125,
          paddingMs: 75,
          frequencyInterpolation: "period-ms-linear",
        },
      },
    },
  ];
  for (const conversion of conversions) {
    const fixture: Fixture = {
      name: `${conversion.expected.name}.pulse`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(conversion.text),
    };
    await choose(fixture);
    const selected = await imported(conversion.expected);
    assert.match(selected.importNote ?? "", /周期.*线性|线性.*周期/);
    if (conversion.expected.pulseImport?.paddingMs)
      assert.match(selected.importNote ?? "", /补.*静音|静音.*补/);
    await idle(writes);
    // Hashes refer only to the actual executable frames, across formats.
    await expectFileError(
      {
        name: `${conversion.expected.name}-same-frames.json`,
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            name: "不得改名",
            frames: conversion.expected.frames,
          }),
        ),
      },
      /已存在|重复/,
    );
    assert.equal(
      (await api(`/api/waveforms/${selected.id}`, undefined, "DELETE")).ok,
      true,
    );
    await waitState(
      "删除选择导入记录后验证真实拖放",
      (state) => !state.waveforms.some((item) => item.id === selected.id),
    );
    await drop(fixture);
    await imported(conversion.expected);
    await idle(writes);
  }
  steps.push(
    "三种频率渐变与25/50/75ms末尾零幅补齐均经真实选择/拖放成功：手算帧字节、端点、名称、帧数、源文件时长/实际时长/补齐说明正确，跨JSON内容哈希去重且无输出",
  );

  if (process.argv.includes("--user-samples")) {
    const samples = [
      {
        path: "D:/qq/wenjian/pulse-三重低语-波形坩埚.pulse",
        frameCount: 169,
        durationMs: 16900,
      },
      {
        path: "D:/qq/wenjian/u_飘逸_高频惩罚.pulse",
        frameCount: 213,
        durationMs: 21300,
      },
    ];
    for (const sample of samples) {
      // Read the user-selected files in place; never modify or copy them into
      // repository fixtures or artifacts. Only aggregate results are recorded.
      const fixture: Fixture = {
        name: basename(sample.path),
        mimeType: "application/octet-stream",
        buffer: await readFile(sample.path),
      };
      const expectedSample = {
        name: basename(sample.path, ".pulse"),
        frameCount: sample.frameCount,
        durationMs: sample.durationMs,
      };
      await choose(fixture);
      const selected = await imported(expectedSample);
      assert.ok(selected.frames.every((frame) => /^[0-9A-F]{16}$/.test(frame)));
      assert.equal(selected.pulseImport?.paddingMs, 0);
      await idle(writes);
      assert.equal(
        (await api(`/api/waveforms/${selected.id}`, undefined, "DELETE")).ok,
        true,
      );
      await waitState(
        "用户样本选择验收结束后验证拖放",
        (state) => !state.waveforms.some((item) => item.id === selected.id),
      );
      await drop(fixture);
      await imported(expectedSample);
      await idle(writes);
      assert.deepEqual(
        await readFile(sample.path),
        fixture.buffer,
        "用户源文件保持原样",
      );
    }
    steps.push(
      "两个用户提供的原始.pulse分别通过真实文件选择和拖放，三重低语169帧/16.9秒，高频惩罚213帧/21.3秒；名称、预览和时长正确，无自动输出，原文件只读",
    );
  }

  await expectFileError(
    {
      ...pulse,
      name: "unsupported-mode5.pulse",
      buffer: Buffer.from(
        pulse.buffer.toString("utf8").replace("=0,20,1,1,1/", "=0,20,1,5,1/"),
      ),
    },
    /模式|mode|范围|1.*4|不支持/,
    "drop",
  );
  await expectFileError(
    {
      ...pulse,
      name: "truncated.pulse",
      buffer: pulse.buffer.subarray(
        0,
        Math.max(1, Math.floor(pulse.buffer.length / 2)),
      ),
    },
    /无效|损坏|截断|格式|解析|JSON|不受支持|参数|缺少/,
  );
  const beforeLocalRejections = importRequests.length;
  await expectFileError(
    { ...pulse, name: "unsupported-extension.txt" },
    /请选择.*\.json.*\.pulse/,
    "drop",
  );
  await expectFileError(
    { ...pulse, name: `${"x".repeat(101)}.pulse` },
    /名称最多.*100|100.*缩短/,
  );
  await expectFileError(
    {
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from("{broken"),
    },
    /无效|格式|解析|JSON|Unexpected/,
  );
  await expectFileError(
    {
      name: "invalid-utf8.pulse",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0xff, 0xfe, 0x80, 0x00]),
    },
    /UTF-8|二进制|重新导出/,
    "drop",
  );
  await expectFileError(
    {
      name: "over-limit.pulse",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(5_000_001),
    },
    /5\s?MB|超过|大小|上限/,
  );
  assert.equal(
    importRequests.length,
    beforeLocalRejections,
    "错误扩展名、超长文件名、损坏 JSON、非法 UTF-8 与文件超限应在浏览器阻止上传",
  );
  await capture("rejected-import");
  steps.push(
    "未知模式5、截断 pulse、错误扩展名、超长文件名、损坏 JSON、非法 UTF-8、文件超限显示可操作错误，不落库且不输出",
  );

  for (const width of [390, 375]) {
    await page.setViewportSize({ width, height: 844 });
    // Resize acknowledgment can precede the media-query layout commit.
    await page.evaluate(
      () =>
        new Promise<void>((resolveFrame) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolveFrame()),
          ),
        ),
    );
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.body.querySelectorAll("*")]
        .flatMap((element) => {
          const box = element.getBoundingClientRect();
          return box.right > innerWidth + 2
            ? [
                {
                  tag: element.tagName,
                  className: element.getAttribute("class"),
                  right: box.right,
                  width: box.width,
                },
              ]
            : [];
        })
        .slice(0, 12),
    }));
    assert.ok(
      layout.scrollWidth <= width + 2,
      `${width}px 波形库无横向溢出：${JSON.stringify(layout)}`,
    );
    await capture(`library-${width}px`);
    await imported(expected);
    await imported(conversions[3].expected);
    await idle(writes);
  }
  await page.setViewportSize({ width: 1512, height: 1020 });
  steps.push("390px 和 375px 波形库与 pulse 预览完整可见，无横向溢出");

  application.ai.status = { ready: true };
  application.ai.decide = async () => ({
    action: "rest",
    channels: [],
    waveformId: "",
    intensity: { A: 0, B: 0 },
    durationSec: 1,
    reason: "独立 pulse 验收内存模型桩",
  });
  application.store.saveSettings({
    baseUrl: `${baseUrl}/unused-memory-fixture`,
    model: "pulse-browser-memory-fixture",
  });
  const plan: TaskPlan = {
    id: randomUUID(),
    version: 1,
    title: "独立 pulse 导入锁定验收",
    description: "模拟设备归零休息",
    completionCriteria: "人工急停",
    createdAt: Date.now(),
    bounds: {
      channels: ["A", "B"] as Channel[],
      waveformIds: [wave.id],
      minIntensity: { A: 0, B: 0 },
      maxIntensity: { A: 0, B: 0 },
      rampPerSecond: { A: 2, B: 2 },
      allowSync: true,
      allowRandom: false,
      allowRamp: false,
      allowRest: true,
      maxActionSec: 10,
      durationSec: 60,
      decisionIntervalSec: 15,
      preference: "只用于隔离验收",
    },
    stages: [
      {
        id: randomUUID(),
        name: "归零休息",
        durationSec: 60,
        gapSec: 0,
        channels: ["A", "B"],
        waveformId: wave.id,
        intensity: { A: 0, B: 0 },
        startIntensity: { A: 0, B: 0 },
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
  const locked = await waitState("真实接口锁定任务", (state) => state.locked);
  assert.deepEqual(
    locked.run?.waveformSnapshots[wave.id],
    locked.waveforms.find((item) => item.id === wave.id),
    "锁定任务冻结已导入波形快照",
  );
  await until("锁定导入按钮禁用", () =>
    page!.getByRole("button", { name: "导入波形", exact: true }).isDisabled(),
  );
  const lockedRequests = importRequests.length;
  await drop(pulse);
  await page.locator(".wave-library input[type=file]").setInputFiles(pulse);
  const lockedGradient: Fixture = {
    name: `${conversions[3].expected.name}.pulse`,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(conversions[3].text),
  };
  await drop(lockedGradient);
  await page
    .locator(".wave-library input[type=file]")
    .setInputFiles(lockedGradient);
  // Flush browser microtasks and HTTP roundtrips before checking the guards.
  const afterGuards = await snapshot();
  assert.equal(
    importRequests.length,
    lockedRequests,
    "锁定期间文件选择和拖放均不得发出导入请求",
  );
  assert.deepEqual(afterGuards.waveforms, locked.waveforms);
  expectedRejections.add("423 /api/waveforms/import");
  const rejected = await api("/api/waveforms/import", successfulPayload);
  assert.equal(rejected.status, 423);
  assert.equal(rejected.code, "TASK_LOCKED");
  assert.deepEqual(
    (await snapshot()).waveforms,
    locked.waveforms,
    "后端锁定拒绝不写库",
  );
  await capture("locked-import");
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
    "内存模型桩和真实锁定 API：禁用导入、文件选择/拖放不发请求、后端 423 不落库、波形引用快照保留，显式急停解锁",
  );

  assert.deepEqual(errors, [], "无非预期页面、控制台、网络错误");
  const result = {
    ok: true,
    steps,
    baseUrl,
    importRequests: importRequests.length,
    outputWrites: outputWrites.length,
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
    completedSteps: steps,
    error: error instanceof Error ? error.message : String(error),
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
  // Verify the resolved deletion target before recursive cleanup on Windows.
  if (
    verified.startsWith(resolve(tmpdir()) + sep) &&
    basename(verified).startsWith("coyote-pulse-browser-")
  )
    await rm(verified, { recursive: true, force: true });
}
