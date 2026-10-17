import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectBuildState,
  invalidateBuild,
  invalidateDependencies,
  markBuild,
  markDependencies,
} from "../scripts/build-state.mjs";

function write(root: string, relative: string, contents = "fixture") {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coyote-build-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries({
    "package.json": '{"name":"fixture","type":"module"}',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - .\n",
    "src/main.tsx": 'export const name = "old interface";\n',
    "server/index.ts": "export {};\n",
    "shared/types.ts": "export {};\n",
    "agent/agent.ts": "export {};\n",
    "agent/instructions.md": "fixture agent instructions\n",
    "public/favicon.svg": "<svg/>\n",
    "index.html": "<div id='root'></div>\n",
    "vite.config.ts": "export default {};\n",
    "tsconfig.json": "{}\n",
    "scripts/build-agent.mjs": "// build fixture\n",
    "scripts/local-service.ps1": "# launcher fixture\n",
    "scripts/build-state.mjs": "// helper fixture\n",
    "Start-Coyote.cmd": "@echo off\n",
    "Stop-Coyote.cmd": "@echo off\n",
  }))
    write(root, path, contents);
  return root;
}

function install(root: string) {
  const snapshot = inspectBuildState(root);
  write(root, "node_modules/tsx/package.json", '{"name":"tsx"}');
  markDependencies(root, snapshot.dependencyFingerprint);
}

function build(root: string) {
  const snapshot = inspectBuildState(root);
  invalidateBuild(root);
  write(root, "dist/index.html", "built interface");
  write(root, ".output/server/index.mjs", "// built agent");
  markBuild(root, snapshot.sourceFingerprint);
}

function state(root: string) {
  return JSON.parse(readFileSync(join(root, "data/build-state.json"), "utf8"));
}

test("首次无 Git 目录检查不写文件；安装构建后多次启动可复用", (t) => {
  const root = fixture(t);
  const first = inspectBuildState(root);
  assert.equal(first.needsInstall, true);
  assert.equal(first.needsBuild, true);
  assert.match(first.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(first.dependencyFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(root, "data")), false);
  assert.equal(existsSync(join(root, ".git")), false);

  install(root);
  assert.equal(inspectBuildState(root).needsInstall, false);
  assert.equal(inspectBuildState(root).needsBuild, true);
  build(root);
  const successful = inspectBuildState(root);
  assert.equal(successful.needsInstall, false);
  assert.equal(successful.needsBuild, false);
  const saved = readFileSync(join(root, "data/build-state.json"), "utf8");
  assert.deepEqual(inspectBuildState(root), successful);
  assert.equal(
    readFileSync(join(root, "data/build-state.json"), "utf8"),
    saved,
  );
  assert.deepEqual(readdirSync(join(root, "data")), ["build-state.json"]);
});

test("源码内容变化即使恢复原时间戳也会重新构建；无需重复安装", (t) => {
  const root = fixture(t);
  install(root);
  build(root);
  const original = inspectBuildState(root);
  const target = join(root, "src/main.tsx");
  const time = statSync(target);
  writeFileSync(target, 'export const name = "new interface";\n');
  utimesSync(target, time.atime, time.mtime);
  const changed = inspectBuildState(root);
  assert.notEqual(changed.sourceFingerprint, original.sourceFingerprint);
  assert.equal(changed.dependencyFingerprint, original.dependencyFingerprint);
  assert.equal(changed.needsInstall, false);
  assert.equal(changed.needsBuild, true);
  build(root);
  assert.equal(inspectBuildState(root).needsBuild, false);
});

test("所有运行源目录、启动器与构建配置都会使构建失效", (t) => {
  const root = fixture(t);
  install(root);
  build(root);
  for (const path of [
    "src/new-component.tsx",
    "server/controller.ts",
    "shared/intensity.ts",
    "agent/instructions.md",
    "public/avatar.svg",
    "index.html",
    "vite.config.ts",
    "tsconfig.json",
    "scripts/build-agent.mjs",
    "scripts/local-service.ps1",
    "scripts/build-state.mjs",
    "Start-Coyote.cmd",
    "Stop-Coyote.cmd",
  ]) {
    write(root, path, `changed ${path}`);
    assert.equal(inspectBuildState(root).needsBuild, true, path);
    assert.equal(inspectBuildState(root).needsInstall, false, path);
    build(root);
  }
  rmSync(join(root, "src/new-component.tsx"));
  assert.equal(inspectBuildState(root).needsBuild, true);
});

test("日志、数据库、产物、文档与验收截图不参与源码指纹", (t) => {
  const root = fixture(t);
  install(root);
  build(root);
  const original = inspectBuildState(root);
  for (const path of [
    "data/private.sqlite",
    "data/service.stdout.log",
    "artifacts/screenshot.png",
    "docs/VERIFICATION.md",
    "README.md",
    ".git/HEAD",
    ".eve/session.json",
    "dist/assets/frontend.js",
    ".output/server/chunks/agent.mjs",
    "node_modules/tsx/unrelated.txt",
  ])
    write(root, path, "changed runtime data");
  assert.deepEqual(inspectBuildState(root), original);
});

test("依赖配置变化需重新安装和构建；成功安装会清除旧构建标记", (t) => {
  const root = fixture(t);
  install(root);
  build(root);
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]) {
    const previous = inspectBuildState(root);
    write(root, path, `changed ${path}`);
    const changed = inspectBuildState(root);
    assert.notEqual(
      changed.dependencyFingerprint,
      previous.dependencyFingerprint,
    );
    assert.equal(changed.needsInstall, true, path);
    assert.equal(changed.needsBuild, true, path);
    install(root);
    assert.equal(state(root).sourceFingerprint, undefined);
    assert.equal(inspectBuildState(root).needsInstall, false);
    build(root);
  }
  const otherNode = inspectBuildState(
    root,
    Number(process.versions.node.split(".")[0]) + 1,
  );
  assert.equal(otherNode.needsInstall, true);
  assert.equal(otherNode.needsBuild, true);
});

test("构建失败使旧成功标记失效，依赖可复用，下一次仍需构建", (t) => {
  const root = fixture(t);
  install(root);
  build(root);
  const dependencyFingerprint = state(root).dependencyFingerprint;
  invalidateBuild(root);
  write(root, "dist/index.html", "partial build that failed");
  assert.equal(state(root).sourceFingerprint, undefined);
  assert.equal(state(root).dependencyFingerprint, dependencyFingerprint);
  assert.equal(inspectBuildState(root).needsInstall, false);
  assert.equal(inspectBuildState(root).needsBuild, true);
  build(root);
  assert.equal(inspectBuildState(root).needsBuild, false);
});

test("构建期间源码变化拒绝成功标记，并清除先前成功状态", (t) => {
  const root = fixture(t);
  install(root);
  build(root);
  const before = inspectBuildState(root);
  write(root, "src/main.tsx", "modified during build");
  assert.throws(
    () => markBuild(root, before.sourceFingerprint),
    /构建期间源码发生变化/,
  );
  assert.equal(state(root).sourceFingerprint, undefined);
  assert.equal(inspectBuildState(root).needsBuild, true);
  assert.equal(inspectBuildState(root).needsInstall, false);
});

test("依赖安装期间配置变化或入口缺失不能记录安装成功", (t) => {
  const root = fixture(t);
  const before = inspectBuildState(root);
  write(root, "pnpm-lock.yaml", "modified while installing");
  assert.throws(
    () => markDependencies(root, before.dependencyFingerprint),
    /安装期间依赖配置发生变化/,
  );
  assert.equal(inspectBuildState(root).needsInstall, true);
  const current = inspectBuildState(root);
  assert.throws(
    () => markDependencies(root, current.dependencyFingerprint),
    /依赖安装未生成 tsx 入口/,
  );
  assert.equal(state(root).sourceFingerprint, undefined);
  assert.equal(state(root).dependencyFingerprint, undefined);
});

test("同一锁文件的修复安装中途失败，即使已恢复 tsx 入口也仍需重新安装", (t) => {
  const root = fixture(t);
  install(root);
  build(root);
  rmSync(join(root, "node_modules/tsx/package.json"));
  assert.equal(inspectBuildState(root).needsInstall, true);
  invalidateDependencies(root);
  // A failed package manager can have already copied tsx, without completing
  // installation of all other packages. It must not revive the old marker.
  write(root, "node_modules/tsx/package.json", "{}");
  assert.equal(state(root).dependencyFingerprint, undefined);
  assert.equal(state(root).sourceFingerprint, undefined);
  assert.equal(inspectBuildState(root).needsInstall, true);
  assert.equal(inspectBuildState(root).needsBuild, true);
  install(root);
  build(root);
  assert.equal(inspectBuildState(root).needsInstall, false);
  assert.equal(inspectBuildState(root).needsBuild, false);
});

test("缺少任一产物入口均需构建，且不能标记成功", (t) => {
  const root = fixture(t);
  install(root);
  build(root);
  for (const path of ["dist/index.html", ".output/server/index.mjs"]) {
    rmSync(join(root, path));
    const current = inspectBuildState(root);
    assert.equal(current.needsBuild, true);
    assert.throws(() => markBuild(root, current.sourceFingerprint), /构建缺少/);
    assert.equal(state(root).sourceFingerprint, undefined);
    build(root);
  }
  rmSync(join(root, "node_modules/tsx/package.json"));
  const current = inspectBuildState(root);
  assert.equal(current.needsInstall, true);
  assert.equal(current.needsBuild, true);
  assert.throws(
    () => markBuild(root, current.sourceFingerprint),
    /当前依赖尚未验证/,
  );
  assert.equal(state(root).sourceFingerprint, undefined);
});

test("损坏或版本不符记录视为过期，部分记录不能绕过依赖检查", (t) => {
  const root = fixture(t);
  install(root);
  build(root);
  const current = inspectBuildState(root);
  for (const contents of [
    "{incomplete",
    "null",
    "[]",
    JSON.stringify({ version: 999, ...current }),
    JSON.stringify({ version: 1, dependencyFingerprint: "invalid" }),
    JSON.stringify({
      version: 1,
      sourceFingerprint: current.sourceFingerprint,
    }),
  ]) {
    write(root, "data/build-state.json", contents);
    assert.equal(inspectBuildState(root).needsInstall, true);
    assert.equal(inspectBuildState(root).needsBuild, true);
    assert.equal(
      readFileSync(join(root, "data/build-state.json"), "utf8"),
      contents,
    );
  }
});

test("CLI 单行 JSON、成功静默与失败退出仅作用于独立副本", (t) => {
  const root = fixture(t);
  const helper = join(root, "scripts/build-state.mjs");
  copyFileSync(
    fileURLToPath(new URL("../scripts/build-state.mjs", import.meta.url)),
    helper,
  );
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [helper, ...args], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
  const inspected = cli("inspect");
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.stderr, "");
  assert.equal(inspected.stdout.trim().split(/\r?\n/).length, 1);
  assert.match(
    inspected.stdout,
    /^[\x00-\x7f]*$/,
    "版本检测 JSON 应兼容 Windows 传统控制台编码",
  );
  const current = JSON.parse(inspected.stdout);
  assert.match(current.reason, /依赖/);
  assert.equal(current.needsInstall, true);
  write(root, "node_modules/tsx/package.json", "{}");
  const installed = cli("mark-dependencies", current.dependencyFingerprint);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout, "");
  assert.equal(installed.stderr, "");
  write(root, "dist/index.html");
  write(root, ".output/server/index.mjs");
  const built = cli("mark-build", current.sourceFingerprint);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(built.stdout, "");
  assert.equal(built.stderr, "");
  assert.equal(JSON.parse(cli("inspect").stdout).needsBuild, false);
  const invalidated = cli("invalidate-build");
  assert.equal(invalidated.status, 0, invalidated.stderr);
  assert.equal(invalidated.stdout, "");
  assert.equal(invalidated.stderr, "");
  const failure = cli("mark-build", "wrong-snapshot");
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /构建期间源码发生变化/);
  assert.equal(state(root).sourceFingerprint, undefined);
  const dependenciesInvalidated = cli("invalidate-dependencies");
  assert.equal(
    dependenciesInvalidated.status,
    0,
    dependenciesInvalidated.stderr,
  );
  assert.equal(dependenciesInvalidated.stdout, "");
  assert.equal(dependenciesInvalidated.stderr, "");
  assert.equal(JSON.parse(cli("inspect").stdout).needsInstall, true);
  assert.equal(cli("unknown-command").status, 1);
  assert.equal(cli("inspect", "unexpected").status, 1);
});
