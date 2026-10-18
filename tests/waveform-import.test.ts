import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createApplication } from "../server/app.js";
import type { AiBridge } from "../server/controller.js";
import {
  MAX_WAVEFORM_FILE_BYTES,
  MAX_WAVEFORM_IMPORT_BODY_BYTES,
} from "../shared/waveformImport.js";
import type {
  AppSnapshot,
  ControlBounds,
  PlaybackConfig,
  Stage,
  TaskPlan,
  Waveform,
} from "../shared/types.js";

const pulseText = () =>
  readFileSync(
    new URL("./fixtures/pulse/minimal.pulse", import.meta.url),
    "utf8",
  );
const pulseFrames = ["0A0A0A0A14141414", "0A0A0A0A28282828"];
// Derived from minimal.pulse: three 25ms editing points repeated twice.
// Physical periods span 10–30ms, and the final 150ms cycle gets 50ms silence.
const gradientPulse = (mode = 2, rest = 0) =>
  pulseText()
    .replace("pulse:0,1,8", `pulse:${rest},4,8`)
    .replace(
      "=0,20,1,1,1/20.00-1,40.00-1",
      `=0,20,4,${mode},1/20.00-1,40.00-1,60.00-1`,
    );
const gradientFrames: Record<number, string[]> = {
  2: ["0A0E121614283C14", "1A1E0A0A283C0000"],
  3: ["0A141E0A14283C14", "141E0A0A283C0000"],
  4: ["0A0A0A1E14283C14", "1E1E0A0A283C0000"],
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "coyote-waveform-import-"));
  const aiDirectory = join(directory, "ai-runtime");
  mkdirSync(aiDirectory);
  const app = await createApplication({
    directory,
    aiDirectory,
    startAi: false,
  });
  const url = await app.listen(0);
  assert.notEqual(new URL(url).port, "3000");
  const bootstrap = await fetch(`${url}/api/state`);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
  const initial = (await bootstrap.json()).data as AppSnapshot;
  const aiContexts: unknown[] = [];
  const ai: AiBridge = {
    status: { ready: true },
    decide: async (_profile, context) => {
      aiContexts.push(context);
      return {
        action: "rest",
        channels: [],
        waveformId: "",
        intensity: { A: 0, B: 0 },
        durationSec: 1,
        reason: "本地测试桩保持归零",
      };
    },
    draft: async () => {
      throw new Error("波形导入测试不得调用实际模型或生成任务");
    },
  };
  app.controller.ai = ai;
  app.store.saveSettings({ baseUrl: `${url}/fixture/v1`, model: "fixture" });
  const call = async (path: string, body: unknown = {}, method = "POST") => {
    const response = await fetch(url + path, {
      method,
      headers: {
        cookie,
        origin: url,
        "content-type": "application/json",
        "x-coyote-request": "1",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, result: await response.json() };
  };
  const stage = (waveformId: string): Stage => ({
    id: randomUUID(),
    name: "导入波形阶段",
    durationSec: 30,
    gapSec: 0,
    channels: ["A"],
    waveformId,
    intensity: { A: 0, B: 0 },
    startIntensity: { A: 0, B: 0 },
    behavior: "hold",
  });
  const bounds = (waveformId: string): ControlBounds => ({
    channels: ["A"],
    waveformIds: [waveformId],
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 0, B: 0 },
    rampPerSecond: { A: 20, B: 20 },
    allowSync: false,
    allowRandom: false,
    allowRamp: false,
    allowRest: true,
    maxActionSec: 1,
    durationSec: 60,
    decisionIntervalSec: 15,
    preference: "本地测试桩，仅归零",
  });
  return {
    app,
    initial,
    aiContexts,
    call,
    stage,
    bounds,
    state: async () =>
      (await (await fetch(url + "/api/state")).json()).data as AppSnapshot,
    close: async () => {
      await app.close();
      assert.ok(
        dirname(resolve(directory)) === resolve(tmpdir()) &&
          basename(directory).startsWith("coyote-waveform-import-"),
      );
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("旧 JSON 导入保留名称、帧顺序和时长，并按内容而非名称去重", async () => {
  const f = await fixture();
  try {
    const cases = [
      {
        content: ["0A0B0C0D01020304", "0D0C0B0A04030201"],
        name: "旧数组波形",
        expectedName: "旧数组波形",
      },
      {
        format: "json",
        content: { label: { cn: "旧 raw 中文名" }, raw: ["0A0B0C0D05060708"] },
        expectedName: "旧 raw 中文名",
      },
      {
        content: {
          name: "JSON 导出名称",
          frames: ["0A0B0C0D090a0b0c"],
          // JSON input cannot forge trusted .pulse conversion metadata.
          pulseImport: {
            sourceDurationMs: -1,
            paddingMs: 0,
            frequencyInterpolation: "arbitrary",
          },
          importNote: "伪造已完成渐变转换",
        },
        expectedName: "JSON 导出名称",
      },
      {
        content: { label: "导出标签名称", raw: ["0A0B0C0D0D0E0F10"] },
        expectedName: "导出标签名称",
      },
    ];
    for (const item of cases) {
      const response = await f.call("/api/waveforms/import", item);
      assert.equal(response.status, 200, JSON.stringify(response.result));
      const wave = response.result.data as Waveform;
      const frames = Array.isArray(item.content)
        ? item.content
        : "raw" in item.content
          ? item.content.raw
          : item.content.frames;
      assert.ok(frames, "合法 JSON fixture 必须声明帧");
      assert.equal(wave.name, item.expectedName);
      assert.deepEqual(
        wave.frames,
        frames.map((frame) => frame.toUpperCase()),
      );
      assert.equal(wave.durationMs, frames.length * 100);
      assert.equal(wave.builtin, false);
      assert.equal(wave.lastUsedAt, 0);
      assert.equal(wave.pulseImport, undefined);
      assert.equal(wave.importNote, undefined);
      const duplicate = await f.call("/api/waveforms/import", {
        content: { name: "不同名称", frames },
      });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.result.code, "DUPLICATE_WAVEFORM");
    }
    assert.equal(
      f.app.store.list<Waveform>("waveforms").length,
      f.initial.waveforms.length + cases.length,
    );
    assert.equal(f.app.controller.run, null);
    assert.equal(f.app.device.state.connected, false);
    assert.deepEqual(f.app.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.close();
  }
});

test("无效 JSON 导入不改变已保存波形或控制状态", async () => {
  const f = await fixture();
  try {
    const before = f.app.store.list<Waveform>("waveforms");
    const channels = structuredClone(f.app.controller.config);
    for (const content of [
      null,
      [],
      ["NOT-A-FRAME"],
      ["090A0A0A00000000"],
      ["0A0A0A0A65000000"],
      { name: "部分帧损坏", frames: ["0A0A0A0A00000000", "bad"] },
      Array.from({ length: 100001 }, () => "0A0B0C0D01020304"),
    ]) {
      const rejected = await f.call("/api/waveforms/import", { content });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.result));
      assert.deepEqual(f.app.store.list<Waveform>("waveforms"), before);
      assert.deepEqual(f.app.controller.config, channels);
      assert.equal(f.app.controller.run, null);
    }
  } finally {
    await f.close();
  }
});

test("真实格式派生 pulse 经 HTTP 保留节奏和名称，跨格式去重且不自动输出", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.call("/api/device/connect", { protocol: "simulator" })).status,
      200,
    );
    const channels = structuredClone(f.app.controller.config);
    const commands: string[] = [];
    const setIntensity = f.app.device.setIntensity.bind(f.app.device);
    const sendFrames = f.app.device.sendFrames.bind(f.app.device);
    f.app.device.setIntensity = async (channel, target) => {
      commands.push(`intensity:${channel}:${target}`);
      return setIntensity(channel, target);
    };
    f.app.device.sendFrames = async (channel, frames) => {
      commands.push(`pulse:${channel}:${frames.length}`);
      return sendFrames(channel, frames);
    };
    const imported = await f.call("/api/waveforms/import", {
      format: "pulse",
      content: pulseText(),
      name: "导出的原文件名",
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.result));
    const wave = imported.result.data as Waveform;
    assert.equal(wave.name, "导出的原文件名");
    assert.deepEqual(wave.frames, pulseFrames);
    assert.equal(wave.durationMs, 200);
    assert.equal(wave.lastUsedAt, 0);
    assert.match(wave.importNote ?? "", /8.*未应用/);
    const state = await f.state();
    assert.deepEqual(
      state.waveforms.find((item) => item.id === wave.id),
      wave,
    );
    for (const body of [
      {
        content: pulseFrames.map((frame) => frame.toLowerCase()),
        name: "同内容 JSON",
      },
      { format: "pulse", content: pulseText(), name: "同内容不同文件名" },
    ]) {
      const duplicate = await f.call("/api/waveforms/import", body);
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.result.code, "DUPLICATE_WAVEFORM");
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 150));
    assert.deepEqual(commands, [], "相对幅度不能启动或提高设备强度");
    assert.deepEqual(f.app.controller.config, channels);
    assert.equal(f.app.controller.run, null);
    assert.deepEqual(f.app.device.state.intensities, { A: 0, B: 0 });
    assert.equal(
      f.app.store.list<Waveform>("waveforms").length,
      f.initial.waveforms.length + 1,
    );
  } finally {
    await f.close();
  }
});

test("渐变 pulse 经 HTTP 展开有效帧并在末尾补零，导出 JSON 与 pulse 按内容去重", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.call("/api/device/connect", { protocol: "simulator" })).status,
      200,
    );
    const config = structuredClone(f.app.controller.config);
    const commands: string[] = [];
    const setIntensity = f.app.device.setIntensity.bind(f.app.device);
    const sendFrames = f.app.device.sendFrames.bind(f.app.device);
    f.app.device.setIntensity = async (channel, target) => {
      commands.push(`intensity:${channel}:${target}`);
      return setIntensity(channel, target);
    };
    f.app.device.sendFrames = async (channel, frames) => {
      commands.push(`pulse:${channel}:${frames.length}`);
      return sendFrames(channel, frames);
    };
    for (const mode of [2, 3, 4]) {
      const content = gradientPulse(mode);
      const imported = await f.call("/api/waveforms/import", {
        format: "pulse",
        content,
        name: `渐变模式 ${mode}`,
      });
      assert.equal(imported.status, 200, JSON.stringify(imported.result));
      const wave = imported.result.data as Waveform;
      assert.equal(wave.name, `渐变模式 ${mode}`);
      assert.deepEqual(wave.frames, gradientFrames[mode]);
      assert.equal(wave.durationMs, 200);
      assert.equal(wave.lastUsedAt, 0);
      assert.deepEqual(wave.pulseImport, {
        sourceDurationMs: 150,
        paddingMs: 50,
        frequencyInterpolation: "period-ms-linear",
      });
      assert.match(wave.importNote ?? "", /50.*ms/);
      assert.match(wave.importNote ?? "", /8.*未应用/);
      for (const frame of wave.frames) {
        const bytes = Buffer.from(frame, "hex");
        assert.equal(bytes.length, 8);
        assert.ok(
          [...bytes.subarray(0, 4)].every(
            (value) => value >= 10 && value <= 240,
          ),
        );
        assert.ok([...bytes.subarray(4)].every((value) => value <= 100));
      }
      const state = await f.state();
      assert.deepEqual(
        state.waveforms.find((item) => item.id === wave.id),
        wave,
      );
      assert.deepEqual(f.app.store.get("waveforms", wave.id), wave);
      // This is the exact existing UI JSON export shape. Its saved frames are
      // already executable; no .pulse interpolation is needed on reimport.
      const exported = JSON.parse(
        JSON.stringify({ label: wave.name, raw: wave.frames }),
      );
      for (const body of [
        { content: exported },
        { format: "pulse", content, name: "重复渐变文件" },
      ]) {
        const duplicate = await f.call("/api/waveforms/import", body);
        assert.equal(duplicate.status, 409, JSON.stringify(duplicate.result));
        assert.equal(duplicate.result.code, "DUPLICATE_WAVEFORM");
      }
      // Verify the JSON export also imports successfully by itself after the
      // original entry is removed, with the same frame duration and amplitude.
      assert.equal(
        (await f.call(`/api/waveforms/${wave.id}`, {}, "DELETE")).status,
        200,
      );
      const reimported = await f.call("/api/waveforms/import", {
        content: exported,
      });
      assert.equal(reimported.status, 200, JSON.stringify(reimported.result));
      assert.equal(reimported.result.data.name, wave.name);
      assert.deepEqual(reimported.result.data.frames, wave.frames);
      assert.equal(reimported.result.data.durationMs, 200);
    }
    const withRest = await f.call("/api/waveforms/import", {
      format: "pulse",
      content: gradientPulse(2, 1),
      name: "先保留休息再补齐",
    });
    assert.equal(withRest.status, 200, JSON.stringify(withRest.result));
    const wave = withRest.result.data as Waveform;
    assert.deepEqual(wave.frames, [...gradientFrames[2], "0A0A0A0A00000000"]);
    assert.equal(wave.durationMs, 300);
    assert.deepEqual(wave.pulseImport, {
      sourceDurationMs: 250,
      paddingMs: 50,
      frequencyInterpolation: "period-ms-linear",
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 150));
    assert.deepEqual(commands, [], "渐变计算、补静音与 JSON 导出不能操作设备");
    assert.deepEqual(f.app.controller.config, config);
    assert.deepEqual(f.app.device.state.intensities, { A: 0, B: 0 });
    assert.equal(f.app.controller.run, null);
  } finally {
    await f.close();
  }
});

test("错误、截断和不支持模式的 pulse 不写入部分波形", async () => {
  const f = await fixture();
  try {
    const before = f.app.store.list<Waveform>("waveforms");
    const original = pulseText().trimEnd();
    for (const content of [
      "not a pulse file",
      JSON.stringify({ name: "不能仅按 JSON 改扩展名", frames: pulseFrames }),
      "\u0000\uFFFD",
      original.replace("Dungeonlab+pulse:", "Dungeonlab+pulse-v2:"),
      original.slice(0, -1),
      original.replace("/20.00-1,40.00-1", ""),
      `${original}\n${original}`,
      original.replace("=0,20,1,1,1/", "=0,20,1,5,1/"),
      `${gradientPulse().trimEnd()}+section+0,20,1,5,1/20.00-1,40.00-1`,
    ]) {
      const rejected = await f.call("/api/waveforms/import", {
        format: "pulse",
        content,
        name: "拒绝保存",
      });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.result));
      assert.deepEqual(f.app.store.list<Waveform>("waveforms"), before);
      assert.equal(f.app.controller.run, null);
    }
  } finally {
    await f.close();
  }
});

test("渐变及末尾静音导入后只有显式播放才向模拟设备按保存帧序输出", async () => {
  const f = await fixture();
  try {
    const imported = await f.call("/api/waveforms/import", {
      format: "pulse",
      content: gradientPulse(),
      name: "显式模拟播放",
    });
    assert.equal(imported.status, 200);
    const wave = imported.result.data as Waveform;
    assert.equal(
      (await f.call("/api/device/connect", { protocol: "simulator" })).status,
      200,
    );
    const sent: { channel: string; frames: string[] }[] = [];
    const sendFrames = f.app.device.sendFrames.bind(f.app.device);
    f.app.device.sendFrames = async (channel, frames) => {
      assert.equal(f.app.device.state.protocol, "simulator");
      sent.push({ channel, frames: [...frames] });
      await sendFrames(channel, frames);
    };
    const started = await f.call("/api/console/play", {
      requestId: randomUUID(),
      config: {
        mode: "single",
        singleTargets: { A: 3 },
        stages: [{ ...f.stage(wave.id), intensity: { A: 3, B: 0 } }],
        repeat: 1,
        shuffle: false,
        durationSec: 30,
      },
    });
    assert.equal(started.status, 200, JSON.stringify(started.result));
    const deadline = Date.now() + 2000;
    while (!sent.length) {
      assert.ok(Date.now() < deadline, "模拟设备未收到导入波形");
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(sent[0].channel, "A");
    assert.deepEqual(sent[0].frames, [
      gradientFrames[2][0],
      gradientFrames[2][1],
      gradientFrames[2][0],
      gradientFrames[2][1],
      gradientFrames[2][0],
    ]);
    assert.ok(sent.every((item) => item.channel === "A"));
    assert.ok(f.app.device.state.intensities.A <= 3);
    assert.equal(f.app.device.state.intensities.B, 0);
    assert.equal((await f.call("/api/console/stop")).status, 200);
    assert.deepEqual(f.app.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.close();
  }
});

test("pulse 导入校验 UTF-8 文件字节及 HTTP 传输上限，错误不落库", async () => {
  const f = await fixture();
  try {
    const before = f.app.store.list<Waveform>("waveforms");
    for (const content of [
      "x".repeat(MAX_WAVEFORM_FILE_BYTES + 1),
      "波".repeat(Math.floor(MAX_WAVEFORM_FILE_BYTES / 3) + 1),
    ]) {
      assert.ok(Buffer.byteLength(content, "utf8") > MAX_WAVEFORM_FILE_BYTES);
      const rejected = await f.call("/api/waveforms/import", {
        format: "pulse",
        content,
      });
      assert.equal(rejected.status, 413, JSON.stringify(rejected.result));
      assert.deepEqual(f.app.store.list<Waveform>("waveforms"), before);
    }
    const expandedTooLarge = await f.call("/api/waveforms/import", {
      format: "pulse",
      content: pulseText().replace("pulse:0,", "pulse:100000,"),
    });
    assert.equal(expandedTooLarge.status, 413);
    assert.equal(expandedTooLarge.result.code, "WAVEFORM_TOO_LARGE");
    assert.deepEqual(f.app.store.list<Waveform>("waveforms"), before);
    const escapedContent = "\n".repeat(3_000_000);
    const escaped = { format: "pulse", content: escapedContent };
    assert.ok(Buffer.byteLength(JSON.stringify(escaped)) > 5 * 1024 * 1024);
    assert.ok(Buffer.byteLength(escapedContent) < MAX_WAVEFORM_FILE_BYTES);
    const malformed = await f.call("/api/waveforms/import", escaped);
    assert.equal(
      malformed.status,
      400,
      "导入专用传输余量须允许 JSON 转义后交给解析器校验",
    );
    const transportTooLarge = await f.call("/api/waveforms/import", {
      format: "pulse",
      content: "invalid",
      padding: "x".repeat(MAX_WAVEFORM_IMPORT_BODY_BYTES),
    });
    assert.equal(transportTooLarge.status, 413);
    const unchangedApiLimit = await f.call(
      "/api/settings",
      { padding: "x".repeat(6_000_000) },
      "PUT",
    );
    assert.equal(unchangedApiLimit.status, 413, "其他 API 仍维持原有传输上限");
    assert.notEqual(unchangedApiLimit.result.code, "WAVEFORM_TOO_LARGE");
    for (const body of [
      { format: "unsupported", content: ["0A0B0C0D01020304"] },
      { format: "pulse", content: ["0A0B0C0D01020304"] },
      { format: "pulse", content: "" },
    ]) {
      const rejected = await f.call("/api/waveforms/import", body);
      assert.equal(rejected.status, 400, JSON.stringify(rejected.result));
    }
    assert.deepEqual(f.app.store.list<Waveform>("waveforms"), before);
    assert.equal(f.app.controller.run, null);
  } finally {
    await f.close();
  }
});

test("导入波形用于列表、阶段和 AI 时保持各自引用快照", async () => {
  const f = await fixture();
  try {
    const imported = await f.call("/api/waveforms/import", {
      format: "pulse",
      content: gradientPulse(),
      name: "引用的导入波形",
    });
    assert.equal(imported.status, 200);
    const wave = imported.result.data as Waveform;
    assert.equal(
      (await f.call("/api/device/connect", { protocol: "simulator" })).status,
      200,
    );
    const config: PlaybackConfig = {
      mode: "stages",
      stages: [f.stage(wave.id)],
      repeat: 1,
      shuffle: false,
      durationSec: 30,
    };
    const saved = await f.call("/api/presets", {
      name: "导入波形列表",
      config,
    });
    assert.equal(saved.status, 200);
    const preset = saved.result.data;
    const started = await f.call("/api/console/play", {
      config,
      requestId: randomUUID(),
    });
    assert.equal(started.status, 200, JSON.stringify(started.result));
    const snapshots = structuredClone(f.app.controller.run!.waveformSnapshots);
    assert.ok(snapshots[wave.id].lastUsedAt > 0);
    assert.deepEqual(snapshots[wave.id], {
      ...wave,
      lastUsedAt: snapshots[wave.id].lastUsedAt,
    });
    assert.deepEqual(snapshots[wave.id].frames, gradientFrames[2]);
    assert.deepEqual(snapshots[wave.id].pulseImport, {
      sourceDurationMs: 150,
      paddingMs: 50,
      frequencyInterpolation: "period-ms-linear",
    });
    const extra = await f.call("/api/waveforms/import", {
      content: { name: "追加波形", frames: ["1E1F202105060708"] },
    });
    assert.equal(extra.status, 200);
    assert.deepEqual(f.app.controller.run!.waveformSnapshots, snapshots);
    assert.deepEqual(f.app.controller.run!.playback, config);
    assert.deepEqual(f.app.store.get("presets", preset.id), preset);
    assert.equal((await f.call("/api/console/stop")).status, 200);

    const ai = await f.call("/api/ai-control/start", {
      bounds: f.bounds(wave.id),
      requestId: randomUUID(),
    });
    assert.equal(ai.status, 200, JSON.stringify(ai.result));
    const aiSnapshots = structuredClone(
      f.app.controller.run!.waveformSnapshots,
    );
    const addedDuringAi = await f.call("/api/waveforms/import", {
      content: { name: "AI 运行中追加", frames: ["2223242505060708"] },
    });
    assert.equal(addedDuringAi.status, 200);
    const renamed = await f.call(
      `/api/waveforms/${wave.id}`,
      { name: "波形库中的新名称" },
      "PATCH",
    );
    assert.equal(renamed.status, 200);
    assert.deepEqual(f.app.controller.run!.waveformSnapshots, aiSnapshots);
    assert.equal(
      f.app.controller.run!.waveformSnapshots[wave.id].name,
      wave.name,
    );
    assert.deepEqual(Object.keys(aiSnapshots), [wave.id]);
    const end = Date.now() + 2000;
    while (f.aiContexts.length === 0) {
      assert.ok(Date.now() < end, "本地 AI 桩未收到上下文");
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
    const context = f.aiContexts[0] as {
      waveforms: { id: string; name: string; durationMs: number }[];
    };
    assert.deepEqual(context.waveforms, [
      {
        id: wave.id,
        name: wave.name,
        durationMs: wave.durationMs,
      },
    ]);
    assert.deepEqual(f.app.device.state.intensities, { A: 0, B: 0 });
    assert.equal((await f.call("/api/ai-control/stop")).status, 200);
  } finally {
    await f.close();
  }
});

test("上锁任务经 HTTP 拒绝 JSON 与 pulse 导入，保持阶段、AI 和波形快照", async () => {
  const f = await fixture();
  try {
    const wave = (
      await f.call("/api/waveforms/import", {
        format: "pulse",
        content: gradientPulse(),
        name: "锁定引用",
      })
    ).result.data as Waveform;
    assert.equal(
      (await f.call("/api/device/connect", { protocol: "simulator" })).status,
      200,
    );
    const plan: TaskPlan = {
      id: randomUUID(),
      version: 1,
      title: "波形锁定验证",
      description: "只有本地模拟设备和本地 AI 桩",
      completionCriteria: "手动紧急停止",
      bounds: f.bounds(wave.id),
      stages: [f.stage(wave.id)],
      createdAt: Date.now(),
    };
    f.app.store.set("plans", plan.id, plan);
    const started = await f.call(`/api/locked-tasks/${plan.id}/start`, {
      requestId: randomUUID(),
    });
    assert.equal(started.status, 200, JSON.stringify(started.result));
    const savedWaveforms = f.app.store.list<Waveform>("waveforms");
    const snapshots = structuredClone(f.app.controller.run!.waveformSnapshots);
    for (const body of [
      { content: ["1516171801020304"] },
      { format: "pulse", content: pulseText(), name: "锁定中导入" },
      { format: "pulse", content: gradientPulse(3), name: "锁定中渐变补齐" },
      { format: "pulse", content: "invalid pulse" },
    ]) {
      const rejected = await f.call("/api/waveforms/import", body);
      assert.equal(rejected.status, 423);
      assert.equal(rejected.result.code, "TASK_LOCKED");
    }
    assert.deepEqual(f.app.store.list<Waveform>("waveforms"), savedWaveforms);
    assert.deepEqual(f.app.controller.run!.waveformSnapshots, snapshots);
    assert.deepEqual(f.app.controller.run!.plan, plan);
    assert.deepEqual(f.app.controller.run!.bounds, plan.bounds);
    assert.deepEqual(f.app.device.state.intensities, { A: 0, B: 0 });
    assert.equal((await f.call("/api/emergency-stop")).status, 200);
  } finally {
    await f.close();
  }
});
