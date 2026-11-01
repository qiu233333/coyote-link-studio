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
import {
  aiProvider,
  credentialTarget,
  type AiProvider,
} from "../shared/aiProvider.js";

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
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  page<T>(
    collection: string,
    limit = 50,
    before = Number.MAX_SAFE_INTEGER,
  ): { items: T[]; cursor?: number } {
    const rows = this.db
      .prepare(
        "SELECT rowid,payload FROM documents WHERE collection=? AND rowid<? ORDER BY rowid DESC LIMIT ?",
      )
      .all(collection, before, Math.min(100, Math.max(1, limit))) as {
      rowid: number;
      payload: string;
    }[];
    return {
      items: rows.map((r) => JSON.parse(r.payload) as T),
      cursor: rows.length ? rows.at(-1)!.rowid : undefined,
    };
  }
  storyRange<T>(
    collection: string,
    afterSeq: number,
    beforeSeq: number,
    limit = 20,
  ): T[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM documents WHERE collection=? AND json_extract(payload,'$.seq')>? AND json_extract(payload,'$.seq')<? ORDER BY rowid ASC LIMIT ?",
        )
        .all(collection, afterSeq, beforeSeq, limit) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as T);
  }
  clear(collection: string) {
    this.db.prepare("DELETE FROM documents WHERE collection=?").run(collection);
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
      provider: aiProvider({
        baseUrl: saved?.baseUrl ?? "",
        provider: saved?.provider,
      }),
      deepseekThinking: saved?.deepseekThinking ?? "disabled",
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
    const selected = input.provider ?? previous.provider;
    assert(
      selected === "deepseek" || selected === "openai-compatible",
      "AI 服务类型无效。",
    );
    const provider = aiProvider({ baseUrl, provider: selected as AiProvider });
    const deepseekThinking =
      input.deepseekThinking ?? previous.deepseekThinking;
    assert(
      deepseekThinking === "disabled" || deepseekThinking === "enabled",
      "DeepSeek 思考模式无效。",
    );
    assert(
      !previous.apiKey ||
        typeof input.apiKey === "string" ||
        credentialTarget(previous) === credentialTarget({ baseUrl, provider }),
      "已切换 AI 服务或地址，请重新输入供该服务使用的 API Key；旧密钥不会自动转发。无需密钥时请先清除已保存的密钥。",
    );
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
      provider,
      deepseekThinking,
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
