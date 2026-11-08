Windows x64 免安装版：下载 **Coyote-Link-v0.2.0-windows-x64.zip**，完整解压，双击 **Start-Coyote.cmd**。无需安装 Node.js、pnpm、Git 或 Codex。

包含控制台、A/B 独立控制、JSON/.pulse 波形、AI 控制、AI 上锁任务、情景演绎和角色卡/故事记忆；支持 DeepSeek 和自定义 OpenAI 兼容接口。使用 AI 需在设置页提供自己的 API Key 和模型。

- 已包含官方 Node.js 24.22.2、编译后的后台、网页和独立 eve AI 运行时。
- 首次启动在 data/ 创建自己的数据，发布包没有任何预置用户配置、密钥或故事。
- 启动检查程序完整性，校验 ZIP 可使用随附 SHA256 文件。
- 发布工作流在 Windows 上执行全量测试和解压包验收，使用本地模型桩及模拟设备验证；不等同于所有真实模型/硬件的兼容保证。

**升级前先停止旧版并备份整个 data/，将新版解压到新目录，再迁移 data/。** 数据库和 installation.key 必须一起保留。不要在运行期间覆盖程序或复制数据库。

停止设备输出请先使用网页紧急停止并核对 APP。Stop-Coyote.cmd 直接结束本项目进程，不代表设备归零已确认。

使用说明：https://github.com/qiu233333/coyote-link-studio/blob/main/docs/PORTABLE.md

下载 ZIP 成品附件，不要把下方自动生成的 Source code 当成免安装包。
