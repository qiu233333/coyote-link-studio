import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller, type AiBridge } from "../server/controller.js";
import { CoyoteDevice } from "../server/device.js";
import { Store } from "../server/store.js";
import type { Stage, Waveform } from "../shared/types.js";

const until = async (condition: () => boolean, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!condition()) {
    assert.ok(Date.now() < end, "调度状态未在限定时间内到达");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
};
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "coyote-programs-"));
  const store = new Store(directory),
    device = new CoyoteDevice();
  const ai: AiBridge = {
    status: { ready: false },
    decide: async () => {
      throw new Error("手动编排不应调用 AI");
    },
    draft: async () => {
      throw new Error("手动编排不应生成任务");
    },
  };
  const controller = new Controller(store, device, ai, [
    { name: "编排测试", frames: ["0A0A0A0A32323232"] },
  ]);
  await controller.connect({ protocol: "simulator" });
  const wave = store.list<Waveform>("waveforms")[0];
  await controller.updateChannels({
    channels: { A: { limit: 10, rampPerSecond: 20, waveformId: wave.id } },
  });
  const stage = (changes: Partial<Stage>): Stage => ({
    id: randomUUID(),
    name: "编排阶段",
    channels: ["A"],
    waveformId: wave.id,
    intensity: { A: 1, B: 1 },
    startIntensity: { A: 0, B: 0 },
    durationSec: 0.5,
    gapSec: 0,
    behavior: "hold",
    ...changes,
  });
  return {
    controller,
    device,
    stage,
    close: async () => {
      await controller.close();
      await device.dispose();
      store.close();
      assert.ok(
        dirname(resolve(directory)) === resolve(tmpdir()) &&
          basename(directory).startsWith("coyote-programs-"),
      );
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("阶段编排执行保持、归零间隔和渐变，结束后归零", async () => {
  const f = await fixture();
  const observed: number[] = [];
  f.device.on("state", (state) => observed.push(state.intensities.A));
  try {
    await f.controller.startPlayback(
      {
        mode: "stages",
        stages: [
          f.stage({ name: "保持", gapSec: 0.3 }),
          f.stage({
            name: "渐变",
            intensity: { A: 4, B: 4 },
            behavior: "ramp",
            durationSec: 0.6,
          }),
        ],
        repeat: 1,
        shuffle: false,
        durationSec: 10,
      },
      randomUUID(),
    );
    await until(() => f.device.state.intensities.A === 1);
    await until(() => f.device.state.intensities.A === 0);
    await until(() => f.controller.run?.stageIndex === 1);
    await until(() => f.device.state.intensities.A >= 2);
    await until(() => f.controller.run?.status === "completed");
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
    assert.ok(observed.every((value) => value >= 0 && value <= 4));
  } finally {
    await f.close();
  }
});

test("播放列表跳项先清理旧输出，并从下一项恢复", async () => {
  const f = await fixture();
  try {
    await f.controller.startPlayback(
      {
        mode: "playlist",
        stages: [
          f.stage({
            name: "第一项",
            durationSec: 5,
            intensity: { A: 2, B: 2 },
          }),
          f.stage({
            name: "第二项",
            durationSec: 5,
            intensity: { A: 4, B: 4 },
          }),
        ],
        repeat: 1,
        shuffle: false,
        durationSec: 10,
      },
      randomUUID(),
    );
    await until(() => f.device.state.intensities.A === 2);
    await f.controller.next();
    assert.equal(f.device.state.intensities.A, 0);
    await until(
      () =>
        f.controller.run?.stageIndex === 1 &&
        f.device.state.intensities.A === 4,
    );
    await f.controller.pause("manual");
    assert.equal(f.device.state.intensities.A, 0);
    await f.controller.resume("manual");
    await until(() => f.device.state.intensities.A === 4);
    await f.controller.stop("manual");
    assert.equal(f.controller.run?.status, "stopped");
    assert.deepEqual(f.device.state.intensities, { A: 0, B: 0 });
  } finally {
    await f.close();
  }
});
