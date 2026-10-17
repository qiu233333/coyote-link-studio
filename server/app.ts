import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { ZodError } from "zod";
import { AiService } from "./ai.js";
import { Controller } from "./controller.js";
import { CoyoteDevice, getBuiltinWaveforms } from "./device.js";
import { Store } from "./store.js";
import { AppError, assert } from "./errors.js";
import type { Protocol } from "../shared/types.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const secureEqual = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export async function createApplication(
  options: { directory?: string; dev?: boolean; startAi?: boolean } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app),
    sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const store = new Store(options.directory ?? resolve(root, "data"));
  const device = new CoyoteDevice(),
    ai = new AiService();
  const controller = new Controller(store, device, ai, getBuiltinWaveforms());
  const csrf = randomBytes(32).toString("hex");
  let localPort = 0;
  const allowedHosts = () =>
    new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
  const validOrigin = (origin: string | undefined) =>
    !origin || [...allowedHosts()].some((host) => origin === `http://${host}`);
  const validCookie = (cookie: string | undefined) => {
    const token =
      cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("coyote_session="))
        ?.slice("coyote_session=".length) ?? "";
    return secureEqual(token, csrf);
  };
  app.use((req, res, next) => {
    if (
      !allowedHosts().has(req.headers.host ?? "") ||
      !validOrigin(req.headers.origin)
    ) {
      res
        .status(403)
        .json({
          ok: false,
          error: "只允许本机同源访问。",
          code: "ORIGIN_REJECTED",
        });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'${options.dev ? " 'unsafe-inline'" : ""}; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'; base-uri 'self'`,
    );
    next();
  });
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      req.method !== "GET" &&
      (req.headers["x-coyote-request"] !== "1" ||
        !validCookie(req.headers.cookie))
    ) {
      res
        .status(403)
        .json({
          ok: false,
          error: "会话验证失败，请刷新页面后重试。",
          code: "SESSION_REQUIRED",
        });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "5mb", strict: true }));
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, data: { service: "coyote-link", ai: ai.status } }),
  );
  app.get("/api/state", (_req, res) => {
    res.setHeader(
      "Set-Cookie",
      `coyote_session=${csrf}; Path=/; HttpOnly; SameSite=Strict`,
    );
    res.json({ ok: true, data: controller.snapshot() });
  });
  type Action = (req: Request) => unknown | Promise<unknown>;
  const route = (
    method: "post" | "put" | "patch" | "delete",
    path: string,
    action: Action,
  ) => {
    app[method](
      path,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const result = await action(req);
          controller.broadcast(true);
          res.json({
            ok: true,
            data: result === undefined ? controller.snapshot() : result,
          });
        } catch (error) {
          next(error);
        }
      },
    );
  };
  const text = (value: unknown, label: string, maximum = 8000): string => {
    assert(
      typeof value === "string" && value.length <= maximum,
      `${label}无效。`,
    );
    return value;
  };
  route("post", "/api/device/connect", (req) =>
    controller.connect({
      protocol: req.body.protocol as Protocol,
      relayUrl:
        req.body.relayUrl === undefined
          ? undefined
          : text(req.body.relayUrl, "中继地址", 1000),
    }),
  );
  route("post", "/api/device/select", (req) =>
    controller.selectDevice(
      text(req.body.clientId, "APP 标识", 200),
      text(req.body.slotId, "设备标识", 200),
    ),
  );
  route("post", "/api/device/disconnect", () => controller.disconnect());
  route("patch", "/api/console/channels", (req) =>
    controller.updateChannels(req.body),
  );
  route("post", "/api/console/play", (req) =>
    controller.startPlayback(
      req.body.config,
      text(req.body.requestId, "请求标识", 200),
    ),
  );
  route("post", "/api/console/pause", () => controller.pause("manual"));
  route("post", "/api/console/resume", () => controller.resume("manual"));
  route("post", "/api/console/stop", () => controller.stop("manual"));
  route("post", "/api/console/next", () => controller.next());
  route("post", "/api/console/takeover", () => controller.takeover());
  route("post", "/api/waveforms/import", (req) =>
    controller.importWaveform(
      req.body.content,
      req.body.name === undefined
        ? undefined
        : text(req.body.name, "波形名称", 100),
    ),
  );
  route("patch", "/api/waveforms/:id", (req) =>
    controller.updateWaveform(String(req.params.id), req.body),
  );
  route("delete", "/api/waveforms/:id", (req) =>
    controller.deleteWaveform(String(req.params.id)),
  );
  route("post", "/api/presets", (req) =>
    controller.savePreset(
      text(req.body.name, "预设名称", 100),
      req.body.config,
    ),
  );
  route("delete", "/api/presets/:id", (req) =>
    controller.deletePreset(String(req.params.id)),
  );
  route("post", "/api/ai-control/start", (req) =>
    controller.startAi(
      req.body.bounds,
      text(req.body.requestId, "请求标识", 200),
    ),
  );
  route("post", "/api/ai-control/pause", () => controller.pause("ai-control"));
  route("post", "/api/ai-control/resume", () =>
    controller.resume("ai-control"),
  );
  route("post", "/api/ai-control/stop", () => controller.stop("ai-control"));
  route("patch", "/api/ai-control/bounds", (req) =>
    controller.changeBounds(req.body.bounds),
  );
  route("post", "/api/ai-control/feedback", (req) =>
    controller.feedback(text(req.body.text, "反馈", 4000), "ai-control"),
  );
  route("post", "/api/locked-tasks/draft", (req) =>
    controller.draftTask(text(req.body.prompt, "任务描述")),
  );
  route("patch", "/api/locked-tasks/:id", (req) =>
    controller.updatePlan(String(req.params.id), req.body.plan),
  );
  route("post", "/api/locked-tasks/:id/start", (req) =>
    controller.startTask(
      String(req.params.id),
      text(req.body.requestId, "请求标识", 200),
    ),
  );
  route("post", "/api/locked-tasks/feedback", (req) =>
    controller.feedback(text(req.body.text, "反馈", 4000), "locked-task"),
  );
  route("post", "/api/emergency-stop", () => controller.emergency());
  route("put", "/api/settings", (req) => {
    controller.assertIdle();
    store.saveSettings(req.body);
    controller.log("info", "设置", "AI 接口配置已保存，密钥已加密");
  });
  route("post", "/api/settings/test", async () => {
    controller.assertIdle();
    return ai.test(store.profile());
  });
  app.use("/api", (_req, res) =>
    res
      .status(404)
      .json({ ok: false, error: "接口不存在。", code: "NOT_FOUND" }),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      let status = 500,
        message = "操作失败，请检查运行记录。",
        code = "INTERNAL_ERROR";
      if (error instanceof AppError) {
        status = error.status;
        message = error.message;
        code = error.code;
      } else if (error instanceof ZodError) {
        status = 400;
        message = error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .slice(0, 5)
          .join("；");
        code = "VALIDATION_ERROR";
      } else if (error instanceof Error) {
        message = error.message;
        if ("status" in error && typeof error.status === "number")
          status = error.status;
        else status = 400;
      }
      res
        .status(status)
        .json({ ok: false, error: store.redact(message), code });
    },
  );
  let vite:
    Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
  if (options.dev) {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({
      root,
      server: {
        middlewareMode: true,
        hmr: { server, path: "/__vite_hmr" },
        fs: {
          deny: [
            "**/.env",
            "**/.env.*",
            "**/.git/**",
            "**/data/**",
            "**/.eve/**",
            "**/*.sqlite",
            "**/*.sqlite-*",
            "**/installation.key",
          ],
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const dist = resolve(root, "dist");
    app.use(express.static(dist, { index: false }));
    app.use((req, res) => {
      if (req.method === "GET" && existsSync(resolve(dist, "index.html")))
        res.sendFile("index.html", { root: dist });
      else
        res
          .status(404)
          .send("前端尚未构建，请运行 pnpm build 或使用 pnpm dev。");
    });
  }
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws")
      return;
    if (
      !allowedHosts().has(request.headers.host ?? "") ||
      !validOrigin(request.headers.origin) ||
      !validCookie(request.headers.cookie) ||
      sockets.clients.size >= 8
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.send(
        JSON.stringify({ type: "state", data: controller.snapshot() }),
      );
      websocket.on("error", () => websocket.close());
    });
  });
  controller.on("state", (snapshot) => {
    if (!sockets.clients.size) return;
    const body = JSON.stringify({ type: "state", data: snapshot });
    for (const socket of sockets.clients)
      if (socket.readyState === WebSocket.OPEN) {
        if (socket.bufferedAmount > 4 * 1024 * 1024)
          socket.close(1013, "请重新连接");
        else socket.send(body);
      }
  });
  ai.on("status", () => controller.broadcast(true));
  return {
    app,
    server,
    controller,
    store,
    ai,
    device,
    async listen(port = 3000) {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolveListen();
        });
      });
      localPort = (server.address() as { port: number }).port;
      if (options.startAi !== false)
        void ai
          .start()
          .catch((error) =>
            controller.log(
              "error",
              "AI 运行时",
              error instanceof Error ? error.message : "运行时启动失败",
            ),
          );
      return `http://127.0.0.1:${localPort}`;
    },
    async close() {
      await controller.close();
      await ai.stop();
      await device.disconnect();
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      await vite?.close();
      if (server.listening)
        await new Promise<void>((resolveClose) =>
          server.close(() => resolveClose()),
        );
      store.close();
    },
  };
}
