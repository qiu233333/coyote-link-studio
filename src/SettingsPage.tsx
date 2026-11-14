import { memo, useEffect, useMemo, useState } from "react";
import {
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Link,
  Save,
  Server,
  ShieldCheck,
  WandSparkles,
  X,
} from "lucide-react";
import type { AppSnapshot } from "../shared/types";
import { DraftBar, useDraft } from "./drafts";
import { settingsDraft } from "./draftSchemas";
import {
  aiProvider,
  credentialTarget,
  DEEPSEEK_PRESET,
  type AiProvider,
} from "../shared/aiProvider";
import type { Action } from "./api";
import { Badge, Card, Field, LoadingButton, NumberInput } from "./ui";
import {
  AI_TIMEOUT_MIN_SEC,
  AI_TIMEOUT_MAX_SEC,
  aiTimeoutSeconds,
} from "../shared/aiTimeouts";

const SettingsPage = memo(function SettingsPage({
  settings,
  aiRuntime,
  active,
  stopping,
  locked,
  action,
  pending,
}: {
  settings: AppSnapshot["settings"];
  aiRuntime: AppSnapshot["aiRuntime"];
  active: boolean;
  stopping: boolean;
  locked: boolean;
  action: Action;
  pending: boolean;
}) {
  const draft = useDraft("settings", settingsDraft);
  const savedFields = useMemo(() => {
    const { apiKeySet: _apiKeySet, revision: _revision, ...fields } = settings;
    return fields;
  }, [settings]);
  const [credential, setCredential] = useState<{
    apiKey: string;
    fields: typeof savedFields;
    base: string;
  }>();
  const remoteBase = settings.revision ?? "";
  const fields = draft.value?.fields ?? credential?.fields ?? savedFields;
  const base = draft.value?.base ?? credential?.base ?? remoteBase;
  const conflict = base !== remoteBase;
  const form = useMemo(
    () => ({ ...fields, apiKey: credential?.apiKey ?? "" }),
    [fields, credential],
  );
  const setForm = ({ apiKey, ...fields }: typeof form) => {
    if (
      JSON.stringify(fields) !==
      JSON.stringify(draft.value?.fields ?? savedFields)
    )
      draft.cell.write({ fields, base });
    setCredential(apiKey ? { apiKey, fields, base } : undefined);
  };
  const [showKey, setShowKey] = useState(false);
  const [result, setResult] = useState<{
    chat: boolean;
    tools: boolean;
    message: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const disabled = active || stopping || pending || testing;
  const canSave = !conflict && draft.status !== "conflict";
  const provider = aiProvider(form);
  const targetChanged = credentialTarget(form) !== credentialTarget(settings);
  const savedKeyUsable = settings.apiKeySet && !targetChanged;
  useEffect(() => setResult(null), [form]);
  const chooseProvider = (selected: AiProvider) => {
    setShowKey(false);
    setForm({
      ...form,
      ...(selected === "deepseek"
        ? DEEPSEEK_PRESET
        : {
            provider: selected,
            baseUrl: aiProvider(settings) === selected ? settings.baseUrl : "",
            model: aiProvider(settings) === selected ? settings.model : "",
            contextWindow:
              aiProvider(settings) === selected
                ? settings.contextWindow
                : 32000,
            deepseekThinking: "disabled" as const,
          }),
      apiKey: "",
    });
  };
  const save = async () => {
    if (!canSave) return;
    const result = await action(
      "/api/settings",
      {
        provider,
        deepseekThinking: form.deepseekThinking ?? "disabled",
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        contextWindow: form.contextWindow,
        timeoutSec: form.timeoutSec,
        draftTimeoutSec: aiTimeoutSeconds(form, "draft"),
        expectedRevision: base,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      },
      "PUT",
      "AI 配置已保存",
    );
    if (result !== undefined) {
      if (draft.cell.write(undefined, draft.revision)) draft.cell.flush();
      setCredential(undefined);
    }
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
        <h1>系统设置</h1>
      </div>
      {active && (
        <div className="notice notice-pink">
          <ShieldCheck size={18} />
          <span>
            {locked
              ? "任务锁定中，设置暂不可修改。"
              : "请先结束当前控制会话，再修改 AI 配置。"}
          </span>
        </div>
      )}
      <div className="settings-layout">
        <Card title="AI 接口配置" icon={<WandSparkles size={19} />}>
          <div className="settings-status">
            <Badge color={aiRuntime.ready ? "blue" : "gray"} dot>
              {aiRuntime.ready ? "AI 运行时已就绪" : "AI 运行时未就绪"}
            </Badge>
            {!aiRuntime.ready && aiRuntime.error && <p>{aiRuntime.error}</p>}
          </div>
          <DraftBar
            draft={draft}
            label="丢弃设置草稿"
            disabled={disabled}
            onDiscard={() => setCredential(undefined)}
            onReload={() => setCredential(undefined)}
          />
          {conflict && (
            <div className="notice notice-pink" role="status">
              后台设置已更新（{settings.model || "未配置模型"}
              ）。当前输入已保留。
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  draft.cell.discard();
                  setCredential(undefined);
                }}
              >
                载入后台设置
              </button>
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={() => {
                  if (
                    !confirm(
                      "继续编辑本地设置？下次正式保存会覆盖当前后台设置。",
                    )
                  )
                    return;
                  draft.cell.write({ fields, base: remoteBase });
                  setCredential(undefined);
                }}
              >
                保留本地设置修改
              </button>
            </div>
          )}
          <form
            onInvalid={(event) => {
              if (!(event.target instanceof HTMLElement)) return;
              const advanced =
                event.target.closest<HTMLDetailsElement>(".settings-advanced");
              if (advanced) advanced.open = true;
            }}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset className="plain-fieldset" disabled={disabled}>
              <Field label="AI 服务">
                <select
                  aria-label="AI 服务"
                  value={provider}
                  onChange={(e) => chooseProvider(e.target.value as AiProvider)}
                >
                  <option value="openai-compatible">
                    自定义 OpenAI 兼容服务
                  </option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              </Field>
              <Field label="Base URL">
                <div className="input-with-icon">
                  <Link size={17} />
                  <input
                    aria-label="AI Base URL"
                    type="url"
                    required
                    placeholder="https://api.openai.com/v1"
                    value={form.baseUrl}
                    onChange={(e) => {
                      setShowKey(false);
                      setForm({ ...form, baseUrl: e.target.value, apiKey: "" });
                    }}
                  />
                </div>
              </Field>
              <Field
                label="API Key"
                hint={
                  targetChanged && settings.apiKeySet
                    ? "地址或服务已变化，请重新输入对应的密钥。"
                    : savedKeyUsable
                      ? "留空保留已保存的密钥。"
                      : undefined
                }
              >
                <div className="input-with-icon">
                  <KeyRound size={17} />
                  <input
                    aria-label="AI API Key"
                    type={showKey ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder={
                      savedKeyUsable ? "••••••••••••••••（已保存）" : "sk-…"
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
                {provider === "deepseek" && !savedKeyUsable && (
                  <a
                    className="text-button"
                    href="https://platform.deepseek.com/api_keys"
                    target="_blank"
                    rel="noreferrer"
                  >
                    获取 DeepSeek 密钥
                  </a>
                )}
              </Field>
              <Field label="模型名称">
                <div className="input-with-icon">
                  <Server size={17} />
                  <input
                    aria-label="AI 模型名称"
                    required
                    placeholder={
                      provider === "deepseek" ? "deepseek-flash" : "填写模型 ID"
                    }
                    value={form.model}
                    onChange={(e) =>
                      setForm({ ...form, model: e.target.value })
                    }
                  />
                </div>
              </Field>
              <details className="inline-details settings-advanced">
                <summary>高级设置</summary>
                {provider === "deepseek" && (
                  <Field
                    label="DeepSeek 思考模式"
                    hint="开启思考可能增加等待时间。"
                  >
                    <select
                      aria-label="DeepSeek 思考模式"
                      value={form.deepseekThinking ?? "disabled"}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          deepseekThinking: e.target.value as
                            "enabled" | "disabled",
                        })
                      }
                    >
                      <option value="disabled">关闭（推荐用于实时控制）</option>
                      <option value="enabled">开启</option>
                    </select>
                  </Field>
                )}
                <div className="form-grid">
                  <Field
                    label="上下文窗口 / tokens"
                    hint="按模型规格填写，范围 1,024–2,000,000。"
                  >
                    <NumberInput
                      label="模型上下文窗口"
                      value={form.contextWindow}
                      min={1024}
                      max={2000000}
                      step={1}
                      onChange={(contextWindow) =>
                        setForm({ ...form, contextWindow })
                      }
                    />
                  </Field>
                  <Field label="决策与测试超时 / 秒">
                    <NumberInput
                      label="AI 请求超时"
                      value={form.timeoutSec}
                      min={AI_TIMEOUT_MIN_SEC}
                      max={AI_TIMEOUT_MAX_SEC}
                      onChange={(timeoutSec) =>
                        setForm({ ...form, timeoutSec })
                      }
                    />
                  </Field>
                  <Field label="任务草稿超时 / 秒">
                    <NumberInput
                      label="AI 任务草稿超时"
                      value={aiTimeoutSeconds(form, "draft")}
                      min={AI_TIMEOUT_MIN_SEC}
                      max={AI_TIMEOUT_MAX_SEC}
                      onChange={(draftTimeoutSec) =>
                        setForm({ ...form, draftTimeoutSec })
                      }
                    />
                  </Field>
                </div>
              </details>
            </fieldset>
            {settings.apiKeySet && (
              <button
                type="button"
                className="text-button"
                disabled={disabled || !canSave}
                onClick={async () => {
                  if (
                    confirm(
                      "确定清除已保存的 API Key？无密钥的本地模型可以继续使用。",
                    )
                  ) {
                    const cleared = await action(
                      "/api/settings",
                      {
                        provider,
                        deepseekThinking: form.deepseekThinking ?? "disabled",
                        baseUrl: form.baseUrl.trim(),
                        model: form.model.trim(),
                        contextWindow: form.contextWindow,
                        timeoutSec: form.timeoutSec,
                        draftTimeoutSec: aiTimeoutSeconds(form, "draft"),
                        apiKey: "",
                        expectedRevision: base,
                      },
                      "PUT",
                      "已清除保存的密钥",
                    );
                    if (cleared !== undefined) {
                      if (draft.cell.write(undefined, draft.revision))
                        draft.cell.flush();
                      setCredential(undefined);
                    }
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
                  disabled ||
                  !canSave ||
                  !form.baseUrl.trim() ||
                  !form.model.trim()
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
                  disabled ||
                  !canSave ||
                  !form.baseUrl.trim() ||
                  !form.model.trim()
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
          <details className="inline-details">
            <summary>接口配置说明</summary>
            <p>
              填写支持工具调用的模型。Base URL 使用 API 基础地址，例如
              https://api.openai.com/v1。密钥加密保存在本机后端，连接测试会分别验证聊天和工具调用。
            </p>
            <a
              className="text-button"
              href="https://github.com/dungeonlab-open/dglab-kit"
              target="_blank"
              rel="noreferrer"
            >
              郊狼设备文档
            </a>
          </details>
        </Card>
      </div>
    </div>
  );
});

export default SettingsPage;
