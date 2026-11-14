import { ActionCard } from "./ActionCard";
import { storyAction } from "./actionCardModel";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { DraftBar, useDraft, useDraftStore } from "./drafts";
import { storyInputDraft, textDraft } from "./draftSchemas";
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
  PanelRight,
  Bookmark,
  GitBranch,
} from "lucide-react";
import type { AppSnapshot, Channel, ChannelValues } from "../shared/types";
import { channelLimit } from "../shared/limits";
import {
  cardFields,
  cardInstructions,
  cardSchema,
  cardTemplate,
  fileOf,
  fitRoleplayIntensity,
  roleplayExecutionLabel,
  roleplayIntensityError,
  type CardFile,
  type CharacterCard,
  type RoleplayBounds,
  type RoleplaySession,
  type RoleplayTurn,
  type StoryMessage,
} from "../shared/roleplay";
import { request, type Action } from "./api";
import { Badge, Field, Modal, NumberInput } from "./ui";
import type {
  StoryBootstrap,
  StoryDelta,
  StorySignal,
  StorySync,
} from "../shared/storyFeed";
import {
  mergeStoryMessages,
  StoryFeedClient,
  StoryProgressView,
} from "./storyFeedClient";
import { StoryPreviewMessage, StoryWaiting } from "./StoryGeneration";
import type { StorySource } from "../shared/storyState";
import { StoryStatePanel } from "./StoryStatePanel";
import { StorySaves, type StorySaveView } from "./StorySaves";

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
type StoryDetails = RoleplaySession & { sourceAvailable?: boolean };
const emptyProgress = new StoryProgressView();
const panelPreference = "coyote.story-state-open";
function defaultBranchName(title: string, stories: StoryList) {
  const names = new Set(stories.map((story) => story.title));
  let index = 1;
  for (;;) {
    const suffix = ` · 分支 ${index++}`;
    const name = title.slice(0, 100 - suffix.length).trimEnd() + suffix;
    if (!names.has(name)) return name;
  }
}
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
const StoryActionCard = memo(function StoryActionCard({
  message,
  state,
}: {
  message: StoryMessage;
  state?: AppSnapshot;
}) {
  const record = storyAction(message);
  return record ? <ActionCard record={record} state={state} /> : null;
});

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
  const [session, setSession] = useState<StoryDetails | null>(null),
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
    channels: (["A", "B"] as const).filter((c) => state.channels[c].enabled),
    waveformIds: state.waveforms.map((w) => w.id),
    minIntensity: { A: 0, B: 0 },
    maxIntensity: { ...state.device.limits },
    rampPerSecond: { A: 5, B: 5 },
    allowSync: true,
    allowRest: true,
    allowRamp: true,
  });
  const [linkDialog, setLinkDialog] = useState<"start" | "bounds" | null>(null),
    [bounds, setBounds] = useState<RoleplayBounds>(initialBounds);
  const [initialEdits, setInitialEdits] = useState<Partial<ChannelValues>>({});
  const [intensityDialog, setIntensityDialog] = useState<{
    targets: ChannelValues;
    expectedRun: string;
  } | null>(null);
  const [startWithLink, setStartWithLink] = useState(true);
  const draftStore = useDraftStore();
  const inputDraft = useDraft(`story:${session?.id ?? ""}`, storyInputDraft);
  const input = inputDraft.value?.text ?? "";
  const setInput = (text: string) =>
    inputDraft.cell.write(
      text ? { text, editId: crypto.randomUUID() } : undefined,
    );
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const selected = useRef<string | null>(null),
    viewport = useRef<HTMLDivElement>(null),
    sourceArticle = useRef<HTMLElement>(null),
    baseline = useRef<StoryBootstrap>(undefined),
    streamRef = useRef<StoryFeedClient>(undefined),
    openRequest = useRef(0),
    sourceRequest = useRef(0),
    followLatest = useRef(true),
    sending = useRef(false),
    composing = useRef(false);
  const [sourceMessage, setSourceMessage] = useState<StoryMessage>();
  const [saveView, setSaveView] = useState<StorySaveView>();
  const [saveFeedback, setSaveFeedback] = useState("");
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [bookmarkVersion, setBookmarkVersion] = useState(0);
  const [progress, setProgress] = useState(emptyProgress);
  const follow = useCallback(() => {
    if (followLatest.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, []);
  const cancel = useCallback(() => {
    void action(base + "/cancel", {});
  }, [action]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [wide, setWide] = useState(
    () => matchMedia("(min-width: 1024px)").matches,
  );
  const [panelOpen, setPanelOpen] = useState<boolean | undefined>(() => {
    const saved = localStorage.getItem(panelPreference);
    return saved === null ? undefined : saved === "true";
  });
  const showPanel = panelOpen ?? wide;
  useEffect(() => {
    const media = matchMedia("(min-width: 1024px)");
    const change = () => setWide(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const activeRun =
    state.run && ["running", "paused"].includes(state.run.status)
      ? state.run
      : null;
  const run = activeRun?.roleplay?.sessionId === session?.id ? activeRun : null;
  const linkState = run?.roleplay;
  const linkToken = run ? `${run.id}:${run.boundsVersion}:${run.status}` : "";
  const hardwareLimits = {
    A: channelLimit(state.channels, state.device.limits, "A"),
    B: channelLimit(state.channels, state.device.limits, "B"),
  };
  const defaultIntensity = fitRoleplayIntensity(
    {
      A: Math.floor(hardwareLimits.A / 2),
      B: Math.floor(hardwareLimits.B / 2),
    },
    bounds,
    hardwareLimits,
  );
  const initialIntensity = {
    A: bounds.channels.includes("A")
      ? (initialEdits.A ?? defaultIntensity.A)
      : 0,
    B: bounds.channels.includes("B")
      ? (initialEdits.B ?? defaultIntensity.B)
      : 0,
  };
  const initialError = roleplayIntensityError(
    initialIntensity,
    bounds,
    hardwareLimits,
  );
  const intensityError =
    linkState && intensityDialog
      ? roleplayIntensityError(
          intensityDialog.targets,
          linkState.bounds,
          hardwareLimits,
        )
      : undefined;
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
    return s;
  }
  useEffect(() => {
    void loadLists()
      .then((stories) => {
        if (openRequest.current) return;
        const last = draftStore.preference("story", textDraft, "");
        if (last && stories.some((story) => story.id === last))
          return open(last);
        if (state.roleplay?.activeSessionId)
          return open(state.roleplay.activeSessionId);
      })
      .catch((e) => setNotice(e.message));
  }, []);
  async function open(id: string) {
    if (id === selected.current && streamRef.current)
      return streamRef.current.refresh();
    const requestNumber = ++openRequest.current;
    const initial = await request<StoryBootstrap>(
      `${base}/sessions/${id}/sync?initial=1`,
      undefined,
      "GET",
    );
    const latestTurn = initial.turn;
    settleStoryInput(id, latestTurn);
    const sent = draftStore.cell(`story:${id}`, storyInputDraft).snapshot()
      .value?.sent;
    if (sent?.turnId && sent.requestId !== latestTurn?.requestId) {
      void request<RoleplayTurn>(
        `${base}/sessions/${id}/turns/${sent.turnId}`,
        undefined,
        "GET",
      )
        .then((turn) => settleStoryInput(id, turn))
        .catch(() => undefined);
    }
    if (openRequest.current !== requestNumber) return;
    streamRef.current?.stop();
    streamRef.current = undefined;
    baseline.current = initial;
    selected.current = id;
    draftStore.setPreference("story", id);
    sourceRequest.current++;
    setSourceMessage(undefined);
    setSaveView(undefined);
    setSaveFeedback("");
    setLinkDialog(null);
    setIntensityDialog(null);
    setLibraryOpen(false);
    followLatest.current = true;
    setFollowing(true);
    setUnseen(false);
    setSyncError("");
    setProgress(emptyProgress);
    setBookmarkVersion(initial.signal.bookmarkVersion);
    setSession(initial.story);
    setMessages(initial.items);
    setCursor(initial.earlier);
    setTurn(latestTurn);
  }
  function updateStory(delta: StoryDelta, signal: StorySignal) {
    const { status: s, items, turn: latestTurn, bookmarks, reset } = delta;
    if (selected.current !== s.id) return;
    settleStoryInput(s.id, latestTurn);
    setSession((old) => {
      if (old?.id !== s.id) return old;
      return {
        ...(!reset && old.revision > s.revision ? old : { ...old, ...s }),
        storyState:
          s.storyState &&
          (reset || s.storyState.version >= old.storyState.version)
            ? s.storyState
            : old.storyState,
      };
    });
    setTurn(latestTurn);
    if (items.length && !followLatest.current) setUnseen(true);
    setMessages((old) =>
      mergeStoryMessages(reset ? [] : old, items, bookmarks),
    );
    if (reset) setCursor(delta.earlier);
    setBookmarkVersion(signal.bookmarkVersion);
    if (bookmarks)
      setSourceMessage((old) => {
        if (!old?.nodeRound || !!old.bookmarked === bookmarks.includes(old.id))
          return old;
        return { ...old, bookmarked: bookmarks.includes(old.id) };
      });
  }
  function settleStoryInput(id: string, latest?: RoleplayTurn) {
    if (!latest) return;
    const cell = draftStore.cell(`story:${id}`, storyInputDraft);
    const { value, revision } = cell.snapshot();
    if (!value?.sent || value.sent.requestId !== latest.requestId) return;
    if (latest.status === "pending") {
      if (!value.sent.turnId) {
        cell.write(
          {
            ...value,
            sent: { requestId: latest.requestId, turnId: latest.id },
          },
          revision,
        );
        cell.flush();
      }
      return;
    }
    cell.write(
      latest.status === "completed" ? undefined : { ...value, sent: undefined },
      revision,
    );
    cell.flush();
  }
  useEffect(() => {
    if (!session || baseline.current?.story.id !== session.id) return;
    const path = `${base}/sessions/${session.id}`;
    const stream = new StoryFeedClient(
      baseline.current,
      (params, signal) =>
        request<StorySync>(`${path}/sync?${params}`, undefined, "GET", signal),
      () => new EventSource(`${path}/events`),
      updateStory,
      setSyncError,
    );
    streamRef.current = stream;
    setProgress(stream.progress);
    stream.start();
    return () => {
      stream.stop();
      if (streamRef.current === stream) streamRef.current = undefined;
    };
  }, [session?.id]);
  useEffect(() => {
    if (!sourceMessage && followLatest.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [session?.id, latestMessage?.id, sourceMessage]);
  useEffect(() => {
    if (!sourceMessage) return;
    if (viewport.current) viewport.current.scrollTop = 0;
    sourceArticle.current?.scrollIntoView({ block: "nearest" });
    sourceArticle.current?.focus({ preventScroll: true });
  }, [sourceMessage?.id]);
  async function locateSource(source: StorySource) {
    if (!session) return;
    const id = session.id;
    const requestNumber = ++sourceRequest.current;
    try {
      const message =
        messages.find((message) => message.id === source.messageId) ??
        (await request<StoryMessage>(
          `${base}/sessions/${id}/messages/${encodeURIComponent(source.messageId)}`,
          undefined,
          "GET",
        ));
      if (selected.current !== id || requestNumber !== sourceRequest.current)
        return;
      if (message.seq !== source.seq || message.role !== "assistant")
        throw new Error("找不到对应的剧情回复");
      setSourceMessage({ ...message });
    } catch (error) {
      if (selected.current === id && requestNumber === sourceRequest.current)
        setNotice((error as Error).message);
    }
  }
  function returnToLatest() {
    sourceRequest.current++;
    setSourceMessage(undefined);
    followLatest.current = true;
    setFollowing(true);
    setUnseen(false);
    if (viewport.current) {
      viewport.current.focus({ preventScroll: true });
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }
  function openNodeAction(kind: "save" | "branch", message: StoryMessage) {
    if (!session || !message.nodeRound) return;
    const summary = (message.narration?.trim() || message.text.trim())
      .replace(/\s+/gu, " ")
      .slice(0, 120);
    setSaveView({
      kind,
      node: {
        storyId: session.id,
        storyTitle: session.title,
        messageId: message.id,
        round: message.nodeRound,
        seq: message.seq,
        summary,
      },
    });
  }
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
  async function send(text = input, retryOf?: string) {
    if (
      !session ||
      selected.current !== session.id ||
      !text.trim() ||
      busy ||
      sending.current ||
      (turn?.status === "pending" &&
        inputDraft.value?.sent?.requestId === turn.requestId &&
        text === input) ||
      locked ||
      (activeRun && !run)
    )
      return;
    const navigationAtSend = openRequest.current;
    const id = session.id;
    const requestId = crypto.randomUUID();
    const cell = inputDraft.cell;
    const { value, revision } = cell.snapshot();
    if (value && text === value.text) {
      cell.write({ ...value, sent: { requestId } }, revision);
      cell.flush();
    }
    sending.current = true;
    try {
      await task(async () => {
        const result = await action<RoleplayTurn>(
          `${base}/sessions/${session.id}/messages`,
          {
            text,
            requestId,
            revision: session.revision,
            ...(retryOf && { retryOf }),
          },
        );
        if (result) settleStoryInput(id, result);
        else {
          const { value, revision } = cell.snapshot();
          if (value?.sent?.requestId === requestId) {
            cell.write({ ...value, sent: undefined }, revision);
            cell.flush();
          }
        }
        if (
          selected.current !== session.id ||
          openRequest.current !== navigationAtSend
        )
          return;
        if (result) await streamRef.current?.refresh();
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
    if (r) {
      if (op === "start" || op === "bounds") setLinkDialog(null);
      if (op === "intensity") setIntensityDialog(null);
    }
  }
  const intensityFields = (
    label: string,
    targets: ChannelValues,
    range: RoleplayBounds,
    update: (channel: Channel, target: number) => void,
  ) => (
    <div className="form-grid">
      {(["A", "B"] as const).map((c) => (
        <Field label={`${c} ${label}`} key={c}>
          <NumberInput
            label={`${c} ${label}`}
            value={targets[c]}
            min={0}
            max={Math.min(range.maxIntensity[c], hardwareLimits[c])}
            disabled={!range.channels.includes(c) || busy}
            onChange={(target) => update(c, target)}
          />
        </Field>
      ))}
    </div>
  );
  const initialFields = () => (
    <>
      {intensityFields("初始强度", initialIntensity, bounds, (c, target) =>
        setInitialEdits((current) => ({ ...current, [c]: target })),
      )}
      {initialError && (
        <p className="notice" role="status">
          {initialError}
        </p>
      )}
    </>
  );
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
      <div className="section-title">
        <h1>情景演绎</h1>
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
      {saveFeedback && (
        <div role="status" className="notice">
          {saveFeedback}
          <button aria-label="关闭存档提示" onClick={() => setSaveFeedback("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {locked && (
        <div className="notice notice-pink">
          AI 上锁任务占用设备。请在原任务中反馈或急停后，再开始演绎。
        </div>
      )}
      <div
        className={`story-workspace${session ? " has-story" : ""}${libraryOpen ? " library-open" : ""}`}
      >
        <aside className="glass-card story-library" id="story-library">
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
                      setInitialEdits({});
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
                <details className="story-menu inline-details">
                  <summary>故事管理</summary>
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
                            if (r && selected.current === session.id)
                              await streamRef.current?.refresh();
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
                              draftStore
                                .cell(`story:${session.id}`, storyInputDraft)
                                .deleteEntity();
                              if (selected.current === session.id) {
                                openRequest.current++;
                                setSession(null);
                                selected.current = null;
                                draftStore.setPreference("story", "");
                              }
                              await loadLists();
                            }
                          });
                      }}
                    >
                      删除
                    </button>
                  </div>
                </details>
              </div>
              {session.origin && (
                <div className="story-branch-origin">
                  <Badge color="pink">分支</Badge>
                  <span>
                    {session.origin.storyTitle} · 第 {session.origin.round}{" "}
                    轮之后
                  </span>
                  {session.sourceAvailable ? (
                    <button
                      type="button"
                      className="button small secondary"
                      onClick={() =>
                        void task(() => open(session.origin!.storyId))
                      }
                    >
                      返回来源故事
                    </button>
                  ) : (
                    <small>
                      来源故事已删除
                      {session.origin.summary && ` · ${session.origin.summary}`}
                    </small>
                  )}
                </div>
              )}
              <div className="story-view-actions">
                <button
                  type="button"
                  className="button small secondary story-library-toggle"
                  aria-expanded={libraryOpen}
                  aria-controls="story-library"
                  onClick={() => setLibraryOpen(!libraryOpen)}
                >
                  <BookOpen size={15} aria-hidden="true" />
                  角色与故事
                </button>
                <button
                  type="button"
                  className="button small secondary"
                  aria-haspopup="dialog"
                  onClick={() => setSaveView({ kind: "list" })}
                >
                  <Bookmark size={15} aria-hidden="true" />
                  剧情存档
                </button>
                <button
                  type="button"
                  className="button small secondary"
                  aria-expanded={showPanel}
                  aria-controls="story-state"
                  onClick={() => {
                    setPanelOpen(!showPanel);
                    localStorage.setItem(panelPreference, String(!showPanel));
                  }}
                >
                  <PanelRight size={15} aria-hidden="true" />
                  剧情状态
                </button>
              </div>
              <div className="story-content">
                <div id="story-state" hidden={!showPanel}>
                  {showPanel && (
                    <StoryStatePanel
                      state={session.storyState}
                      pending={turn?.status === "pending"}
                      onSource={(source) => void locateSource(source)}
                    />
                  )}
                </div>
                <div className="story-conversation">
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
                          state.stopping ||
                          state.stopUnconfirmed ||
                          turn?.status === "pending"
                        }
                        onClick={() => {
                          setBounds(initialBounds());
                          setInitialEdits({});
                          setLinkDialog("start");
                        }}
                      >
                        启用设备联动
                      </button>
                    ) : (
                      <>
                        <button
                          className="button small"
                          disabled={
                            state.stopping || (run.status === "paused" && busy)
                          }
                          onClick={() =>
                            void link(
                              run.status === "paused" ? "resume" : "pause",
                            )
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
                          disabled={
                            state.stopping || state.stopUnconfirmed || busy
                          }
                          onClick={() => {
                            const current = run.roleplay!;
                            setIntensityDialog({
                              expectedRun: linkToken,
                              targets: fitRoleplayIntensity(
                                run.status === "paused"
                                  ? (current.resumeIntensity ?? { A: 0, B: 0 })
                                  : {
                                      A: current.output.A.target,
                                      B: current.output.B.target,
                                    },
                                current.bounds,
                                hardwareLimits,
                              ),
                            });
                          }}
                        >
                          修改强度
                        </button>
                        <button
                          className="button small secondary"
                          onClick={() => {
                            setBounds(structuredClone(run.roleplay!.bounds));
                            setLinkDialog("bounds");
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
                    <div className="notice story-branch-origin">
                      {activeRun.roleplay ? (
                        <>
                          <span>
                            设备由「
                            {stories.find(
                              (story) =>
                                story.id === activeRun.roleplay!.sessionId,
                            )?.title ?? "另一则故事"}
                            」占用。
                          </span>
                          <button
                            type="button"
                            className="button small secondary"
                            onClick={() =>
                              void task(() =>
                                open(activeRun.roleplay!.sessionId),
                              )
                            }
                          >
                            返回占用设备的故事
                          </button>
                        </>
                      ) : (
                        <span>设备由其他模式占用，请先停止该运行。</span>
                      )}
                    </div>
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
                            通道 {c}：目标 {run.roleplay!.output[c].target} ·
                            回传 {state.device.intensities[c]} · 设备上限{" "}
                            {state.device.limits[c]} · 授权{" "}
                            {run.roleplay!.bounds.minIntensity[c]}–
                            {run.roleplay!.bounds.maxIntensity[c]} · 速率{" "}
                            {run.roleplay!.output[c].rampPerSecond}/s ·{" "}
                            {state.waveforms.find(
                              (w) =>
                                w.id === run.roleplay!.output[c].waveformId,
                            )?.name || "快照波形"}
                          </p>
                        ))}
                      </>
                    ) : (
                      <p>当前故事没有设备授权，回复只推进剧情。</p>
                    )}
                  </details>
                  <div className="story-history-actions">
                    {unseen && !sourceMessage && <span>有新消息</span>}
                    {sourceMessage && (
                      <span>正在查看第 {sourceMessage.seq} 条回复</span>
                    )}
                    {(sourceMessage || !following) && (
                      <button
                        type="button"
                        className="button small secondary"
                        onClick={returnToLatest}
                      >
                        返回最新剧情
                      </button>
                    )}
                  </div>
                  <div
                    className="story-messages"
                    ref={viewport}
                    tabIndex={0}
                    aria-label={sourceMessage ? "变化来源回复" : "剧情对话"}
                    aria-live={sourceMessage ? "off" : "polite"}
                    onScroll={(event) => {
                      if (sourceMessage) return;
                      const { scrollHeight, scrollTop, clientHeight } =
                        event.currentTarget;
                      const nearLatest =
                        scrollHeight - scrollTop - clientHeight < 48;
                      followLatest.current = nearLatest;
                      setFollowing(nearLatest);
                      if (nearLatest) setUnseen(false);
                    }}
                  >
                    {cursor && !sourceMessage && (
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
                            if (selected.current !== session.id) return;
                            followLatest.current = false;
                            setFollowing(false);
                            setMessages((old) =>
                              mergeStoryMessages(old, page.items),
                            );
                            setCursor(
                              page.items.length === 50
                                ? page.cursor
                                : undefined,
                            );
                          })
                        }
                      >
                        加载更早对话
                      </button>
                    )}
                    {(sourceMessage ? [sourceMessage] : messages).map((m) => (
                      <article
                        className={`story-message ${m.role}`}
                        key={m.id}
                        ref={sourceMessage ? sourceArticle : undefined}
                        tabIndex={sourceMessage ? -1 : undefined}
                        aria-label={
                          sourceMessage ? `第 ${m.seq} 条助手回复` : undefined
                        }
                      >
                        <strong>
                          {m.role === "user"
                            ? session.player.name
                            : session.card.character.name}
                        </strong>
                        {m.narration && (
                          <p className="story-narration">{m.narration}</p>
                        )}
                        {m.text && <p>{m.text}</p>}
                        {m.historicalControl && !m.actionRecord && (
                          <details>
                            <summary>来源故事联动记录</summary>
                            <p>
                              {m.inheritedFrom?.storyTitle} ·{" "}
                              {m.historicalControl.label}
                            </p>
                            {m.historicalControl.reason && (
                              <p>{m.historicalControl.reason}</p>
                            )}
                            {m.historicalControl.targets && (
                              <small>
                                当时目标 A {m.historicalControl.targets.A} / B{" "}
                                {m.historicalControl.targets.B}
                              </small>
                            )}
                          </details>
                        )}
                        {(m.control || m.actionRecord) && (
                          <StoryActionCard
                            message={m}
                            state={
                              !m.inheritedFrom &&
                              m.actionRecord &&
                              m.actionRecord.id === state.run?.lastAction?.id
                                ? state
                                : undefined
                            }
                          />
                        )}
                        {m.nodeRound ? (
                          <div
                            className="story-message-tools"
                            role="group"
                            aria-label={`第 ${m.nodeRound} 轮节点操作`}
                          >
                            <button
                              type="button"
                              className="button small secondary"
                              disabled={locked && !m.bookmarked}
                              aria-haspopup="dialog"
                              onClick={() =>
                                m.bookmarked
                                  ? setSaveView({ kind: "list" })
                                  : openNodeAction("save", m)
                              }
                            >
                              <Bookmark size={13} aria-hidden="true" />
                              {m.bookmarked ? "已存档" : "保存这一刻"}
                            </button>
                            <button
                              type="button"
                              className="button small secondary"
                              disabled={locked}
                              aria-haspopup="dialog"
                              onClick={() => openNodeAction("branch", m)}
                            >
                              <GitBranch size={13} aria-hidden="true" />
                              创建分支
                            </button>
                          </div>
                        ) : null}
                      </article>
                    ))}
                    {!sourceMessage && (
                      <StoryPreviewMessage
                        view={progress}
                        turn={turn}
                        follow={follow}
                      />
                    )}
                  </div>
                  {turn && (
                    <StoryWaiting view={progress} turn={turn} cancel={cancel} />
                  )}
                  {syncError && (
                    <p className="field-hint" role="status">
                      故事同步暂不可用：{syncError}
                    </p>
                  )}
                  {turn?.error && (
                    <div role="status" className="notice notice-pink">
                      {turn.error} · 输入仍可重新发送。
                    </div>
                  )}
                  {turn &&
                    ["failed", "cancelled", "interrupted"].includes(
                      turn.status,
                    ) &&
                    latestMessage?.role === "user" &&
                    latestMessage.turnId === (turn.retryOf ?? turn.id) && (
                      <button
                        type="button"
                        className="button small secondary"
                        disabled={busy || locked || !!(activeRun && !run)}
                        onClick={() => void send(latestMessage.text, turn.id)}
                      >
                        重试本轮
                      </button>
                    )}
                  {replyOptions.length === 3 && (
                    <div
                      className="story-quick-replies"
                      role="group"
                      aria-label="快捷回复"
                    >
                      <p>快捷回复 · 点击发送</p>
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
                      placeholder="输入剧情回复…"
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
                  <DraftBar draft={inputDraft} label="丢弃这条回复草稿" />
                  <details className="story-memory">
                    <summary>故事记忆</summary>
                    <h4>角色与玩家设定</h4>
                    <p>
                      {session.card.character.personality} ·{" "}
                      {session.player.name}：{session.player.identity} ·{" "}
                      {session.player.relationship}
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
                      已归档至消息 {session.memory.throughSeq}
                      ；摘要不改变设备权限。
                    </small>
                  </details>
                </div>
              </div>
            </>
          ) : (
            <div className="story-empty">
              <BookOpen size={46} />
              <h2>选择角色或打开历史故事</h2>
              {!cards.length && (
                <button
                  className="button primary"
                  onClick={() =>
                    setEditor({ file: structuredClone(cardTemplate) })
                  }
                >
                  <Plus size={16} />
                  创建角色
                </button>
              )}
            </div>
          )}
        </section>
      </div>
      {session && saveView && (
        <StorySaves
          view={saveView}
          onView={setSaveView}
          storyId={session.id}
          title={session.title}
          bookmarkVersion={bookmarkVersion}
          branchName={defaultBranchName(session.title, stories)}
          locked={locked}
          onBookmarkChange={(_messageId, _bookmarked, feedback) => {
            if (selected.current !== session.id) return;
            void streamRef.current?.refresh();
            setSaveFeedback(feedback);
          }}
          onBranch={async (id) => {
            if (selected.current !== session.id) return;
            await open(id);
            if (selected.current === id) setSaveFeedback("已创建分支");
            void loadLists().catch((error: Error) => setNotice(error.message));
          }}
        />
      )}
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
                /s。确认后按初始强度逐步输出，首条玩家回复后由 AI 调整。
              </p>
              {initialFields()}
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
                (!!initialError ||
                  !bounds.channels.length ||
                  !state.device.connected ||
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
                    ? {
                        link: {
                          bounds,
                          initialIntensity,
                          requestId: crypto.randomUUID(),
                        },
                      }
                    : {}),
                });
                if (r) {
                  await open(r.id);
                  setNewCard(null);
                  await loadLists();
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
          </p>
        </Modal>
      )}
      {linkDialog && session && (
        <Modal
          title={
            linkDialog === "bounds" ? "修改演绎授权范围" : "确认持续设备联动"
          }
          onClose={() => setLinkDialog(null)}
        >
          <p className="notice notice-pink">
            {linkDialog === "bounds"
              ? "修改范围会先暂停归零。恢复时，目标强度会按新范围和设备上限调整。"
              : "确认后按初始强度逐步输出。等待回复及关闭网页后，后台仍保持联动，可随时暂停、结束或急停。"}
          </p>
          {linkDialog === "start" && initialFields()}
          {boundsFields()}
          <button
            className="button primary"
            disabled={
              busy ||
              state.stopping ||
              (linkDialog === "bounds"
                ? !run
                : !!initialError ||
                  !bounds.channels.length ||
                  !state.device.connected ||
                  !!activeRun ||
                  state.stopUnconfirmed)
            }
            onClick={() =>
              void task(() =>
                link(
                  linkDialog,
                  linkDialog === "bounds"
                    ? { bounds }
                    : {
                        bounds,
                        initialIntensity,
                        requestId: crypto.randomUUID(),
                      },
                  linkDialog === "bounds" ? "PATCH" : "POST",
                ),
              )
            }
          >
            {linkDialog === "bounds"
              ? "确认新范围并保持暂停"
              : "确认并启用联动"}
          </button>
        </Modal>
      )}
      {intensityDialog && run && linkState && (
        <Modal title="修改强度" onClose={() => setIntensityDialog(null)}>
          <p>
            {run.status === "paused"
              ? "保存后保持暂停，点击「恢复联动」才会逐步输出。"
              : "保存后会按当前波形和变化速率调整到新的目标强度。"}
          </p>
          {intensityFields(
            "目标强度",
            intensityDialog.targets,
            linkState.bounds,
            (c, target) =>
              setIntensityDialog(
                (current) =>
                  current && {
                    ...current,
                    targets: { ...current.targets, [c]: target },
                  },
              ),
          )}
          {(intensityError || intensityDialog.expectedRun !== linkToken) && (
            <p className="notice" role="status">
              {intensityDialog.expectedRun !== linkToken
                ? "联动状态或授权已变化，请重新打开强度设置。"
                : intensityError}
            </p>
          )}
          <button
            className="button primary"
            disabled={
              busy ||
              state.stopping ||
              state.stopUnconfirmed ||
              !!intensityError ||
              intensityDialog.expectedRun !== linkToken
            }
            onClick={() =>
              void task(() => link("intensity", intensityDialog, "PATCH"))
            }
          >
            保存强度
          </button>
        </Modal>
      )}
    </div>
  );
}
