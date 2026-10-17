import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const runtimeMajor = Number(process.versions.node.split(".")[0]);
const schemaVersion = 1;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const dependencyInputs = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];
const sourceInputs = [
  ...dependencyInputs,
  "src",
  "server",
  "shared",
  "agent",
  "public",
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "scripts/build-agent.mjs",
  "scripts/local-service.ps1",
  "scripts/build-state.mjs",
  "Start-Coyote.cmd",
  "Stop-Coyote.cmd",
];
const buildEntrypoints = ["dist/index.html", ".output/server/index.mjs"];

function statePath(root) {
  return join(root, "data", "build-state.json");
}

function readState(root) {
  try {
    const state = JSON.parse(
      readFileSync(statePath(root), "utf8").replace(/^\uFEFF/, ""),
    );
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      state.version !== schemaVersion ||
      (state.dependencyFingerprint !== undefined &&
        (typeof state.dependencyFingerprint !== "string" ||
          !fingerprintPattern.test(state.dependencyFingerprint))) ||
      (state.sourceFingerprint !== undefined &&
        (typeof state.sourceFingerprint !== "string" ||
          !fingerprintPattern.test(state.sourceFingerprint)))
    ) {
      return { version: schemaVersion };
    }
    return {
      version: schemaVersion,
      ...(state.dependencyFingerprint
        ? { dependencyFingerprint: state.dependencyFingerprint }
        : {}),
      ...(state.sourceFingerprint
        ? { sourceFingerprint: state.sourceFingerprint }
        : {}),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return { version: schemaVersion };
    }
    throw error;
  }
}

function writeState(root, state) {
  const target = statePath(root);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function hashInput(hash, root, relative) {
  const path = join(root, relative);
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    hash.update(JSON.stringify(["missing", relative]));
    hash.update("\0");
    return;
  }
  if (entry.isDirectory()) {
    hash.update(JSON.stringify(["directory", relative]));
    hash.update("\0");
    for (const name of readdirSync(path).sort()) {
      hashInput(hash, root, `${relative}/${name}`);
    }
    return;
  }
  // The build follows file contents. Refuse source links rather than treating
  // an untracked external target as unchanged or recursing through a cycle.
  if (!entry.isFile()) {
    throw new Error(`构建输入不是普通文件或目录：${relative}`);
  }
  const contents = readFileSync(path);
  hash.update(JSON.stringify(["file", relative, contents.length]));
  hash.update("\0");
  hash.update(contents);
  hash.update("\0");
}

function fingerprint(root, inputs, kind, nodeMajor) {
  const hash = createHash("sha256");
  hash.update(
    `coyote-build-state-v${schemaVersion}\0${kind}\0node-${nodeMajor}\0`,
  );
  for (const relative of [...inputs].sort()) hashInput(hash, root, relative);
  return hash.digest("hex");
}

function fingerprints(root, nodeMajor) {
  return {
    sourceFingerprint: fingerprint(root, sourceInputs, "sources", nodeMajor),
    dependencyFingerprint: fingerprint(
      root,
      dependencyInputs,
      "dependencies",
      nodeMajor,
    ),
  };
}

function hasFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Inspecting freshness never creates directories or changes the stored state. */
export function inspectBuildState(root = workspace, nodeMajor = runtimeMajor) {
  const current = fingerprints(root, nodeMajor);
  const state = readState(root);
  const dependenciesMissing = !hasFile(
    join(root, "node_modules/tsx/package.json"),
  );
  const needsInstall =
    dependenciesMissing ||
    state.dependencyFingerprint !== current.dependencyFingerprint;
  const buildMissing = buildEntrypoints.some(
    (path) => !hasFile(join(root, path)),
  );
  const sourceChanged = state.sourceFingerprint !== current.sourceFingerprint;
  const needsBuild = needsInstall || buildMissing || sourceChanged;
  const reasons = [];
  if (needsInstall)
    reasons.push("依赖尚未验证，或依赖配置/Node.js 主版本已变化");
  if (buildMissing) reasons.push("缺少网页或 AI 运行时构建入口");
  if (sourceChanged) reasons.push("源码或启动配置已变化，或尚无成功构建记录");
  return {
    ...current,
    needsInstall,
    needsBuild,
    reason: reasons.length ? reasons.join("；") : "依赖和构建均为最新版本",
  };
}

/** Discard only the build success marker, including after a failed rebuild. */
export function invalidateBuild(root = workspace) {
  const state = readState(root);
  delete state.sourceFingerprint;
  writeState(root, state);
}

/** Invalidate before install, including a repair using the same lockfile. */
export function invalidateDependencies(root = workspace) {
  writeState(root, { version: schemaVersion });
}

/** Record a successful frozen install only for the snapshot it installed. */
export function markDependencies(
  root,
  expectedDependencyFingerprint,
  nodeMajor = runtimeMajor,
) {
  invalidateBuild(root);
  const current = fingerprints(root, nodeMajor);
  if (
    !fingerprintPattern.test(expectedDependencyFingerprint ?? "") ||
    current.dependencyFingerprint !== expectedDependencyFingerprint
  ) {
    throw new Error("安装期间依赖配置发生变化，请重新运行启动器。");
  }
  if (!hasFile(join(root, "node_modules/tsx/package.json"))) {
    throw new Error("依赖安装未生成 tsx 入口，不能记录安装成功。");
  }
  writeState(root, {
    version: schemaVersion,
    dependencyFingerprint: current.dependencyFingerprint,
  });
}

/** Record success only after the full build and its source snapshot agree. */
export function markBuild(
  root,
  expectedSourceFingerprint,
  nodeMajor = runtimeMajor,
) {
  // A rejected attempt must never leave an earlier successful build reusable.
  invalidateBuild(root);
  const current = fingerprints(root, nodeMajor);
  const state = readState(root);
  if (
    !fingerprintPattern.test(expectedSourceFingerprint ?? "") ||
    current.sourceFingerprint !== expectedSourceFingerprint
  ) {
    throw new Error("构建期间源码发生变化，请重新运行启动器。");
  }
  if (
    state.dependencyFingerprint !== current.dependencyFingerprint ||
    !hasFile(join(root, "node_modules/tsx/package.json"))
  ) {
    throw new Error("当前依赖尚未验证，不能记录构建成功。");
  }
  if (buildEntrypoints.some((path) => !hasFile(join(root, path)))) {
    throw new Error("构建缺少网页或 AI 运行时入口，不能记录构建成功。");
  }
  writeState(root, {
    version: schemaVersion,
    dependencyFingerprint: current.dependencyFingerprint,
    sourceFingerprint: current.sourceFingerprint,
  });
}

function runCli() {
  const [command, expected, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("构建状态命令参数无效。");
  switch (command) {
    case "inspect":
      if (expected !== undefined) throw new Error("inspect 不接受额外参数。");
      // Windows PowerShell 5.1 may decode native stdout using the legacy console
      // code page. Keep this machine-readable channel ASCII so Chinese reasons
      // survive ConvertFrom-Json in both double-click and UTF-8 terminals.
      process.stdout.write(
        `${JSON.stringify(inspectBuildState()).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`,
      );
      break;
    case "mark-dependencies":
      markDependencies(workspace, expected);
      break;
    case "invalidate-build":
      if (expected !== undefined)
        throw new Error("invalidate-build 不接受额外参数。");
      invalidateBuild();
      break;
    case "invalidate-dependencies":
      if (expected !== undefined)
        throw new Error("invalidate-dependencies 不接受额外参数。");
      invalidateDependencies();
      break;
    case "mark-build":
      markBuild(workspace, expected);
      break;
    default:
      throw new Error(
        "未知构建状态命令。支持 inspect、mark-dependencies、invalidate-dependencies、invalidate-build、mark-build。",
      );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runCli();
  } catch (error) {
    console.error(
      `构建状态：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
