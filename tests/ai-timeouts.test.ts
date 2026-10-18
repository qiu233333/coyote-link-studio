import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  aiTimeoutSeconds,
  AI_TRANSPORT_GRACE_MS,
} from "../shared/aiTimeouts.js";
import { profileSchema } from "../agent/lib/schemas.ts";
import { Store } from "../server/store.ts";

test("旧的30秒设置保留，任务草稿独立获得180秒预算", () => {
  assert.equal(aiTimeoutSeconds({ timeoutSec: 30 }, "decide"), 30);
  assert.equal(aiTimeoutSeconds({ timeoutSec: 30 }, "draft"), 180);
  assert.equal(aiTimeoutSeconds({ timeoutSec: 240 }, "draft"), 240);
  assert.equal(
    aiTimeoutSeconds({ timeoutSec: 240, draftTimeoutSec: 60 }, "draft"),
    60,
  );
  assert.equal(aiTimeoutSeconds({ timeoutSec: 999 }, "decide"), 600);
  assert.ok(AI_TRANSPORT_GRACE_MS > 1000);
});

test("设置和worker协议都接受独立的长超时并拒绝越界，保留密钥", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coyote-timeout-settings-"));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("coyote-timeout-settings-"));
    rmSync(target, { recursive: true, force: true });
  });
  assert.equal(store.profile().timeoutSec, 120);
  assert.equal(store.profile().draftTimeoutSec, 180);
  store.saveSettings({
    baseUrl: "http://localhost:1/v1",
    model: "fixture",
    apiKey: "fake-timeout-test-key",
    timeoutSec: 30,
  });
  assert.equal(store.profile().timeoutSec, 30);
  assert.equal(store.profile().draftTimeoutSec, 180);
  store.saveSettings({ timeoutSec: 600, draftTimeoutSec: 240 });
  assert.equal(store.settings().timeoutSec, 600);
  assert.equal(store.settings().draftTimeoutSec, 240);
  assert.equal(store.profile().apiKey, "fake-timeout-test-key");
  assert.ok(profileSchema.safeParse(store.profile()).success);
  for (const key of ["timeoutSec", "draftTimeoutSec"]) {
    for (const value of [4, 601, NaN, Infinity])
      assert.throws(() => store.saveSettings({ [key]: value }));
    assert.equal(
      profileSchema.safeParse({ ...store.profile(), [key]: 601 }).success,
      false,
    );
  }
  assert.equal(store.settings().timeoutSec, 600);
  assert.equal(store.settings().draftTimeoutSec, 240);
  assert.ok(
    !JSON.stringify(store.settings()).includes("fake-timeout-test-key"),
  );
});
