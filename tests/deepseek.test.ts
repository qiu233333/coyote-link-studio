import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { decide, draft, test as probe } from "../agent/lib/inference.ts";
import { safeInferenceError } from "../agent/lib/errors.ts";
import { model } from "../agent/lib/provider.ts";
import { aiProvider, DEEPSEEK_PRESET } from "../shared/aiProvider.ts";
import { Store } from "../server/store.ts";
import { AiService } from "../server/ai.ts";
import type { AiProfile, ControlBounds } from "../shared/types.ts";

const key = "fake-deepseek-contract-key";
const reasoning = "fixture-only-private-reasoning";
const bounds: ControlBounds = {
  channels: ["A", "B"],
  waveformIds: ["wave"],
  minIntensity: { A: 0, B: 0 },
  maxIntensity: { A: 20, B: 19 },
  rampPerSecond: { A: 2, B: 1 },
  allowSync: true,
  allowRandom: false,
  allowRamp: true,
  allowRest: true,
  maxActionSec: 15,
  durationSec: 90,
  decisionIntervalSec: 5,
  preference: "fixture",
};
const context = {
  bounds,
  device: { connected: true, limits: { A: 20, B: 19 } },
  waveforms: [{ id: "wave", name: "fixture" }],
  feedback: [{ role: "user", text: "只调整 B" }],
};
const decision = {
  action: "adjust",
  channels: ["A", "B"],
  waveformId: "wave",
  intensity: { A: 20, B: 5 },
  durationSec: 10,
  reason: "fixture",
};
const plan = {
  title: "fixture",
  description: "fixture",
  completionCriteria: "按计时或反馈",
  bounds,
  stages: [
    {
      id: "one",
      name: "fixture",
      durationSec: 30,
      gapSec: 0,
      channels: ["A", "B"],
      waveformId: "wave",
      intensity: { A: 5, B: 2 },
      startIntensity: { A: 0, B: 0 },
      behavior: "hold",
    },
  ],
};

function toolCall(name: string, input: unknown) {
  return {
    id: crypto.randomUUID(),
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}
function reply(
  res: ServerResponse,
  body: any,
  message: any,
  finish = "tool_calls",
) {
  res.writeHead(200, { "content-type": "application/json" });
  // DeepSeek may send whitespace while a non-streaming inference is pending.
  res.end(
    " \n" +
      JSON.stringify({
        id: "contract",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", ...message },
            finish_reason: finish,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
  );
}
async function fixture(
  t: TestContext,
  handler?: (body: any, response: ServerResponse) => void,
) {
  const seen: any[] = [],
    failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      assert.equal(req.url, "/chat/completions");
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.ok(!raw.includes(key));
      const body = JSON.parse(raw);
      seen.push(body);
      assert.equal(body.response_format, undefined);
      assert.ok(
        body.tools?.every((item: any) => item.function.strict !== true) ?? true,
      );
      if (body.thinking?.type === "enabled") {
        assert.ok(
          [undefined, "auto", "none"].includes(body.tool_choice),
          "thinking rejects forced tools",
        );
        assert.equal(body.reasoning_effort, "high");
        assert.ok(body.max_tokens >= 8192);
      }
      if (handler) return handler(body, res);
      const name = body.tools?.[0]?.function.name;
      const result = body.messages.findLast((m: any) => m.role === "tool");
      if (result) {
        const assistant = body.messages.findLast(
          (m: any) => m.role === "assistant",
        );
        assert.equal(result.tool_call_id, assistant.tool_calls[0].id);
        if (body.thinking.type === "enabled")
          assert.equal(
            assistant.reasoning_content,
            body.model === "empty-reasoning" ? "" : reasoning,
          );
        reply(
          res,
          body,
          { content: JSON.parse(result.content).receipt },
          "stop",
        );
      } else if (!name) reply(res, body, { content: "连接成功" }, "stop");
      else {
        const input =
          name === "submit_task_draft"
            ? plan
            : name === "submit_decision"
              ? decision
              : {
                  token: JSON.stringify(body.messages).match(
                    /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/,
                  )?.[0],
                };
        reply(res, body, {
          content: null,
          reasoning_content:
            body.thinking?.type === "enabled"
              ? body.model === "empty-reasoning"
                ? ""
                : reasoning
              : undefined,
          tool_calls: [toolCall(name, input)],
        });
      }
    } catch (error) {
      failures.push(error);
      res.writeHead(500);
      res.end("fixture assertion failed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.deepEqual(failures, []);
  });
  const profile: AiProfile = {
    ...DEEPSEEK_PRESET,
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: key,
    apiKeySet: true,
    timeoutSec: 5,
    draftTimeoutSec: 10,
  };
  return { profile, seen };
}
function directory(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), "coyote-deepseek-"));
  t.after(() => {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith("coyote-deepseek-"));
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

test("DeepSeek 设置迁移、密钥绑定与密文存储；变更失败保持原配置", (t) => {
  const folder = directory(t),
    store = new Store(folder);
  try {
    store.saveSettings({
      baseUrl: "https://other.example/v1",
      model: "custom",
      apiKey: key,
    });
    const previous = store.settings();
    assert.throws(
      () => store.saveSettings(DEEPSEEK_PRESET),
      /旧密钥不会自动转发/,
    );
    assert.deepEqual(store.settings(), previous);
    assert.throws(
      () => store.saveSettings({ baseUrl: "https://other.example/other" }),
      /旧密钥/,
    );
    store.saveSettings({
      ...DEEPSEEK_PRESET,
      apiKey: "deepseek-specific-fixture",
    });
    store.saveSettings({
      model: "deepseek-v4-pro",
      deepseekThinking: "enabled",
    });
    assert.equal(store.profile().apiKey, "deepseek-specific-fixture");
    assert.equal(store.settings().deepseekThinking, "enabled");
    assert.ok(!JSON.stringify(store.settings()).includes("deepseek-specific"));
    assert.ok(
      !JSON.stringify(store.get("settings", "ai")).includes(
        "deepseek-specific",
      ),
    );
    assert.throws(
      () =>
        store.saveSettings({
          ...DEEPSEEK_PRESET,
          baseUrl: "http://127.0.0.1:1",
        }),
      /旧密钥/,
    );
    assert.throws(() => store.saveSettings({ deepseekThinking: "bogus" }));
    store.saveSettings({ apiKey: "" });
    assert.equal(store.settings().apiKeySet, false);
    store.saveSettings({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    assert.equal(store.settings().provider, "openai-compatible");
    store.set("settings", "ai", {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      timeoutSec: 30,
    });
    assert.equal(store.settings().provider, "deepseek");
    assert.equal(store.settings().deepseekThinking, "disabled");
    assert.equal(store.settings().timeoutSec, 30);
    assert.equal(store.settings().draftTimeoutSec, 180);
    assert.equal(
      aiProvider({ baseUrl: "https://api.deepseek.com.evil.invalid" }),
      "openai-compatible",
    );
    assert.ok(
      !readFileSync(join(folder, "coyote.sqlite")).includes(Buffer.from(key)),
    );
  } finally {
    store.close();
  }
});

for (const mode of ["disabled", "enabled"] as const) {
  test(`DeepSeek ${mode}：聊天、真实工具回传、草稿和 A/B 决策契约`, async (t) => {
    const { profile, seen } = await fixture(t);
    profile.deepseekThinking = mode;
    assert.equal((await probe(profile, AbortSignal.timeout(5000))).tools, true);
    const result = await decide(profile, context, AbortSignal.timeout(5000));
    assert.deepEqual(result.intensity, { A: 20, B: 5 });
    assert.ok(!JSON.stringify(result).includes(reasoning));
    assert.deepEqual(
      await draft(profile, "fixture", context, AbortSignal.timeout(5000)),
      plan,
    );
    assert.equal(seen.length, 5);
    for (const body of seen) assert.equal(body.thinking.type, mode);
    if (mode === "disabled")
      assert.equal(seen[1].tool_choice.function.name, "connection_probe");
    assert.ok(
      !seen[3].messages.some(
        (m: any) => m.role === "tool" || m.role === "assistant",
      ),
      "decisions use fresh snapshots, no orphan tool history",
    );
    assert.equal(
      seen[3].tools[0].function.parameters.properties.intensity.properties.B
        .maximum,
      19,
    );
  });
}

test("自定义服务保留原有协议，不注入 DeepSeek 参数；缺少密钥在发送前失败", async (t) => {
  const { profile, seen } = await fixture(t);
  await decide(
    { ...profile, provider: "openai-compatible" },
    context,
    AbortSignal.timeout(5000),
  );
  assert.equal(seen[0].thinking, undefined);
  assert.equal(seen[0].reasoning_effort, undefined);
  assert.throws(() => model({ ...profile, apiKey: "" }), /AI_KEY_REQUIRED/);
  assert.equal(seen.length, 1);
});

test("DeepSeek 无效、越界、截断与服务错误均不接受为动作，错误不泄露原文", async (t) => {
  const { profile } = await fixture(t, (body, res) => {
    const status = Number(body.model);
    if (status) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `${key} ${reasoning}`, type: "fixture" },
        }),
      );
      return;
    }
    let calls = [toolCall("submit_decision", decision)],
      finish = "tool_calls";
    if (body.model === "empty") calls = [];
    if (body.model === "multiple")
      calls.push(toolCall("submit_decision", decision));
    if (body.model === "malformed") calls[0].function.arguments = "{broken";
    if (body.model === "over")
      calls = [
        toolCall("submit_decision", {
          ...decision,
          intensity: { A: 20, B: 20 },
        }),
      ];
    if (body.model === "scalar")
      calls = [toolCall("submit_decision", { ...decision, intensity: 5 })];
    if (
      [
        "length",
        "content_filter",
        "insufficient_system_resource",
        "aborted",
      ].includes(body.model)
    )
      finish = body.model;
    reply(
      res,
      body,
      { content: null, reasoning_content: reasoning, tool_calls: calls },
      finish,
    );
  });
  const cases: Record<string, string> = {
    empty: "AI_INVALID_TOOL_RESULT",
    multiple: "AI_INVALID_TOOL_RESULT",
    malformed: "AI_INVALID_TOOL_RESULT",
    over: "AI_INVALID_TOOL_RESULT",
    scalar: "AI_INVALID_TOOL_RESULT",
    length: "AI_OUTPUT_TRUNCATED",
    content_filter: "AI_CONTENT_FILTER",
    insufficient_system_resource: "AI_PROVIDER_UNAVAILABLE",
    aborted: "AI_PROVIDER_UNAVAILABLE",
    400: "AI_PARAMETERS",
    401: "AI_AUTH",
    402: "AI_BALANCE",
    404: "AI_MODEL_NOT_FOUND",
    422: "AI_PARAMETERS",
    429: "AI_RATE_LIMIT",
    500: "AI_PROVIDER_UNAVAILABLE",
    503: "AI_PROVIDER_UNAVAILABLE",
  };
  for (const [model, code] of Object.entries(cases)) {
    await assert.rejects(
      decide(
        { ...profile, model, deepseekThinking: "enabled" },
        context,
        AbortSignal.timeout(5000),
      ),
      (error) => {
        const classified = safeInferenceError(error);
        assert.equal(classified.errorCode, code, model);
        assert.ok(!JSON.stringify(classified).includes(key));
        assert.ok(!JSON.stringify(classified).includes(reasoning));
        return true;
      },
    );
  }
});

test(
  "DeepSeek eve 构建产物端到端与单一在途请求；取消后可继续",
  { timeout: 60000 },
  async (t) => {
    const { profile, seen } = await fixture(t);
    const folder = directory(t),
      service = new AiService({ runtimeDirectory: folder });
    try {
      await service.start();
      for (const deepseekThinking of ["disabled", "enabled"] as const) {
        const selected = { ...profile, deepseekThinking };
        assert.equal((await service.test(selected)).tools, true);
        assert.deepEqual(await service.decide(selected, context), decision);
        assert.deepEqual(
          await service.draft(selected, "fixture", context),
          plan,
        );
      }
      const pending = service.test(profile);
      await assert.rejects(
        service.draft(profile, "fixture", context),
        (error: any) => error.code === "AI_BUSY",
      );
      await pending;
      assert.equal(service.busy, false);
      const controller = new AbortController();
      controller.abort();
      const before = seen.length;
      await assert.rejects(
        service.decide(profile, context, controller.signal),
        (error: any) => error.code === "AI_CANCELLED",
      );
      assert.equal(seen.length, before);
      assert.deepEqual(await service.decide(profile, context), decision);
    } finally {
      await service.stop();
    }
    for (const file of readdirSync(folder, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!file.isFile()) continue;
      const content = readFileSync(join(file.parentPath, file.name));
      assert.ok(
        !content.includes(Buffer.from(key)),
        "worker must not persist credentials",
      );
      assert.ok(
        !content.includes(Buffer.from(reasoning)),
        "worker must not persist reasoning",
      );
    }
  },
);

test("接口重定向不能把密钥转发到另一路径", async (t) => {
  const { profile, seen } = await fixture(t, (_body, res) => {
    res.writeHead(307, { location: "/credential-sink" });
    res.end();
  });
  await assert.rejects(decide(profile, context, AbortSignal.timeout(5000)));
  assert.equal(seen.length, 1);
});

test("思考模式空 reasoning_content 仍能完整回传工具历史", async (t) => {
  const { profile } = await fixture(t);
  const result = await probe(
    { ...profile, model: "empty-reasoning", deepseekThinking: "enabled" },
    AbortSignal.timeout(5000),
  );
  assert.equal(result.tools, true);
});

test("只返回文本或错误回执不能通过 DeepSeek 工具测试", async (t) => {
  const { profile } = await fixture(t, (body, res) => {
    const name = body.tools?.[0]?.function.name;
    if (
      name &&
      !body.messages.some((m: any) => m.role === "tool") &&
      body.model === "wrong-receipt"
    ) {
      const token = JSON.stringify(body.messages).match(
        /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/,
      )?.[0];
      reply(res, body, {
        content: null,
        tool_calls: [toolCall(name, { token })],
      });
    } else
      reply(
        res,
        body,
        { content: body.model === "empty-chat" ? "" : "连接成功" },
        "stop",
      );
  });
  for (const model of ["text-only", "wrong-receipt", "empty-chat"]) {
    const result = await probe(
      { ...profile, model },
      AbortSignal.timeout(5000),
    );
    assert.equal(result.tools, false, model);
    assert.equal(result.chat, model !== "empty-chat");
  }
});
