/** Raw file bytes; JSON transport has a separate allowance for escaping. */
export const MAX_WAVEFORM_FILE_BYTES = 5_000_000;
export const MAX_WAVEFORM_IMPORT_BODY_BYTES =
  MAX_WAVEFORM_FILE_BYTES * 2 + 1024;
export const MAX_WAVEFORM_FRAMES = 100_000;
export type WaveformImportFormat = "json" | "pulse";
