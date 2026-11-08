# Windows 免安装版

从 [GitHub Releases](https://github.com/qiu233333/coyote-link-studio/releases/latest) 下载 `Coyote-Link-v版本号-windows-x64.zip`。不要下载 `Source code` 源码包代替成品。

1. Windows 10/11 x64：将 ZIP **完整解压**到当前用户可写的普通目录，例如 `D:\Apps\Coyote-Link`。支持中文和空格路径；不要直接在压缩包里运行，也不要放进需要管理员权限的 Program Files。
2. 双击 `Start-Coyote.cmd`，等待「控制台与 AI 运行时已就绪」，浏览器会自动打开 `http://127.0.0.1:3000`。
3. 在系统设置中填写自己的 AI 接口、模型和 API Key，执行连接测试；在控制台选择模拟设备，或用官方 APP 配对真实设备。

不需要安装 Node.js、pnpm、Git、Codex，也不需要在首次启动时下载依赖或编译。调用在线模型和连接官方 APP 中继仍需要网络、自己的 API Key 和可用额度。手动控制不需要 AI Key。

## 停止与后台

关闭浏览器不会退出后台。先在网页使用紧急停止，并核对 APP/设备状态，再运行 `Stop-Coyote.cmd` 结束本项目后台及 AI 子进程。Stop 是直接结束进程，不代表设备归零已经确认。重复启动会复用当前后台，重复停止可以安全执行。

端口占用会显示原因，不会关闭其他程序。可用以下命令选择其他端口：

```powershell
.\Start-Coyote.cmd -Port 3100
```

只监听本机 `127.0.0.1`，不提供公开网站或多用户服务。

## 数据、备份和升级

所有用户数据及 AI 工作目录默认保存在解压目录下的 `data/`。发布包没有预置用户数据；首次运行自动创建。`data/coyote.sqlite` 与 `data/installation.key` 必须一起备份，缺少原加密密钥将无法解密已保存的 API Key。

升级时先停止旧版，完整备份旧版 `data/`，将新版解压到**新目录**，再把旧版整个 `data/` 复制到新版目录，最后启动新版。不要在旧后台运行时覆盖程序或复制数据库。程序不会自动恢复上次的设备输出。回退旧版时使用升级前的数据库备份，避免旧程序读取已升级的数据结构。

如果一直使用源码工作树，需复制实际使用目录的数据，不能只凭代码是否已合并判断数据在哪个目录。支持用 `COYOTE_DATA_DIR` 指定固定数据目录；Start 和 Stop 必须使用相同值。不建议多个版本同时共用一个数据目录。

## 排错与校验

- 首次解压若被 Windows 提示来源，请确认下载自本仓库 Releases。不要关闭系统安全软件；有拦截时保留提示内容以便排查。
- 提示包不完整或校验失败：重新下载并完整解压。不要只复制网页或删除 `app/.output`、`app/node_modules`、`runtime` 等目录。
- 启动失败查看 `data/service.stderr.log` 和 `data/service.stdout.log`。提交反馈前删除密钥和私人聊天信息。
- 每个 ZIP 附带 `.sha256`，可用 `Get-FileHash .\Coyote-Link-v版本号-windows-x64.zip -Algorithm SHA256` 对比；启动器会检查包内程序文件。
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local-service.ps1 status` 查看后台状态。

第三方运行时许可见 `runtime/LICENSE`，依赖许可随文件保留，清单见 `THIRD-PARTY-NOTICES.txt`。

## 构建与验收（开发者）

在 Windows x64、Node.js 24、pnpm 11.25.0 中运行：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm package:windows
pnpm verify:portable
```

成品在 `artifacts/release/`，使用官方 Node.js 24.22.2 x64 ZIP，并比对官方 SHASUMS256。后台编译为 JS；网页、eve 产物及按锁文件独立安装的生产依赖一并发布。打包只复制白名单文件，不复制开发目录的 `data/`、`.eve/`、日志、凭据或私有故事。

`.github/workflows/release.yml` 在推送 `v*` 标签时测试、构建和验收，通过后上传 ZIP 和 SHA256 到 GitHub Releases。也可以手动运行工作流只生成验收产物。版本标签必须与 package.json 一致。

验收覆盖隔离 PATH/用户目录、独立提取 ZIP、后台与 eve 就绪、网页/API/WebSocket、模拟设备、设置保存和模型测试、故事轮次、停止、重启后数据保留、端口占用、文件损坏与升级迁移。隔离启动环境不等于全新 Windows 虚拟机；真实硬件和真实模型兼容性需另行验证。
