# 本机运行环境

- 核验日期：2026-10-18。
- Node.js：24.19.0。
- pnpm：11.25.0。
- 依赖：已通过 `pnpm install --frozen-lockfile` 核对，与锁文件一致。
- 生产构建：`dist/` 为网页，`.output/` 为独立 eve AI 运行时。
- 默认地址：`http://127.0.0.1:3000`，仅本机可访问。

## 普通终端与双击启动

当前电脑的 Node.js/pnpm 由 Codex 提供，原有 Windows 用户和系统 PATH 中没有对应条目。项目启动器会自动发现已安装的 Node.js 24+，找不到时使用当前账户下 Codex 自带的运行时。

启动器仅设置本次启动进程的 PATH，不修改系统或用户全局环境。项目不需要 `.env` 文件；AI Base URL、API Key 和模型名在网页系统设置中填写。

- `Start-Coyote.cmd`：后台启动项目，检查网页和 AI 运行时，并打开浏览器。
- `Stop-Coyote.cmd`：停止本项目服务；结束前先尝试急停归零。
- `scripts/local-service.ps1 status`：查询本项目服务状态。
- `scripts/local-service.ps1 start -NoBrowser`：后台启动，不自动打开外部浏览器。

从项目目录运行 PowerShell 脚本时，可使用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local-service.ps1 start -NoBrowser
```

`ExecutionPolicy Bypass` 仅用于这次脚本进程，不更改系统执行策略。

## 状态与日志

- `data/service.json`：本项目后台进程及端口记录，不含 AI 密钥。
- `data/service.stdout.log`：启动日志。
- `data/service.stderr.log`：错误日志。
- `GET /api/health`：本地服务健康状态，以及独立 AI 运行时是否就绪。

上述运行数据均不提交 Git。不要在服务运行期间重建 eve 的 `.output/`，Windows 可能锁定正在运行的文件；更新时先停止，再构建、启动。

## 验证范围

本次已在只保留 Windows 用户/系统 PATH（不含 Codex 临时 PATH）的进程中实际验证：

- 一键启动成功，重复启动复用已有后台。
- 一键停止后端口释放，再次启动成功。
- 网页 HTTP 200，`/api/health` 返回本地服务正常且 AI 运行时 `ready: true`。
- 控制台、AI 控制、AI 上锁任务和设置四个页面均可打开，浏览器未发现页面异常或控制台错误。
- 服务已保持后台运行；最新进程记录在 `data/service.json`。本次网页检查截图及结果在 `artifacts/startup-current.png`、`artifacts/startup-current.json`。

网页和本地 AI 运行时启动成功，不代表已经连接真实设备或通过外部模型服务验证。首次使用仍需在网页配置实际 AI 接口，并通过官方 APP 配对设备。
