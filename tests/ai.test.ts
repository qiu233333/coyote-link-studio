import { test } from "node:test";
import { verifyAiRuntime } from "../scripts/verify-ai.ts";

test(
  "独立 eve 运行时：真实兼容接口调用、业务范围、内部鉴权、取消与密钥脱敏",
  { timeout: 60000 },
  verifyAiRuntime,
);
