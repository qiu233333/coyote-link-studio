import type { Waveform, WaveformSummary } from "../shared/types.js";

export function summarizeWave(
  wave: Waveform,
  previous?: WaveformSummary,
): WaveformSummary {
  const { frames, ...metadata } = wave;
  if (previous?.hash === wave.hash) {
    const { preview, range, frameCount } = previous;
    return { ...metadata, preview, range, frameCount };
  }
  const range = {
    minFrequency: 255,
    maxFrequency: 0,
    minAmplitude: 100,
    maxAmplitude: 0,
  };
  for (const frame of frames)
    for (let offset = 0; offset < 16; offset += 2) {
      const value = Number.parseInt(frame.slice(offset, offset + 2), 16);
      if (offset < 8) {
        range.minFrequency = Math.min(range.minFrequency, value);
        range.maxFrequency = Math.max(range.maxFrequency, value);
      } else {
        range.minAmplitude = Math.min(range.minAmplitude, value);
        range.maxAmplitude = Math.max(range.maxAmplitude, value);
      }
    }
  const total = frames.length * 4;
  const count = Math.min(100, total);
  const preview = Array.from({ length: count }, (_, i) => {
    const sample = Math.floor((i * total) / count);
    const offset = 8 + (sample % 4) * 2;
    return Math.min(
      100,
      Number.parseInt(
        frames[Math.floor(sample / 4)].slice(offset, offset + 2),
        16,
      ),
    );
  });
  return { ...metadata, frameCount: frames.length, preview, range };
}
