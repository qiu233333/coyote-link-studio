import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseStoryResult } from "../agent/lib/storyResult.ts";
import { story } from "../agent/lib/roleplay.ts";
import { replySchema, emptyMemory } from "../shared/roleplay.ts";
import type { AiProfile } from "../shared/types.ts";

const reply = {
  narration: "她递来一杯茶。",
  dialogue: "接下来想去哪里？",
  memory: {
    recentPlot: "喝茶",
    plotBackground: "客厅",
    longPlot: "",
    longDialogue: "",
  },
  control: { action: "update", channels: { A: { target: 3 } } },
  controlReason: "轻微变化",
};
const call = (input: unknown = reply, toolName = "submit_roleplay") => ({
  toolName,
  input,
});
const parse = (toolCalls: ReturnType<typeof call>[], text = "") =>
  parseStoryResult(replySchema, "submit_roleplay", { toolCalls, text });

test("story result accepts strict single documents and semantically identical duplicate calls", () => {
  assert.deepEqual(parse([call()]), reply);
  assert.deepEqual(
    parse([call(), call(Object.fromEntries(Object.entries(reply).reverse()))]),
    reply,
  );
  assert.deepEqual(parse([call(JSON.stringify(reply))]), reply);
  for (const text of [
    JSON.stringify(reply),
    `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``,
    JSON.stringify({ name: "submit_roleplay", arguments: reply }),
  ])
    assert.deepEqual(parse([], text), reply);
});

test("story result rejects conflicting proposals, prose, unexpected tools and coerced device values", () => {
  for (const result of [
    {
      toolCalls: [call(), call({ ...reply, control: { action: "keep" } })],
      text: "",
    },
    { toolCalls: [call(reply, "shell")], text: JSON.stringify(reply) },
    {
      toolCalls: [
        call({
          ...reply,
          control: { action: "update", channels: { A: { target: "3" } } },
        }),
      ],
      text: "",
    },
    { toolCalls: [], text: "她微笑着说：\n" + JSON.stringify(reply) },
    { toolCalls: [], text: JSON.stringify(reply) + JSON.stringify(reply) },
    { toolCalls: [], text: JSON.stringify({ ...reply, hiddenCommand: "run" }) },
    { toolCalls: [], text: "" },
  ])
    assert.throws(() =>
      parseStoryResult(replySchema, "submit_roleplay", result),
    );
});

test("SDK named-tool and DeepSeek thinking responses recover complete text JSON without exposing reasoning", async () => {
  let mode = "single",
    calls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += String(part);
    const body = JSON.parse(raw);
    calls++;
    const tool = (value: unknown = reply, name = "submit_roleplay") => ({
      id: crypto.randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(value) },
    });
    const content =
      mode === "json" || mode === "truncated"
        ? JSON.stringify(reply)
        : mode === "fenced"
          ? `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``
          : mode === "prose"
            ? "普通叙事，不能提取命令。"
            : null;
    const tools =
      mode === "single"
        ? [tool()]
        : mode === "duplicate"
          ? [tool(), tool()]
          : mode === "conflict"
            ? [tool(), tool({ ...reply, control: { action: "keep" } })]
            : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              reasoning_content:
                mode === "reasoning"
                  ? JSON.stringify(reply)
                  : "private-reasoning-must-not-be-returned",
              ...(tools ? { tool_calls: tools } : {}),
            },
            finish_reason:
              mode === "truncated" ? "length" : tools ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const profile: AiProfile = {
      provider: "deepseek",
      deepseekThinking: "disabled",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      apiKey: "fixture-key",
      apiKeySet: true,
      model: "fixture",
      contextWindow: 32000,
      timeoutSec: 60,
    };
    for (const thinking of ["disabled", "enabled"] as const) {
      profile.deepseekThinking = thinking;
      for (mode of ["single", "duplicate", "json", "fenced"]) {
        const result = await story(
          "roleplay",
          profile,
          { memory: emptyMemory(), authorization: null },
          AbortSignal.timeout(10000),
        );
        assert.deepEqual(result, reply, `${thinking}/${mode}`);
      }
      for (mode of ["conflict", "prose", "reasoning", "truncated"])
        await assert.rejects(() =>
          story("roleplay", profile, {}, AbortSignal.timeout(10000)),
        );
    }
    assert.equal(calls, 16);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
