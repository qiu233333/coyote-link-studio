import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  Link,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  WandSparkles,
  X,
} from "lucide-react";
import type { AppSnapshot } from "../shared/types";
import { isActive, type Action } from "./api";
import { Badge, Card, Field, LoadingButton, NumberInput } from "./ui";

export default function SettingsPage({
  state,
  action,
  pending,
}: {
  state: AppSnapshot;
  action: Action;
  pending: boolean;
}) {
  const [form, setForm] = useState({ ...state.settings, apiKey: "" });
  const [showKey, setShowKey] = useState(false);
  const [result, setResult] = useState<{
    chat: boolean;
    tools: boolean;
    message: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const active = isActive(state);
  const disabled = active || state.stopping || pending;
  useEffect(
    () => setForm((f) => ({ ...state.settings, apiKey: f.apiKey })),
    [
      state.settings.baseUrl,
      state.settings.model,
      state.settings.contextWindow,
      state.settings.timeoutSec,
      state.settings.apiKeySet,
    ],
  );
  const save = async () => {
    const result = await action(
      "/api/settings",
      {
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        contextWindow: form.contextWindow,
        timeoutSec: form.timeoutSec,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      },
      "PUT",
      "AI 配置已保存",
    );
    if (result !== undefined) setForm((f) => ({ ...f, apiKey: "" }));
    return result;
  };
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      if ((await save()) === undefined) return;
      const r = await action<{
        chat: boolean;
        tools: boolean;
        message: string;
      }>("/api/settings/test", {});
      if (r) setResult(r);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="page-content">
      <div className="section-title">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>
            系统设置<span className="title-dot">.</span>
          </h1>
          <p>连接你的模型，让星涟拥有属于你的思考方式。</p>
        </div>
        <Badge color="blue">
          <ShieldCheck size={14} />
          仅本机保存
        </Badge>
      </div>
      {active && (
        <div className="notice notice-pink">
          <ShieldCheck size={18} />
          <span>
            {state.locked
              ? "任务锁定中，设置暂不可修改。"
              : "请先结束当前控制会话，再修改 AI 配置。"}
          </span>
        </div>
      )}
      <div className="settings-layout">
        <Card
          title="AI 接口配置"
          eyebrow="OPENAI COMPATIBLE"
          icon={<WandSparkles size={19} />}
        >
          <div className="settings-status">
            <span className="settings-icon">
              <Sparkles size={22} />
            </span>
            <div>
              <strong>
                {state.aiRuntime.ready ? "AI 运行时已就绪" : "连接你的 AI 模型"}
              </strong>
              <p>
                {state.aiRuntime.ready
                  ? "控制范围由后端校验，模型仅能调用授权业务工具。"
                  : state.aiRuntime.error ||
                    "支持提供聊天与工具调用的 OpenAI 兼容接口。"}
              </p>
            </div>
            <Badge color={state.aiRuntime.ready ? "blue" : "gray"} dot>
              {state.aiRuntime.ready ? "可用" : "待配置"}
            </Badge>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset className="plain-fieldset" disabled={disabled}>
              <Field
                label="Base URL"
                hint="填写兼容 API 的基础地址，通常以 /v1 结尾。"
              >
                <div className="input-with-icon">
                  <Link size={17} />
                  <input
                    aria-label="AI Base URL"
                    type="url"
                    required
                    placeholder="https://api.openai.com/v1"
                    value={form.baseUrl}
                    onChange={(e) =>
                      setForm({ ...form, baseUrl: e.target.value })
                    }
                  />
                </div>
              </Field>
              <Field
                label="API Key"
                hint={
                  state.settings.apiKeySet
                    ? "已加密保存。留空保留现有密钥，填写新值可替换。"
                    : "密钥仅保存在后端，不会进入浏览器持久化或日志。"
                }
              >
                <div className="input-with-icon">
                  <KeyRound size={17} />
                  <input
                    aria-label="AI API Key"
                    type={showKey ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder={
                      state.settings.apiKeySet
                        ? "••••••••••••••••（已保存）"
                        : "sk-…"
                    }
                    value={form.apiKey}
                    onChange={(e) =>
                      setForm({ ...form, apiKey: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="input-icon-button"
                    aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </Field>
              <Field
                label="模型名称"
                hint="请使用提供商支持工具调用的模型 ID。"
              >
                <div className="input-with-icon">
                  <Server size={17} />
                  <input
                    aria-label="AI 模型名称"
                    required
                    placeholder="例如 gpt-4.1-mini"
                    value={form.model}
                    onChange={(e) =>
                      setForm({ ...form, model: e.target.value })
                    }
                  />
                </div>
              </Field>
              <div className="form-grid">
                <Field label="上下文窗口 / tokens">
                  <NumberInput
                    label="模型上下文窗口"
                    value={form.contextWindow}
                    min={1024}
                    max={2000000}
                    step={1024}
                    onChange={(contextWindow) =>
                      setForm({ ...form, contextWindow })
                    }
                  />
                </Field>
                <Field label="请求超时 / 秒">
                  <NumberInput
                    label="AI 请求超时"
                    value={form.timeoutSec}
                    min={5}
                    max={120}
                    onChange={(timeoutSec) => setForm({ ...form, timeoutSec })}
                  />
                </Field>
              </div>
            </fieldset>
            {state.settings.apiKeySet && (
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={async () => {
                  if (
                    confirm(
                      "确定清除已保存的 API Key？无密钥的本地模型可以继续使用。",
                    )
                  ) {
                    const cleared = await action(
                      "/api/settings",
                      {
                        baseUrl: form.baseUrl.trim(),
                        model: form.model.trim(),
                        contextWindow: form.contextWindow,
                        timeoutSec: form.timeoutSec,
                        apiKey: "",
                      },
                      "PUT",
                      "已清除保存的密钥",
                    );
                    if (cleared !== undefined)
                      setForm((f) => ({ ...f, apiKey: "" }));
                  }
                }}
              >
                清除已保存的密钥
              </button>
            )}
            <div className="settings-actions">
              <button
                type="submit"
                className="button primary"
                disabled={
                  disabled || !form.baseUrl.trim() || !form.model.trim()
                }
              >
                <Save size={16} />
                保存配置
              </button>
              <LoadingButton
                type="button"
                className="button secondary"
                busy={testing}
                disabled={
                  disabled || !form.baseUrl.trim() || !form.model.trim()
                }
                onClick={() => void test()}
              >
                <WandSparkles size={16} />
                保存并测试连接
              </LoadingButton>
            </div>
          </form>
          {result && (
            <div
              className={`test-result ${result.chat && result.tools ? "success" : "failed"}`}
              role="status"
            >
              <div>
                <span>
                  {result.chat ? <Check size={16} /> : <X size={16} />}聊天能力
                </span>
                <span>
                  {result.tools ? <Check size={16} /> : <X size={16} />}工具调用
                </span>
              </div>
              <p>{result.message}</p>
            </div>
          )}
        </Card>
        <div className="settings-side">
          <Card title="配置小贴士" icon={<Settings2 size={18} />}>
            <div className="tip-item">
              <span>01</span>
              <div>
                <strong>使用兼容接口</strong>
                <p>Base URL 指向 API 基础地址，避免填写网页聊天地址。</p>
              </div>
            </div>
            <div className="tip-item">
              <span>02</span>
              <div>
                <strong>工具调用很重要</strong>
                <p>
                  AI 会通过受限工具控制设备；仅支持聊天的接口不能用于 AI 控制。
                </p>
              </div>
            </div>
            <div className="tip-item">
              <span>03</span>
              <div>
                <strong>先测试，再开始</strong>
                <p>测试会发送少量模型请求，分别验证聊天和工具调用能力。</p>
              </div>
            </div>
          </Card>
          <Card title="本地运行" icon={<Terminal size={18} />}>
            <div className="summary-line">
              <span>访问范围</span>
              <strong>本机</strong>
            </div>
            <div className="summary-line">
              <span>数据存储</span>
              <strong>SQLite</strong>
            </div>
            <div className="summary-line">
              <span>密钥存储</span>
              <strong>后端加密</strong>
            </div>
            <p className="field-hint">
              浏览器关闭后，后台服务继续计时和调度。停止服务会中断运行，重启后不会自动恢复输出。
            </p>
          </Card>
          <a
            className="docs-link"
            href="https://github.com/dungeonlab-open/dglab-kit"
            target="_blank"
            rel="noreferrer"
          >
            <span>
              <strong>郊狼官方开发文档</strong>
              <small>协议与设备连接说明</small>
            </span>
            <ChevronRight size={17} />
          </a>
        </div>
      </div>
    </div>
  );
}
