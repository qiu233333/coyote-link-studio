import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { aiProvider } from "../../shared/aiProvider.ts";
import type { AiProfile } from "../../shared/types.ts";
import { InferenceError } from "./errors.ts";

export const isDeepSeek = (profile: AiProfile) =>
  aiProvider(profile) === "deepseek";
export const thinkingEnabled = (profile: AiProfile) =>
  isDeepSeek(profile) && profile.deepseekThinking === "enabled";

export function model(profile: AiProfile) {
  const deepseek = isDeepSeek(profile);
  if (deepseek && !profile.apiKey.trim())
    throw new InferenceError("AI_KEY_REQUIRED");
  return createOpenAICompatible({
    name: "user-configured",
    baseURL: profile.baseUrl.replace(/\/+$/, ""),
    apiKey: profile.apiKey,
    // DeepSeek's stable API uses ordinary tools + local schema validation.
    // JSON Output is json_object, not OpenAI json_schema; strict tools are beta.
    supportsStructuredOutputs: false,
    ...(deepseek
      ? {
          transformRequestBody: (body: Record<string, unknown>) => ({
            ...body,
            thinking: {
              type: thinkingEnabled(profile) ? "enabled" : "disabled",
            },
            ...(thinkingEnabled(profile) ? { reasoning_effort: "high" } : {}),
            ...(thinkingEnabled(profile) && Array.isArray(body.messages)
              ? {
                  // The SDK omits empty reasoning parts. DeepSeek's tool
                  // conversation still requires the assistant field to exist.
                  messages: body.messages.map((message) =>
                    message.role === "assistant"
                      ? {
                          ...message,
                          reasoning_content: message.reasoning_content ?? "",
                        }
                      : message,
                  ),
                }
              : {}),
          }),
        }
      : {}),
    // Never forward an explicitly entered credential to a redirected endpoint.
    fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
  }).chatModel(profile.model);
}

export function businessToolChoice<T extends string>(
  profile: AiProfile,
  toolName: T,
) {
  // DeepSeek rejects required/named choices while thinking. The response still
  // must contain exactly one validated tool call; text is never a fallback.
  return thinkingEnabled(profile)
    ? ("auto" as const)
    : { type: "tool" as const, toolName };
}

export function outputBudget(
  profile: AiProfile,
  operation: "test" | "decide" | "draft",
) {
  if (thinkingEnabled(profile)) return operation === "draft" ? 16384 : 8192;
  return operation === "draft" ? 7000 : operation === "decide" ? 1800 : 400;
}

export function checkFinish(result: {
  finishReason: string;
  rawFinishReason?: string;
}) {
  if (result.finishReason === "length")
    throw new InferenceError("AI_OUTPUT_TRUNCATED");
  if (result.finishReason === "content-filter")
    throw new InferenceError("AI_CONTENT_FILTER");
  if (
    ["insufficient_system_resource", "aborted"].includes(
      result.rawFinishReason ?? "",
    )
  )
    throw new InferenceError("AI_PROVIDER_UNAVAILABLE");
}
