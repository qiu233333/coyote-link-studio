import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiDecision, AiProfile, TaskPlan } from "../shared/types.ts";

type AiStatus = { ready: boolean; error?: string; errorCode?: string };
type TestResult = { chat: boolean; tools: boolean; message: string };
type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
};
const recoverableErrors = new Set([
  "AI_TIMEOUT",
  "AI_TRANSPORT",
  "AI_RATE_LIMIT",
  "AI_PROVIDER_UNAVAILABLE",
]);

/** Stable, redacted categories; recovery policy belongs to the controller. */
export class AiServiceError extends Error {
  readonly name = "AiServiceError";
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.retryable = recoverableErrors.has(code);
  }
}
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
  private generation = 0;
  private healthPending?: number;
  private healthFailures = 0;
  private requests = new Set<AbortController>();
  private exitRegistered = false;
  private readonly runtimeDirectory?: string;

  constructor(options: { runtimeDirectory?: string } = {}) {
    super();
    this.runtimeDirectory = options.runtimeDirectory;
  }

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
      status.error !== this.status.error ||
      status.errorCode !== this.status.errorCode
    ) {
      this.status = status;
      this.emit("status", this.status);
    }
  }

  async start(): Promise<void> {
    if (this.status.ready) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    const generation = ++this.generation;
    this.clearHealth();
    if (!this.exitRegistered) {
      process.once("exit", this.exitCleanup);
      this.exitRegistered = true;
    }
    this.starting = this.launch(generation).finally(() => {
      if (this.generation === generation) this.starting = undefined;
    });
    return this.starting;
  }

  private current(generation: number) {
    return !this.stopping && this.generation === generation;
  }

  private clearHealth() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    this.healthPending = undefined;
    this.healthFailures = 0;
  }

  private async launch(generation: number) {
    try {
      // A failed health check can leave the worker alive. Replace that exact
      // process before opening another worker, rather than leaking a second one.
      await this.killChild();
      if (!this.current(generation)) return;
      const port = await availablePort();
      if (!this.current(generation)) return;
      this.endpoint = `http://127.0.0.1:${port}`;
      this.token = randomBytes(32).toString("hex");
      const development =
        process.argv.includes("--dev") || process.env.COYOTE_EVE_DEV === "1";
      if (
        !development &&
        !existsSync(join(root, ".output", "server", "index.mjs"))
      ) {
        this.setStatus({ ready: false, error: "正在首次构建 eve AI 运行时…" });
        await this.build(generation);
      }
      if (!this.current(generation)) return;
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
        : this.runtimeDirectory
          ? // The built Nitro entry supports an isolated working directory. eve
            // otherwise pins its workflow data to <cwd>/.eve/.workflow-data.
            [join(root, ".output", "server", "index.mjs")]
          : [cli, "start", "--host", "127.0.0.1", "--port", String(port)];
      const env = {
        ...process.env,
        COYOTE_EVE_TOKEN: this.token,
        EVE_TELEMETRY_DISABLED: "1",
        ...(!development && this.runtimeDirectory
          ? {
              HOST: "127.0.0.1",
              NITRO_HOST: "127.0.0.1",
              PORT: String(port),
              NITRO_PORT: String(port),
            }
          : {}),
      };
      // The selected provider credentials arrive only in authenticated requests.
      for (const name of [
        "AI_GATEWAY_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
      ])
        delete (env as Record<string, string | undefined>)[name];
      const child = spawn(process.execPath, args, {
        cwd: !development ? (this.runtimeDirectory ?? root) : root,
        env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      // Consume pipes without exposing eve internals in product logs. Explicit
      // `node scripts/build-agent.mjs` retains complete build diagnostics.
      child.stdout?.resume();
      child.stderr?.resume();
      child.once("error", () => {
        if (this.current(generation) && this.child === child)
          this.runtimeFailed("eve AI 运行时无法启动，请检查 Node.js 与依赖。");
      });
      child.once("exit", () => {
        if (this.current(generation) && this.child === child) {
          this.child = undefined;
          this.runtimeFailed("eve AI 运行时已退出，请重新启动应用。");
        }
      });
      const startAt = Date.now();
      const endpoint = this.endpoint,
        token = this.token;
      while (
        this.current(generation) &&
        this.child === child &&
        Date.now() - startAt < 120000
      ) {
        const healthy = await this.healthy(endpoint, token);
        if (!this.current(generation)) return;
        if (this.child !== child)
          throw new Error(this.status.error ?? "eve AI 运行时在启动时退出。");
        if (healthy) {
          this.setStatus({ ready: true });
          this.healthTimer = setInterval(() => {
            void this.checkHealth();
          }, 5000);
          this.healthTimer.unref();
          return;
        }
        await delay(500);
      }
      if (this.current(generation))
        throw new Error(
          "eve AI 运行时未就绪，请运行 node scripts/build-agent.mjs 查看构建诊断。",
        );
    } catch (error) {
      if (!this.current(generation)) return;
      const message =
        error instanceof Error ? error.message : "eve AI 运行时启动失败。";
      this.setStatus({
        ready: false,
        error: message,
        errorCode: "AI_RUNTIME_UNAVAILABLE",
      });
      await this.killChild();
      throw new AiServiceError("AI_RUNTIME_UNAVAILABLE", message);
    }
  }

  private async build(generation: number) {
    const child = spawn(process.execPath, [cli, "build"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" },
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.killChild(child);
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
        if (this.generation === generation && this.child === child)
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

  private async healthy(endpoint = this.endpoint, token = this.token) {
    try {
      const response = await fetch(`${endpoint}/internal/health`, {
        headers: { authorization: `Bearer ${token}` },
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
    const generation = this.generation,
      child = this.child;
    if (
      this.stopping ||
      !this.status.ready ||
      this.healthPending === generation
    )
      return;
    this.healthPending = generation;
    try {
      const healthy = await this.healthy();
      // An old probe must neither fault nor revive a replacement worker.
      if (
        !this.current(generation) ||
        this.child !== child ||
        !this.status.ready
      )
        return;
      if (healthy) {
        this.healthFailures = 0;
      } else if (++this.healthFailures >= 3) {
        this.runtimeFailed("eve AI 运行时连续三次健康检查失败，连接已中断。");
      }
    } finally {
      if (this.healthPending === generation) this.healthPending = undefined;
    }
  }

  private runtimeFailed(error: string) {
    this.clearHealth();
    this.setStatus({
      ready: false,
      error,
      errorCode: "AI_RUNTIME_UNAVAILABLE",
    });
    for (const request of this.requests)
      request.abort(new AiServiceError("AI_RUNTIME_UNAVAILABLE", error));
  }

  private async invoke<T>(
    operation: string,
    profile: AiProfile,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.status.ready)
      throw new AiServiceError(
        "AI_RUNTIME_UNAVAILABLE",
        this.status.error ?? "AI 运行时尚未就绪，请稍后重试。",
      );
    if (signal?.aborted)
      throw new AiServiceError("AI_CANCELLED", "AI 请求已取消。");
    const requestId = randomUUID();
    // Capture credentials and the address together. A late cancellation from a
    // previous generation must never be sent to a replacement worker.
    const endpoint = this.endpoint,
      token = this.token,
      generation = this.generation;
    const controller = new AbortController();
    this.requests.add(controller);
    let cancellation: Promise<boolean> | undefined;
    let failure: AiServiceError | undefined;
    const cancelRemote = () => {
      cancellation ??= fetch(`${endpoint}/internal/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ requestId }),
        signal: AbortSignal.timeout(2000),
      })
        .then(async (response) => {
          if (!response.ok) return false;
          const result = (await response.json()) as Envelope<unknown>;
          return result?.ok === true;
        })
        .catch(() => false);
      return cancellation;
    };
    const cancel = () => {
      controller.abort(new AiServiceError("AI_CANCELLED", "AI 请求已取消。"));
      void cancelRemote();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timeout = setTimeout(
      () => {
        controller.abort(new AiServiceError("AI_TIMEOUT", "AI 请求超时。"));
        void cancelRemote();
      },
      Math.max(2, Math.min(180, profile.timeoutSec)) * 1000 + 1000,
    );
    try {
      const response = await fetch(`${endpoint}/internal/${operation}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ requestId, profile, ...payload }),
        signal: controller.signal,
      });
      let body: Envelope<T>;
      try {
        body = (await response.json()) as Envelope<T>;
      } catch {
        throw new AiServiceError("AI_INVALID_RESPONSE", "AI 返回无效响应。");
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!body || typeof body !== "object" || typeof body.ok !== "boolean")
        throw new AiServiceError("AI_INVALID_RESPONSE", "AI 返回无效响应。");
      if (!response.ok || !body.ok || body.data === undefined)
        throw new AiServiceError(
          typeof body.errorCode === "string" &&
            /^AI_[A-Z_]+$/.test(body.errorCode)
            ? body.errorCode
            : "AI_REQUEST_FAILED",
          typeof body.error === "string" ? body.error : "AI 返回无效响应。",
        );
      return body.data;
    } catch (error) {
      const reason = controller.signal.aborted
        ? controller.signal.reason
        : error;
      // Never forward native fetch errors, causes or stacks. The only remote
      // error strings are sanitized by our internal route, then redacted again.
      const classified =
        reason instanceof AiServiceError
          ? reason
          : new AiServiceError("AI_TRANSPORT", "AI 本地运行时请求连接失败。");
      failure = new AiServiceError(
        classified.code,
        profile.apiKey
          ? classified.message.split(profile.apiKey).join("[已隐藏]")
          : classified.message,
      );
      throw failure;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      // Keep the controller's single-flight promise pending through the bounded
      // remote cancellation, so replacement feedback cannot race its old call.
      try {
        if (controller.signal.aborted || failure?.code === "AI_TRANSPORT") {
          const confirmed = await cancelRemote();
          if (!confirmed && this.current(generation) && this.status.ready) {
            const message = "AI 旧请求取消未获确认，已停止后续推理。";
            this.runtimeFailed(message);
            throw new AiServiceError("AI_CANCELLATION_UNCONFIRMED", message);
          }
        }
      } finally {
        this.requests.delete(controller);
      }
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
    const generation = ++this.generation;
    this.starting = undefined;
    this.clearHealth();
    this.setStatus({ ready: false });
    for (const request of this.requests)
      request.abort(new AiServiceError("AI_CANCELLED", "AI 运行时已停止。"));
    this.requests.clear();
    await this.killChild();
    if (this.generation !== generation) return;
    if (this.exitRegistered) {
      process.removeListener("exit", this.exitCleanup);
      this.exitRegistered = false;
    }
  }

  private async killChild(child = this.child) {
    if (this.child === child) this.child = undefined;
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
