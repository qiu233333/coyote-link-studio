import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePulse } from "../server/pulse.js";
import { normalizeWaveform } from "../server/validation.js";
import { MAX_WAVEFORM_FILE_BYTES } from "../shared/waveformImport.js";
import { AppError } from "../server/errors.js";

const section = (fields = "0,20,1,1,1", points = "20.00-1,40.00-1") =>
  `${fields}/${points}`;
const pulse = (sections = [section()], rest = 0, speed = 1, parameter = 8) =>
  `Dungeonlab+pulse:${rest},${speed},${parameter}=${sections.join("+section+")}`;

test("verified export-derived fixture retains 100ms points, name fallback and relative amplitudes", () => {
  const content = readFileSync(
    new URL("./fixtures/pulse/minimal.pulse", import.meta.url),
    "utf8",
  );
  const expected = JSON.parse(
    readFileSync(
      new URL("./fixtures/pulse/minimal.expected.json", import.meta.url),
      "utf8",
    ),
  );
  const parsed = parsePulse(content);
  const wave = normalizeWaveform(parsed, expected.name);
  assert.deepEqual(wave.frames, expected.frames);
  assert.equal(wave.name, expected.name);
  assert.equal(wave.frames.length, expected.frameCount);
  assert.equal(wave.durationMs, expected.durationMs);
  assert.match(parsed.importNote, /附加参数 8 未应用/);
  assert.deepEqual(
    parsePulse(`\uFEFF  ${content}\r\n`).frames,
    expected.frames,
  );
});

test("speed packs 100/50/25ms points without inserting silence or changing cycle timing", () => {
  assert.deepEqual(parsePulse(pulse(undefined, 0, 2)).frames, [
    "0A0A0A0A14142828",
  ]);
  assert.throws(
    () => parsePulse(pulse(undefined, 0, 4)),
    (error) =>
      error instanceof AppError && error.code === "UNSUPPORTED_PULSE_TIMING",
  );
  assert.deepEqual(
    parsePulse(pulse([section("0,0,0,1,1", "20-1,40-1,60-1,80-1")], 0, 4))
      .frames,
    ["0A0A0A0A14283C50"],
  );
  // Distinct 50ms sections must share a frame; per-section padding loses rhythm.
  assert.deepEqual(
    parsePulse(
      pulse(
        [
          section("0,0,0,1,1", "10-1,20-1"),
          section("10,10,0,1,1", "30-1,40-1"),
        ],
        0,
        4,
      ),
    ).frames,
    ["0A0A14140A141E28"],
  );
});

test("complete motifs round upward and one rest follows all enabled sections, unaffected by speed", () => {
  const rounded = parsePulse(pulse([section("0,0,2,1,1")])).frames;
  assert.deepEqual(rounded, [
    "0A0A0A0A14141414",
    "0A0A0A0A28282828",
    "0A0A0A0A14141414",
    "0A0A0A0A28282828",
  ]);
  const withRest = parsePulse(
    pulse([section(), section("83,0,99,2,0"), section("10,0,1,1,1")], 3, 2),
  ).frames;
  assert.deepEqual(withRest, [
    "0A0A0A0A14142828",
    "1414141414142828",
    "0A0A0A0A00000000",
    "0A0A0A0A00000000",
    "0A0A0A0A00000000",
  ]);
});

test("new duration table preserves short, nonlinear and 300 second sections", () => {
  for (const [index, expectedFrames] of [
    [0, 2],
    [49, 50],
    [50, 52],
    [64, 80],
    [68, 100],
    [79, 234],
    [80, 266],
    [99, 3000],
  ]) {
    assert.equal(
      parsePulse(pulse([section(`0,0,${index},1,1`)])).frames.length,
      expectedFrames,
      `duration index ${index}`,
    );
  }
});

test("period indices use milliseconds and official compression; decimal amplitude never increases", () => {
  // The nonlinear table and compression boundaries have independent known values.
  for (const [index, encoded] of [
    [0, 10],
    [40, 50],
    [59, 100],
    [69, 120],
    [70, 126],
    [79, 200],
    [83, 240],
  ]) {
    const frames = parsePulse(
      pulse([section(`${index},0,0,1,1`, "33.99-0,100.00-1")]),
    ).frames;
    const bytes = Buffer.from(frames[0], "hex");
    assert.deepEqual(
      [...bytes.subarray(0, 4)],
      Array(4).fill(encoded),
      `period index ${index}`,
    );
    assert.deepEqual([...bytes.subarray(4)], [33, 33, 33, 33]);
    assert.equal(frames[1].slice(8), "64646464");
  }
  assert.deepEqual(
    parsePulse(pulse(undefined, 0, 1, 16)).frames,
    parsePulse(pulse(undefined, 0, 1, 0)).frames,
  );
});

test("genuine gradients reject as a whole; identical endpoints are exactly fixed", () => {
  for (const mode of [2, 3, 4]) {
    assert.throws(
      () => parsePulse(pulse([section(), section(`0,83,1,${mode},1`)])),
      (error) =>
        error instanceof AppError && error.code === "UNSUPPORTED_PULSE_MODE",
    );
    assert.deepEqual(
      parsePulse(pulse([section(`0,0,1,${mode},1`)])).frames,
      parsePulse(pulse()).frames,
    );
  }
});

test("rejects corrupt, truncated, old, unknown and multi-wave containers without partial output", () => {
  const invalid = [
    "",
    "[]",
    "PK\u0003\u0004",
    "Dungeonlab+pulse-v2:0,1,8=" + section(),
    "Dungeonlab+pulse:" + section(),
    pulse() + "\n" + pulse(),
    "Dungeonlab+pulse:0,1,8,99=" + section(),
    pulse([section("0,0,1,1,1", "20-1,")]),
    pulse() + "+section+",
    pulse([section("84,0,1,1,1")]),
    pulse([section("0,84,1,1,1")]),
    pulse([section("0,0,100,1,1")]),
    pulse([section("0,0,1,0,1")]),
    pulse([section("0,0,1,5,1")]),
    pulse([section("0,0,1,1,2")]),
    pulse([section("0,0,1,1,0")]),
    pulse([section("0,0,1,1")]),
    pulse([section("0,0,1,1,1", "1-1")]),
    pulse([section("0,0,1,1,1", "101-1,0-1")]),
    pulse([section("0,0,1,1,1", "-1-1,0-1")]),
    pulse([section("0,0,1,1,1", "NaN-1,0-1")]),
    pulse([section("0,0,1,1,1", "1e2-1,0-1")]),
    pulse([section("0,0,1,1,1", "20-2,0-1")]),
    pulse([section("0,0,1,1,1", "20-1,0-1/")]),
    ...[0, 3, -1, 1.5].map((speed) => pulse(undefined, 0, speed)),
    pulse(undefined, -1),
    pulse(undefined, 0.1),
    pulse(Array(11).fill(section())),
    pulse() + "+name+another",
  ];
  for (const value of invalid)
    assert.throws(() => parsePulse(value), AppError, value.slice(0, 100));
  assert.throws(() => parsePulse({ frames: [] }), AppError);
  // A disabled section cannot hide malformed protocol fields or amplitudes.
  assert.throws(() => parsePulse(pulse([section(), section("84,0,0,1,0")])));
});

test("checks raw UTF-8 bytes and expanded frame limits before allocating frame output", () => {
  assert.deepEqual(
    parsePulse(pulse().padEnd(MAX_WAVEFORM_FILE_BYTES)).frames,
    parsePulse(pulse()).frames,
  );
  assert.equal(parsePulse(pulse(undefined, 99_998)).frames.length, 100_000);
  for (const value of [
    pulse(undefined, 99_999),
    "a".repeat(MAX_WAVEFORM_FILE_BYTES + 1),
    "界".repeat(Math.ceil(MAX_WAVEFORM_FILE_BYTES / 3)),
  ]) {
    assert.throws(
      () => parsePulse(value),
      (error) => error instanceof AppError && error.status === 413,
    );
  }
  assert.throws(() =>
    parsePulse(
      pulse([section("0,0,0,1,1", Array(100_001).fill("1-1").join(","))]),
    ),
  );
  assert.equal(parsePulse(pulse(Array(10).fill(section()))).frames.length, 20);
});
