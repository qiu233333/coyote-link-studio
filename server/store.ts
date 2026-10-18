import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { AiProfile, AiSettings } from "../shared/types.js";
import {
  AI_TIMEOUT_DEFAULT_SEC,
  AI_DRAFT_TIMEOUT_DEFAULT_SEC,
  AI_TIMEOUT_MIN_SEC,
  AI_TIMEOUT_MAX_SEC,
} from "../shared/aiTimeouts.js";
import { assert } from "./errors.js";

export class Store {
  private db: DatabaseSync;
  private key: Buffer;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, "installation.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(keyPath);
    assert(
      this.key.length === 32,
      "本机密钥文件无效，请恢复 installation.key。",
    );
    this.db = new DatabaseSync(join(directory, "coyote.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(collection,id)); PRAGMA user_version=1;",
    );
  }
  get<T>(collection: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT payload FROM documents WHERE collection=? AND id=?")
      .get(collection, id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
  list<T>(collection: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM documents WHERE collection=? ORDER BY rowid DESC",
        )
        .all(collection) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as T);
  }
  set(collection: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO documents(collection,id,payload) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload",
      )
      .run(collection, id, JSON.stringify(value));
  }
  delete(collection: string, id: string) {
    this.db
      .prepare("DELETE FROM documents WHERE collection=? AND id=?")
      .run(collection, id);
  }
  private seal(text: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    return Buffer.concat([
      iv,
      cipher.update(text, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  private unseal(value: string): string {
    const bytes = Buffer.from(value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      decipher.update(bytes.subarray(12, -16)),
      decipher.final(),
    ]).toString("utf8");
  }
  profile(): AiProfile {
    const saved = this.get<AiSettings & { secret?: string }>("settings", "ai");
    return {
      baseUrl: saved?.baseUrl ?? "",
      model: saved?.model ?? "",
      contextWindow: saved?.contextWindow ?? 32000,
      timeoutSec: saved?.timeoutSec ?? AI_TIMEOUT_DEFAULT_SEC,
      draftTimeoutSec:
        saved?.draftTimeoutSec ??
        Math.max(
          saved?.timeoutSec ?? AI_TIMEOUT_DEFAULT_SEC,
          AI_DRAFT_TIMEOUT_DEFAULT_SEC,
        ),
      apiKeySet: Boolean(saved?.secret),
      apiKey: saved?.secret ? this.unseal(saved.secret) : "",
    };
  }
  settings(): AiSettings {
    const { apiKey: _secret, ...settings } = this.profile();
    return settings;
  }
  saveSettings(input: Record<string, unknown>) {
    const previous = this.profile();
    const baseUrl = String(input.baseUrl ?? previous.baseUrl)
      .trim()
      .replace(/\/+$/, "");
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("请输入有效的 AI Base URL。");
    }
    assert(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "Base URL 必须是无凭证、查询参数或片段的 HTTP/HTTPS 地址。",
    );
    const model = String(input.model ?? previous.model).trim();
    assert(model.length > 0 && model.length <= 200, "请填写模型名称。");
    const contextWindow = Number(input.contextWindow ?? previous.contextWindow),
      timeoutSec = Number(input.timeoutSec ?? previous.timeoutSec),
      draftTimeoutSec = Number(
        input.draftTimeoutSec ?? previous.draftTimeoutSec,
      );
    assert(
      Number.isInteger(contextWindow) &&
        contextWindow >= 1024 &&
        contextWindow <= 2000000,
      "上下文窗口须在 1024 到 2000000 之间。",
    );
    assert(
      Number.isFinite(timeoutSec) &&
        timeoutSec >= AI_TIMEOUT_MIN_SEC &&
        timeoutSec <= AI_TIMEOUT_MAX_SEC,
      `超时须为 ${AI_TIMEOUT_MIN_SEC} 到 ${AI_TIMEOUT_MAX_SEC} 秒。`,
    );
    assert(
      Number.isFinite(draftTimeoutSec) &&
        draftTimeoutSec >= AI_TIMEOUT_MIN_SEC &&
        draftTimeoutSec <= AI_TIMEOUT_MAX_SEC,
      `任务草稿超时须为 ${AI_TIMEOUT_MIN_SEC} 到 ${AI_TIMEOUT_MAX_SEC} 秒。`,
    );
    const apiKey =
      typeof input.apiKey === "string" ? input.apiKey.trim() : previous.apiKey;
    assert(apiKey.length <= 4096, "API Key 过长。");
    this.set("settings", "ai", {
      baseUrl,
      model,
      contextWindow,
      timeoutSec,
      draftTimeoutSec,
      secret: apiKey ? this.seal(apiKey) : undefined,
    });
  }
  redact(message: string): string {
    const secret = this.profile().apiKey;
    return secret ? message.split(secret).join("[已隐藏]") : message;
  }
  close() {
    this.db.close();
  }
}
