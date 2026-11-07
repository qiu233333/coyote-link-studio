import { z } from "zod";
import { InferenceError } from "./errors.ts";

type Call = { toolName: string; input: unknown };
const invalid = () => new InferenceError("AI_INVALID_TOOL_RESULT");

// Decode complete JSON documents only. Never search narrative or reasoning for
// commands, coerce device values, or choose between conflicting proposals.
function document(raw: unknown): unknown {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    if (value.length > 131072) throw invalid();
    const text = value.trim();
    const fence = text.match(/^```(?:json)?\s*\n([\s\S]*)\n```$/i);
    try {
      value = JSON.parse(fence ? fence[1] : text);
    } catch {
      throw invalid();
    }
  }
  return value;
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
export function parseStoryResult<T>(
  schema: z.ZodType<T>,
  name: string,
  result: { toolCalls: readonly Call[]; text: string },
): T {
  let inputs: unknown[];
  if (result.toolCalls.length) {
    if (result.toolCalls.some((call) => call.toolName !== name))
      throw invalid();
    inputs = result.toolCalls.map((call) => document(call.input));
  } else {
    let input = document(result.text);
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const record = input as Record<string, unknown>;
      if (
        Object.keys(record).length === 2 &&
        record.name === name &&
        "arguments" in record
      )
        input = document(record.arguments);
    }
    inputs = [input];
  }
  const values = inputs.map((input) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw invalid();
    return parsed.data;
  });
  if (new Set(values.map(canonical)).size !== 1) throw invalid();
  return values[0];
}
