import { dictionary } from "./schemas.ts";

export class InferenceError extends Error {
  constructor(public readonly errorCode: string) {
    super(errorCode);
    this.name = "InferenceError";
  }
}

// Provider exceptions can include prompts, credentials, headers, and raw
// responses. Only these allowlisted categories cross the internal boundary.
export function safeInferenceError(error: unknown) {
  const value = dictionary(error);
  const code = error instanceof InferenceError ? error.errorCode : undefined;
  const status = Number(value.statusCode);
  if (value.name === "TimeoutError")
    return { errorCode: "AI_TIMEOUT", error: "AI 推理请求超时。" };
  if (value.name === "AbortError")
    return { errorCode: "AI_CANCELLED", error: "AI 推理请求已取消。" };
  if (status === 401 || status === 403)
    return {
      errorCode: "AI_AUTH",
      error: "AI 接口拒绝认证，请检查 API Key 和访问权限。",
    };
  if (status === 404)
    return {
      errorCode: "AI_MODEL_NOT_FOUND",
      error: "AI 模型或接口路径不存在，请检查 Base URL 与模型名称。",
    };
  if (status === 429)
    return { errorCode: "AI_RATE_LIMIT", error: "AI 接口达到速率或额度限制。" };
  if ([408, 500, 502, 503, 504].includes(status))
    return {
      errorCode: "AI_PROVIDER_UNAVAILABLE",
      error: "AI 接口暂时不可用。",
    };
  if (code === "AI_CONTEXT_TOO_LARGE" || value.message === "CONTEXT_TOO_LARGE")
    return {
      errorCode: "AI_CONTEXT_TOO_LARGE",
      error: "上下文超过配置窗口，请增加上下文窗口或减少任务阶段。",
    };
  if (value.message === "NO_WAVEFORMS")
    return {
      errorCode: "AI_NO_WAVEFORMS",
      error: "没有可用于草稿的波形，请先导入波形。",
    };
  if (
    code === "AI_INVALID_TOOL_RESULT" ||
    value.message === "INVALID_TOOL_RESULT" ||
    [
      "AI_ToolChoiceViolationError",
      "AI_InvalidToolInputError",
      "AI_NoSuchToolError",
    ].includes(String(value.name))
  )
    return {
      errorCode: "AI_INVALID_TOOL_RESULT",
      error: "模型未返回有效的单次业务工具调用，请检查工具调用兼容性。",
    };
  if (code === "AI_INVALID_DECISION" || value.name === "ZodError")
    return {
      errorCode: "AI_INVALID_DECISION",
      error: "模型返回的动作未通过业务结构或授权范围校验。",
    };
  // AI SDK identifies fetch-level API errors with no HTTP response as retryable.
  // Check the SDK's own classification, never provider text or arbitrary cause.
  if (
    value.name === "AI_APICallError" &&
    value.statusCode === undefined &&
    value.isRetryable === true
  )
    return { errorCode: "AI_TRANSPORT", error: "AI 接口连接暂时失败。" };
  return {
    errorCode: "AI_REQUEST_FAILED",
    error: "AI 请求失败，请检查接口、模型与任务范围。",
  };
}
