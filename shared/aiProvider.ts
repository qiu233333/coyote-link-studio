export type AiProvider = "openai-compatible" | "deepseek";
export type DeepSeekThinking = "disabled" | "enabled";

/** Verified against the official API documentation on 2026-10-23. */
export const DEEPSEEK_PRESET = {
  provider: "deepseek" as const,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  contextWindow: 1_000_000,
  deepseekThinking: "disabled" as const,
};

export function aiProvider(settings: {
  baseUrl: string;
  provider?: AiProvider;
}): AiProvider {
  // Existing hand-entered official endpoints receive the same protocol fix.
  try {
    if (new URL(settings.baseUrl).hostname === "api.deepseek.com")
      return "deepseek";
  } catch {
    /* An incomplete URL is normal while editing. */
  }
  return settings.provider ?? "openai-compatible";
}

export function credentialTarget(settings: {
  baseUrl: string;
  provider?: AiProvider;
}): string {
  let endpoint = settings.baseUrl.trim().replace(/\/+$/, "");
  try {
    endpoint = new URL(endpoint).href.replace(/\/+$/, "");
  } catch {
    /* Empty initial configuration. */
  }
  // Include the path: different accounts/services may share an origin.
  return `${aiProvider(settings)}:${endpoint}`;
}
