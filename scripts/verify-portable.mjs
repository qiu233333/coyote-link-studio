/** Exercise the extracted ZIP, not the source launcher or source server. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const latest = JSON.parse(
  readFileSync(join(root, "artifacts/release/latest.json"), "utf8"),
);
const zipArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const zip = zipArg ? resolve(zipArg) : latest.zip;
const temp = realpathSync.native(
  mkdtempSync(join(tmpdir(), "Coyote 验收 space-")),
);
const profile = join(temp, "empty-user");
mkdirSync(profile);
const reportDir = join(root, "artifacts/portable");
mkdirSync(reportDir, { recursive: true });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (
    /^(COYOTE_|NODE_|npm_|pnpm_|init_cwd)/i.test(key) ||
    /API_KEY$/i.test(key)
  )
    delete env[key];
env.PATH = ["System32", "System32/WindowsPowerShell/v1.0", "System32/Wbem"]
  .map((p) => join(process.env.SystemRoot, p))
  .join(";");
env.USERPROFILE = profile;
env.APPDATA = join(profile, "AppData/Roaming");
env.LOCALAPPDATA = join(profile, "AppData/Local");
env.HOME = profile;
let folder;
const checks = [];
const recordCheck = checks.push.bind(checks);
checks.push = (...items) => {
  for (const item of items) console.log("PASS " + item);
  return recordCheck(...items);
};
let providerCalls = 0;
let launchCount = 0;
const key = "portable-local-fixture-" + randomUUID();
const provider = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const data of req) raw += data;
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    assert.ok(!raw.includes(key));
    const body = JSON.parse(raw);
    providerCalls++;
    const toolResult = body.messages.findLast((m) => m.role === "tool");
    const name = toolResult ? undefined : body.tools?.[0]?.function?.name;
    assert.ok(!name || ["connection_probe", "submit_roleplay"].includes(name));
    const token = JSON.stringify(body.messages).match(
      /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/,
    )?.[0];
    const message = name
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "portable-probe",
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(
                  name === "connection_probe"
                    ? { token }
                    : {
                        narration: "星涟递来一本新的旅行手记。",
                        dialogue: "准备好出发了吗？",
                        ...(body.tools[0].function.parameters.properties
                          .replyOptions
                          ? {
                              replyOptions: [
                                "我准备好了，现在就出发。",
                                "先给我看看旅行手记吧。",
                                "能说说我们要去的地方吗？",
                              ],
                            }
                          : {}),
                        memory: {
                          recentPlot: "收到手记",
                          plotBackground: "星城",
                          longPlot: "开始旅程",
                          longDialogue: "约定一起旅行",
                        },
                        ...(body.tools[0].function.parameters.properties
                          .storyStateDelta
                          ? { storyStateDelta: {} }
                          : {}),
                        control: { action: "keep" },
                        controlReason: "本轮仅进行文字验收。",
                      },
                ),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: toolResult
            ? JSON.parse(toolResult.content).receipt
            : "连接成功",
        };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: randomUUID(),
        object: "chat.completion",
        model: body.model,
        created: 1,
        choices: [
          { index: 0, message, finish_reason: name ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = provider.address().port;
async function run(command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...env, ...extraEnv },
    windowsHide: true,
    stdio: "pipe",
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));
  child.stdin.on("error", () => {});
  child.stdin.end("\r\n");
  const timer = setTimeout(() => child.kill(), 180000);
  try {
    const code = await new Promise((r, j) => {
      child.once("error", j);
      child.once("exit", (code) => {
        // Start-Process may leave inherited pipe handles in the background tree.
        // The launcher exit, rather than all descendants closing pipes, is final.
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          r(code);
        }, 100);
      });
    });
    const output = Buffer.concat(out).toString("utf8");
    return { code, output };
  } finally {
    clearTimeout(timer);
  }
}
async function launcher(action, args = "", expected = 0, extra = {}) {
  const result = await run(
    join(process.env.SystemRoot, "System32/cmd.exe"),
    ["/d", "/c", `${action === "start" ? "Start" : "Stop"}-Coyote.cmd ${args}`],
    folder,
    extra,
  );
  writeFileSync(
    join(reportDir, `launcher-${launchCount++}-${action}.log`),
    result.output,
  );
  assert.equal(result.code, expected, result.output);
  return result;
}
function extract(destination) {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:TEST_ZIP,$env:TEST_DEST)",
    ],
    {
      windowsHide: true,
      env: { ...env, TEST_ZIP: zip, TEST_DEST: destination },
    },
  );
  return join(destination, `Coyote-Link-v${latest.version}-windows-x64`);
}
async function freePort() {
  const server = createNetServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
let cookie;
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(url + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Coyote-Request": "1",
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  assert.ok(response.ok && value.ok, `${path}: ${value.error}`);
  return value.data;
}
try {
  assert.equal(
    createHash("sha256").update(readFileSync(zip)).digest("hex"),
    readFileSync(zip + ".sha256", "utf8").split(/\s/)[0],
  );
  folder = extract(join(temp, "first 中文路径"));
  assert.ok(
    !existsSync(join(folder, "data")),
    "Release must not contain user data",
  );
  assert.ok(
    !existsSync(join(folder, "app/node_modules/tsx")),
    "No development runtime",
  );
  const absent = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "if ((Get-Command node,pnpm,git -ErrorAction SilentlyContinue)) {exit 1}",
    ],
    folder,
  );
  assert.equal(absent.code, 0, "Clean PATH must not resolve development tools");
  checks.push(
    "ZIP checksum, empty data, no development runtime, isolated PATH and user profile",
  );
  await launcher("start", `-NoBrowser -Port ${port}`);
  assert.equal((await api("/api/health")).ai.ready, true);
  const record = JSON.parse(
    readFileSync(join(folder, "data/service.json"), "utf8").replace(
      /^\uFEFF/,
      "",
    ),
  );
  assert.equal(record.executablePath, join(folder, "runtime/node.exe"));
  await launcher("start", `-NoBrowser -Port ${port}`);
  const record2 = JSON.parse(
    readFileSync(join(folder, "data/service.json"), "utf8").replace(
      /^\uFEFF/,
      "",
    ),
  );
  assert.equal(record.pid, record2.pid);
  checks.push(
    "Actual CMD launcher, Chinese/space path, bundled Node + eve ready, duplicate start reuses PID",
  );
  const html = await (await fetch(url)).text();
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(url + asset)).status, 200);
  const first = await api("/api/state");
  assert.equal(first.settings.apiKeySet, false);
  const ws = new WebSocket(url.replace("http", "ws") + "/ws", {
    headers: { cookie, origin: url },
  });
  await new Promise((r, j) => {
    const timer = setTimeout(() => j(Error("WebSocket timeout")), 5000);
    ws.once("message", () => {
      clearTimeout(timer);
      ws.close();
      r();
    });
    ws.once("error", j);
  });
  checks.push(
    "Production HTML + hashed JS, fresh settings, authenticated WebSocket",
  );
  await api(
    "/api/settings",
    {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      model: "portable-local",
      apiKey: key,
    },
    "PUT",
  );
  const probe = await api("/api/settings/test", {});
  assert.ok(probe.chat && probe.tools);
  await api("/api/device/connect", { protocol: "simulator" });
  await api("/api/console/live/start", { requestId: randomUUID() });
  assert.equal((await api("/api/state")).run.owner, "manual");
  await api("/api/emergency-stop", {});
  const format = await api("/api/roleplay/card-format");
  const card = await api("/api/roleplay/cards", format.template);
  assert.ok(card.id);
  const story = await api("/api/roleplay/sessions", {
    cardId: card.id,
    player: { name: "旅人", identity: "探索者", relationship: "同伴" },
    scenario: "星城",
  });
  const turn = await api(`/api/roleplay/sessions/${story.id}/messages`, {
    text: "带上手记出发",
    requestId: randomUUID(),
  });
  const turnDeadline = Date.now() + 30000;
  let reply;
  do {
    reply = await api(`/api/roleplay/sessions/${story.id}/turns/${turn.id}`);
    if (reply.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < turnDeadline);
  assert.equal(reply.status, "completed");
  const dialogue = JSON.stringify(
    await api(`/api/roleplay/sessions/${story.id}/messages`),
  );
  assert.ok(dialogue.includes("准备好出发了吗"));
  assert.ok(!JSON.stringify(await api("/api/state")).includes(key));
  checks.push(
    "HTTP → packaged backend → bundled eve → local chat/tool/result provider; simulator + emergency; character save",
  );
  await launcher("stop");
  await launcher("stop");
  await assert.rejects(fetch(url + "/api/health"));
  const db = readFileSync(join(folder, "data/coyote.sqlite"));
  assert.ok(!db.includes(Buffer.from(key)), "Key encrypted on disk");
  await launcher("start", `-NoBrowser -Port ${port}`);
  cookie = undefined;
  assert.equal((await api("/api/state")).settings.apiKeySet, true);
  assert.ok((await api("/api/roleplay/cards")).some((c) => c.id === card.id));
  assert.ok(
    (await api("/api/settings/test", {})).tools,
    "Stored key decrypts after restart",
  );
  await launcher("stop");
  checks.push(
    "Stop releases port, repeated stop, encrypted key and characters persist, AI works after restart",
  );
  const oldFolder = folder;
  folder = extract(join(temp, "upgrade 新目录"));
  cpSync(join(oldFolder, "data"), join(folder, "data"), { recursive: true });
  await launcher("start", `-NoBrowser -Port ${port}`);
  cookie = undefined;
  await api("/api/state");
  assert.ok((await api("/api/roleplay/cards")).some((c) => c.id === card.id));
  assert.ok((await api("/api/settings/test", {})).tools);
  assert.equal(
    JSON.stringify(await api(`/api/roleplay/sessions/${story.id}/messages`)),
    dialogue,
  );
  await launcher("stop");
  checks.push(
    "Upgrade into fresh extraction with complete data migration retains characters and encrypted key",
  );
  const occupied = createNetServer();
  await new Promise((r) => occupied.listen(port, "127.0.0.1", r));
  try {
    await launcher("start", `-NoBrowser -Port ${port}`, 1);
    assert.ok(occupied.listening);
  } finally {
    await new Promise((r) => occupied.close(r));
  }
  const entry = join(folder, "app/dist/index.html");
  renameSync(entry, entry + ".backup");
  try {
    await launcher("start", `-NoBrowser -Port ${port}`, 1);
  } finally {
    renameSync(entry + ".backup", entry);
  }
  checks.push(
    "Occupied port and damaged package reject startup without killing unrelated service",
  );
  const custom = join(temp, "custom data");
  await launcher("start", `-NoBrowser -Port ${port}`, 0, {
    COYOTE_DATA_DIR: custom,
  });
  cookie = undefined;
  assert.equal((await api("/api/state")).settings.apiKeySet, false);
  await launcher("stop", "", 0, { COYOTE_DATA_DIR: custom });
  checks.push("Custom data directory used consistently by Start and Stop");
  if (!process.argv.includes("--smoke-only")) {
    const bundled = join(folder, "runtime/node.exe");
    const loader = pathToFileURL(
      join(root, "node_modules/tsx/dist/loader.mjs"),
    ).href;
    const regressionEnv = {
      ...env,
      COYOTE_VERIFY_APP: pathToFileURL(join(folder, "app/server/app.js")).href,
      ...(process.env.COYOTE_BROWSER_PATH
        ? { COYOTE_BROWSER_PATH: process.env.COYOTE_BROWSER_PATH }
        : {}),
    };
    for (const [script, args] of [
      ["verify-browser.ts", []],
      ["verify-roleplay.ts", ["--browser", "--deepseek", "--thinking"]],
    ]) {
      const child = spawn(
        bundled,
        ["--import", loader, join(root, "scripts", script), ...args],
        {
          cwd: root,
          env: regressionEnv,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const out = [];
      child.stdout.on("data", (b) => out.push(b));
      child.stderr.on("data", (b) => out.push(b));
      const code = await new Promise((r, j) => {
        child.once("error", j);
        child.once("close", r);
      });
      writeFileSync(join(reportDir, script + ".log"), Buffer.concat(out));
      assert.equal(code, 0, Buffer.concat(out).toString("utf8"));
      checks.push(
        `Bundled Node + packaged JS regression: ${script} ${args.join(" ")}`,
      );
    }
  }
  writeFileSync(
    join(reportDir, "report.json"),
    JSON.stringify(
      {
        passed: true,
        zip,
        node: JSON.parse(readFileSync(join(folder, "release.json"), "utf8"))
          .nodeVersion,
        temp,
        providerCalls,
        checks,
        limitation:
          "Restricted PATH/profile on existing Windows; not a pristine VM. Local provider and simulated device only.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: true, checks, providerCalls, reportDir }),
  );
} finally {
  if (folder) await launcher("stop").catch(() => {});
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
}
