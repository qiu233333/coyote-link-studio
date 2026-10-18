import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import { z } from "zod";
import channel from "../agent/channels/internal.ts";
import { decide } from "../agent/lib/inference.ts";
import { decisionToolSchema, validateDecision } from "../agent/lib/schemas.ts";
import type { AiProfile, ControlBounds } from "../shared/types.ts";

const bounds: ControlBounds = {
  channels: ["A", "B"],
  waveformIds: ["fixture-wave"],
  minIntensity: { A: 0, B: 0 },
  maxIntensity: { A: 20, B: 19 },
  rampPerSecond: { A: 2, B: 1 },
  allowSync: true,
  allowRandom: false,
  allowRamp: true,
  allowRest: true,
  maxActionSec: 15,
  durationSec: 600,
  decisionIntervalSec: 15,
  preference: "fixture",
};
const decision = {
  action: "adjust",
  channels: ["A", "B"],
  waveformId: "fixture-wave",
  intensity: { A: 3, B: 2 },
  durationSec: 10,
  reason: "fixture decision",
};

function context() {
  const now = Date.now();
  return {
    now,
    bounds,
    device: { connected: true, limits: { A: 20, B: 19 } },
    waveforms: [{ id: "fixture-wave", name: "fixture" }],
    run: {
      owner: "locked-task",
      status: "running",
      startedAt: now - 120000,
      deadlineAt: now + 480000,
      elapsedMs: 120000,
      stageIndex: 1,
      stageCount: 3,
      isLastStage: false,
      stageStartedAt: now - 20000,
      stageDurationSec: 90,
      stage: { id: "phase-2", durationSec: 60 },
      task: { title: "fixture", completionCriteria: "计时或用户明确反馈" },
    },
  };
}

function reply(response: ServerResponse, body: any, calls: unknown[]) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "fixture",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: calls },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

function call(input: unknown = decision, name = "submit_decision") {
  return {
    id: crypto.randomUUID(),
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

async function fixture(
  handle: (body: any, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    await handle(JSON.parse(raw), response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const profile: AiProfile = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKey: "fixture-only-key",
    apiKeySet: true,
    contextWindow: 32000,
    timeoutSec: 2,
  };
  return {
    profile,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function route(path: string) {
  const found = channel.routes.find((item) => item.path === path);
  assert.ok(found && found.transport === "http");
  return (request: Request) => found.handler(request, {} as never);
}

function internalRequest(path: string, payload: unknown, signal?: AbortSignal) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-internal-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
}

test("重复内部请求不能移除原请求的取消控制器", async () => {
  const previous = process.env.COYOTE_EVE_TOKEN;
  process.env.COYOTE_EVE_TOKEN = "fixture-internal-token";
  let received!: () => void;
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  const provider = await fixture(() => {
    received();
  });
  const abort = new AbortController();
  let pending: Promise<Response> | undefined;
  try {
    const payload = {
      requestId: crypto.randomUUID(),
      profile: provider.profile,
      context: context(),
    };
    pending = Promise.resolve(
      route("/internal/decide")(
        internalRequest("/internal/decide", payload, abort.signal),
      ),
    );
    await started;
    const duplicate = await route("/internal/decide")(
      internalRequest("/internal/decide", payload),
    );
    assert.equal(duplicate.status, 409);
    await route("/internal/cancel")(
      internalRequest("/internal/cancel", { requestId: payload.requestId }),
    );
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("取消未送达原请求")), 500),
      ),
    ]);
    assert.equal(result.status, 502);
    assert.equal((await result.json()).errorCode, "AI_CANCELLED");
  } finally {
    abort.abort();
    await pending?.catch(() => undefined);
    await provider.close();
    if (previous === undefined) delete process.env.COYOTE_EVE_TOKEN;
    else process.env.COYOTE_EVE_TOKEN = previous;
  }
});

test("模型接收控制器快照的当前阶段计时及动态总时长", async () => {
  const input = context();
  let sent: any;
  const provider = await fixture((body, response) => {
    const prompt = body.messages.find(
      (message: any) => message.role === "user",
    ).content;
    sent = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
    reply(response, body, [call()]);
  });
  try {
    assert.deepEqual(
      (await decide(provider.profile, input, new AbortController().signal))
        .intensity,
      { A: 3, B: 2 },
    );
    assert.equal(sent.now, input.now);
    assert.equal(sent.run.stageStartedAt, input.run.stageStartedAt);
    assert.equal(sent.run.stageIndex, 1);
    assert.equal(sent.run.stageCount, 3);
    assert.equal(sent.run.isLastStage, false);
    assert.equal(sent.run.stageElapsedSec, 20);
    assert.equal(sent.run.stageDurationSec, 90);
    assert.equal(sent.run.stageRemainingSec, 70);
    assert.equal(sent.run.elapsedMs, 120000);
    assert.equal(sent.run.remainingSec, 480);
    input.run.stageIndex = 2;
    input.run.isLastStage = true;
    await decide(provider.profile, input, new AbortController().signal);
    assert.equal(sent.run.stageIndex, 2);
    assert.equal(sent.run.stageCount, 3);
    assert.equal(sent.run.isLastStage, true);
  } finally {
    await provider.close();
  }
});

test("阶段总时长工具上限与已有最晚截止规则一致", () => {
  const input = context();
  const schema = z.toJSONSchema(decisionToolSchema(input)) as any;
  assert.equal(schema.properties.stageDurationSec.maximum, 500);
  assert.equal(
    validateDecision({ ...decision, stageDurationSec: 500 }, input)
      .stageDurationSec,
    500,
  );
  assert.throws(() =>
    validateDecision({ ...decision, stageDurationSec: 501 }, input),
  );
});

test("正常完成建议保持语义，异常工具和接口结果返回独立脱敏类别", async () => {
  const previous = process.env.COYOTE_EVE_TOKEN;
  process.env.COYOTE_EVE_TOKEN = "fixture-internal-token";
  const provider = await fixture((body, response) => {
    const statuses: Record<string, number> = {
      auth: 401,
      missing: 404,
      rate: 429,
      unavailable: 503,
    };
    if (statuses[body.model]) {
      response.writeHead(statuses[body.model], {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: {
            message: "fixture-private-message-and-key",
            type: "fixture",
          },
        }),
      );
      return;
    }
    let calls: unknown[] = [call()];
    if (body.model === "none") calls = [];
    if (body.model === "multiple") calls.push(call());
    if (body.model === "wrong") calls = [call(decision, "unavailable_tool")];
    if (body.model === "malformed")
      calls = [
        {
          ...call(),
          function: { name: "submit_decision", arguments: "{invalid" },
        },
      ];
    if (body.model === "scalar") calls = [call({ ...decision, intensity: 10 })];
    if (body.model === "invalid-business")
      calls = [call({ ...decision, channels: ["A"] })];
    if (body.model === "rest")
      calls = [
        call({ ...decision, action: "rest", intensity: { A: 0, B: 0 } }),
      ];
    if (body.model === "finish")
      calls = [
        call({ ...decision, action: "finish", intensity: { A: 0, B: 0 } }),
      ];
    if (body.model === "phase")
      calls = [call({ ...decision, phaseComplete: true })];
    reply(response, body, calls);
  });
  try {
    for (const model of ["fixture", "rest", "finish", "phase"]) {
      const result = await route("/internal/decide")(
        internalRequest("/internal/decide", {
          requestId: crypto.randomUUID(),
          profile: { ...provider.profile, model },
          context: context(),
        }),
      );
      const body = await result.json();
      assert.equal(body.ok, true, model);
      assert.equal(
        body.data.action,
        model === "rest" || model === "finish" ? model : "adjust",
      );
      assert.equal(
        body.data.phaseComplete,
        model === "phase" ? true : undefined,
      );
    }
    const expected: Record<string, string> = {
      none: "AI_INVALID_TOOL_RESULT",
      multiple: "AI_INVALID_TOOL_RESULT",
      wrong: "AI_INVALID_TOOL_RESULT",
      malformed: "AI_INVALID_TOOL_RESULT",
      scalar: "AI_INVALID_TOOL_RESULT",
      "invalid-business": "AI_INVALID_DECISION",
      auth: "AI_AUTH",
      missing: "AI_MODEL_NOT_FOUND",
      rate: "AI_RATE_LIMIT",
      unavailable: "AI_PROVIDER_UNAVAILABLE",
    };
    for (const [model, code] of Object.entries(expected)) {
      const result = await route("/internal/decide")(
        internalRequest("/internal/decide", {
          requestId: crypto.randomUUID(),
          profile: { ...provider.profile, model },
          context: context(),
        }),
      );
      const body = await result.json();
      assert.equal(body.ok, false, model);
      assert.equal(body.errorCode, code, model);
      assert.ok(!JSON.stringify(body).includes("fixture-private"));
      assert.ok(!JSON.stringify(body).includes(provider.profile.apiKey));
    }
  } finally {
    await provider.close();
    if (previous === undefined) delete process.env.COYOTE_EVE_TOKEN;
    else process.env.COYOTE_EVE_TOKEN = previous;
  }
});

test("取消墓碑拦住晚到的旧请求但不影响新请求，推理超时与主动取消分开", async () => {
  const previous = process.env.COYOTE_EVE_TOKEN;
  process.env.COYOTE_EVE_TOKEN = "fixture-internal-token";
  let calls = 0;
  const provider = await fixture((body, response) => {
    calls++;
    if (body.model !== "slow") reply(response, body, [call()]);
  });
  try {
    const cancelled = crypto.randomUUID();
    await route("/internal/cancel")(
      internalRequest("/internal/cancel", { requestId: cancelled }),
    );
    const late = await route("/internal/decide")(
      internalRequest("/internal/decide", {
        requestId: cancelled,
        profile: provider.profile,
        context: context(),
      }),
    );
    assert.equal(late.status, 409);
    assert.equal(calls, 0);
    const fresh = await route("/internal/decide")(
      internalRequest("/internal/decide", {
        requestId: crypto.randomUUID(),
        profile: provider.profile,
        context: context(),
      }),
    );
    assert.equal((await fresh.json()).ok, true);
    const timeout = await route("/internal/decide")(
      internalRequest("/internal/decide", {
        requestId: crypto.randomUUID(),
        profile: { ...provider.profile, model: "slow" },
        context: context(),
      }),
    );
    assert.equal((await timeout.json()).errorCode, "AI_TIMEOUT");
    assert.equal(calls, 2);
  } finally {
    await provider.close();
    if (previous === undefined) delete process.env.COYOTE_EVE_TOKEN;
    else process.env.COYOTE_EVE_TOKEN = previous;
  }
});
