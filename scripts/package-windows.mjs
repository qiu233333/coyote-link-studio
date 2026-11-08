/** Build an allowlisted, self-contained Windows x64 release; never copy local data. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const nodeVersion = "24.22.2";
const output = join(root, "artifacts", "release");
const name = `Coyote-Link-v${pkg.version}-windows-x64`;
const stage = join(output, `build-${randomUUID()}`, name);
const app = join(stage, "app");
const pnpm = process.env.npm_execpath;
if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Package on Windows x64");
if (!pnpm) throw Error("Run with pnpm package:windows");
function run(command, args, cwd = root) {
  const env = { ...process.env };
  if (cwd !== root)
    for (const key of Object.keys(env))
      if (/^(npm_|pnpm_|init_cwd)/i.test(key)) delete env[key];
  execFileSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
}
function powershell(script, env = {}) {
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );
}
const sha = (data) => createHash("sha256").update(data).digest("hex");
async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
if (!process.argv.includes("--skip-build"))
  run(process.execPath, [pnpm, "build"]);
const emitted = resolve(root, ".server-build");
if (
  emitted !== join(root, ".server-build") ||
  (existsSync(emitted) && lstatSync(emitted).isSymbolicLink())
)
  throw Error("Refusing to clean an unexpected compiled-output directory");
rmSync(emitted, { recursive: true, force: true });
run(process.execPath, [
  join(root, "node_modules/typescript/bin/tsc"),
  "-p",
  "tsconfig.release.json",
]);
mkdirSync(app, { recursive: true });
// A separate hoisted installation contains only locked production dependencies,
// with real directories rather than pnpm links into the build machine's store.
for (const file of ["package.json", "pnpm-lock.yaml"])
  cpSync(join(root, file), join(app, file));
run(
  process.execPath,
  [
    pnpm,
    "--dir",
    app,
    "--ignore-workspace",
    "install",
    "--prod",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--config.node-linker=hoisted",
  ],
  app,
);
for (const file of [
  "pnpm-lock.yaml",
  "node_modules/.modules.yaml",
  "node_modules/.pnpm-workspace-state-v1.json",
]) {
  const path = join(app, file);
  if (existsSync(path)) unlinkSync(path);
}
console.log("Production dependencies prepared; copying compiled application.");
for (const dir of ["server", "shared"])
  cpSync(join(root, ".server-build", dir), join(app, dir), { recursive: true });
for (const dir of ["dist", ".output"])
  cpSync(join(root, dir), join(app, dir), {
    recursive: true,
    dereference: true,
  });
// The lockfile is build input, not needed by users at runtime.
mkdirSync(join(stage, "scripts"));
for (const file of ["Start-Coyote.cmd", "Stop-Coyote.cmd"])
  cpSync(join(root, file), join(stage, file));
for (const file of ["local-service.ps1", "verify-package.mjs"])
  cpSync(join(root, "scripts", file), join(stage, "scripts", file));
cpSync(join(root, "docs", "PORTABLE.md"), join(stage, "使用说明.md"));
cpSync(join(root, "docs"), join(stage, "docs"), { recursive: true });

const archiveName = `node-v${nodeVersion}-win-x64.zip`;
const base = `https://nodejs.org/dist/v${nodeVersion}/`;
const cache = join(output, "downloads");
mkdirSync(cache, { recursive: true });
const checksums = (await download(base + "SHASUMS256.txt")).toString("utf8");
const expected = checksums
  .split(/\r?\n/)
  .find((line) => line.endsWith(`  ${archiveName}`))
  ?.split(/\s+/)[0];
if (!expected) throw Error("Official Node archive checksum missing");
const archive = join(cache, archiveName);
let bytes = existsSync(archive)
  ? readFileSync(archive)
  : await download(base + archiveName);
if (sha(bytes) !== expected)
  throw Error("Official Node archive SHA256 mismatch");
writeFileSync(archive, bytes);
const unpack = join(output, `node-${randomUUID()}`);
console.log("Official Node ZIP SHA256 verified; extracting bundled runtime.");
powershell(
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:PACK_ARCHIVE, $env:PACK_UNPACK)",
  { PACK_ARCHIVE: archive, PACK_UNPACK: unpack },
);
mkdirSync(join(stage, "runtime"));
for (const file of ["node.exe", "LICENSE"])
  cpSync(
    join(unpack, `node-v${nodeVersion}-win-x64`, file),
    join(stage, "runtime", file),
  );
// Include all installed third-party license files and a version inventory.
const notices = [];
const files = {};
function visit(dir) {
  for (const item of readdirSync(dir)) {
    const path = join(dir, item);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error(`Non-portable symlink: ${path}`);
    if (stat.isDirectory()) visit(path);
    else {
      const name = relative(stage, path).replaceAll("\\", "/");
      files[name] = sha(readFileSync(path));
      if (item === "package.json" && name.includes("node_modules/")) {
        const p = JSON.parse(readFileSync(path, "utf8"));
        if (p.name && p.version)
          notices.push(
            `${p.name}@${p.version} — ${p.license ?? "see package license files"}`,
          );
      }
    }
  }
}
writeFileSync(
  join(stage, "THIRD-PARTY-NOTICES.txt"),
  "Node.js license: runtime/LICENSE\nDependency licenses are retained in app/node_modules and app/.output/server/node_modules.\n",
);
visit(stage);
console.log(
  `Hashed ${Object.keys(files).length} portable files; creating ZIP.`,
);
writeFileSync(
  join(stage, "THIRD-PARTY-NOTICES.txt"),
  readFileSync(join(stage, "THIRD-PARTY-NOTICES.txt"), "utf8") +
    [...new Set(notices)].sort().join("\n") +
    "\n",
);
files["THIRD-PARTY-NOTICES.txt"] = sha(
  readFileSync(join(stage, "THIRD-PARTY-NOTICES.txt")),
);
const manifest = {
  format: 1,
  version: pkg.version,
  platform: "win32-x64",
  nodeVersion,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  nodeArchiveSha256: expected,
  fingerprint: sha(JSON.stringify(files)),
  files,
};
writeFileSync(
  join(stage, "release.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const zip = join(output, name + ".zip");
// .NET ZIP includes hidden .output directories; Compress-Archive can skip them.
powershell(
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; if (Test-Path -LiteralPath $env:PACK_ZIP) { Remove-Item -LiteralPath $env:PACK_ZIP }; [IO.Compression.ZipFile]::CreateFromDirectory($env:PACK_STAGE, $env:PACK_ZIP, [IO.Compression.CompressionLevel]::Optimal, $true)",
  { PACK_STAGE: stage, PACK_ZIP: zip },
);
writeFileSync(zip + ".sha256", `${sha(readFileSync(zip))}  ${name}.zip\n`);
writeFileSync(
  join(output, "latest.json"),
  JSON.stringify({ stage, zip, version: pkg.version }, null, 2),
);
console.log(
  JSON.stringify({
    zip,
    stage,
    files: Object.keys(files).length,
    bytes: lstatSync(zip).size,
  }),
);
