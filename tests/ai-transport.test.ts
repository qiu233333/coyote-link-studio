import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AiService, AiServiceError } from "../server/ai.ts";
import type { AiProfile } from "../shared/types.ts";

const profile: AiProfile = {
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "fixture-key-never-use",
  apiKeySet: true,
  model: "fixture",
  timeoutSec: 2,
  contextWindow: 32000,
};
type Internal = {
  endpoint: string;
  token: string;
  generation: number;
  healthPending?: number;
  healthFailures: number;
  requests: Set<AbortController>;
  checkHealth(): Promise<void>;
  runtimeFailed(message: string): void;
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
const json = (data: unknown, status = 200) => Response.json(data, { status });
const health = (ready: boolean) =>
  json({ ok: true, data: { runtime: "eve", ready } });
function fixture() {
  const service = new AiService();
  service.status = { ready: true };
  const internal = service as unknown as Internal;
  internal.endpoint = "http://127.0.0.1:1";
  internal.token = "fixture-internal-token";
  return { service, internal };
}
function intercept(
  context: TestContext,
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
) {
  context.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init: RequestInit = {}) =>
      Promise.resolve(handler(String(input), init)),
  );
}
function aborted(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
      once: true,
    });
  });
}
const category = (code: string, retryable: boolean) => (error: unknown) => {
  assert.ok(error instanceof AiServiceError);
  assert.equal(error.code, code);
  assert.equal(error.retryable, retryable);
  assert.ok(!error.message.includes(profile.apiKey!));
  return true;
};

test("一次健康失败不会取消有效推理，成功探测重置连续失败计数", async (context) => {
  const { service, internal } = fixture();
  const decision = deferred<Response>();
  let ready = false,
    abortedCount = 0;
  intercept(context, (url, init) => {
    if (url.endsWith("/health")) return health(ready);
    init.signal!.addEventListener("abort", () => abortedCount++);
    return decision.promise;
  });
  const request = service.decide(profile, {});
  await internal.checkHealth();
  assert.equal(service.status.ready, true);
  assert.equal(internal.healthFailures, 1);
  assert.equal(abortedCount, 0);
  ready = true;
  await internal.checkHealth();
  assert.equal(internal.healthFailures, 0);
  decision.resolve(json({ ok: true, data: { fixture: true } }));
  assert.deepEqual(await request, { fixture: true });
});

test("连续三次健康失败明确中止运行时，不把故障变成主动取消或超时", async (context) => {
  const { service, internal } = fixture();
  let cancelled = 0;
  intercept(context, (url, init) => {
    if (url.endsWith("/health")) return health(false);
    if (url.endsWith("/cancel")) {
      cancelled++;
      return json({ ok: true });
    }
    return aborted(init);
  });
  const failure = assert.rejects(
    service.decide(profile, {}),
    category("AI_RUNTIME_UNAVAILABLE", false),
  );
  await internal.checkHealth();
  await internal.checkHealth();
  assert.equal(service.status.ready, true);
  await internal.checkHealth();
  await failure;
  assert.equal(service.status.ready, false);
  assert.equal(service.status.errorCode, "AI_RUNTIME_UNAVAILABLE");
  assert.equal(cancelled, 1);
  assert.equal(internal.requests.size, 0);
});

for (const ready of [false, true]) {
  test(`旧代际健康${ready ? "成功" : "失败"}不能覆盖新状态或清除新探测`, async (context) => {
    const { service, internal } = fixture();
    const probe = deferred<Response>();
    intercept(context, () => probe.promise);
    const pending = internal.checkHealth();
    internal.generation++;
    internal.healthPending = internal.generation;
    internal.healthFailures = 2;
    service.status = { ready: false, error: "新代际状态" };
    probe.resolve(health(ready));
    await pending;
    assert.deepEqual(service.status, { ready: false, error: "新代际状态" });
    assert.equal(internal.healthFailures, 2);
    assert.equal(internal.healthPending, internal.generation);
  });
}

test("停止后的迟到健康成功不能复活运行时", async (context) => {
  const { service, internal } = fixture();
  const probe = deferred<Response>();
  intercept(context, () => probe.promise);
  const pending = internal.checkHealth();
  await service.stop();
  probe.resolve(health(true));
  await pending;
  assert.equal(service.status.ready, false);
});

test("主动取消等到旧requestId取消确认，始终使用发起时的地址和凭证", async (context) => {
  const { service, internal } = fixture();
  const acknowledgement = deferred<Response>();
  const remoteIds: string[] = [];
  intercept(context, (url, init) => {
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer fixture-internal-token",
    );
    assert.ok(url.startsWith("http://127.0.0.1:1/"));
    remoteIds.push(JSON.parse(String(init.body)).requestId);
    return url.endsWith("/cancel") ? acknowledgement.promise : aborted(init);
  });
  const caller = new AbortController();
  let settled = false;
  const request = service.decide(profile, {}, caller.signal);
  void request.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const failure = assert.rejects(request, category("AI_CANCELLED", false));
  internal.endpoint = "http://127.0.0.1:2";
  internal.token = "replacement-token";
  caller.abort(new Error("arbitrary sensitive cancellation reason"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(internal.requests.size, 1);
  acknowledgement.resolve(json({ ok: true }));
  await failure;
  assert.equal(remoteIds.length, 2);
  assert.equal(remoteIds[0], remoteIds[1]);
  assert.equal(internal.requests.size, 0);
  assert.equal(service.status.ready, true);
});

test("已取消请求不发出新推理或远端取消", async (context) => {
  const { service } = fixture();
  let calls = 0;
  intercept(context, () => {
    calls++;
    return json({ ok: true });
  });
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(
    service.decide(profile, {}, caller.signal),
    category("AI_CANCELLED", false),
  );
  assert.equal(calls, 0);
});

test("受控时钟触发本地超时，与用户取消和worker退出严格区分", async (context) => {
  const { service } = fixture();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  intercept(context, (url, init) =>
    url.endsWith("/cancel") ? json({ ok: true }) : aborted(init),
  );
  const failure = assert.rejects(
    service.decide(profile, {}),
    category("AI_TIMEOUT", true),
  );
  context.mock.timers.tick(7000);
  await failure;
  assert.equal(service.status.ready, true);
});

test("草稿等待采用独立预算，超过旧30秒也不会被短决策限时取消", async (context) => {
  const { service, internal } = fixture();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const result = deferred<Response>();
  let cancelled = false;
  intercept(context, (_url, init) => {
    init.signal!.addEventListener("abort", () => {
      cancelled = true;
    });
    return result.promise;
  });
  const request = service.draft(
    { ...profile, draftTimeoutSec: 120 },
    "fixture",
    {},
  );
  context.mock.timers.tick(31000);
  assert.equal(cancelled, false);
  assert.equal(internal.requests.size, 1);
  result.resolve(json({ ok: true, data: { fixture: true } }));
  assert.deepEqual(await request, { fixture: true });
  assert.equal(internal.requests.size, 0);
});

test("配置超过180秒时传输层不会隐式截短，并保留取消能力", async (context) => {
  const { service } = fixture();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  intercept(context, (url, init) => {
    if (url.endsWith("/cancel")) return json({ ok: true });
    init.signal!.addEventListener("abort", () => {
      cancelled = true;
    });
    return aborted(init);
  });
  const caller = new AbortController();
  const rejected = assert.rejects(
    service.decide({ ...profile, timeoutSec: 240 }, {}, caller.signal),
    category("AI_CANCELLED", false),
  );
  context.mock.timers.tick(181000);
  assert.equal(cancelled, false);
  caller.abort();
  await rejected;
  assert.equal(cancelled, true);
});

test("worker退出立即取消请求，无需等待三次健康检查", async (context) => {
  const { service, internal } = fixture();
  intercept(context, (url, init) =>
    url.endsWith("/cancel") ? json({ ok: true }) : aborted(init),
  );
  const failure = assert.rejects(
    service.decide(profile, {}),
    category("AI_RUNTIME_UNAVAILABLE", false),
  );
  internal.runtimeFailed("fixture worker exited");
  await failure;
  assert.equal(service.status.ready, false);
});

test("无法确认旧推理取消时禁止新推理，不能当成可恢复超时", async (context) => {
  const { service } = fixture();
  intercept(context, (url, init) =>
    url.endsWith("/cancel")
      ? json({ ok: false, errorCode: "AI_CANCELLATION_PENDING" }, 503)
      : aborted(init),
  );
  const caller = new AbortController();
  const failure = assert.rejects(
    service.decide(profile, {}, caller.signal),
    category("AI_CANCELLATION_UNCONFIRMED", false),
  );
  caller.abort();
  await failure;
  assert.equal(service.status.ready, false);
  await assert.rejects(
    service.decide(profile, {}),
    category("AI_RUNTIME_UNAVAILABLE", false),
  );
});

test("旧worker的取消失败不会使新worker故障", async (context) => {
  const { service, internal } = fixture();
  const acknowledgement = deferred<Response>();
  intercept(context, (url, init) =>
    url.endsWith("/cancel") ? acknowledgement.promise : aborted(init),
  );
  const caller = new AbortController();
  const failure = assert.rejects(
    service.decide(profile, {}, caller.signal),
    category("AI_CANCELLED", false),
  );
  caller.abort();
  internal.generation++;
  acknowledgement.resolve(json({ ok: false }, 503));
  await failure;
  assert.equal(service.status.ready, true);
});

test("连接失败先确认取消，再返回可恢复的脱敏transport错误", async (context) => {
  const { service, internal } = fixture();
  let cancels = 0;
  intercept(context, (url) => {
    if (url.endsWith("/cancel")) {
      cancels++;
      return json({ ok: true });
    }
    throw new Error(`private provider response ${profile.apiKey}`);
  });
  await assert.rejects(
    service.decide(profile, {}),
    category("AI_TRANSPORT", true),
  );
  assert.equal(cancels, 1);
  assert.equal(internal.requests.size, 0);
});

for (const [code, retryable] of [
  ["AI_TIMEOUT", true],
  ["AI_RATE_LIMIT", true],
  ["AI_PROVIDER_UNAVAILABLE", true],
  ["AI_AUTH", false],
  ["AI_INVALID_TOOL_RESULT", false],
  ["AI_INVALID_DECISION", false],
] as const) {
  test(`保留远端${code}分类且不在服务层自动重试`, async (context) => {
    const { service } = fixture();
    let calls = 0;
    intercept(context, () => {
      calls++;
      return json(
        { ok: false, errorCode: code, error: `${code} ${profile.apiKey}` },
        502,
      );
    });
    await assert.rejects(
      service.decide(profile, {}),
      category(code, retryable),
    );
    assert.equal(calls, 1);
  });
}

for (const response of [
  () => new Response("malformed JSON"),
  () => json(null),
  () => json({}),
]) {
  test("无效运行时响应不是临时提供商错误", async (context) => {
    const { service } = fixture();
    intercept(context, response);
    await assert.rejects(
      service.decide(profile, {}),
      category("AI_INVALID_RESPONSE", false),
    );
  });
}
