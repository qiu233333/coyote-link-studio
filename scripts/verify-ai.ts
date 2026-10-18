/** Local fixture integration; makes no request to a real provider or device. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AiService } from "../server/ai.ts";
import type { AiProfile, ControlBounds } from "../shared/types.ts";

export async function verifyAiRuntime(): Promise<void> {
  const bounds: ControlBounds = {
    channels: ["A"],
    waveformIds: ["fixture-wave"],
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { A: 20, B: 19 },
    rampPerSecond: { A: 2, B: 1 },
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
        intensity: { A: 3, B: 0 },
        startIntensity: { A: 0, B: 0 },
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
    if (body.model === "slow-draft-fixture")
      await new Promise((resolve) => setTimeout(resolve, 2500));
    const name = body.tools?.[0]?.function?.name;
    const messages = JSON.stringify(body.messages);
    if (name === "submit_decision") {
      assert.ok(
        messages.includes("文字反馈测试标记"),
        "控制器反馈必须送达模型",
      );
      assert.ok(messages.includes("本地测试草稿"), "锁定任务说明必须送达模型");
      assert.ok(messages.includes("保持"), "当前阶段必须送达模型");
      const intensity = body.tools[0].function.parameters.properties.intensity;
      assert.equal(intensity.type, "object", "强度工具必须使用完整 A/B 对象");
      assert.equal(intensity.properties.A.maximum, 20);
      assert.equal(
        intensity.properties.B.maximum,
        body.model.startsWith("dual-") ? 19 : 0,
      );
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
              channels: body.model.startsWith("dual-") ? ["A", "B"] : ["A"],
              waveformId: "fixture-wave",
              intensity:
                body.model === "scalar-fixture"
                  ? 3
                  : {
                      A:
                        body.model === "bad-fixture" ||
                        body.model === "dual-a-over-fixture"
                          ? 100
                          : body.model.startsWith("dual-")
                            ? 20
                            : 3,
                      B:
                        body.model === "dual-b-over-fixture"
                          ? 20
                          : body.model.startsWith("dual-")
                            ? 19
                            : body.model === "unselected-fixture"
                              ? 1
                              : 0,
                    },
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
    channels: { A: { limit: 0 }, B: { limit: 0 } },
    device: { limits: { A: 20, B: 19 }, connected: true },
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
  const directory = await mkdtemp(resolve(tmpdir(), "coyote-ai-runtime-"));
  const service = new AiService({ runtimeDirectory: directory });
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
    assert.deepEqual(decision.intensity, { A: 3, B: 0 });
    const dualContext = {
      ...context,
      bounds: { ...bounds, channels: ["A", "B"], allowSync: true },
    };
    const dualDecision = await service.decide(
      { ...profile, model: "dual-fixture" },
      dualContext,
    );
    assert.deepEqual(
      dualDecision.intensity,
      { A: 20, B: 19 },
      "双通道不受共同较低上限影响",
    );
    for (const model of ["dual-a-over-fixture", "dual-b-over-fixture"])
      await assert.rejects(service.decide({ ...profile, model }, dualContext));
    for (const model of ["scalar-fixture", "unselected-fixture"])
      await assert.rejects(service.decide({ ...profile, model }, context));
    const draft = await service.draft(profile, "生成一个平稳的任务", context);
    assert.equal(draft.title, plan.title);
    const slowDraft = await service.draft(
      {
        ...profile,
        model: "slow-draft-fixture",
        timeoutSec: 2,
        draftTimeoutSec: 5,
      },
      "生成一个平稳的任务",
      context,
    );
    assert.equal(slowDraft.title, plan.title, "草稿不使用较短的控制决策预算");
    await assert.rejects(
      service.draft(
        {
          ...profile,
          model: "slow-draft-fixture",
          timeoutSec: 5,
          draftTimeoutSec: 2,
        },
        "生成一个平稳的任务",
        context,
      ),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "AI_TIMEOUT");
        assert.match(String(error), /任务草稿生成超时：2 秒/);
        return true;
      },
    );
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
      "PASS eve 独立进程：实际聊天、A/B 工具与草稿、独立草稿限时与慢响应、两路范围拒绝、凭证脱敏、内部鉴权与取消。",
    );
  } finally {
    await service.stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    const verified = resolve(directory);
    assert.ok(
      dirname(verified) === resolve(tmpdir()) &&
        basename(verified).startsWith("coyote-ai-runtime-"),
    );
    await rm(verified, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await verifyAiRuntime();
