import {
  memo,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { Sparkles } from "lucide-react";
import type { RoleplayTurn } from "../shared/roleplay";
import type { StoryProgress } from "../shared/storyFeed";
import { StoryProgressView } from "./storyFeedClient";

function useTurnProgress(view: StoryProgressView, turn?: RoleplayTurn) {
  const progress = useSyncExternalStore(view.subscribe, view.read, view.read);
  return progress?.turnId === turn?.id ? progress : undefined;
}

export const StoryPreviewMessage = memo(function StoryPreviewMessage({
  view,
  turn,
  follow,
}: {
  view: StoryProgressView;
  turn?: RoleplayTurn;
  follow: () => void;
}) {
  const progress = useTurnProgress(view, turn);
  const preview = progress?.preview;
  useLayoutEffect(follow, [preview, follow]);
  if (!progress || !preview || (!preview.narration && !preview.dialogue))
    return null;
  const unfinished =
    progress.phase === "unfinished" || progress.phase === "retrying";
  if (turn?.status !== "pending" && !unfinished) return null;
  return (
    <article
      className="story-message assistant story-preview-message"
      aria-live="off"
    >
      <strong>{unfinished ? "未完成的生成预览" : "生成中 · 临时预览"}</strong>
      {preview.narration && (
        <p className="story-narration">{preview.narration}</p>
      )}
      {preview.dialogue && <p>{preview.dialogue}</p>}
    </article>
  );
});

function label(progress?: StoryProgress) {
  switch (progress?.phase) {
    case "history":
      return "正在整理历史…";
    case "checking":
      return "正在检查结果…";
    case "retrying": {
      const retry = progress.retry;
      return retry?.kind === "format"
        ? `正在调整回复格式 ${retry.count}/${retry.max}`
        : `模型暂时不可用，正在重试 ${retry?.count ?? 0}/${retry?.max ?? 0}`;
    }
    case "unfinished":
      return "本次生成未完成";
    default:
      return "正在生成剧情…";
  }
}

function Waited({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <small>已等待 {Math.max(0, Math.floor((now - since) / 1000))} 秒</small>
  );
}

export const StoryWaiting = memo(function StoryWaiting({
  view,
  turn,
  cancel,
}: {
  view: StoryProgressView;
  turn: RoleplayTurn;
  cancel: () => void;
}) {
  const progress = useTurnProgress(view, turn);
  if (turn.status !== "pending") return null;
  return (
    <div className="story-thinking">
      <Sparkles size={16} aria-hidden="true" />
      <span role="status">{label(progress)}</span>
      <Waited since={turn.createdAt} />
      <button type="button" onClick={cancel}>
        取消生成
      </button>
    </div>
  );
});
