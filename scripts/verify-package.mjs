import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "release.json"), "utf8"),
  );
  if (
    manifest.format !== 1 ||
    !manifest.files ||
    manifest.platform !== "win32-x64"
  )
    throw Error("Invalid release manifest");
  if (process.platform !== "win32" || process.arch !== "x64")
    throw Error("This package requires Windows x64");
  for (const [name, digest] of Object.entries(manifest.files)) {
    const path = resolve(root, name);
    if (!path.startsWith(resolve(root) + sep) || !/^[a-f0-9]{64}$/.test(digest))
      throw Error("Invalid manifest path or checksum");
    if (
      !lstatSync(path).isFile() ||
      createHash("sha256").update(readFileSync(path)).digest("hex") !== digest
    )
      throw Error(`Missing or damaged release file: ${name}`);
  }
  for (const required of [
    "runtime/node.exe",
    "app/server/index.js",
    "app/dist/index.html",
    "app/.output/server/index.mjs",
  ])
    if (!manifest.files[required])
      throw Error(`Required entry missing: ${required}`);
  console.log(
    JSON.stringify({
      version: manifest.version,
      sourceFingerprint: manifest.fingerprint,
      needsInstall: false,
      needsBuild: false,
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
