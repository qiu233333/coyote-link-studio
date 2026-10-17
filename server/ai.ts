import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiDecision, AiProfile, TaskPlan } from "../shared/types.ts";

type AiStatus = { ready: boolean; error?: string };
type TestResult = { chat: boolean; tools: boolean; message: string };
type Envelope<T> = { ok: boolean; data?: T; error?: string };
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(
  dirname(createRequire(import.meta.url).resolve("eve/package.json")),
  "bin",
  "eve.js",
);
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 AI 内部端口"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Independent local eve worker. It can recommend, never send device commands. */
export class AiService extends EventEmitter {
  status: AiStatus = { ready: false };
  private child?: ChildProcess;
  private token = randomBytes(32).toString("hex");
  private endpoint = "";
  private starting?: Promise<void>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private healthPending = false;
  private requests = new Set<AbortController>();
  private exitRegistered = false;
  private exitCleanup = () => {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform === "win32")
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5000,
      });
    else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already exited */
        }
      }
    }
  };

  private setStatus(status: AiStatus) {
    if (
      status.ready !== this.status.ready ||
      status.error !== this.status.error
    ) {
      this.status = status;
      this.emit("status", this.status);
    }
  }

  async start(): Promise<void> {
    if (this.status.ready) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    if (!this.exitRegistered) {
      process.once("exit", this.exitCleanup);
      this.exitRegistered = true;
    }
    this.starting = this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async launch() {
    try {
      const port = await availablePort();
      this.endpoint = `http://127.0.0.1:${port}`;
      this.token = randomBytes(32).toString("hex");
      const development =
        process.argv.includes("--dev") || process.env.COYOTE_EVE_DEV === "1";
      if (
        !development &&
        !existsSync(join(root, ".output", "server", "index.mjs"))
      ) {
        this.setStatus({ ready: false, error: "正在首次构建 eve AI 运行时…" });
        await this.build();
      }
      if (this.stopping) return;
      const args = development
        ? [
            cli,
            "dev",
            "--no-ui",
            "--no-default-extensions",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
          ]
        : [cli, "start", "--host", "127.0.0.1", "--port", String(port)];
      const env = {
        ...process.env,
        COYOTE_EVE_TOKEN: this.token,
        EVE_TELEMETRY_DISABLED: "1",
      };
      // The selected provider credentials arrive only in authenticated requests.
      for (const name of [
        "AI_GATEWAY_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
      ])
        delete (env as Record<string, string | undefined>)[name];
      this.child = spawn(process.execPath, args, {
        cwd: root,
        env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Consume pipes without exposing eve internals in product logs. Explicit
      // `node scripts/build-agent.mjs` retains complete build diagnostics.
      this.child.stdout?.resume();
      this.child.stderr?.resume();
      this.child.once("error", () =>
        this.runtimeFailed("eve AI 运行时无法启动，请检查 Node.js 与依赖。"),
      );
      this.child.once("exit", () => {
        this.child = undefined;
        if (!this.stopping)
          this.runtimeFailed("eve AI 运行时已退出，请重新启动应用。");
      });
      const startAt = Date.now();
      while (!this.stopping && this.child && Date.now() - startAt < 120000) {
        if (await this.healthy()) {
          this.setStatus({ ready: true });
          this.healthTimer = setInterval(() => {
            void this.checkHealth();
          }, 5000);
          this.healthTimer.unref();
          return;
        }
        await delay(500);
      }
      if (!this.stopping)
        throw new Error(
          "eve AI 运行时未就绪，请运行 node scripts/build-agent.mjs 查看构建诊断。",
        );
    } catch (error) {
      if (this.stopping) {
        await this.killChild();
        return;
      }
      const message =
        error instanceof Error ? error.message : "eve AI 运行时启动失败。";
      this.setStatus({ ready: false, error: message });
      await this.killChild();
      throw new Error(message);
    }
  }

  private async build() {
    const child = spawn(process.execPath, [cli, "build"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" },
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.killChild();
        reject(
          new Error("eve 构建超时，请手动运行 node scripts/build-agent.mjs。"),
        );
      }, 180000);
      child.once("error", () => {
        clearTimeout(timeout);
        reject(new Error("无法启动 eve 构建。"));
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        this.child = undefined;
        code === 0
          ? resolve()
          : reject(
              new Error(
                "eve 构建失败，请运行 node scripts/build-agent.mjs 查看诊断。",
              ),
            );
      });
    });
  }

  private async healthy() {
    try {
      const response = await fetch(`${this.endpoint}/internal/health`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(2000),
      });
      const body = (await response.json()) as Envelope<{
        runtime: string;
        ready: boolean;
      }>;
      return (
        response.ok &&
        body.ok &&
        body.data?.runtime === "eve" &&
        body.data.ready
      );
    } catch {
      return false;
    }
  }

  private async checkHealth() {
    if (this.stopping || this.healthPending) return;
    this.healthPending = true;
    try {
      if (await this.healthy()) this.setStatus({ ready: true });
      else this.runtimeFailed("eve AI 运行时连接中断。");
    } finally {
      this.healthPending = false;
    }
  }

  private runtimeFailed(error: string) {
    this.setStatus({ ready: false, error });
    for (const request of this.requests) request.abort(new Error(error));
  }

  private async invoke<T>(
    operation: string,
    profile: AiProfile,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.status.ready)
      throw new Error(this.status.error ?? "AI 运行时尚未就绪，请稍后重试。");
    const requestId = randomUUID();
    const controller = new AbortController();
    this.requests.add(controller);
    const cancelRemote = () => {
      controller.abort(
        signal?.reason ?? new DOMException("Cancelled", "AbortError"),
      );
      void fetch(`${this.endpoint}/internal/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ requestId }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancelRemote, { once: true });
    if (signal?.aborted) cancelRemote();
    const timeout = setTimeout(
      cancelRemote,
      Math.max(2, Math.min(180, profile.timeoutSec)) * 1000 + 1000,
    );
    try {
      const response = await fetch(`${this.endpoint}/internal/${operation}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ requestId, profile, ...payload }),
        signal: controller.signal,
      });
      const body = (await response.json()) as Envelope<T>;
      if (!response.ok || !body.ok || body.data === undefined)
        throw new Error(body.error ?? "AI 返回无效响应。");
      return body.data;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          signal?.aborted ? "AI 请求已取消。" : "AI 请求超时或运行时中断。",
        );
      // The only remote error string is already redacted by our internal route.
      const text = error instanceof Error ? error.message : "AI 请求失败。";
      throw new Error(
        profile.apiKey ? text.split(profile.apiKey).join("[已隐藏]") : text,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancelRemote);
      this.requests.delete(controller);
    }
  }

  decide(
    profile: AiProfile,
    context: unknown,
    signal?: AbortSignal,
  ): Promise<AiDecision> {
    return this.invoke("decide", profile, { context }, signal);
  }
  draft(
    profile: AiProfile,
    prompt: string,
    context: unknown,
    signal?: AbortSignal,
  ): Promise<Omit<TaskPlan, "id" | "version" | "createdAt">> {
    return this.invoke("draft", profile, { prompt, context }, signal);
  }
  test(profile: AiProfile): Promise<TestResult> {
    return this.invoke("test", profile, {});
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    for (const request of this.requests)
      request.abort(new DOMException("Stopped", "AbortError"));
    this.requests.clear();
    await this.killChild();
    if (this.exitRegistered) {
      process.removeListener("exit", this.exitCleanup);
      this.exitRegistered = false;
    }
    this.setStatus({ ready: false });
  }

  private async killChild() {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      // eve starts child workers; kill the process tree so hot reloads and exits
      // never leave a second hidden runtime listening behind the controller.
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      await new Promise<void>((resolve) => {
        killer.once("exit", () => resolve());
        killer.once("error", () => {
          child.kill();
          resolve();
        });
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  }
}
