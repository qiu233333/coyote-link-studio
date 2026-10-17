/** Local fixture integration; makes no request to a real provider or device. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AiService } from "../server/ai.ts";
import type { AiProfile, ControlBounds } from "../shared/types.ts";

export async function verifyAiRuntime(): Promise<void> {
  const bounds: ControlBounds = {
    channels: ["A"],
    waveformIds: ["fixture-wave"],
    minIntensity: 0,
    maxIntensity: 5,
    rampPerSecond: 1,
    allowSync: false,
    allowRandom: false,
    allowRamp: true,
    allowRest: true,
    maxActionSec: 15,
    durationSec: 60,
    decisionIntervalSec: 15,
    preference: "平稳",
  };
  const plan = {
    title: "本地测试草稿",
    description: "仅测试推理接口，不控制设备。",
    completionCriteria: "计时结束或用户反馈完成",
    bounds,
    stages: [
      {
        id: "stage-1",
        name: "保持",
        durationSec: 30,
        gapSec: 0,
        channels: ["A"],
        waveformId: "fixture-wave",
        intensity: 3,
        startIntensity: 0,
        behavior: "hold",
      },
    ],
  };
  const secret = "fixture-key-do-not-persist";
  let calls = 0;
  let providerCancelledResolve: () => void = () => undefined;
  const providerCancelled = new Promise<void>((resolve) => {
    providerCancelledResolve = resolve;
  });
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    assert.ok(!raw.includes(secret), "凭证不能进入模型提示词");
    calls++;
    const body = JSON.parse(raw);
    if (body.model === "error-fixture") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: secret, type: "authentication_error" },
        }),
      );
      return;
    }
    if (body.model === "slow-fixture") {
      response.once("close", () => {
        if (!response.writableEnded) providerCancelledResolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const name = body.tools?.[0]?.function?.name;
    const messages = JSON.stringify(body.messages);
    if (name === "submit_decision") {
      assert.ok(
        messages.includes("文字反馈测试标记"),
        "控制器反馈必须送达模型",
      );
      assert.ok(messages.includes("本地测试草稿"), "锁定任务说明必须送达模型");
      assert.ok(messages.includes("保持"), "当前阶段必须送达模型");
    }
    const input =
      name === "connection_probe"
        ? {
            token: messages.match(
              /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/,
            )?.[0],
          }
        : name === "submit_task_draft"
          ? plan
          : {
              action: "adjust",
              channels: ["A"],
              waveformId: "fixture-wave",
              intensity: body.model === "bad-fixture" ? 100 : 3,
              durationSec: 10,
              reason: "按授权范围平稳调整",
            };
    const message =
      name && body.model !== "no-tools-fixture"
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call-${calls}`,
                type: "function",
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          }
        : { role: "assistant", content: "连接成功" };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `fixture-${calls}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          { index: 0, message, finish_reason: name ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const profile: AiProfile = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKey: secret,
    apiKeySet: true,
    contextWindow: 32000,
    timeoutSec: 10,
  };
  const context = {
    bounds,
    channels: { A: { limit: 5 }, B: { limit: 0 } },
    waveforms: [{ id: "fixture-wave", name: "测试波形" }],
    run: {
      owner: "locked-task",
      stageIndex: 0,
      stage: plan.stages[0],
      task: {
        title: plan.title,
        description: plan.description,
        completionCriteria: plan.completionCriteria,
      },
      feedback: [{ role: "user", text: "文字反馈测试标记" }],
    },
  };
  const service = new AiService();
  try {
    await service.start();
    assert.equal(service.status.ready, true);
    const internal = service as unknown as { endpoint: string; token: string };
    assert.equal(
      (await fetch(`${internal.endpoint}/internal/health`)).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${internal.endpoint}/internal/health`, {
          headers: {
            authorization: `Bearer ${internal.token}`,
            origin: "http://evil.invalid",
          },
        })
      ).status,
      401,
    );
    const tested = await service.test(profile);
    assert.equal(tested.chat, true);
    assert.equal(tested.tools, true);
    const unsupported = await service.test({
      ...profile,
      model: "no-tools-fixture",
    });
    assert.equal(unsupported.chat, true);
    assert.equal(unsupported.tools, false);
    const decision = await service.decide(profile, context);
    assert.equal(decision.intensity, 3);
    const draft = await service.draft(profile, "生成一个平稳的任务", context);
    assert.equal(draft.title, plan.title);
    await assert.rejects(
      service.decide({ ...profile, model: "bad-fixture" }, context),
    );
    await assert.rejects(
      service.test({ ...profile, model: "error-fixture" }),
      (error) => !String(error).includes(secret),
    );
    const cancel = new AbortController();
    const pending = service.decide(
      { ...profile, model: "slow-fixture" },
      context,
      cancel.signal,
    );
    setTimeout(() => cancel.abort(), 100);
    await assert.rejects(pending, /取消/);
    await Promise.race([
      providerCancelled,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("取消必须传播到提供商连接")), 1000),
      ),
    ]);
    assert.ok(calls >= 9);
    console.log(
      "PASS eve 独立进程：实际聊天、工具调用、草稿、范围拒绝、凭证脱敏、内部鉴权与取消。",
    );
  } finally {
    await service.stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await verifyAiRuntime();
