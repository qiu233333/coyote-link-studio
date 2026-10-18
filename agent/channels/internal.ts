import { timingSafeEqual } from "node:crypto";
import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";
import type { AiProfile } from "../../shared/types.ts";
import {
  aiTimeoutSeconds,
  aiTimeoutMessage,
  AI_TIMEOUT_MAX_SEC,
} from "../../shared/aiTimeouts.ts";
import * as inference from "../lib/inference.ts";
import { safeInferenceError } from "../lib/errors.ts";
import { profileSchema } from "../lib/schemas.ts";

interface ActiveInference {
  controller: AbortController;
  settled: Promise<void>;
}
const active = new Map<string, ActiveInference>();
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

async function run(request: Request, operation: "test" | "decide" | "draft") {
  if (!authorized(request))
    return json({ ok: false, error: "Unauthorized" }, 401);
  if (Number(request.headers.get("content-length") ?? 0) > 524288)
    return json({ ok: false, error: "请求过大" }, 413);
  let profile: AiProfile | undefined;
  let requestId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let current: ActiveInference | undefined;
  let settle: (() => void) | undefined;
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
      return json(
        {
          ok: false,
          errorCode: "AI_CANCELLED_OR_DUPLICATE",
          error: "请求已取消或重复",
        },
        409,
      );
    const controller = new AbortController();
    current = {
      controller,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    active.set(requestId, current);
    abort = () => controller.abort(new DOMException("Cancelled", "AbortError"));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    timer = setTimeout(
      () => controller.abort(new DOMException("Timed out", "TimeoutError")),
      aiTimeoutSeconds(profile, operation) * 1000,
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
    if (!profile)
      return json(
        {
          ok: false,
          errorCode: "AI_INVALID_REQUEST",
          error: "AI 内部请求结构无效。",
        },
        422,
      );
    // SDKs may wrap an abort in a provider error; the request's own signal is
    // authoritative for distinguishing cancellation from a provider failure.
    const cause = current?.controller.signal.aborted
      ? current.controller.signal.reason
      : error;
    const classified = safeInferenceError(cause);
    if (
      profile &&
      current?.controller.signal.aborted &&
      classified.errorCode === "AI_TIMEOUT"
    )
      classified.error = aiTimeoutMessage(
        operation,
        aiTimeoutSeconds(profile, operation),
      );
    return json({ ok: false, ...classified }, 502);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) request.signal.removeEventListener("abort", abort);
    // A rejected duplicate must never delete another request's controller.
    if (requestId && current && active.get(requestId) === current)
      active.delete(requestId);
    settle?.();
    const now = Date.now();
    for (const [id, time] of cancelled)
      if (now - time > (AI_TIMEOUT_MAX_SEC + 60) * 1000) cancelled.delete(id);
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
        const pending = active.get(requestId);
        pending?.controller.abort(new DOMException("Cancelled", "AbortError"));
        if (pending) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const settled = await Promise.race([
              pending.settled.then(() => true),
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), 1000);
              }),
            ]);
            if (!settled)
              return json(
                {
                  ok: false,
                  errorCode: "AI_CANCELLATION_PENDING",
                  error: "AI 推理取消尚未确认。",
                },
                503,
              );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        return json({ ok: true });
      } catch {
        return json({ ok: false, error: "无效请求" }, 422);
      }
    }),
  ],
});
