import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { WebSocket } from "ws";
import { createApplication } from "../server/app.js";

test("HTTP 本机同源保护、密钥加密、WebSocket 和实际模拟器控制链路", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coyote-http-"));
  const app = await createApplication({ directory, startAi: false });
  const url = await app.listen(0);
  let websocket: WebSocket | undefined;
  try {
    const bootstrap = await fetch(`${url}/api/state`);
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
    const initial = (await bootstrap.json()).data;
    assert.ok(initial.waveforms.length >= 5);
    assert.equal(initial.device.connected, false);
    assert.equal(initial.channels.A.limit, 0);
    const rejected = await fetch(`${url}/api/device/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: "simulator" }),
    });
    assert.equal(rejected.status, 403);
    const foreign = await fetch(`${url}/api/state`, {
      headers: { origin: "https://untrusted.invalid" },
    });
    assert.equal(foreign.status, 403);
    const call = async (path: string, body = {}, method = "POST") => {
      const response = await fetch(url + path, {
        method,
        headers: {
          cookie,
          "content-type": "application/json",
          "x-coyote-request": "1",
          origin: url,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, result: await response.json() };
    };
    const secret = "local-fixture-secret-never-in-output";
    assert.equal(
      (
        await call(
          "/api/settings",
          {
            baseUrl: "http://127.0.0.1:12345/v1",
            model: "local-fixture",
            apiKey: secret,
            contextWindow: 32000,
            timeoutSec: 10,
          },
          "PUT",
        )
      ).status,
      200,
    );
    const snapshotText = await (await fetch(url + "/api/state")).text();
    assert.ok(!snapshotText.includes(secret));
    assert.equal(app.store.profile().apiKey, secret);
    const saved = app.store.get<{ secret: string }>("settings", "ai")!;
    assert.ok(saved.secret && !saved.secret.includes(secret));
    assert.ok(
      !readFileSync(join(directory, "coyote.sqlite-wal")).includes(
        Buffer.from(secret),
      ),
    );
    assert.equal(
      (await call("/api/device/connect", { protocol: "simulator" })).status,
      200,
    );
    app.device.state.limits = { A: 20, B: 19 };
    app.device.emit("state", app.device.state);
    assert.equal(
      (
        await call(
          "/api/console/channels",
          { channels: { A: { limit: 10, target: 3, rampPerSecond: 10 } } },
          "PATCH",
        )
      ).status,
      200,
    );
    websocket = new WebSocket(url.replace("http:", "ws:") + "/ws", {
      headers: { cookie, origin: url },
    });
    const push = await new Promise<any>((resolveMessage, reject) => {
      websocket!.once("message", (data) =>
        resolveMessage(JSON.parse(String(data))),
      );
      websocket!.once("error", reject);
    });
    assert.equal(push.type, "state");
    assert.equal(push.data.device.protocol, "simulator");
    const waveformId = initial.waveforms[0].id;
    const requestId = crypto.randomUUID();
    const config = {
      mode: "single",
      stages: [
        {
          id: "one",
          name: "单波形",
          durationSec: 30,
          gapSec: 0,
          channels: ["A"],
          waveformId,
          intensity: 3,
          startIntensity: 0,
          behavior: "hold",
        },
      ],
      repeat: 1,
      shuffle: false,
      durationSec: 30,
    };
    const started = await call("/api/console/play", { config, requestId });
    assert.equal(started.status, 200);
    assert.equal(started.result.data.run.status, "running");
    const runId = started.result.data.run.id;
    const repeated = await call("/api/console/play", { config, requestId });
    assert.equal(repeated.result.data.run.id, runId);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
    assert.ok(app.device.state.intensities.A > 0);
    assert.ok(
      app.controller
        .snapshot()
        .logs.some(
          (entry) => entry.channel === "A" && entry.source === "设备回传",
        ),
      "实际通道回传应可在记录中按通道筛选",
    );
    assert.equal(
      (
        await call(
          "/api/console/channels",
          { channels: { A: { target: 50 } } },
          "PATCH",
        )
      ).status,
      400,
    );
    const stopped = await call("/api/emergency-stop");
    assert.equal(stopped.status, 200);
    assert.equal(stopped.result.data.run.status, "stopped");
    assert.equal(stopped.result.data.device.intensities.A, 0);
    assert.equal(stopped.result.data.stopUnconfirmed, false);
    app.controller.synced = true;
    const livePatch = await call(
      "/api/console/live/channels",
      { channels: { A: { target: 5 }, B: { target: 3 } } },
      "PATCH",
    );
    assert.equal(livePatch.status, 200);
    assert.equal(livePatch.result.data.synced, false);
    assert.deepEqual(livePatch.result.data.device.intensities, { A: 0, B: 0 });
    const liveStart = await call("/api/console/live/start", {
      requestId: crypto.randomUUID(),
    });
    assert.equal(liveStart.status, 200);
    assert.equal(liveStart.result.data.run.mode, "live");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 450));
    assert.deepEqual(app.device.state.intensities, { A: 5, B: 3 });
    assert.equal(
      (
        await call(
          "/api/console/live/channels",
          { channels: { B: { target: 20 } } },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/api/console/live/channels",
          { channels: { A: { rampPerSecond: 1 } } },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal((await call("/api/console/pause")).status, 200);
    assert.equal(
      (
        await call(
          "/api/console/live/channels",
          { channels: { A: { target: 2 }, B: { enabled: false } } },
          "PATCH",
        )
      ).status,
      200,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    assert.deepEqual(app.device.state.intensities, { A: 0, B: 0 });
    assert.equal(
      (
        await call("/api/console/live/start", {
          requestId: crypto.randomUUID(),
        })
      ).status,
      200,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assert.deepEqual(app.device.state.intensities, { A: 2, B: 0 });
    assert.equal((await call("/api/emergency-stop")).status, 200);
    assert.equal(
      (await call("/api/waveforms/import", { content: ["NOT-A-FRAME"] }))
        .status,
      400,
    );
    assert.equal(
      (
        await call("/api/waveforms/import", {
          content: initial.waveforms[0].frames,
        })
      ).status,
      409,
    );
  } finally {
    websocket?.terminate();
    await app.close();
    if (
      dirname(resolve(directory)) === resolve(tmpdir()) &&
      basename(directory).startsWith("coyote-http-")
    )
      rmSync(directory, { recursive: true, force: true });
  }
});
