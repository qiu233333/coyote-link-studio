import assert from "node:assert/strict";
import test from "node:test";
import {
  LiveChannelQueue,
  type LiveChannelsPatch,
} from "../src/liveChannelQueue.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("连续热更串行发送，并合并待发送值；旧回包不清除最新目标", async () => {
  const first = deferred(),
    second = deferred();
  const sent: LiveChannelsPatch[] = [];
  let visible: LiveChannelsPatch = {};
  const queue = new LiveChannelQueue(
    async (patch) => {
      sent.push(patch);
      await (sent.length === 1 ? first.promise : second.promise);
    },
    (pending) => {
      visible = pending;
    },
  );

  queue.enqueue({ A: { target: 1 } });
  queue.enqueue({ A: { target: 3, waveformId: "a-wave" } });
  queue.enqueue({ B: { enabled: true, target: 12 } });
  queue.enqueue({ A: { target: 7 } });
  assert.deepEqual(sent, [{ A: { target: 1 } }]);
  assert.deepEqual(visible, {
    A: { target: 7, waveformId: "a-wave" },
    B: { enabled: true, target: 12 },
  });
  first.resolve();
  await settle();
  assert.deepEqual(sent, [
    { A: { target: 1 } },
    {
      A: { target: 7, waveformId: "a-wave" },
      B: { enabled: true, target: 12 },
    },
  ]);
  assert.equal(visible.A?.target, 7);
  queue.enqueue({ A: { target: 9 } });
  second.resolve();
  await settle();
  assert.deepEqual(sent[2], { A: { target: 9 } });
  assert.deepEqual(visible, {});
  queue.dispose();
});

test("热更新失败不自动重试，后续明确修改仍可独立发送", async () => {
  const gate = deferred();
  const sent: LiveChannelsPatch[] = [];
  let visible: LiveChannelsPatch = {};
  const queue = new LiveChannelQueue(
    async (patch) => {
      sent.push(patch);
      if (sent.length === 1) {
        await gate.promise;
        throw new Error("fixture failure");
      }
    },
    (pending) => {
      visible = pending;
    },
  );
  queue.enqueue({ A: { target: 3 } });
  queue.enqueue({ B: { target: 2 } });
  gate.resolve();
  await settle();
  assert.deepEqual(sent, [{ A: { target: 3 } }, { B: { target: 2 } }]);
  assert.deepEqual(visible, {});
  queue.enqueue({ A: { target: 4 } });
  await settle();
  assert.deepEqual(sent[2], { A: { target: 4 } });
  queue.dispose();
});

test("离开实时控制后丢弃未发送配置，旧请求完成不继续发送或更新界面", async () => {
  const gate = deferred();
  const sent: LiveChannelsPatch[] = [];
  let changed = 0;
  const queue = new LiveChannelQueue(
    async (patch) => {
      sent.push(patch);
      await gate.promise;
    },
    () => {
      changed++;
    },
  );
  queue.enqueue({ A: { target: 2 } });
  queue.enqueue({ A: { target: 8 } });
  queue.dispose();
  const before = changed;
  gate.resolve();
  await settle();
  queue.enqueue({ B: { target: 4 } });
  assert.deepEqual(sent, [{ A: { target: 2 } }]);
  assert.equal(changed, before);
});
