# DeepSeek 配置与适配说明

核对日期：2026-10-23。适用当前分支的系统设置、AI 控制和 AI 上锁任务。

## 配置

1. 打开「系统设置」，在「AI 服务」选择 **DeepSeek**。
2. 保留官方 Base URL `https://api.deepseek.com` 和预设模型 `deepseek-flash`；需要时可改为 `deepseek-v4-pro`。模型名可编辑，以提供商当前可用模型为准。
3. 在本机页面输入供 DeepSeek 使用的 API Key，点击「保存并测试连接」。不要把密钥发到聊天、截图或问题报告中。
4. 测试成功后，先连接模拟设备，按正常流程确认 AI 控制范围或生成上锁任务草稿。

预设上下文窗口为 1,000,000 tokens；这是配置预算，应用仍只发送必要的业务快照。决策/测试与草稿超时分别设置，原有超时值保留。聊天测试、工具测试和回执验证共用一次测试的总超时预算。

首次使用建议关闭「DeepSeek 思考模式」，降低等待时间。显式开启后会增加输出预算，可能仍因服务排队或长推理超时；关闭思考或简化草稿可减少等待。调高超时不会延长任务截止时间。

「自定义 OpenAI 兼容服务」仍支持自定义地址、模型和无密钥本地模型。DeepSeek 选项的地址也可编辑以支持兼容代理；代理必须接受 DeepSeek 的思考参数。旧配置若已使用 `api.deepseek.com`，读取时自动采用 DeepSeek 协议，不改模型名或现有超时。

## 密钥与切换服务

- 仍使用本机 SQLite + AES-256-GCM 加密，网页只得到 `apiKeySet` 并显示固定掩码；密钥不进入浏览器持久化、模型提示词、业务日志或 eve 工作流历史。
- 同一服务和规范化地址下，留空保留已保存密钥；模型、思考模式或超时修改不要求重新输入。
- 服务类型或地址（包括路径）变化时，后端拒绝隐式继承旧密钥，原配置保持有效。请重新输入目标服务的密钥，或在无密钥服务场景显式清除。页面切换预设或编辑地址会清空尚未保存的密钥输入。
- 只有一份当前 AI 配置，不保存多供应商密钥列表。供应商请求不跟随 HTTP 重定向，避免凭证被转发；遇到重定向接口应填写最终 API 地址。
- `DEEPSEEK_API_KEY` 等环境密钥不继承给 AI 子进程；选定密钥仅随经过本机鉴权的请求进入 worker 内存。

## 协议选择

官方当前推荐 `deepseek-flash`，另提供 `deepseek-v4-pro`，使用 `/chat/completions`。两者支持工具调用和思考/非思考模式。依据：[首次调用](https://api-docs.deepseek.com/)、[模型说明](https://api-docs.deepseek.com/quick_start/pricing/)。不把旧模型别名静默替换成新模型。

DeepSeek 默认开启思考，但思考时不允许 `required` 或指定名称的 `tool_choice`。本应用关闭思考时显式发送 `thinking.type=disabled` 并指定业务工具；开启时发送 `enabled`、`reasoning_effort=high` 和 `tool_choice=auto`。无论模式如何，返回值必须是**恰好一次指定业务工具调用**，并通过结构和业务范围双重校验。自然语言、空结果、多工具调用、非法 JSON、截断或越界结果不能转成设备动作。依据：[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。

业务结构通过工具参数提交；未使用 OpenAI 的 `response_format=json_schema`，也未启用 DeepSeek `/beta` 的 strict 工具。官方 JSON Output 是 `json_object`，仍可能产生空内容；strict 工具有单独的 schema 限制，不能用来替代后端校验。依据：[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。

每次控制决策和草稿使用新业务快照，反馈作为该快照的数据发送，不复用未配对的工具历史。DeepSeek 的连接测试另做一次无副作用工具结果回传：保留原工具 ID、将本地随机回执作为 tool 消息发送，要求模型读出回执。安装版本的 OpenAI 兼容适配器会把 assistant 的 `reasoning_content` 完整回传；这些内容仅留在本次测试内存中，不展示或持久化。依据：[思考模式多轮工具约束](https://api-docs.deepseek.com/guides/thinking_mode/)。

测试/草稿/决策共用单一在途请求限制，取消确认之前不能开启替代请求。草稿仅待机时生成，急停后迟到的草稿不能入库。原有控制会话代际隔离、A/B 独立边界、后端锁定、控制权互斥、硬截止和急停继续生效。

## 失败提示

认证失败提示检查 Key/权限；402 提示余额不足；404 提示地址/模型；400/422 提示服务类型、模型或思考参数；429 和临时服务错误保留有限恢复策略。截断提示关闭思考或简化任务。原始服务错误文本、响应体和推理内容不返回页面。依据：[官方错误码](https://api-docs.deepseek.com/quick_start/error_codes/)。

运行中的临时推理错误先清队列并确认双路归零，再最多重试 20 次；连续恢复期间保持零输出，每次间隔 1 秒，成功决策后重置额度。无效业务输出不进入这类重试，截止不延长。细节见 [AI 中断排查](AI-INTERRUPTIONS.md)。

## 验证范围

本次使用隔离数据库、独立 eve 进程、本地可控 API 桩和模拟设备。协议契约、完整控制流程和错误恢复均有自动化覆盖，详见 [验证记录](VERIFICATION.md)。

**未进行真实 DeepSeek API 验证，也未进行真实硬件验证。** 本会话没有获得明确授权供 DeepSeek 使用的有效密钥。实际账户权限、余额、模型可用性、网络时延及模型输出质量需在设置页输入密钥后验证。界面测试成功只说明当前地址的聊天、工具和回传能力，不承诺所有任务描述或设备组合都能成功。

可复现命令（浏览器套件使用本机 Edge 和随机端口，不访问生产配置）：

```powershell
pnpm build
pnpm test
pnpm exec tsx scripts/verify-browser.ts --deepseek
pnpm exec tsx scripts/verify-browser.ts --deepseek --thinking
pnpm exec tsx scripts/verify-ai-interruptions-browser.ts --deepseek
pnpm verify:browser
pnpm verify:limits
pnpm verify:pulse-import
```
