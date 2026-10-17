import { createApplication } from "./app.js";

const port = Number(process.env.COYOTE_PORT || process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("端口必须为 1 到 65535。");
const application = await createApplication({
  dev: process.argv.includes("--dev"),
  directory: process.env.COYOTE_DATA_DIR,
});
const url = await application.listen(port);
process.stdout.write(
  `\n  星涟联动 · Coyote Link\n  本机控制台：${url}\n  AI 运行时会在后台启动；首次使用请配置接口并连接设备。\n\n`,
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await application.close();
  process.exit(0);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
