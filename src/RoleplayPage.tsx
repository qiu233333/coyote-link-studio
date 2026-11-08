import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Plus,
  Send,
  Upload,
  Download,
  Copy,
  Pencil,
  Trash2,
  Sparkles,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
import type { AppSnapshot, Channel } from "../shared/types";
import {
  cardFields,
  cardInstructions,
  cardSchema,
  cardTemplate,
  fileOf,
  roleplayExecutionLabel,
  type CardFile,
  type CharacterCard,
  type RoleplayBounds,
  type RoleplaySession,
  type RoleplayTurn,
  type StoryMessage,
} from "../shared/roleplay";
import { request, type Action } from "./api";
import { Badge, Field, Modal, NumberInput } from "./ui";
import { STORY_FORMAT_MAX_RETRIES } from "../shared/executionPolicy";

const base = "/api/roleplay";
const fieldNames: Record<string, string> = {
  name: "角色姓名",
  description: "简介",
  background: "外貌与背景",
  personality: "性格",
  speakingStyle: "说话风格",
  scenario: "默认情景",
  firstMessage: "开场白",
  alternateGreetings: "备选开场",
  exampleDialogue: "对话示例",
  worldInfo: "重要世界设定",
  linkageStyle: "联动风格",
  avatar: "头像",
};
type StoryList = {
  id: string;
  title: string;
  characterName: string;
  updatedAt: number;
}[];
function download(name: string, value: unknown, text = false) {
  const url = URL.createObjectURL(
    new Blob([text ? String(value) : JSON.stringify(value, null, 2)], {
      type: text
        ? "text/plain;charset=utf-8"
        : "application/json;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function elapsed(start: number) {
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000)),
    days = Math.floor(sec / 86400);
  return `${days ? days + "天 " : ""}${String(Math.floor(sec / 3600) % 24).padStart(2, "0")}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}
async function dataUrl(file: File) {
  if (file.size > 10 * 1024 * 1024) throw new Error("头像最多 10 MiB");
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("图片读取失败"));
    r.readAsDataURL(file);
  });
}
export default function RoleplayPage({
  state,
  action,
}: {
  state: AppSnapshot;
  action: Action;
}) {
  const [cards, setCards] = useState<CharacterCard[]>([]),
    [stories, setStories] = useState<StoryList>([]),
    [search, setSearch] = useState("");
  const [session, setSession] = useState<RoleplaySession | null>(null),
    [messages, setMessages] = useState<StoryMessage[]>([]),
    [cursor, setCursor] = useState<number>(),
    [turn, setTurn] = useState<RoleplayTurn>();
  const [editor, setEditor] = useState<{ file: CardFile; id?: string } | null>(
      null,
    ),
    [format, setFormat] = useState(false),
    [paste, setPaste] = useState(""),
    [feedback, setFeedback] = useState("");
  const [imported, setImported] = useState<{
    source: unknown;
    avatar: string | null;
    warnings: string[];
  } | null>(null);
  const [newCard, setNewCard] = useState<CharacterCard | null>(null),
    [player, setPlayer] = useState({
      name: "玩家",
      identity: "",
      relationship: "",
    }),
    [scenario, setScenario] = useState(""),
    [greeting, setGreeting] = useState(0);
  const initialBounds = (): RoleplayBounds => ({
    channels: ["A", "B"],
    waveformIds: state.waveforms.map((w) => w.id),
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { ...state.device.limits },
    rampPerSecond: { A: 5, B: 5 },
    allowSync: true,
    allowRest: true,
    allowRamp: true,
  });
  const [linkDialog, setLinkDialog] = useState(false),
    [bounds, setBounds] = useState<RoleplayBounds>(initialBounds);
  const [startWithLink, setStartWithLink] = useState(true);
  const [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const selected = useRef<string | null>(null),
    bottom = useRef<HTMLDivElement>(null),
    sending = useRef(false),
    composing = useRef(false);
  const activeRun =
    state.run && ["running", "paused"].includes(state.run.status)
      ? state.run
      : null;
  const run = activeRun?.roleplay?.sessionId === session?.id ? activeRun : null;
  const locked = state.locked;
  const latestMessage = messages.at(-1);
  const replyOptions =
    latestMessage?.role === "assistant"
      ? (latestMessage.replyOptions ?? [])
      : [];
  async function loadLists() {
    const [c, s] = await Promise.all([
      request<CharacterCard[]>(base + "/cards", undefined, "GET"),
      request<StoryList>(base + "/sessions", undefined, "GET"),
    ]);
    setCards(c);
    setStories(s);
  }
  useEffect(() => {
    void loadLists()
      .then(() => {
        if (state.roleplay?.activeSessionId)
          return open(state.roleplay.activeSessionId);
      })
      .catch((e) => setNotice(e.message));
  }, []);
  useEffect(() => {
    selected.current = session?.id ?? null;
  }, [session?.id]);
  async function open(id: string) {
    selected.current = id;
    const s = await request<RoleplaySession>(
        `${base}/sessions/${id}`,
        undefined,
        "GET",
      ),
      m = await request<{ items: StoryMessage[]; cursor?: number }>(
        `${base}/sessions/${id}/messages`,
        undefined,
        "GET",
      );
    if (selected.current !== id) return;
    setSession(s);
    setMessages(m.items);
    setCursor(m.items.length === 50 ? m.cursor : undefined);
    setTurn(
      s.turnId
        ? await request<RoleplayTurn>(
            `${base}/sessions/${id}/turns/${s.turnId}`,
            undefined,
            "GET",
          )
        : undefined,
    );
  }
  useEffect(() => {
    if (!session) return;
    const abort = new AbortController();
    const id = session.id;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const s = await request<RoleplaySession>(
          `${base}/sessions/${id}?status=1`,
          undefined,
          "GET",
          abort.signal,
        );
        if (selected.current !== id || abort.signal.aborted) return;
        setSession((old) => (old?.id === id ? { ...old, ...s } : old));
        if (s.turnId)
          setTurn(
            await request(
              `${base}/sessions/${id}/turns/${s.turnId}`,
              undefined,
              "GET",
              abort.signal,
            ),
          );
        const m = await request<{ items: StoryMessage[] }>(
          `${base}/sessions/${id}/messages`,
          undefined,
          "GET",
          abort.signal,
        );
        if (!abort.signal.aborted && selected.current === id)
          setMessages((old) => {
            const merged = new Map(old.map((m) => [m.seq, m]));
            for (const item of m.items) merged.set(item.seq, item);
            return [...merged.values()].sort((a, b) => a.seq - b.seq);
          });
      } catch (e) {
        if (!abort.signal.aborted) setNotice((e as Error).message);
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [session?.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [messages.length]);
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!editor) return;
    await task(async () => {
      const file = cardSchema.parse(editor.file);
      const result = await action(
        `${base}/cards${editor.id ? "/" + editor.id : ""}`,
        file,
        editor.id ? "PATCH" : "POST",
        "角色卡已保存",
      );
      if (result) {
        setEditor(null);
        setImported(null);
        await loadLists();
      }
    });
  }
  async function importFile(file: File) {
    await task(async () => {
      if (file.size > 20 * 1024 * 1024) throw new Error("角色卡最多 20 MiB");
      const response = await fetch(base + "/cards/import/extract", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "X-Coyote-Request": "1",
          "Content-Type": "application/octet-stream",
        },
        body: file,
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error);
      if (result.data.native) {
        setEditor({ file: result.data.native });
      } else setImported(result.data);
    });
  }
  async function parseImport() {
    if (!imported) return;
    await task(async () => {
      const result = await action<{ card: CardFile; warnings: string[] }>(
        base + "/cards/import/convert",
        { source: imported.source },
      );
      if (result) {
        setEditor({
          file: {
            ...result.card,
            character: { ...result.card.character, avatar: imported.avatar },
          },
        });
        setImported({
          ...imported,
          warnings: [...imported.warnings, ...result.warnings],
        });
      }
    });
  }
  async function send(text = input) {
    if (
      !session ||
      selected.current !== session.id ||
      !text.trim() ||
      busy ||
      sending.current ||
      locked ||
      (activeRun && !run)
    )
      return;
    sending.current = true;
    try {
      await task(async () => {
        const result = await action<RoleplayTurn>(
          `${base}/sessions/${session.id}/messages`,
          { text, requestId: crypto.randomUUID(), revision: session.revision },
        );
        if (selected.current !== session.id) return;
        if (result) {
          setInput("");
          setTurn(result);
          await open(session.id);
        }
      });
    } finally {
      sending.current = false;
    }
  }
  async function link(op: string, body: unknown = {}, method = "POST") {
    if (!session) return;
    const r = await action(
      `${base}/sessions/${session.id}/link/${op}`,
      body,
      method,
    );
    if (r) setLinkDialog(false);
  }
  const boundsFields = () => (
    <>
      <div className="story-toolbar">
        {(["A", "B"] as Channel[]).map((c) => (
          <label key={c}>
            <input
              type="checkbox"
              checked={bounds.channels.includes(c)}
              onChange={(e) =>
                setBounds({
                  ...bounds,
                  channels: e.target.checked
                    ? [...bounds.channels, c]
                    : bounds.channels.filter((x) => x !== c),
                })
              }
            />
            通道 {c}
          </label>
        ))}
      </div>
      {(["A", "B"] as Channel[]).map((c) => (
        <fieldset key={c} disabled={!bounds.channels.includes(c)}>
          <legend>
            通道 {c} · 设备上限 {state.device.limits[c]}
          </legend>
          <div className="form-grid three">
            {(["minIntensity", "maxIntensity", "rampPerSecond"] as const).map(
              (k) => (
                <Field
                  key={k}
                  label={
                    {
                      minIntensity: "最低强度",
                      maxIntensity: "最高强度",
                      rampPerSecond: "最大变化速率 / s",
                    }[k]
                  }
                >
                  <NumberInput
                    label={`${c} ${{ minIntensity: "最低强度", maxIntensity: "最高强度", rampPerSecond: "最大变化速率" }[k]}`}
                    value={bounds[k][c]}
                    min={k === "rampPerSecond" ? 0.1 : 0}
                    step={k === "rampPerSecond" ? 0.1 : 1}
                    max={k === "rampPerSecond" ? 20 : state.device.limits[c]}
                    onChange={(v) =>
                      setBounds({ ...bounds, [k]: { ...bounds[k], [c]: v } })
                    }
                  />
                </Field>
              ),
            )}
          </div>
        </fieldset>
      ))}
      <Field label="允许波形">
        <div className="wave-checks">
          {state.waveforms.map((w) => (
            <label className="wave-check" key={w.id}>
              <input
                type="checkbox"
                checked={bounds.waveformIds.includes(w.id)}
                onChange={(e) =>
                  setBounds({
                    ...bounds,
                    waveformIds: e.target.checked
                      ? [...bounds.waveformIds, w.id]
                      : bounds.waveformIds.filter((x) => x !== w.id),
                  })
                }
              />
              {w.name}
            </label>
          ))}
        </div>
      </Field>
      {(["allowSync", "allowRamp", "allowRest"] as const).map((k) => (
        <label className="story-option" key={k}>
          <input
            type="checkbox"
            checked={bounds[k]}
            onChange={(e) => setBounds({ ...bounds, [k]: e.target.checked })}
          />
          {
            {
              allowSync: "允许双通道同时输出",
              allowRamp: "允许渐变",
              allowRest: "允许 AI 按剧情归零休息",
            }[k]
          }
        </label>
      ))}
    </>
  );
  const smallAvatar = (card: CharacterCard) =>
    card.character.avatar ? (
      <img
        className="story-avatar"
        src={card.character.avatar}
        alt={card.character.name}
      />
    ) : (
      <span className="story-avatar fallback">
        <BookOpen size={22} />
      </span>
    );
  return (
    <div className="roleplay-page">
      <div className="page-heading">
        <div>
          <Badge color="pink">STORY STUDIO</Badge>
          <h1>情景演绎</h1>
          <p>你来回答，故事向前。角色与设备节奏随剧情自然变化。</p>
        </div>
        <button className="button secondary" onClick={() => setFormat(true)}>
          角色卡格式
        </button>
      </div>
      {notice && (
        <div role="alert" className="notice notice-pink">
          {notice}
          <button aria-label="关闭提示" onClick={() => setNotice("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {locked && (
        <div className="notice notice-pink">
          AI 上锁任务占用设备。请在原任务中反馈或急停后，再开始演绎。
        </div>
      )}
      <div className="story-workspace">
        <aside className="glass-card story-library">
          <h2>
            <BookOpen size={19} />
            角色与故事
          </h2>
          <input
            aria-label="搜索角色与故事"
            placeholder="搜索角色或故事"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="story-toolbar">
            <button
              className="button small"
              disabled={locked}
              onClick={() => setEditor({ file: structuredClone(cardTemplate) })}
            >
              <Plus size={15} />
              创建角色
            </button>
            <label className="button small secondary">
              <Upload size={15} />
              导入
              <input
                aria-label="导入角色卡"
                type="file"
                accept=".json,.png"
                hidden
                disabled={busy || locked}
                onChange={(e) => {
                  if (e.target.files?.[0]) void importFile(e.target.files[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <h3>角色库</h3>
          {cards
            .filter(
              (c) =>
                c.character.name.includes(search) ||
                c.tags.some((t) => t.includes(search)),
            )
            .map((card) => (
              <article className="story-card" key={card.id}>
                {smallAvatar(card)}
                <div>
                  <strong>{card.character.name}</strong>
                  <p>{card.character.description || "尚无简介"}</p>
                  <button
                    className="button small primary"
                    disabled={locked}
                    onClick={() => {
                      setNewCard(card);
                      setStartWithLink(true);
                      setBounds(initialBounds());
                      setScenario(card.character.scenario);
                      setGreeting(0);
                    }}
                  >
                    开始演绎
                  </button>
                </div>
                <div className="story-card-tools">
                  <button
                    title="编辑角色"
                    aria-label={`编辑${card.character.name}`}
                    onClick={() =>
                      setEditor({ file: fileOf(card), id: card.id })
                    }
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    title="复制角色"
                    onClick={() =>
                      void task(async () => {
                        await action(`${base}/cards/${card.id}/copy`, {});
                        await loadLists();
                      })
                    }
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    title="导出角色 JSON"
                    onClick={() =>
                      download(card.character.name + ".json", fileOf(card))
                    }
                  >
                    <Download size={14} />
                  </button>
                  <button
                    title="删除角色"
                    disabled={locked}
                    onClick={() => {
                      if (
                        confirm("删除角色库中的卡片？已有故事仍保留角色快照。")
                      )
                        void task(async () => {
                          await action(
                            `${base}/cards/${card.id}`,
                            undefined,
                            "DELETE",
                          );
                          await loadLists();
                        });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            ))}
          {!cards.length && (
            <p className="muted">创建一个角色，或导入已有角色卡。</p>
          )}
          <h3>历史故事</h3>
          {stories
            .filter((s) => s.title.includes(search))
            .map((s) => (
              <button
                key={s.id}
                className={`story-list-item ${session?.id === s.id ? "active" : ""}`}
                onClick={() => void task(() => open(s.id))}
              >
                <strong>{s.title}</strong>
                <small>
                  {s.characterName} ·{" "}
                  {new Date(s.updatedAt).toLocaleDateString()}
                </small>
              </button>
            ))}
        </aside>
        <section className="glass-card story-main">
          {session ? (
            <>
              <div className="story-chat-heading">
                {smallAvatar(session.card)}
                <div>
                  <h2>{session.title}</h2>
                  <small>
                    无限时游戏 · 已开始 {elapsed(session.createdAt)}
                  </small>
                </div>
                <div className="story-toolbar">
                  <button
                    className="button small secondary"
                    onClick={() => {
                      const value = prompt("故事新名称", session.title);
                      if (value)
                        void task(async () => {
                          const r = await action<RoleplaySession>(
                            `${base}/sessions/${session.id}`,
                            { title: value },
                            "PATCH",
                          );
                          if (r) setSession(r);
                          await loadLists();
                        });
                    }}
                  >
                    重命名
                  </button>
                  <button
                    className="button small secondary"
                    onClick={() =>
                      void task(async () =>
                        download(
                          session.title + ".txt",
                          await request(
                            `${base}/sessions/${session.id}/export`,
                            undefined,
                            "GET",
                          ),
                          true,
                        ),
                      )
                    }
                  >
                    导出
                  </button>
                  <button
                    className="button small secondary"
                    disabled={
                      !!run || busy || turn?.status === "pending" || locked
                    }
                    onClick={() => {
                      if (confirm("删除这个故事及其聊天记录？"))
                        void task(async () => {
                          const r = await action(
                            `${base}/sessions/${session.id}`,
                            undefined,
                            "DELETE",
                          );
                          if (r) {
                            setSession(null);
                            selected.current = null;
                            await loadLists();
                          }
                        });
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
              <div className="story-link-strip">
                <Badge>
                  {run
                    ? run.status === "paused"
                      ? "联动已暂停"
                      : "持续联动中"
                    : "纯文字演绎"}
                </Badge>
                {run && (
                  <span>
                    联动 {elapsed(run.startedAt)} · A{" "}
                    {state.device.intensities.A} / B{" "}
                    {state.device.intensities.B}
                  </span>
                )}
                {!run ? (
                  <button
                    className="button small primary"
                    disabled={
                      !!activeRun ||
                      locked ||
                      busy ||
                      turn?.status === "pending"
                    }
                    onClick={() => {
                      setBounds(initialBounds());
                      setLinkDialog(true);
                    }}
                  >
                    启用设备联动
                  </button>
                ) : (
                  <>
                    <button
                      className="button small"
                      disabled={state.stopping}
                      onClick={() =>
                        void link(run.status === "paused" ? "resume" : "pause")
                      }
                    >
                      {run.status === "paused" ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}{" "}
                      {run.status === "paused" ? "恢复联动" : "暂停输出"}
                    </button>
                    <button
                      className="button small secondary"
                      onClick={() => {
                        setBounds(structuredClone(run.roleplay!.bounds));
                        setLinkDialog(true);
                      }}
                    >
                      修改范围
                    </button>
                    <button
                      className="button small secondary"
                      onClick={() => void link("stop")}
                    >
                      <Square size={14} />
                      结束联动
                    </button>
                  </>
                )}
              </div>
              {activeRun && !run && (
                <p className="notice">
                  设备由其他模式或故事占用，请先停止该运行。
                </p>
              )}
              <details className="story-device">
                <summary>设备详情与授权范围</summary>
                {run ? (
                  <>
                    <p>
                      无限时保持输出。聊天和等待 AI
                      不会强制归零；以设备回传为准。
                    </p>
                    {(["A", "B"] as Channel[]).map((c) => (
                      <p key={c}>
                        通道 {c}：目标 {run.roleplay!.output[c].target} · 回传{" "}
                        {state.device.intensities[c]} · 设备上限{" "}
                        {state.device.limits[c]} · 授权{" "}
                        {run.roleplay!.bounds.minIntensity[c]}–
                        {run.roleplay!.bounds.maxIntensity[c]} · 速率{" "}
                        {run.roleplay!.output[c].rampPerSecond}/s ·{" "}
                        {state.waveforms.find(
                          (w) => w.id === run.roleplay!.output[c].waveformId,
                        )?.name || "快照波形"}
                      </p>
                    ))}
                  </>
                ) : (
                  <p>当前故事没有设备授权，回复只推进剧情。</p>
                )}
              </details>
              <div className="story-messages" aria-live="polite">
                {cursor && (
                  <button
                    className="button small secondary"
                    onClick={() =>
                      void task(async () => {
                        const page = await request<{
                          items: StoryMessage[];
                          cursor?: number;
                        }>(
                          `${base}/sessions/${session.id}/messages?before=${cursor}`,
                          undefined,
                          "GET",
                        );
                        setMessages((old) => [
                          ...page.items,
                          ...old.filter(
                            (m) => !page.items.some((p) => p.id === m.id),
                          ),
                        ]);
                        setCursor(
                          page.items.length === 50 ? page.cursor : undefined,
                        );
                      })
                    }
                  >
                    加载更早对话
                  </button>
                )}
                {messages.map((m) => (
                  <article className={`story-message ${m.role}`} key={m.id}>
                    <strong>
                      {m.role === "user"
                        ? session.player.name
                        : session.card.character.name}
                    </strong>
                    {m.narration && (
                      <p className="story-narration">{m.narration}</p>
                    )}
                    {m.text && <p>{m.text}</p>}
                    {m.control && (
                      <details>
                        <summary>
                          {roleplayExecutionLabel(m.control, !!m.output)}
                        </summary>
                        {m.controlReason && <p>联动说明：{m.controlReason}</p>}
                        {m.control.action === "keep" && m.output && (
                          <p>
                            keep 只保留原参数；原目标为 0 时会继续保持零输出。
                          </p>
                        )}
                        <pre>{JSON.stringify(m.control, null, 2)}</pre>
                        {m.output && (
                          <small>
                            当时目标 A {m.output.A.target} / B{" "}
                            {m.output.B.target}；实际执行请查看设备回传。
                          </small>
                        )}
                      </details>
                    )}
                  </article>
                ))}
                <div ref={bottom} />
              </div>
              {turn?.status === "pending" && (
                <div className="story-thinking">
                  <Sparkles size={16} />{" "}
                  {turn.retryKind === "format" && turn.formatAttempt
                    ? `正在调整回复格式 ${turn.formatAttempt}/${STORY_FORMAT_MAX_RETRIES}${run?.status === "running" ? "，保持当前输出" : ""}`
                    : turn.attempt
                      ? `模型暂时不可用，保持输出并重试 ${turn.attempt}/20`
                      : "角色正在构思下一幕…"}
                  <button onClick={() => void action(base + "/cancel", {})}>
                    取消生成
                  </button>
                </div>
              )}
              {turn?.error && (
                <div role="status" className="notice notice-pink">
                  {turn.error} · 输入仍可重新发送。
                </div>
              )}
              {replyOptions.length === 3 && (
                <div
                  className="story-quick-replies"
                  role="group"
                  aria-label="快捷回复"
                >
                  <p>
                    试试这样回复 <span>点击即发送，也可在下方自由输入</span>
                  </p>
                  {replyOptions.map((option, index) => (
                    <button
                      type="button"
                      key={`${latestMessage!.id}-${index}`}
                      disabled={
                        busy ||
                        locked ||
                        turn?.status === "pending" ||
                        !!(activeRun && !run)
                      }
                      onClick={() => void send(option)}
                    >
                      <span aria-hidden="true">{index + 1}</span>
                      {option}
                    </button>
                  ))}
                </div>
              )}
              <form
                className="story-compose"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  aria-label="回复剧情"
                  placeholder="正常回复剧情，例如：我接过徽章，问她下一步去哪里。"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !composing.current &&
                      !e.nativeEvent.isComposing &&
                      e.nativeEvent.keyCode !== 229
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  maxLength={8000}
                />
                <button
                  className="button primary"
                  disabled={
                    busy || locked || !input.trim() || !!(activeRun && !run)
                  }
                >
                  <Send size={17} />
                  发送
                </button>
              </form>
              <p className="field-hint">Enter 发送 · Shift+Enter 换行</p>
              <details className="story-memory">
                <summary>六部分故事记忆</summary>
                <h4>角色与玩家设定</h4>
                <p>
                  {session.card.character.personality} · {session.player.name}：
                  {session.player.identity} · {session.player.relationship}
                </p>
                <h4>近期剧情</h4>
                <p>{session.memory.recentPlot || "尚无"}</p>
                <h4>近期对话</h4>
                <p>
                  默认保留最近 20 条原文，按模型预算调整；完整历史存于本机。
                </p>
                <h4>剧情背景</h4>
                <p>
                  {session.scenario}
                  {"\n"}
                  {session.memory.plotBackground}
                </p>
                <h4>长期剧情摘要</h4>
                <p>{session.memory.longPlot || "尚无"}</p>
                <h4>长期对话摘要</h4>
                <p>{session.memory.longDialogue || "尚无"}</p>
                <small>
                  已归档至消息 {session.memory.throughSeq}；摘要不改变设备权限。
                </small>
              </details>
            </>
          ) : (
            <div className="story-empty">
              <BookOpen size={46} />
              <h2>让故事从一次回答开始</h2>
              <p>
                选择角色，设定自己的身份。无需连接设备，也可以先进行纯文字演绎。
              </p>
              <button
                className="button primary"
                onClick={() =>
                  setEditor({ file: structuredClone(cardTemplate) })
                }
              >
                <Plus size={16} />
                创建第一个角色
              </button>
            </div>
          )}
        </section>
      </div>
      {editor && (
        <Modal
          title={editor.id ? "编辑角色卡" : "创建角色卡"}
          onClose={() => setEditor(null)}
        >
          <div className="story-editor">
            {imported && (
              <details>
                <summary>原始资料与兼容提示</summary>
                {imported.warnings.map((w, i) => (
                  <p className="notice" key={i}>
                    {w}
                  </p>
                ))}
                <pre className="story-format">
                  {JSON.stringify(imported.source, null, 2)}
                </pre>
              </details>
            )}
            <button
              className="button small secondary"
              onClick={() => setFormat(true)}
            >
              角色卡格式
            </button>
            {editor.file.character.avatar && (
              <img
                className="story-editor-avatar"
                src={editor.file.character.avatar}
                alt="角色头像"
              />
            )}
            <Field label="角色头像">
              <input
                aria-label="角色头像"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    void task(async () => {
                      const avatar = await dataUrl(f);
                      setEditor((v) =>
                        v
                          ? {
                              ...v,
                              file: {
                                ...v.file,
                                character: { ...v.file.character, avatar },
                              },
                            }
                          : v,
                      );
                    });
                }}
              />
            </Field>
            <button
              className="button small secondary"
              onClick={() =>
                setEditor({
                  ...editor,
                  file: {
                    ...editor.file,
                    character: { ...editor.file.character, avatar: null },
                  },
                })
              }
            >
              清除头像
            </button>
            {cardFields
              .filter((k) => k !== "avatar" && k !== "alternateGreetings")
              .map((k) => (
                <Field key={k} label={fieldNames[k]}>
                  <textarea
                    aria-label={fieldNames[k]}
                    rows={k === "name" ? 1 : 3}
                    value={String(
                      editor.file.character[k as keyof CardFile["character"]],
                    )}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        file: {
                          ...editor.file,
                          character: {
                            ...editor.file.character,
                            [k]: e.target.value,
                          },
                        },
                      })
                    }
                  />
                </Field>
              ))}
            <Field label="备选开场（一段一个，使用空行分隔）">
              <textarea
                value={editor.file.character.alternateGreetings.join("\n\n")}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    file: {
                      ...editor.file,
                      character: {
                        ...editor.file.character,
                        alternateGreetings: e.target.value
                          .split(/\n\s*\n/)
                          .filter(Boolean),
                      },
                    },
                  })
                }
              />
            </Field>
            <Field label="标签（逗号分隔）">
              <input
                value={editor.file.tags.join(",")}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    file: {
                      ...editor.file,
                      tags: e.target.value
                        .split(/[,，]/)
                        .map((x) => x.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </Field>
            <Field label="作者">
              <input
                value={editor.file.creator}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    file: { ...editor.file, creator: e.target.value },
                  })
                }
              />
            </Field>
            <button
              className="button primary"
              disabled={busy || locked}
              onClick={() => void save()}
            >
              保存角色卡
            </button>
          </div>
        </Modal>
      )}
      {format && (
        <Modal title="角色卡格式" onClose={() => setFormat(false)}>
          <p>
            spec 和 version 固定；角色姓名必填。其余字段可为空文本，avatar
            可为空或内嵌图片。角色卡不能携带设备授权、脚本或密钥。
          </p>
          <div className="story-toolbar">
            <button
              className="button small primary"
              onClick={() =>
                void task(async () => {
                  await navigator.clipboard.writeText(
                    JSON.stringify(cardTemplate, null, 2),
                  );
                  setFeedback("JSON 模板已复制");
                })
              }
            >
              复制 JSON 模板
            </button>
            <button
              className="button small secondary"
              onClick={() =>
                download("coyote-roleplay-card.json", cardTemplate)
              }
            >
              下载模板
            </button>
            <button
              className="button small secondary"
              onClick={() =>
                void task(async () => {
                  await navigator.clipboard.writeText(cardInstructions);
                  setFeedback("制作说明已复制");
                })
              }
            >
              复制给其他 AI 的制作说明
            </button>
          </div>
          <pre className="story-format">
            {JSON.stringify(cardTemplate, null, 2)}
          </pre>
          <dl>
            {cardFields.map((k) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  {fieldNames[k]}
                  {k === "alternateGreetings"
                    ? "，文本数组"
                    : k === "avatar"
                      ? "，null 或内嵌 PNG/JPEG/WebP"
                      : ""}
                </dd>
              </div>
            ))}
          </dl>
          <Field label="粘贴 JSON 校验">
            <textarea
              aria-label="粘贴 JSON 校验"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={7}
            />
          </Field>
          <button
            className="button primary"
            onClick={() => {
              try {
                const file = cardSchema.parse(JSON.parse(paste));
                setEditor({ file });
                setFormat(false);
                setFeedback("");
              } catch (e) {
                setFeedback((e as Error).message);
              }
            }}
          >
            校验并填入编辑器
          </button>
          <p role="status">{feedback}</p>
        </Modal>
      )}
      {imported && !editor && (
        <Modal title="第三方角色卡转换预览" onClose={() => setImported(null)}>
          <p>
            只在点击解析后，将下方提取的文本发送至当前配置的
            AI。头像留在本机，转换后可编辑，保存后才入库。
          </p>
          {imported.warnings.map((w, i) => (
            <p className="notice" key={i}>
              {w}
            </p>
          ))}
          <details open>
            <summary>提取的原始资料</summary>
            <pre className="story-format">
              {JSON.stringify(imported.source, null, 2)}
            </pre>
          </details>
          <button
            className="button primary"
            disabled={busy || locked}
            onClick={() => void parseImport()}
          >
            {busy ? "正在解析…" : "使用 AI 解析"}
          </button>
          <button
            className="button secondary"
            onClick={() =>
              setEditor({
                file: {
                  ...structuredClone(cardTemplate),
                  character: {
                    ...structuredClone(cardTemplate.character),
                    name: "导入的角色",
                    avatar: imported.avatar,
                  },
                },
              })
            }
          >
            手动整理
          </button>
        </Modal>
      )}
      {newCard && (
        <Modal title="新建故事" onClose={() => setNewCard(null)}>
          <p>{newCard.character.name} · 每个故事使用独立角色快照与记忆。</p>
          {(["name", "identity", "relationship"] as const).map((k) => (
            <Field
              label={
                {
                  name: "玩家称呼",
                  identity: "玩家身份",
                  relationship: "与角色的关系",
                }[k]
              }
              key={k}
            >
              <input
                aria-label={
                  {
                    name: "玩家称呼",
                    identity: "玩家身份",
                    relationship: "与角色的关系",
                  }[k]
                }
                value={player[k]}
                onChange={(e) => setPlayer({ ...player, [k]: e.target.value })}
              />
            </Field>
          ))}
          <Field label="本次情景">
            <textarea
              aria-label="本次情景"
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            />
          </Field>
          <Field label="选择开场">
            <select
              value={greeting}
              onChange={(e) => setGreeting(Number(e.target.value))}
            >
              {[
                newCard.character.firstMessage,
                ...newCard.character.alternateGreetings,
              ].map((g, i) => (
                <option key={i} value={i}>
                  {g.slice(0, 70) || "空开场"}
                </option>
              ))}
            </select>
          </Field>
          <label className="story-option">
            <input
              type="checkbox"
              checked={startWithLink}
              onChange={(e) => setStartWithLink(e.target.checked)}
            />
            进入故事时启用设备联动
          </label>
          {startWithLink && (
            <>
              <p className="notice notice-pink">
                进入故事即按以下范围启用持续联动：{bounds.channels.join("/")}{" "}
                通道，A {bounds.minIntensity.A}–{bounds.maxIntensity.A} / B{" "}
                {bounds.minIntensity.B}–{bounds.maxIntensity.B}，最大变化速率 A{" "}
                {bounds.rampPerSecond.A}/s、B {bounds.rampPerSecond.B}
                /s。开场输出为零，首条玩家回复后由 AI
                调整；等待回复及关闭网页后保持输出，可随时暂停、结束或急停。
              </p>
              <details>
                <summary>查看或调整联动范围</summary>
                {boundsFields()}
              </details>
              {(!state.device.connected || !!activeRun) && (
                <p role="status" className="notice">
                  {activeRun
                    ? "设备正被其他运行占用，请先结束当前联动；也可取消勾选，创建纯文字故事。"
                    : "设备未连接，请先在控制台连接；也可取消勾选，创建纯文字故事。"}
                </p>
              )}
            </>
          )}
          <button
            className="button primary"
            disabled={
              busy ||
              locked ||
              (startWithLink &&
                (!state.device.connected ||
                  !!activeRun ||
                  state.stopping ||
                  state.stopUnconfirmed))
            }
            onClick={() =>
              void task(async () => {
                const r = await action<RoleplaySession>(base + "/sessions", {
                  cardId: newCard.id,
                  player,
                  scenario,
                  greetingIndex: greeting,
                  ...(startWithLink
                    ? { link: { bounds, requestId: crypto.randomUUID() } }
                    : {}),
                });
                if (r) {
                  setNewCard(null);
                  await loadLists();
                  await open(r.id);
                }
              })
            }
          >
            进入故事
          </button>
          <p className="muted">
            {startWithLink
              ? "进入故事后自动启用联动，无需再次点击开启。"
              : "纯文字演绎，之后也可单独启用设备联动。"}
            开场不会产生输出。
          </p>
        </Modal>
      )}
      {linkDialog && session && (
        <Modal
          title={run ? "修改演绎授权范围" : "确认持续设备联动"}
          onClose={() => setLinkDialog(false)}
        >
          <p className="notice notice-pink">
            无限时保持输出。等待回复及关闭网页后，后台仍保持当前输出；可随时暂停、停止或急停。修改范围会先暂停归零，确认后由下一条消息生成新动作。
          </p>
          {boundsFields()}
          <button
            className="button primary"
            disabled={
              busy ||
              state.stopping ||
              (!run && (!state.device.connected || !!activeRun))
            }
            onClick={() =>
              void task(() =>
                link(
                  run ? "bounds" : "start",
                  { bounds, requestId: crypto.randomUUID() },
                  run ? "PATCH" : "POST",
                ),
              )
            }
          >
            {run ? "确认新范围并保持暂停" : "确认授权，等待下一条玩家回复"}
          </button>
        </Modal>
      )}
    </div>
  );
}
