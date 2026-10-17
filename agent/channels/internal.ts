import { timingSafeEqual } from "node:crypto";
import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";
import type { AiProfile } from "../../shared/types.ts";
import * as inference from "../lib/inference.ts";
import { profileSchema } from "../lib/schemas.ts";

const active = new Map<string, AbortController>();
const cancelled = new Map<string, number>();
const payloadSchema = z.object({
  requestId: z.string().uuid(),
  profile: profileSchema,
  context: z.unknown().optional(),
  prompt: z.string().max(12000).optional(),
});

function authorized(request: Request) {
  const expected = process.env.COYOTE_EVE_TOKEN;
  const received = request.headers
    .get("authorization")
    ?.replace(/^Bearer /, "");
  if (!expected || !received || request.headers.has("origin")) return false;
  const left = Buffer.from(expected),
    right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

function safeError(error: unknown): string {
  const value = error as {
    name?: string;
    statusCode?: number;
    message?: string;
  };
  if (value.name === "AbortError" || value.name === "TimeoutError")
    return "AI 请求已取消或超时。";
  if (value.statusCode === 401 || value.statusCode === 403)
    return "AI 接口拒绝认证，请检查 API Key 和访问权限。";
  if (value.statusCode === 404)
    return "AI 模型或接口路径不存在，请检查 Base URL 与模型名称。";
  if (value.statusCode === 429) return "AI 接口达到速率或额度限制。";
  if (value.message === "CONTEXT_TOO_LARGE")
    return "上下文超过配置窗口，请增加上下文窗口或减少任务阶段。";
  if (value.message === "NO_WAVEFORMS")
    return "没有可用于草稿的波形，请先导入波形。";
  if (value.message === "INVALID_TOOL_RESULT" || value.name === "ZodError")
    return "模型未返回符合业务结构的结果，请检查工具调用兼容性。";
  // Provider exceptions can embed request bodies or credentials. Never return,
  // log, or persist their raw message, response, cause, headers, or stack.
  return "AI 请求失败，或返回动作未通过授权范围校验；请检查接口、模型与任务范围。";
}

async function run(request: Request, operation: "test" | "decide" | "draft") {
  if (!authorized(request))
    return json({ ok: false, error: "Unauthorized" }, 401);
  if (Number(request.headers.get("content-length") ?? 0) > 524288)
    return json({ ok: false, error: "请求过大" }, 413);
  let profile: AiProfile | undefined;
  let requestId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const raw = await request.text();
    if (raw.length > 524288) return json({ ok: false, error: "请求过大" }, 413);
    const payload = payloadSchema.parse(JSON.parse(raw));
    profile = {
      ...payload.profile,
      apiKeySet: Boolean(payload.profile.apiKey),
    };
    requestId = payload.requestId;
    if (active.has(requestId) || cancelled.has(requestId))
      return json({ ok: false, error: "请求已取消或重复" }, 409);
    const controller = new AbortController();
    active.set(requestId, controller);
    abort = () => controller.abort(new DOMException("Cancelled", "AbortError"));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    timer = setTimeout(
      () => controller.abort(new DOMException("Timed out", "TimeoutError")),
      profile.timeoutSec * 1000,
    );
    const data =
      operation === "test"
        ? await inference.test(profile, controller.signal)
        : operation === "decide"
          ? await inference.decide(profile, payload.context, controller.signal)
          : await inference.draft(
              profile,
              payload.prompt ?? "",
              payload.context,
              controller.signal,
            );
    if (controller.signal.aborted) throw controller.signal.reason;
    return json({ ok: true, data });
  } catch (error) {
    return json({ ok: false, error: safeError(error) }, profile ? 502 : 422);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) request.signal.removeEventListener("abort", abort);
    if (requestId) active.delete(requestId);
    const now = Date.now();
    for (const [id, time] of cancelled)
      if (now - time > 180000) cancelled.delete(id);
    profile = undefined;
  }
}

export default defineChannel({
  routes: [
    GET("/internal/health", async (request) =>
      authorized(request)
        ? json({
            ok: true,
            data: {
              ready: true,
              runtime: "eve",
              requestScopedCredentials: true,
            },
          })
        : json({ ok: false, error: "Unauthorized" }, 401),
    ),
    POST("/internal/test", (request) => run(request, "test")),
    POST("/internal/decide", (request) => run(request, "decide")),
    POST("/internal/draft", (request) => run(request, "draft")),
    POST("/internal/cancel", async (request) => {
      if (!authorized(request))
        return json({ ok: false, error: "Unauthorized" }, 401);
      try {
        const { requestId } = z
          .object({ requestId: z.string().uuid() })
          .parse(await request.json());
        cancelled.set(requestId, Date.now());
        active
          .get(requestId)
          ?.abort(new DOMException("Cancelled", "AbortError"));
        return json({ ok: true });
      } catch {
        return json({ ok: false, error: "无效请求" }, 422);
      }
    }),
  ],
});
