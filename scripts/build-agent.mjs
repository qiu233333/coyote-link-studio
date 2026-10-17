import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("eve/package.json")), "bin", "eve.js");
const child = spawn(process.execPath, [cli, "build"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" },
});
child.on("error", (error) => {
  console.error("eve 构建无法启动：", error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
