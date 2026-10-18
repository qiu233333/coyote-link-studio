import { assert } from "./errors.js";
import {
  MAX_WAVEFORM_FILE_BYTES,
  MAX_WAVEFORM_FRAMES,
} from "../shared/waveformImport.js";

// APP 3.4.4 text export tables, not the older QR-code tables.
// Evidence, supported profile and unresolved APP fields: docs/PULSE_FORMAT.md.
const range = (start: number, end: number, step = 1) =>
  Array.from(
    { length: Math.floor((end - start) / step) + 1 },
    (_, i) => start + i * step,
  );
const periods = [
  ...range(10, 49),
  ...range(50, 78, 2),
  ...range(80, 95, 5),
  ...range(100, 190, 10),
  200,
  233,
  266,
  300,
  333,
  366,
  ...range(400, 550, 50),
  ...range(600, 1000, 100),
];
// In 100ms editing points, to avoid floating-point errors in repetition counts.
const durations = [
  ...range(1, 49),
  ...range(50, 78, 2),
  ...range(80, 95, 5),
  ...range(100, 190, 10),
  200,
  234,
  266,
  300,
  334,
  366,
  400,
  450,
  500,
  550,
  600,
  700,
  800,
  900,
  1000,
  1200,
  1400,
  1600,
  1800,
  2000,
  2500,
  3000,
];
function invalid(condition: unknown, message: string): asserts condition {
  assert(condition, message, "INVALID_PULSE");
}

function integer(text: string, maximum: number, label: string) {
  invalid(
    /^\d+$/.test(text),
    `.pulse 的${label}须为整数；文件可能已损坏或版本不受支持。`,
  );
  const value = Number(text);
  invalid(
    Number.isSafeInteger(value) && value <= maximum,
    `.pulse 的${label}超出支持范围（0–${maximum}）。`,
  );
  return value;
}

function encodePeriod(period: number) {
  return period <= 100
    ? period
    : period <= 600
      ? Math.floor((period - 100) / 5) + 100
      : Math.floor((period - 600) / 10) + 200;
}

export function parsePulse(input: unknown) {
  invalid(
    typeof input === "string",
    ".pulse 导入内容须为 UTF-8 文本。请从 APP 重新导出文件。",
  );
  assert(
    Buffer.byteLength(input, "utf8") <= MAX_WAVEFORM_FILE_BYTES,
    "波形文件不能超过 5 MB，请缩小后重试。",
    "WAVEFORM_TOO_LARGE",
    413,
  );
  const text = input.replace(/^\uFEFF/, "").trim();
  invalid(
    text.startsWith("Dungeonlab+pulse:"),
    "未识别的 .pulse 格式：支持 APP 3.4.4 的 Dungeonlab+pulse: 文本导出；压缩包、二进制或其他版本请重新导出为文本或 V3 JSON。",
  );
  invalid(
    text.indexOf("Dungeonlab+pulse:", 1) === -1,
    "文件包含多个波形，请分别导出和导入；不能拼接多个 .pulse 文件。",
  );
  const body = text.slice("Dungeonlab+pulse:".length);
  const equal = body.indexOf("=");
  invalid(
    equal >= 0,
    "这是缺少全局参数的旧版或截断 .pulse 文件，请用支持 3.4.4 文本格式的 APP 重新导出，或导出 V3 JSON。",
  );
  const globals = body.slice(0, equal).split(",");
  invalid(
    globals.length === 3,
    ".pulse 全局参数应为休息时长、速度倍率和 APP 附加参数；此版本不受支持。",
  );
  // Rest cannot exceed the final frame budget, even before section expansion.
  const rest = integer(globals[0], MAX_WAVEFORM_FRAMES, "休息时长索引");
  const speed = integer(globals[1], 4, "速度倍率");
  invalid([1, 2, 4].includes(speed), ".pulse 速度倍率仅支持 1、2、4。");
  const appParameter = integer(
    globals[2],
    Number.MAX_SAFE_INTEGER,
    "APP 附加参数",
  );
  const rawSections = body.slice(equal + 1).split("+section+");
  invalid(
    rawSections.length >= 1 && rawSections.length <= 10,
    ".pulse 应包含 1 到 10 个小节；多个波形容器请分别导出。",
  );

  const sections = rawSections.map((raw, index) => {
    const label = `第 ${index + 1} 小节`;
    const parts = raw.split("/");
    invalid(
      parts.length === 2,
      `.pulse ${label}缺少参数或脉冲元；请检查文件是否完整。`,
    );
    const fields = parts[0].split(",");
    invalid(fields.length === 5, `.pulse ${label}参数数量不受支持。`);
    const start = integer(fields[0], 83, `${label}频率 A 索引`);
    const end = integer(fields[1], 83, `${label}频率 B 索引`);
    const duration = integer(fields[2], 99, `${label}时长索引`);
    const mode = integer(fields[3], 4, `${label}频率模式`);
    invalid(mode >= 1, `.pulse ${label}频率模式须为 1–4。`);
    const enabled = integer(fields[4], 1, `${label}开关`);
    const points = parts[1].split(",");
    invalid(
      points.length >= 2 && points.length <= MAX_WAVEFORM_FRAMES,
      `.pulse ${label}脉冲元须有 2 到 ${MAX_WAVEFORM_FRAMES} 个编辑点。`,
    );
    const amplitudes = points.map((point, i) => {
      const match = /^(\d+(?:\.\d+)?)-([01])$/.exec(point);
      invalid(
        match,
        `.pulse ${label}第 ${i + 1} 点须为“0–100 幅度-0/1 锚点”，文件可能被截断。`,
      );
      const amplitude = Number(match[1]);
      invalid(
        Number.isFinite(amplitude) && amplitude >= 0 && amplitude <= 100,
        `.pulse ${label}第 ${i + 1} 点的相对幅度须为 0–100。`,
      );
      // Fractional editor values quantize downward to V3's integer byte. Never
      // normalize peaks, multiply by channel intensity or interpolate anchors.
      return Math.floor(amplitude);
    });
    assert(
      !enabled || mode === 1 || start === end,
      `.pulse ${label}使用频率渐变模式 ${mode}，其 APP 插值规则尚未确认。当前支持固定频率（或 A/B 频率相同）；请导出已展开的 V3 JSON，不能自动近似转换。`,
      "UNSUPPORTED_PULSE_MODE",
    );
    const repeats = Math.ceil(durations[duration] / amplitudes.length);
    return {
      enabled,
      amplitudes,
      count: repeats * amplitudes.length,
      frequency: encodePeriod(periods[start]),
    };
  });
  invalid(
    sections.some((section) => section.enabled),
    ".pulse 没有启用的小节，请在 APP 中启用至少一个小节后重新导出。",
  );
  const ticksPerPoint = 4 / speed;
  const ticks = sections.reduce(
    (sum, section) =>
      sum + (section.enabled ? section.count * ticksPerPoint : 0),
    rest * 4,
  );
  assert(
    Math.ceil(ticks / 4) <= MAX_WAVEFORM_FRAMES,
    ".pulse 展开后超过 100000 帧（10000 秒），请缩短波形或休息时长。",
    "WAVEFORM_TOO_LARGE",
    413,
  );
  assert(
    ticks % 4 === 0,
    `.pulse 的完整周期为 ${ticks * 25}ms，无法用当前 100ms 帧无损表示。请在 APP 中调整点数或倍率，使总周期为 100ms 的整数倍，或导出已展开的 V3 JSON。`,
    "UNSUPPORTED_PULSE_TIMING",
  );

  const frames: string[] = [];
  let frequencies: number[] = [],
    amplitudes: number[] = [];
  const tick = (frequency: number, amplitude: number) => {
    frequencies.push(frequency);
    amplitudes.push(amplitude);
    if (frequencies.length === 4) {
      frames.push(
        Buffer.from([...frequencies, ...amplitudes])
          .toString("hex")
          .toUpperCase(),
      );
      frequencies = [];
      amplitudes = [];
    }
  };
  for (const section of sections) {
    if (!section.enabled) continue;
    for (let point = 0; point < section.count; point++)
      for (let i = 0; i < ticksPerPoint; i++)
        tick(
          section.frequency,
          section.amplitudes[point % section.amplitudes.length],
        );
  }
  for (let i = 0; i < rest * 4; i++) tick(10, 0);
  return {
    frames,
    importNote: `APP 3.4.4 文本：已导入频率、相对幅度与节奏。APP 附加参数 ${appParameter} 未应用；设备设置沿用当前值。`,
  };
}
