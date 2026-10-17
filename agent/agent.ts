import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

// Inference is handled by the authenticated custom channel. Credentials and the
// user's model are request-scoped, never durable eve session inputs.
export default defineAgent({
  model: createOpenAICompatible({
    name: "request-scoped",
    baseURL: "http://127.0.0.1:1/no-session-model",
  }).chatModel("selected-per-request"),
  modelContextWindowTokens: 32000,
  defaultTools: false,
  tool: false,
  experimental: { workflow: { retention: 0 } },
});
