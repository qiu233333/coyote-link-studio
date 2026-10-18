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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; codepage?: number } = {},
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
  child.stdin.end("\r\n");
  const timer = setTimeout(() => child.kill(), 12_000);
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

// Only these disposable processes are started or stopped. No real service,
// model, device or project data participates in the launcher tests.
const fixtureServer = `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const kind = process.argv[2];
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
let requests = 0;
const server = createServer((req, res) => {
  writeFileSync(join(process.cwd(), 'requests.json'), JSON.stringify(++requests));
  if (kind === 'hanging') return;
  const data = req.url === '/api/health'
    ? { service: 'coyote-link', ai: { ready: true } }
    : { stopUnconfirmed: true, stopping: true, run: { status: 'running' }, device: { intensities: { A: 9, B: 7 } } };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, data }));
});
server.listen(0, '127.0.0.1', () => {
  const ready = () => writeFileSync(join(process.cwd(), 'ready.json'), JSON.stringify({ port, childPid: child.pid }));
  const port = server.address().port;
  if (kind === 'offline') server.close(ready);
  else ready();
});
setInterval(() => {}, 1000);
`;

async function fixture(t: TestContext, kind = "offline") {
  const root = mkdtempSync(join(tmpdir(), "coyote-stop 中文-"));
  for (const directory of ["scripts", "server", "data"])
    mkdirSync(join(root, directory));
  copyFileSync(
    join(source, "scripts/local-service.ps1"),
    join(root, "scripts/local-service.ps1"),
  );
  copyFileSync(join(source, "Stop-Coyote.cmd"), join(root, "Stop-Coyote.cmd"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const entry = join(root, "server/index.ts");
  writeFileSync(entry, fixtureServer);
  const service = spawn(process.execPath, [entry, kind], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
  let childPid = 0;
  t.after(async () => {
    if (service.exitCode === null && service.signalCode === null)
      await run("taskkill.exe", ["/PID", String(service.pid), "/T", "/F"]);
    if (childPid && alive(childPid)) {
      try {
        process.kill(childPid);
      } catch {}
    }
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
    assertNoHttp() {
      assert.equal(
        existsSync(join(root, "requests.json")),
        false,
        "stop must not wait on or call the HTTP service",
      );
    },
    stop(env?: NodeJS.ProcessEnv) {
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
        { cwd: root, env },
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
  "PowerShell 5.1：无 HTTP 服务也直接结束进程树；重复 Stop 幂等",
  { skip: !windows },
  async (t) => {
    const f = await fixture(t);
    f.record.port = 0;
    f.save();
    const result = await f.stop({ COYOTE_PORT: "invalid" });
    assert.equal(result.code, 0, result.output);
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

test("Stop 无需 HTTP 响应或设备确认", { skip: !windows }, async (t) => {
  for (const kind of ["hanging", "unconfirmed"]) {
    await t.test(kind, async (nested) => {
      const f = await fixture(nested, kind);
      const result = await f.stop();
      assert.equal(result.code, 0, result.output);
      f.assertNoHttp();
      await assertExited(f.service, f.childPid);
    });
  }
});

test(
  "Stop 保留 PID、可执行路径、创建时间和项目入口所有权检查",
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
      assert.equal(alive(f.childPid), true);
      f.record[field] = original;
    }
    const other = await fixture(t);
    Object.assign(f.record, other.record);
    f.save();
    assert.equal(
      (await f.stop()).code,
      1,
      "another project's server must survive",
    );
    assert.equal(alive(other.service.pid!), true);
    assert.equal(alive(other.childPid), true);
    assert.equal(alive(f.service.pid!), true);
    f.assertNoHttp();
    other.assertNoHttp();
  },
);

test(
  "Stop-Coyote.cmd：中文路径，代码页 936 / UTF-8 65001 均立即退出后台",
  { skip: !windows },
  async (t) => {
    for (const codepage of [936, 65001]) {
      await t.test(String(codepage), async (nested) => {
        const f = await fixture(nested);
        const result = await f.cmd(codepage);
        assert.equal(result.code, 0, result.output);
        await assertExited(f.service, f.childPid);
      });
    }
  },
);
