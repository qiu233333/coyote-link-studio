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

test("speed packs 100/50/25ms points and pads only the complete cycle's final frame", () => {
  assert.deepEqual(parsePulse(pulse(undefined, 0, 2)).frames, [
    "0A0A0A0A14142828",
  ]);
  const padded = parsePulse(pulse(undefined, 0, 4));
  assert.deepEqual(padded.frames, ["0A0A0A0A14280000"]);
  assert.deepEqual(padded.pulseImport, {
    sourceDurationMs: 50,
    paddingMs: 50,
    frequencyInterpolation: "period-ms-linear",
  });
  assert.match(padded.importNote, /50ms.*零幅度静音.*每次循环/);
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

test("three gradient scopes include both period endpoints and preserve motif amplitudes", () => {
  const expected = {
    2: [10, 10, 11, 12, 13, 14, 15, 16],
    3: [10, 12, 14, 16, 10, 12, 14, 16],
    4: [10, 10, 10, 10, 16, 16, 16, 16],
  };
  for (const mode of [2, 3, 4] as const) {
    // Target 0.5s rounds to two whole 0.4s motifs, giving eight points.
    const result = parsePulse(
      pulse([section(`0,6,4,${mode},1`, "10-1,20-0,30-0,40-1")]),
    );
    const bytes = result.frames.map((frame) => Buffer.from(frame, "hex"));
    assert.deepEqual(
      bytes.map((frame) => frame[0]),
      expected[mode],
      `mode ${mode}`,
    );
    for (const frame of bytes)
      assert.ok([...frame.subarray(0, 4)].every((value) => value === frame[0]));
    assert.deepEqual(
      bytes.map((frame) => frame[4]),
      [10, 20, 30, 40, 10, 20, 30, 40],
    );
    assert.equal(result.pulseImport.sourceDurationMs, 800);
    assert.equal(result.pulseImport.paddingMs, 0);
  }
});

test("descending gradients follow their own scope; single-repetition mode 4 uses A", () => {
  const expected = {
    2: [16, 15, 14, 13, 12, 11, 10, 10],
    3: [16, 14, 12, 10, 16, 14, 12, 10],
    4: [16, 16, 16, 16, 10, 10, 10, 10],
  };
  for (const mode of [2, 3, 4] as const) {
    const result = parsePulse(
      pulse([section(`6,0,4,${mode},1`, "10-1,20-0,30-0,40-1")]),
    );
    assert.deepEqual(
      result.frames.map((frame) => parseInt(frame.slice(0, 2), 16)),
      expected[mode],
    );
  }
  assert.deepEqual(
    parsePulse(pulse([section("0,83,0,4,1")])).frames,
    parsePulse(pulse()).frames,
  );
});

test("period interpolation happens before V3 compression across all piecewise boundaries", () => {
  for (const [a, b, points, expected] of [
    // Distinguishes period interpolation from slider-index or Hz interpolation.
    [40, 59, "10-1,20-0,30-1", [50, 75, 100]],
    [58, 60, "10-1,20-0,30-0,40-1", [95, 100, 101, 102]],
    [60, 58, "10-1,20-0,30-0,40-1", [102, 101, 100, 95]],
    [78, 80, "10-1,20-0,30-0,40-1", [190, 200, 205, 210]],
    [80, 78, "10-1,20-0,30-0,40-1", [210, 205, 200, 190]],
  ] as const) {
    const result = parsePulse(pulse([section(`${a},${b},0,3,1`, points)]));
    assert.deepEqual(
      result.frames.map((frame) => parseInt(frame.slice(0, 2), 16)),
      expected,
    );
  }
});

test("identical gradient endpoints and mode 1 remain byte-identical to fixed imports", () => {
  for (const mode of [2, 3, 4]) {
    assert.deepEqual(
      parsePulse(pulse([section(`0,0,1,${mode},1`)])).frames,
      parsePulse(pulse()).frames,
    );
  }
  assert.deepEqual(
    parsePulse(pulse([section("0,83,1,1,1")])).frames,
    parsePulse(pulse()).frames,
  );
});

test("25/50/75ms silence is appended after rest and never per section", () => {
  for (const [points, sourceDurationMs, paddingMs, last] of [
    ["10-1,20-1,30-1", 75, 25, "0A0A0A0A0A141E00"],
    ["10-1,20-1", 50, 50, "0A0A0A0A0A140000"],
    ["10-1,20-1,30-1,40-1,50-1", 125, 75, "0A0A0A0A32000000"],
  ] as const) {
    const result = parsePulse(pulse([section("0,0,0,1,1", points)], 0, 4));
    assert.equal(result.frames.at(-1), last);
    assert.equal(result.pulseImport.sourceDurationMs, sourceDurationMs);
    assert.equal(result.pulseImport.paddingMs, paddingMs);
    assert.equal(result.frames.length * 100, sourceDurationMs + paddingMs);
  }
  const withRest = parsePulse(
    pulse([section("0,0,0,1,1", "10-1,20-1,30-1")], 1, 4),
  );
  assert.deepEqual(withRest.frames, ["0A0A0A0A0A141E00", "0A0A0A0A00000000"]);
  assert.equal(withRest.pulseImport.sourceDurationMs, 175);
  assert.equal(withRest.pulseImport.paddingMs, 25);
});

test("speed changes point duration while retaining gradient samples and whole-motif repetition", () => {
  const expected = {
    1: ["0A0A0A0A14141414", "1010101028282828"],
    2: ["0A0A101014142828"],
    4: ["0A100A0A14280000"],
  };
  for (const speed of [1, 2, 4] as const) {
    const result = parsePulse(pulse([section("0,6,1,3,1")], 0, speed));
    assert.deepEqual(result.frames, expected[speed]);
    assert.equal(result.pulseImport.sourceDurationMs, 200 / speed);
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
  const atLimit = parsePulse(
    pulse([section("0,83,0,3,1", "10-1,20-1,30-1")], 99_999, 4),
  );
  assert.equal(atLimit.frames.length, 100_000);
  assert.equal(atLimit.pulseImport.sourceDurationMs, 9_999_975);
  assert.equal(atLimit.pulseImport.paddingMs, 25);
  assert.equal(atLimit.frames.at(-1), "0A0A0A0A00000000");
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
