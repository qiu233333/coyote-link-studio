import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createApplication } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { normalizeWaveform } from "../server/validation.ts";
import type { TimedControlSession } from "../shared/types.ts";

test("v1 inline run migrates atomically; progress writes leave frozen frames alone and restart interrupts output", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coyote-run-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const waveform = normalizeWaveform(
    Array(2500).fill("0A0A0A0A10101010"),
    "冻结旧波形",
  );
  const run: TimedControlSession = {
    id: "v1-run",
    owner: "manual",
    status: "running",
    mode: "single",
    startedAt: Date.now(),
    deadlineAt: Date.now() + 60000,
    boundsVersion: 1,
    stageIndex: 0,
    stageStartedAt: Date.now(),
    elapsedMs: 0,
    feedback: [],
    thinking: false,
    waveformSnapshots: { [waveform.id]: waveform },
  };
  const legacy = new Store(directory);
  legacy.set("runtime", "current", run);
  legacy.set("waveforms", waveform.id, { ...waveform, name: "库中新名称" });
  legacy.close();
  const sql = new DatabaseSync(join(directory, "coyote.sqlite"));
  sql.exec("PRAGMA user_version=1");
  sql.close();

  const store = new Store(directory);
  try {
    assert.deepEqual(store.loadRun(), run);
    assert.equal(
      Object.hasOwn(
        store.get<object>("runtime", "current")!,
        "waveformSnapshots",
      ),
      false,
    );
    const progress = store.loadRun()!;
    const writes: string[] = [];
    const set = store.set.bind(store);
    store.set = (collection, id, value) => {
      writes.push(collection);
      set(collection, id, value);
    };
    for (let i = 1; i <= 3; i++) {
      progress.elapsedMs = i * 1000;
      store.saveRun(progress);
    }
    assert.deepEqual(writes, ["runtime", "runtime", "runtime"]);
    const newWave = { ...waveform, name: "冻结新版" };
    const changed = {
      ...progress,
      waveformSnapshots: { [waveform.id]: newWave },
    };
    assert.throws(
      () =>
        store.transaction(() => {
          store.saveRun(changed);
          throw new Error("rolled back");
        }),
      /rolled back/,
    );
    assert.deepEqual(store.loadRun()?.waveformSnapshots, run.waveformSnapshots);
    store.saveRun(changed);
    assert.deepEqual(
      store.loadRun()?.waveformSnapshots,
      changed.waveformSnapshots,
    );
  } finally {
    store.close();
  }
  const app = await createApplication({ directory, startAi: false });
  try {
    const current = app.controller.run!;
    assert.equal(current.status, "interrupted");
    assert.equal(current.elapsedMs, 3000);
    assert.equal(current.termination?.source, "service-restart");
    assert.equal(current.waveformSnapshots[waveform.id].name, "冻结新版");
    assert.deepEqual(
      current.waveformSnapshots[waveform.id].frames,
      waveform.frames,
    );
    assert.deepEqual(app.device.state.intensities, { A: 0, B: 0 });
    assert.equal(app.device.state.connected, false);
    assert.equal(
      Object.hasOwn(app.controller.snapshot().run!, "waveformSnapshots"),
      false,
    );
  } finally {
    await app.close();
  }
  const migrated = new DatabaseSync(join(directory, "coyote.sqlite"));
  try {
    assert.equal(
      migrated.prepare("PRAGMA user_version").get()?.user_version,
      3,
    );
  } finally {
    migrated.close();
  }
});
