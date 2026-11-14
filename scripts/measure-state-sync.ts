import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { createApplication as CreateApplication } from "../server/app.js";
import { cursorParams, type StateUpdate } from "../shared/stateSync.js";

// pnpm exec tsx scripts/measure-state-sync.ts [checkout] [windowMs] [importedWaves]
const root = resolve(process.argv[2] ?? ".");
const windowMs = Number(process.argv[3] ?? 10000);
const importedWaves = Number(process.argv[4] ?? 1);
const { createApplication } = (await import(
  pathToFileURL(join(root, "server/app.ts")).href
)) as { createApplication: typeof CreateApplication };

async function measure(frameCount: number) {
  const directory = mkdtempSync(join(tmpdir(), "coyote-sync-measure-"));
  const app = await createApplication({ directory, startAi: false });
  let socket: WebSocket | undefined;
  try {
    const url = await app.listen(0);
    const initial = await fetch(url + "/api/state");
    const cookie = initial.headers.get("set-cookie")!.split(";")[0];
    await initial.text();
    async function call(path: string, body: unknown, method = "POST") {
      const res = await fetch(url + path, {
        method,
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-Coyote-Request": "1",
        },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      assert.ok(result.ok, result.error);
      return result.data;
    }
    for (let i = 0; i < importedWaves; i++)
      await call("/api/waveforms/import", {
        name: `Benchmark ${i}`,
        content: Array(frameCount).fill(`0A0A0A0A1010100${i}`),
      });
    await call("/api/device/connect", { protocol: "simulator" });
    const full = await fetch(url + "/api/state").then((r) => r.text());
    const waveformId = JSON.parse(full).data.waveforms.find(
      (wave: { name: string }) => wave.name === "Benchmark 0",
    ).id;
    await call(
      "/api/console/channels",
      {
        channels: { A: { enabled: true, limit: 10, target: 4, waveformId } },
      },
      "PATCH",
    );
    socket = new WebSocket(url.replace("http", "ws") + "/ws", {
      headers: { Cookie: cookie, Origin: url },
    });
    await new Promise<void>((done, fail) => {
      socket!.once("message", () => done());
      socket!.once("error", fail);
    });
    const sizes: number[] = [];
    let framesOnWire = false;
    let heartbeats = 0;
    let latest: StateUpdate | undefined;
    socket.on("message", (message) => {
      const body = message.toString();
      framesOnWire ||= /"(frames|waveformSnapshots)"\s*:/.test(body);
      heartbeats += Number(body.includes('"type":"heartbeat"'));
      sizes.push(Buffer.byteLength(body));
      if (body.startsWith('{"type":"state","data":{"instance":'))
        latest = JSON.parse(body).data as StateUpdate;
    });
    const writes: { bytes: number; frames: boolean }[] = [];
    const save = app.store.set.bind(app.store);
    app.store.set = (collection, id, value) => {
      if (collection === "runtime" || collection === "runtime-waveforms") {
        const payload = JSON.stringify(value);
        writes.push({
          bytes: Buffer.byteLength(payload),
          frames: payload.includes('"frames":'),
        });
      }
      save(collection, id, value);
    };
    const collect = async () => {
      sizes.length = writes.length = heartbeats = 0;
      framesOnWire = false;
      await delay(windowMs);
      const result = {
        messages: sizes.length,
        heartbeats,
        bytes: sizes.reduce((a, b) => a + b, 0),
        maxBytes: Math.max(0, ...sizes),
        socketOpen: socket?.readyState === WebSocket.OPEN,
        framesOnWire,
        runWrites: writes.length,
        runWriteBytes: writes.reduce((total, write) => total + write.bytes, 0),
        frameWrites: writes.filter((write) => write.frames).length,
      };
      return result;
    };
    const idle = await collect();
    const started = await call("/api/console/live/start", {
      requestId: "benchmark",
    });
    assert.equal(started.run.status, "running");
    // Exclude initial freeze and ramp from steady-state write measurements.
    await delay(2200);
    const playing = await collect();
    assert.equal(app.device.state.intensities.A, 4);
    const playingHttp = await fetch(url + "/api/state").then((r) => r.text());
    const cursor = latest && {
      instance: latest.instance,
      logs: latest.logs.start + latest.logs.entries.length,
      history: latest.history.start + latest.history.entries.length,
      resources: latest.versions,
    };
    const poll = await fetch(`${url}/api/state?${cursorParams(cursor)}`).then(
      (r) => r.text(),
    );
    return {
      frameCount,
      importedWaves,
      totalWaves: JSON.parse(full).data.waveforms.length,
      windowMs,
      idle,
      playing,
      idleHttpBytes: Buffer.byteLength(full),
      playingHttpBytes: Buffer.byteLength(playingHttp),
      playingHttpFrames: /"(frames|waveformSnapshots)"\s*:/.test(playingHttp),
      pollingHttpBytes: Buffer.byteLength(poll),
      pollingHttpFrames: /"(frames|waveformSnapshots)"\s*:/.test(poll),
    };
  } finally {
    socket?.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify([await measure(20), await measure(99_900)], null, 2),
);
