import type { AiSettings } from "./types.js";

export const AI_TIMEOUT_MIN_SEC = 5;
export const AI_TIMEOUT_MAX_SEC = 600;
export const AI_TIMEOUT_DEFAULT_SEC = 120;
export const AI_DRAFT_TIMEOUT_DEFAULT_SEC = 180;
// The worker owns the provider timeout. Give its error/cancellation response
// time to reach the parent instead of racing a second nearly identical timer.
export const AI_TRANSPORT_GRACE_MS = 5000;
export type AiOperation = "test" | "decide" | "draft";

export function aiTimeoutSeconds(
  settings: Pick<AiSettings, "timeoutSec" | "draftTimeoutSec">,
  operation: AiOperation,
): number {
  const value =
    operation === "draft"
      ? (settings.draftTimeoutSec ??
        Math.max(settings.timeoutSec, AI_DRAFT_TIMEOUT_DEFAULT_SEC))
      : settings.timeoutSec;
  // Internal fixtures use two-second budgets; public settings keep a 5s floor.
  return Number.isFinite(value)
    ? Math.max(2, Math.min(AI_TIMEOUT_MAX_SEC, value))
    : operation === "draft"
      ? AI_DRAFT_TIMEOUT_DEFAULT_SEC
      : AI_TIMEOUT_DEFAULT_SEC;
}

export function aiTimeoutMessage(operation: AiOperation, seconds: number) {
  const action =
    operation === "draft"
      ? "任务草稿生成"
      : operation === "test"
        ? "接口测试"
        : "控制决策";
  const setting = operation === "draft" ? "任务草稿超时" : "决策与测试超时";
  return `AI ${action}超时：${seconds} 秒内未完成。可在系统设置调整“${setting}”，并检查模型服务响应。`;
}
