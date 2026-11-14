import assert from "node:assert/strict";
import test from "node:test";
import { redactPreview, storyPreview } from "../agent/lib/storyPreview.ts";
import { mergeStoryMessages, StoryFeedClient } from "../src/storyFeedClient.ts";
import type {
  StoryBootstrap,
  StorySignal,
  StorySync,
} from "../shared/storyFeed.ts";
import type { StoryMessage } from "../shared/roleplay.ts";

test("arbitrary JSON prefixes decode only root prose and never emit a split escape or surrogate", () => {
  const raw =
    '{"memory":{"dialogue":"内部记忆","narration":"保密"},"control":{"target":8},"narr\\u0061tion":"灯亮了\\n他问：\\\"好？\\\" \\uD83C\\uDF19","dialogue":"中文\\\\台词","reasoning":"内部推理"}';
  const expected = {
    narration: '灯亮了\n他问："好？" 🌙',
    dialogue: "中文\\台词",
  };
  for (let i = 0; i <= raw.length; i++) {
    const current = storyPreview(raw.slice(0, i));
    assert.ok(
      expected.narration.startsWith(current.narration),
      JSON.stringify(current),
    );
    assert.ok(
      expected.dialogue.startsWith(current.dialogue),
      JSON.stringify(current),
    );
    assert.doesNotMatch(current.narration, /[\uD800-\uDBFF]$/);
  }
  assert.deepEqual(storyPreview(raw), expected);
  assert.deepEqual(storyPreview('内部推理 {"narration":"不能显示"}'), {
    narration: "",
    dialogue: "",
  });
  assert.deepEqual(
    storyPreview('{"dialogue":["nested"],"dialogue":"duplicate"}'),
    { narration: "", dialogue: "" },
  );
  assert.equal(redactPreview("正文 token-pri", "token-private"), "正文 ");
  assert.equal(
    redactPreview("正文 token-private 结尾", "token-private"),
    "正文 [已隐藏] 结尾",
  );
});

const signal = (
  serial: number,
  version: number,
  instance = "service",
): StorySignal => ({
  serial,
  version,
  instance,
  memoryVersion: 1,
  bookmarkVersion: 1,
});
const item = (seq: number): StoryMessage => ({
  id: `msg-${seq}`,
  seq,
  sessionId: "story",
  at: seq,
  role: "assistant",
  text: String(seq),
  nodeRound: seq,
});
const baseline = {
  signal: signal(1, 1),
  story: { id: "story", storyState: { version: 0 } },
  items: [item(1)],
} as StoryBootstrap;
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};

test("stream notifications coalesce; late and missing events reconcile by cursor", async (t) => {
  let receive: ((e: MessageEvent<string>) => void) | null = null;
  const source = {
    onerror: null,
    get onmessage() {
      return receive;
    },
    set onmessage(value: typeof receive) {
      receive = value;
    },
    close() {},
  };
  const calls: URLSearchParams[] = [];
  const deliver: ((value: StorySync) => void)[] = [];
  let messages = baseline.items;
  const client = new StoryFeedClient(
    baseline,
    (params) => {
      calls.push(params);
      return new Promise((resolve) => deliver.push(resolve));
    },
    () => source,
    (delta) => {
      messages = mergeStoryMessages(messages, delta.items, delta.bookmarks);
    },
    (error) => assert.equal(error, ""),
  );
  t.after(() => client.stop());
  client.start();
  const emit = (value: StorySignal) =>
    receive?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  const preview = {
    turnId: "turn",
    attemptId: 2,
    startedAt: 1,
    phaseAt: 1,
    phase: "generating" as const,
    preview: { narration: "新尝试", dialogue: "" },
  };
  emit({ ...signal(5, 4), progress: preview });
  emit({ ...signal(5, 4), progress: preview });
  emit({
    ...signal(3, 3),
    progress: {
      ...preview,
      attemptId: 1,
      preview: { narration: "过期", dialogue: "" },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(client.progress.read()?.preview?.narration, "新尝试");
  emit(signal(7, 7));
  assert.ok(
    client.progress.read(),
    "final notification waits for the committed delta",
  );
  deliver[0]({
    signal: signal(4, 4),
    delta: {
      status: { id: "story", title: "test", revision: 1, updatedAt: 1 },
      items: [item(2)],
      more: false,
    },
  });
  await flush();
  assert.equal(calls[1].get("after"), "2");
  deliver[1]({
    signal: signal(7, 7),
    delta: {
      status: { id: "story", title: "test", revision: 1, updatedAt: 2 },
      items: [item(3), item(4)],
      more: false,
      bookmarks: ["msg-1"],
    },
  });
  await flush();
  assert.equal(client.progress.read(), undefined);
  assert.deepEqual(
    messages.map(({ seq }) => seq),
    [1, 2, 3, 4],
  );
  assert.equal(messages[0].bookmarked, true);
  assert.equal(mergeStoryMessages(messages, [item(4)]), messages);
});
