import assert from "node:assert/strict";
import test from "node:test";
import type { Stage } from "../shared/types.ts";
import { DraftStore } from "../src/draftStore.ts";
import {
  settingsDraft,
  storyInputDraft,
  textDraft,
} from "../src/draftSchemas.ts";
import { StageIntensityScalingModel } from "../src/stageIntensityScaling.ts";

function fixture() {
  const data = new Map<string, string>();
  let fail = false;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail) throw new DOMException("full", "QuotaExceededError");
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  return {
    data,
    open: (scope = "instance") => new DraftStore(scope, () => storage),
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

test("initialization preserves saved data and isolates app instances and entity IDs", () => {
  const { open, data } = fixture();
  const app = open();
  const a = app.cell("story:a", textDraft);
  a.write("A");
  app.cell("story:b", textDraft).write("B");
  app.flush();
  assert.equal(open().cell("story:a", textDraft).snapshot().value, "A");
  assert.equal(open().cell("story:b", textDraft).snapshot().value, "B");
  assert.equal(
    open("other").cell("story:a", textDraft).snapshot().value,
    undefined,
  );
  data.set(
    a.key,
    JSON.stringify({ version: 9, id: "future", value: "unknown" }),
  );
  const unknown = open().cell("story:a", textDraft);
  assert.equal(unknown.snapshot().status, "invalid");
  unknown.flush();
  assert.match(data.get(a.key)!, /future/);
});

test("failed storage writes preserve editable data and can be retried", () => {
  const f = fixture();
  const cell = f.open().cell("input", textDraft);
  f.fail(true);
  cell.write("my last edit");
  cell.flush();
  assert.equal(cell.snapshot().status, "error");
  assert.equal(cell.snapshot().value, "my last edit");
  f.fail(false);
  cell.retry();
  assert.equal(
    f.open().cell("input", textDraft).snapshot().value,
    "my last edit",
  );
});

test("a stale tab must resolve before replacing newer data; confirmed entity deletion wins", () => {
  const { open, data } = fixture();
  const left = open(),
    right = open();
  const a = left.cell("task:id", textDraft),
    b = right.cell("task:id", textDraft);
  a.write("newer stored");
  a.flush();
  b.write("my unsaved edits");
  b.flush();
  assert.equal(b.snapshot().status, "conflict");
  assert.equal(b.snapshot().value, "my unsaved edits");
  assert.equal(
    open().cell("task:id", textDraft).snapshot().value,
    "newer stored",
  );
  b.keepMine();
  left.storageChanged(a.key);
  assert.equal(a.snapshot().status, "conflict");
  a.reload();
  assert.equal(a.snapshot().value, "my unsaved edits");
  a.write("in flight");
  b.deleteEntity();
  a.flush();
  assert.equal(a.snapshot().deleted, true);
  assert.equal(a.write("late edit"), false);
  assert.doesNotMatch(data.get(a.key)!, /in flight|unsaved edits/);
});

test("a late completion cannot remove newer text even when the same phrase was retyped", () => {
  const { open } = fixture();
  const cell = open().cell("story:a", storyInputDraft);
  cell.write({ text: "same", editId: "1", sent: { requestId: "first" } });
  const sentRevision = cell.snapshot().revision;
  cell.write({ text: "same", editId: "2" });
  assert.equal(cell.write(undefined, sentRevision), false);
  cell.flush();
  assert.equal(cell.snapshot().value?.editId, "2");
  assert.equal(cell.snapshot().value?.sent, undefined);
});

test("settings storage strips API Key and credentials embedded in a URL", () => {
  const { open, data } = fixture();
  const cell = open().cell("settings", settingsDraft);
  const fields = {
    baseUrl: "http://name:secret@localhost/v1?token=hidden",
    model: "test",
    contextWindow: 2000,
    timeoutSec: 50,
    apiKey: "example-credential",
  };
  cell.write({ fields, base: "" });
  cell.flush();
  const raw = data.get(cell.key)!;
  assert.doesNotMatch(raw, /example-credential|secret|hidden|apiKey/);
  assert.equal(
    open().cell("settings", settingsDraft).snapshot().value?.fields.baseUrl,
    "http://localhost/v1",
  );
});

test("restoring reordered stages preserves independent scaling bases and invalid input", () => {
  const row = (id: string, A: number, B: number): Stage => ({
    id,
    name: id,
    behavior: "ramp",
    channels: ["A", "B"],
    waveformId: "wave",
    durationSec: 8,
    gapSec: 0,
    intensity: { A, B },
    startIntensity: { A: 1, B: 2 },
  });
  const initial = new StageIntensityScalingModel([
    row("a", 3, 4),
    row("b", 5, 7),
  ]);
  initial.setMultiplier("A", "1.5");
  initial.setMultiplier("B", "2.0");
  initial.updateStages(initial.stages.slice().reverse());
  initial.setMultiplier("A", "");
  const persisted = JSON.parse(
    JSON.stringify({ stages: initial.stages, draft: initial.snapshot() }),
  );
  const reopened = new StageIntensityScalingModel(
    persisted.stages,
    persisted.draft,
  );
  assert.deepEqual(reopened.multipliers, { A: 1.5, B: 2 });
  assert.equal(reopened.inputValues.A, "");
  assert.ok(reopened.inputIssue);
  assert.deepEqual(
    reopened.setMultiplier("A", "2.0")?.map((stage) => stage.intensity),
    [
      { A: 10, B: 14 },
      { A: 6, B: 8 },
    ],
  );
});
