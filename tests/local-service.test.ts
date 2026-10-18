import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const windows = process.platform === "win32";
const source = fileURLToPath(new URL("../", import.meta.url));

async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    codepage?: number;
  } = {},
) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    windowsHide: true,
    stdio: "pipe",
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (data: Buffer) => chunks.push(data));
  child.stderr.on("data", (data: Buffer) => chunks.push(data));
  child.stdin.on("error", () => {});
  child.stdin.end(options.input ?? "\r\n");
  const timer = setTimeout(() => child.kill(), 40_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return {
      code,
      output: new TextDecoder(
        options.codepage === 936 ? "gbk" : "utf-8",
      ).decode(Buffer.concat(chunks)),
    };
  } finally {
    clearTimeout(timer);
  }
}

const fixtureServer = `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
let stops = 0, readsAfterStop = 0;
const state = (kind, after) => {
  const value = { stopUnconfirmed: false, stopping: false, run: after ? { status: 'stopped' } : null, device: { connected: false, intensities: { A: 0, B: 0 } } };
  if (!after) {
    if (kind !== 'confirmed') {
      value.run = { status: 'running' };
      value.device.connected = true;
      value.device.intensities = { A: 4, B: 3 };
    }
    return value;
  }
  if (kind === 'unconfirmed' || (kind === 'stale-post' && readsAfterStop > 0)) {
    value.stopUnconfirmed = true;
    value.stopReason = '隔离测试：B 通道未回传归零';
  }
  if (kind === 'inflight-forever' || (kind === 'inflight' && readsAfterStop < 3)) value.stopping = true;
  if (kind === 'missing') return {};
  if (kind === 'string-flags') { value.stopUnconfirmed = 'false'; value.stopping = 'false'; }
  if (kind === 'string-zero') value.device.intensities = { A: '0', B: '0' };
  if (kind === 'missing-run') delete value.run;
  if (kind === 'one-channel') value.device.intensities.B = 7;
  if (kind === 'active') value.run = { status: 'running' };
  return value;
};
const server = createServer((req, res) => {
  const kind = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8')).kind;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, data: { service: 'coyote-link', ai: { ready: true } } }));
  if (req.url === '/api/state' && req.method === 'GET') {
    res.setHeader('Set-Cookie', 'coyote_session=fixture; Path=/; HttpOnly; SameSite=Strict');
    if (stops) ++readsAfterStop;
    return res.end(JSON.stringify({ ok: true, data: state(kind, stops > 0) }));
  }
  if (req.url === '/api/emergency-stop' && req.method === 'POST') {
    if (req.headers['x-coyote-request'] !== '1' || req.headers.cookie !== 'coyote_session=fixture' || req.headers.origin !== 'http://127.0.0.1:' + server.address().port) {
      res.statusCode = 403; return res.end(JSON.stringify({ ok: false }));
    }
    ++stops;
    writeFileSync(join(root, 'stops.json'), JSON.stringify({ stops }));
    return res.end(JSON.stringify({ ok: true, data: state(kind, true) }));
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(0, '127.0.0.1', () => writeFileSync(join(root, 'ready.json'), JSON.stringify({ port: server.address().port, childPid: child.pid })));
`;

async function fixture(t: TestContext, kind = "confirmed") {
  const root = mkdtempSync(join(tmpdir(), "coyote-stop 中文-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "server"));
  mkdirSync(join(root, "data"));
  copyFileSync(
    join(source, "scripts/local-service.ps1"),
    join(root, "scripts/local-service.ps1"),
  );
  copyFileSync(join(source, "Stop-Coyote.cmd"), join(root, "Stop-Coyote.cmd"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "fixture.json"), JSON.stringify({ kind }));
  const entry = join(root, "server/index.ts");
  writeFileSync(entry, fixtureServer);
  const service = spawn(process.execPath, [entry], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
  let childPid = 0;
  t.after(async () => {
    if (service.exitCode === null && service.signalCode === null) {
      // Only the fixture ChildProcess created above is targeted.
      await run("taskkill.exe", ["/PID", String(service.pid), "/T", "/F"]);
    }
    if (childPid && alive(childPid)) {
      try {
        process.kill(childPid);
      } catch {}
    }
    for (let i = 0; i < 20 && alive(service.pid!); i++) await delay(50);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  for (let i = 0; i < 100 && !existsSync(join(root, "ready.json")); ++i)
    await delay(50);
  assert.ok(
    existsSync(join(root, "ready.json")),
    "isolated service should start",
  );
  const ready = JSON.parse(readFileSync(join(root, "ready.json"), "utf8"));
  childPid = ready.childPid;
  const identity = await run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "$p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $env:COYOTE_FIXTURE_PID); @{ executablePath = $p.ExecutablePath; processCreationUtc = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
    ],
    { env: { COYOTE_FIXTURE_PID: String(service.pid) } },
  );
  assert.equal(identity.code, 0, identity.output);
  const record = {
    ...JSON.parse(identity.output.trim()),
    pid: service.pid,
    port: ready.port,
  };
  const recordFile = join(root, "data/service.json");
  const save = () => writeFileSync(recordFile, JSON.stringify(record));
  save();
  return {
    root,
    service,
    childPid,
    record,
    recordFile,
    save,
    setKind(value: string) {
      writeFileSync(
        join(root, "fixture.json"),
        JSON.stringify({ kind: value }),
      );
    },
    stops() {
      return existsSync(join(root, "stops.json"))
        ? JSON.parse(readFileSync(join(root, "stops.json"), "utf8")).stops
        : 0;
    },
    stop() {
      return run(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(root, "scripts/local-service.ps1"),
          "-Action",
          "stop",
        ],
        { cwd: root },
      );
    },
    cmd(codepage: number) {
      const runner = join(root, "run-stop.cmd");
      writeFileSync(
        runner,
        `@echo off\r\nchcp ${codepage} >nul\r\ncall "%~dp0Stop-Coyote.cmd"\r\nexit /b %ERRORLEVEL%\r\n`,
      );
      return run("cmd.exe", ["/d", "/c", runner], { cwd: root, codepage });
    },
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function assertExited(service: ChildProcess, childPid: number) {
  for (let i = 0; i < 60 && (alive(service.pid!) || alive(childPid)); ++i)
    await delay(50);
  assert.equal(alive(service.pid!), false, "managed server must exit");
  assert.equal(alive(childPid), false, "managed AI descendant must exit");
}

test(
  "Windows PowerShell 5.1：idle 也调用停止；确认后退出整个受管进程树；重复 Stop 幂等",
  { skip: !windows },
  async (t) => {
    const f = await fixture(t);
    const result = await f.stop();
    assert.equal(result.code, 0, result.output);
    assert.equal(
      f.stops(),
      1,
      "idle snapshot must not bypass controller cancellation",
    );
    await assertExited(f.service, f.childPid);
    assert.equal(existsSync(f.recordFile), false);
    assert.equal((await f.stop()).code, 0);
    assert.deepEqual(
      [
        ...readFileSync(join(f.root, "scripts/local-service.ps1")).subarray(
          0,
          3,
        ),
      ],
      [0xef, 0xbb, 0xbf],
    );
  },
);

test(
  "Windows launcher：停止中的快照等待最终确认",
  { skip: !windows },
  async (t) => {
    const f = await fixture(t, "inflight");
    const result = await f.stop();
    assert.equal(result.code, 0, result.output);
    assert.equal(f.stops(), 1);
    await assertExited(f.service, f.childPid);
  },
);

test(
  "Windows launcher：正常运行确认停止后退出整个后台",
  { skip: !windows },
  async (t) => {
    const f = await fixture(t, "running");
    const result = await f.stop();
    assert.equal(result.code, 0, result.output);
    assert.equal(f.stops(), 1);
    await assertExited(f.service, f.childPid);
  },
);

test(
  "Windows launcher：未确认保留后台，恢复确认后可重试退出",
  { skip: !windows },
  async (t) => {
    const f = await fixture(t, "unconfirmed");
    const result = await f.stop();
    assert.equal(result.code, 1, result.output);
    assert.equal(alive(f.service.pid!), true);
    assert.equal(alive(f.childPid), true);
    assert.equal(existsSync(f.recordFile), true);
    f.setKind("confirmed");
    assert.equal((await f.stop()).code, 0);
    assert.equal(f.stops(), 2);
    await assertExited(f.service, f.childPid);
  },
);

test(
  "Windows launcher：等待停止超时仍保留后台；cmd 传递失败退出码",
  { skip: !windows },
  async (t) => {
    const f = await fixture(t, "inflight-forever");
    const started = Date.now();
    const result = await f.stop();
    assert.equal(result.code, 1, result.output);
    assert.ok(
      Date.now() - started >= 20_000,
      "pending stop should get its confirmation window",
    );
    assert.equal(alive(f.service.pid!), true);
    assert.equal(alive(f.childPid), true);
    assert.equal(existsSync(f.recordFile), true);
    f.setKind("unconfirmed");
    assert.equal((await f.cmd(936)).code, 1);
    assert.equal(alive(f.service.pid!), true);
    f.setKind("confirmed");
    assert.equal((await f.cmd(65001)).code, 0);
    await assertExited(f.service, f.childPid);
  },
);

test(
  "Windows launcher：陈旧回包、缺字段、字符串布尔值、单路归零和活动运行均保留后台",
  { skip: !windows },
  async (t) => {
    for (const kind of [
      "stale-post",
      "missing",
      "string-flags",
      "string-zero",
      "missing-run",
      "one-channel",
      "active",
    ]) {
      await t.test(kind, async (nested) => {
        const f = await fixture(nested, kind);
        assert.equal((await f.stop()).code, 1, kind);
        assert.equal(alive(f.service.pid!), true);
        assert.equal(alive(f.childPid), true);
        assert.equal(existsSync(f.recordFile), true);
      });
    }
  },
);

test(
  "Windows launcher：可执行路径、创建时间、项目入口和 PID 所有权验证阻止误杀",
  { skip: !windows },
  async (t) => {
    const f = await fixture(t);
    for (const field of [
      "executablePath",
      "processCreationUtc",
      "pid",
    ] as const) {
      const original = f.record[field];
      f.record[field] = field === "pid" ? process.pid : "invalid";
      f.save();
      assert.equal((await f.stop()).code, 1, field);
      assert.equal(alive(f.service.pid!), true);
      assert.equal(f.stops(), 0);
      f.record[field] = original;
    }
    const other = await fixture(t);
    f.record.pid = other.record.pid;
    f.record.executablePath = other.record.executablePath;
    f.record.processCreationUtc = other.record.processCreationUtc;
    f.save();
    assert.equal(
      (await f.stop()).code,
      1,
      "a server from another project root is not owned",
    );
    assert.equal(alive(other.service.pid!), true);
    assert.equal(other.stops(), 0);
  },
);

test(
  "Stop-Coyote.cmd：中文代码页 936 与 UTF-8 65001 均调用 PS5.1 并退出后台",
  { skip: !windows },
  async (t) => {
    for (const codepage of [936, 65001]) {
      await t.test(String(codepage), async (nested) => {
        const f = await fixture(nested);
        const result = await f.cmd(codepage);
        assert.equal(result.code, 0, result.output);
        assert.equal(f.stops(), 1);
        await assertExited(f.service, f.childPid);
      });
    }
  },
);
