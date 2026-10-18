import test from "node:test";
import assert from "node:assert/strict";
import type { Stage } from "../shared/types.js";
import {
  parseIntensityMultiplier,
  scaleStageIntensities,
  StageIntensityScalingModel,
} from "../src/stageIntensityScaling.js";

const stage = (changes: Partial<Stage> = {}): Stage => ({
  id: "stage-1",
  name: "渐变阶段",
  durationSec: 30,
  gapSec: 2,
  channels: ["A", "B"],
  waveformId: "wave-a",
  waveformBId: "wave-b",
  intensity: { A: 7, B: 11 },
  startIntensity: { A: 3, B: 5 },
  behavior: "ramp",
  ...changes,
});

test("A/B 倍率分别缩放目标和起始强度，保留阶段其余设置", () => {
  const original = stage();
  const model = new StageIntensityScalingModel([original]);
  model.setMultiplier("A", 2);
  assert.deepEqual(model.stages[0].intensity, { A: 14, B: 11 });
  assert.deepEqual(model.stages[0].startIntensity, { A: 6, B: 5 });
  model.setMultiplier("B", 3);
  assert.deepEqual(model.stages[0], {
    ...original,
    intensity: { A: 14, B: 33 },
    startIntensity: { A: 6, B: 15 },
  });
  assert.deepEqual(original.intensity, { A: 7, B: 11 });
});

test("所有阶段（含未参与通道）的强度一起缩放，0 和归零休息保持 0", () => {
  const baseline = [
    stage({ channels: ["A"], startIntensity: { A: 0, B: 0 } }),
    stage({ id: "rest", behavior: "rest" }),
    stage({ id: "zero", intensity: { A: 0, B: 0 } }),
  ];
  const result = scaleStageIntensities(baseline, { A: 10, B: 2 });
  assert.deepEqual(result[0].intensity, { A: 70, B: 22 });
  assert.deepEqual(result[0].startIntensity, { A: 0, B: 0 });
  assert.deepEqual(result[1].intensity, { A: 0, B: 0 });
  assert.deepEqual(result[1].startIntensity, { A: 0, B: 0 });
  assert.deepEqual(result[2].intensity, { A: 0, B: 0 });
});

test("反复调整 0.5→2→1 不累乘、不累计取整漂移", () => {
  const original = stage();
  const model = new StageIntensityScalingModel([original]);
  for (let iteration = 0; iteration < 25; iteration++) {
    model.setMultiplier("A", 0.5);
    assert.equal(model.stages[0].intensity.A, 4);
    assert.equal(model.stages[0].startIntensity.A, 2);
    model.setMultiplier("A", 2);
    assert.equal(model.stages[0].intensity.A, 14);
    assert.equal(model.stages[0].startIntensity.A, 6);
    model.setMultiplier("A", 1);
    assert.deepEqual(model.stages[0], original);
  }
});

test("倍率范围包含 0.1 和 10，超出硬件上限的结果不静默限幅", () => {
  const model = new StageIntensityScalingModel([
    stage({ intensity: { A: 90, B: 65 } }),
  ]);
  model.setMultiplier("A", "0.1");
  model.setMultiplier("B", 10);
  assert.deepEqual(model.stages[0].intensity, { A: 9, B: 650 });
  assert.equal(model.inputIssue, undefined);
  assert.equal(Number.isInteger(model.stages[0].startIntensity.A), true);
});

test("非法倍率保留输入与已生效倍率，提供明确错误而不修改阶段", () => {
  const invalid: (string | number)[] = [
    "",
    " ",
    "abc",
    0,
    -1,
    0.09,
    10.1,
    1.25,
    Number.NaN,
    Infinity,
  ];
  for (const input of invalid) {
    const model = new StageIntensityScalingModel([stage()]);
    model.setMultiplier("A", 2);
    const current = structuredClone(model.stages);
    assert.equal(model.setMultiplier("A", input), undefined);
    assert.equal(model.multipliers.A, 2);
    assert.deepEqual(model.stages, current);
    assert.match(model.inputIssue!, /A 通道倍率.*0.1–10/);
    assert.equal(
      model.inputValues.A,
      typeof input === "number" ? input.toFixed(1) : input,
    );
  }
  assert.deepEqual(parseIntensityMultiplier("1.5"), { value: 1.5 });
});

test("A/B 非法输入独立修复，滑块变化同步数值输入", () => {
  const model = new StageIntensityScalingModel([stage()]);
  model.setMultiplier("A", "11");
  model.setMultiplier("B", "0");
  model.setMultiplier("A", 1.5);
  assert.equal(model.inputValues.A, "1.5");
  assert.equal(model.inputIssues.A, undefined);
  assert.match(model.inputIssue!, /B 通道倍率/);
  model.setMultiplier("B", "2");
  assert.equal(model.inputIssue, undefined);
  assert.deepEqual(model.multipliers, { A: 1.5, B: 2 });
});

test("手动编辑任一通道目标或起始强度，以当前完整结果建立新基准", () => {
  for (const field of ["intensity", "startIntensity"] as const) {
    const model = new StageIntensityScalingModel([stage()]);
    model.setMultiplier("A", 2);
    model.setMultiplier("B", 3);
    const edited = structuredClone(model.stages);
    edited[0][field].A = 9;
    model.updateStages(edited);
    assert.deepEqual(model.multipliers, { A: 1, B: 1 });
    assert.deepEqual(model.stages, edited);
    model.setMultiplier("A", 2);
    assert.equal(model.stages[0][field].A, 18);
    model.resetMultipliers();
    assert.deepEqual(model.stages, edited);
  }
});

test("新增、复制、删除阶段后当前结果成为新基准", () => {
  const model = new StageIntensityScalingModel([stage()]);
  model.setMultiplier("A", 2);
  model.updateStages([...model.stages, stage({ id: "added" })]);
  assert.deepEqual(model.multipliers, { A: 1, B: 1 });
  assert.equal(model.stages[0].intensity.A, 14);
  assert.equal(model.stages[1].intensity.A, 7);
  model.setMultiplier("B", 2);
  model.updateStages([...model.stages, { ...model.stages[0], id: "copied" }]);
  assert.deepEqual(model.multipliers, { A: 1, B: 1 });
  assert.equal(model.stages[2].intensity.B, 22);
  model.setMultiplier("A", 2);
  model.updateStages(model.stages.filter((item) => item.id !== "added"));
  assert.deepEqual(model.multipliers, { A: 1, B: 1 });
  assert.equal(model.stages[0].intensity.A, 28);
  model.setMultiplier("A", 0.5);
  assert.equal(model.stages[0].intensity.A, 14);
});

test("名称、时长、波形、参与通道和顺序修改保留倍率与原始强度基准", () => {
  const model = new StageIntensityScalingModel([
    stage(),
    stage({ id: "stage-2", intensity: { A: 13, B: 17 } }),
  ]);
  model.setMultiplier("A", 0.5);
  const edited = structuredClone(model.stages).reverse();
  Object.assign(edited[1], {
    name: "新名称",
    durationSec: 18,
    gapSec: 3,
    channels: ["B"],
    waveformId: "new-wave",
    behavior: "hold",
  });
  model.updateStages(edited);
  assert.equal(model.multipliers.A, 0.5);
  model.setMultiplier("A", 1);
  assert.equal(model.stages[0].intensity.A, 13);
  assert.equal(model.stages[1].intensity.A, 7);
  assert.equal(model.stages[1].name, "新名称");
  assert.equal(model.stages[1].durationSec, 18);
  assert.deepEqual(model.stages[1].channels, ["B"]);
  assert.equal(model.stages[1].waveformId, "new-wave");
});

test("改为休息会将起始及目标归零并建立零强度基准", () => {
  const model = new StageIntensityScalingModel([stage()]);
  model.setMultiplier("A", 2);
  model.updateStages([{ ...model.stages[0], behavior: "rest" }]);
  assert.deepEqual(model.multipliers, { A: 1, B: 1 });
  model.setMultiplier("A", 10);
  model.setMultiplier("B", 10);
  assert.deepEqual(model.stages[0].intensity, { A: 0, B: 0 });
  assert.deepEqual(model.stages[0].startIntensity, { A: 0, B: 0 });
});

test("低倍率取整为零后切换休息再恢复渐变，不会复活休息前的强度基准", () => {
  const model = new StageIntensityScalingModel([
    stage({ intensity: { A: 4, B: 4 }, startIntensity: { A: 3, B: 3 } }),
  ]);
  model.setMultiplier("A", 0.1);
  model.setMultiplier("B", 0.1);
  assert.deepEqual(model.stages[0].intensity, { A: 0, B: 0 });
  assert.deepEqual(model.stages[0].startIntensity, { A: 0, B: 0 });
  model.updateStages([{ ...model.stages[0], behavior: "rest" }]);
  assert.deepEqual(model.multipliers, { A: 1, B: 1 });
  model.setMultiplier("A", 2);
  model.setMultiplier("B", 2);
  model.updateStages([{ ...model.stages[0], behavior: "ramp" }]);
  assert.deepEqual(model.multipliers, { A: 1, B: 1 });
  model.resetMultipliers();
  assert.deepEqual(model.stages[0].intensity, { A: 0, B: 0 });
  assert.deepEqual(model.stages[0].startIntensity, { A: 0, B: 0 });
  model.setMultiplier("A", 10);
  model.setMultiplier("B", 10);
  assert.deepEqual(model.stages[0].intensity, { A: 0, B: 0 });
  assert.deepEqual(model.stages[0].startIntensity, { A: 0, B: 0 });
});

test("保存及重新载入仅保存阶段结果，倍率不会二次应用", () => {
  const model = new StageIntensityScalingModel([stage()]);
  model.setMultiplier("A", 2);
  model.setMultiplier("B", 3);
  const saved = JSON.parse(JSON.stringify(model.stages)) as Stage[];
  const reloaded = new StageIntensityScalingModel(saved);
  assert.deepEqual(reloaded.multipliers, { A: 1, B: 1 });
  assert.deepEqual(reloaded.stages, saved);
  reloaded.setMultiplier("A", 0.5);
  assert.equal(reloaded.stages[0].intensity.A, 7);
  model.resetBaseline(saved);
  assert.deepEqual(model.multipliers, { A: 1, B: 1 });
  assert.deepEqual(model.stages, saved);
  model.setMultiplier("A", 1);
  assert.deepEqual(model.stages, saved);
});

test("恢复 1 倍还原当前基准并清除输入错误，载入新草稿替换旧基准", () => {
  const model = new StageIntensityScalingModel([stage()]);
  model.setMultiplier("A", 2);
  model.setMultiplier("B", 0.5);
  model.setMultiplier("A", "11");
  model.resetMultipliers();
  assert.deepEqual(model.stages, [stage()]);
  assert.equal(model.inputIssue, undefined);
  assert.deepEqual(model.inputValues, { A: "1.0", B: "1.0" });
  const loaded = [stage({ id: "loaded", intensity: { A: 3, B: 9 } })];
  model.resetBaseline(loaded);
  loaded[0].intensity.A = 99;
  model.setMultiplier("A", 2);
  assert.equal(model.stages[0].id, "loaded");
  assert.equal(model.stages[0].intensity.A, 6);
  assert.equal(model.stages[0].intensity.B, 9);
});
