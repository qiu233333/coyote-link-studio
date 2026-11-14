import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Page, type WebSocketRoute } from "playwright";
import { createApplication } from "../server/app.ts";
import type {
  ApiEnvelope,
  AppSnapshot,
  PlaybackConfig,
  TaskPlan,
} from "../shared/types.ts";
import type { StateUpdate } from "../shared/stateSync.ts";

const directory = await mkdtemp(join(tmpdir(), "coyote-sync-browser-"));
const artifacts = join("artifacts", "state-sync");
await mkdir(artifacts, { recursive: true });
const app = await createApplication({ directory, startAi: false, dev: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const a = await context.newPage(),
  b = await context.newPage();
context.setDefaultTimeout(8000);
const errors: string[] = [],
  checks: string[] = [];
const timings: Record<string, number> = {};
const received: StateUpdate[] = [];
let socketB: WebSocketRoute | undefined;
let blockSockets = false,
  heartbeats = 0,
  polls = 0,
  details = 0;
for (const page of [a, b])
  page.on("pageerror", (error) => errors.push(error.message));
b.on("request", (request) => {
  if (request.url().includes("/api/state?sync=1")) polls++;
  if (/\/api\/waveforms\/[^/]+$/.test(request.url())) details++;
});
b.on("websocket", (ws) => {
  if (!new URL(ws.url()).pathname.endsWith("/ws")) return;
  ws.on("framereceived", ({ payload }) => {
    const message = JSON.parse(String(payload));
    if (message.type === "heartbeat") heartbeats++;
    if (message.type === "state") received.push(message.data);
  });
});
await b.routeWebSocket("**/ws?*", (socket) => {
  if (blockSockets) void socket.close();
  else {
    socketB = socket;
    socket.connectToServer();
  }
});

async function until(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeout = 7000,
) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await predicate()) return;
    await delay(60);
  }
  throw new Error(label);
}
async function api<T>(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const envelope = (await page.evaluate(
    async ({ path, method, body }) => {
      const r = await fetch(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Coyote-Request": "1",
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return r.json();
    },
    { path, method, body },
  )) as ApiEnvelope<T>;
  assert.equal(envelope.ok, true, envelope.error);
  return envelope.data!;
}
const nav = (page: Page, label: string) =>
  page
    .getByRole("button", { name: new RegExp(`^${label}`) })
    .first()
    .click();
const status = (page: Page) => page.locator(".server-indicator").innerText();
const live = (page: Page) => page.locator(".server-indicator.live").waitFor();

try {
  const url = await app.listen(0);
  await Promise.all([a.goto(url), b.goto(url)]);
  await Promise.all([live(a), live(b)]);
  await b.reload();
  await live(b);
  const baseline = await api<AppSnapshot>(a, "/api/state");
  assert.ok(!JSON.stringify(baseline).includes('"frames":'));
  assert.ok(baseline.waveforms.every((wave) => wave.preview.length <= 100));
  const cursor = received.at(-1)!;
  assert.ok(cursor && !cursor.resources);
  await delay(9200);
  assert.ok(heartbeats >= 2);
  assert.match(await status(b), /实时/);
  checks.push("两个标签页完成初次同步和刷新，静置超过旧连接超时窗口仍在线");

  await nav(b, "波形库");
  const search = b.getByRole("textbox", { name: "搜索波形" });
  await search.fill("同步验证");
  const frames = Array(99_900).fill("0A0A0A0A18181818");
  await nav(a, "波形库");
  const t0 = performance.now();
  await a.locator('input[type="file"]').setInputFiles({
    name: "同步验证.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(frames)),
  });
  const title = b.getByRole("heading", { name: "同步验证", exact: true });
  await title.waitFor();
  timings.importToSecondTabMs = Math.round(performance.now() - t0);
  assert.equal(details, 0, "opening the library did not request full frames");
  const wave = (await api<AppSnapshot>(a, "/api/state")).waveforms.find(
    (w) => w.name === "同步验证",
  )!;
  assert.equal(wave.frameCount, 99_900);
  await title.click();
  await b
    .getByRole("dialog", { name: "同步验证", exact: true })
    .locator("code")
    .first()
    .waitFor();
  assert.equal(details, 1);
  await api(a, `/api/waveforms/${wave.id}`, "PATCH", {
    name: "同步验证已改名",
    favorite: true,
  });
  const dialog = b.getByRole("dialog", { name: "同步验证已改名" });
  await dialog.locator("code").first().waitFor();
  assert.equal(details, 1);
  const downloading = b.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出", exact: true }).click();
  const download = await downloading;
  const file = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of file) chunks.push(Buffer.from(chunk));
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
    label: "同步验证已改名",
    raw: frames,
  });
  assert.equal(details, 1, "export reused the preview content cache");
  await b.keyboard.press("Escape");
  await b.getByRole("button", { name: "取消收藏 同步验证已改名" }).waitFor();
  assert.equal(await search.inputValue(), "同步验证");
  const renamed = (await api<AppSnapshot>(a, "/api/state")).waveforms.find(
    ({ id }) => id === wave.id,
  )!;
  assert.equal(renamed.hash, wave.hash);
  await api(a, "/api/device/connect", "POST", { protocol: "simulator" });
  const before = received.length;
  const gridMutations = await b
    .locator(".wave-library-grid")
    .evaluate(async (grid) => {
      let mutations = 0;
      const observer = new MutationObserver((changes) => {
        mutations += changes.length;
      });
      observer.observe(grid, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      await new Promise((done) => setTimeout(done, 2300));
      observer.disconnect();
      return mutations;
    });
  assert.ok(received.length > before);
  assert.equal(gridMutations, 0);
  timings.waveGridMutationsDuring2300msTelemetry = gridMutations;
  checks.push(
    "长波形导入、重命名、收藏跨页生效；预览按需读取，导出复用缓存且内容一致",
  );

  await nav(b, "系统设置");
  const settings = { baseUrl: url + "/fixture", model: "sync-model" };
  await api(a, "/api/settings", "PUT", settings);
  const model = b.getByRole("textbox", { name: "AI 模型名称" });
  await until(
    "另一页应更新模型设置",
    async () => (await model.inputValue()) === "sync-model",
  );
  await model.fill("未保存的本地设置");
  await api(a, "/api/settings", "PUT", { ...settings, model: "remote-change" });
  await until(
    "设置版本应跨页更新",
    () => received.at(-1)!.versions.settings > cursor.versions.settings + 1,
  );
  assert.equal(await model.inputValue(), "未保存的本地设置");

  await api(a, "/api/console/channels", "PATCH", {
    channels: {
      A: { limit: 12, target: 4, rampPerSecond: 20, waveformId: wave.id },
      B: { limit: 10, rampPerSecond: 20 },
    },
  });
  const stage = (name: string, A: number) => ({
    id: name,
    name,
    durationSec: 4,
    gapSec: 0,
    channels: ["A"] as ["A"],
    waveformId: wave.id,
    behavior: "hold" as const,
    startIntensity: { A: 0, B: 0 },
    intensity: { A, B: 0 },
  });
  const config: PlaybackConfig = {
    mode: "stages",
    stages: [stage("同步第一阶段", 4), stage("同步第二阶段", 6)],
    repeat: 8,
    shuffle: false,
    durationSec: 60,
  };
  await api(a, "/api/presets", "POST", { name: "跨页预设", config });
  await nav(b, "控制台");
  await nav(b, "阶段编排");
  await b.getByText("跨页预设", { exact: true }).waitFor();
  app.ai.status = { ready: true };
  const plan: TaskPlan = {
    id: "sync-task",
    version: 1,
    title: "同步任务草稿",
    description: "本地模型桩",
    completionCriteria: "由计时完成",
    createdAt: Date.now(),
    stages: config.stages,
    bounds: {
      channels: ["A"],
      waveformIds: [wave.id],
      minIntensity: { A: 0, B: 0 },
      maxIntensity: { A: 10, B: 0 },
      rampPerSecond: { A: 20, B: 20 },
      allowSync: false,
      allowRandom: false,
      allowRamp: true,
      allowRest: true,
      maxActionSec: 10,
      durationSec: 60,
      decisionIntervalSec: 5,
      preference: "",
    },
  };
  app.ai.draft = async () => plan;
  const draft = await api<TaskPlan>(a, "/api/locked-tasks/draft", "POST", {
    prompt: "生成跨页同步的任务草稿",
  });
  await nav(b, "AI 上锁任务");
  await b.getByText(plan.title, { exact: true }).waitFor();
  await api(a, `/api/locked-tasks/${draft.id}`, "PATCH", {
    plan: { ...draft, title: "任务跨页已修改" },
  });
  await b.getByText("任务跨页已修改", { exact: true }).waitFor();
  checks.push("设置、预设和任务草稿跨页同步，设置同步保留正在编辑的输入");

  await nav(b, "控制台");
  await nav(b, "实时控制");
  await api(a, "/api/console/play", "POST", {
    config,
    requestId: crypto.randomUUID(),
  });
  await b.getByText("同步第一阶段", { exact: false }).first().waitFor();
  await until(
    "另一页收到模拟设备 A 4",
    () => received.at(-1)?.live.device.intensities.A === 4,
  );
  await b.getByText("同步第二阶段", { exact: false }).first().waitFor();
  await until("另一页收到第二阶段和曲线", () =>
    received.some(
      (p) =>
        p.live.run?.stageIndex === 1 &&
        p.history.entries.some((sample) => sample.A === 6),
    ),
  );
  await nav(b, "运行记录");
  await b.getByText("进入「同步第二阶段」", { exact: true }).waitFor();
  await api(a, "/api/console/pause", "POST", {});
  await until(
    "暂停归零跨页",
    () =>
      received.at(-1)?.live.run?.status === "paused" &&
      received.at(-1)?.live.device.intensities.A === 0,
  );
  const atDisconnect = polls;
  const startId = app.controller.run!.id;
  blockSockets = true;
  await socketB!.close();
  await until(
    "降级轮询状态",
    async () => /轮询/.test(await status(b)) && polls > atDisconnect,
  );
  await b.reload();
  await until(
    "刷新后仍为暂停且继续轮询",
    async () =>
      /轮询/.test(await status(b)) && app.controller.run?.status === "paused",
  );
  assert.equal(app.controller.run!.id, startId);
  assert.deepEqual(app.device.state.intensities, { A: 0, B: 0 });
  blockSockets = false;
  await live(b);
  await api(a, "/api/console/resume", "POST", {});
  await until(
    "恢复后强度重新渐变",
    () => (received.at(-1)?.live.device.intensities.A ?? 0) > 0,
  );
  const stop = app.device.stop.bind(app.device);
  app.device.stop = async () => {
    await stop();
    return false;
  };
  await b.getByRole("button", { name: "紧急停止", exact: true }).click();
  await a.getByText("停止未确认", { exact: true }).waitFor();
  await b.getByText("停止未确认", { exact: true }).waitFor();
  assert.equal(app.controller.run!.termination?.source, "stop-unconfirmed");
  app.device.stop = stop;
  await api(a, "/api/device/connect", "POST", { protocol: "simulator" });
  assert.ok(
    (await api<AppSnapshot>(a, "/api/state")).waveforms.find(
      (w) => w.id === wave.id,
    )!.lastUsedAt > 0,
  );
  await nav(b, "波形库");
  await b
    .getByRole("heading", { name: "同步验证已改名", exact: true })
    .waitFor();
  await api(a, `/api/waveforms/${wave.id}`, "DELETE");
  await b
    .getByRole("heading", { name: "同步验证已改名", exact: true })
    .waitFor({ state: "detached" });
  checks.push(
    "两阶段输出、增量曲线和日志、暂停归零、轮询/刷新/重连、主动恢复、急停未确认、最近使用和删除",
  );
  assert.ok(received.length > 0);
  assert.ok(
    received.every(
      (p) => !/"(frames|waveformSnapshots)"\s*:/.test(JSON.stringify(p)),
    ),
  );
  assert.deepEqual(errors, []);
  const report = {
    checks,
    timings,
    statePackets: received.length,
    heartbeats,
    polls,
    detailReads: details,
    errors,
  };
  await writeFile(
    join(artifacts, "browser.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  await browser.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
