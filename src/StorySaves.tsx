import { useEffect, useRef, useState } from "react";
import type { StoryBookmark, StoryNodeReference } from "../shared/roleplay";
import { request } from "./api";
import { Field, Modal } from "./ui";

export type StorySaveView =
  | { kind: "list" }
  | {
      kind: "save" | "branch" | "rename" | "delete";
      node: StoryNodeReference;
      bookmarkName?: string;
    };

type Props = {
  view: StorySaveView;
  onView: (view?: StorySaveView) => void;
  storyId: string;
  title: string;
  branchName: string;
  locked: boolean;
  onBookmarkChange: (
    messageId: string,
    bookmarked: boolean,
    feedback: string,
  ) => void;
  onBranch: (id: string) => Promise<void>;
};
type BookmarkPage = { items: StoryBookmark[]; cursor?: number };

export function StorySaves(props: Props) {
  const { view, storyId } = props;
  return view.kind === "list" ? (
    <BookmarkList key={storyId} {...props} />
  ) : (
    <NodeAction
      key={`${view.kind}:${view.node.messageId}`}
      {...props}
      view={view}
    />
  );
}

function BookmarkList({ storyId, title, locked, onView }: Props) {
  const [page, setPage] = useState<BookmarkPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const path = `/api/roleplay/sessions/${storyId}/bookmarks`;
  useEffect(() => {
    const controller = new AbortController();
    void request<BookmarkPage>(path, undefined, "GET", controller.signal)
      .then(setPage)
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [path]);
  async function loadMore() {
    if (loading || page?.cursor === undefined) return;
    setLoading(true);
    setError("");
    try {
      const next = await request<BookmarkPage>(
        `${path}?before=${page.cursor}`,
        undefined,
        "GET",
      );
      setPage({ items: [...page.items, ...next.items], cursor: next.cursor });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <Modal title="剧情存档" onClose={() => onView()}>
      <div className="story-saves-content story-bookmarks-content">
        <p className="story-save-story-title">{title}</p>
        {error && (
          <p role="alert" className="notice notice-pink">
            {error}
          </p>
        )}
        {!page && !error && <p role="status">正在读取存档…</p>}
        {page?.items.length === 0 && (
          <p>还没有存档。可在已完成的助手回复下选择「保存这一刻」。</p>
        )}
        {page && page.items.length > 0 && (
          <ul className="story-bookmarks">
            {page.items.map(({ node, name, savedAt }) => (
              <li key={node.messageId}>
                <strong>{name}</strong>
                <small>
                  第 {node.round} 轮 · {new Date(savedAt).toLocaleString()}
                </small>
                <p>{node.summary}</p>
                <div className="story-view-actions">
                  <button
                    type="button"
                    className="button small secondary"
                    disabled={locked}
                    onClick={() =>
                      onView({ kind: "branch", node, bookmarkName: name })
                    }
                  >
                    创建分支
                  </button>
                  <button
                    type="button"
                    className="button small secondary"
                    disabled={locked}
                    onClick={() =>
                      onView({ kind: "rename", node, bookmarkName: name })
                    }
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    className="button small secondary"
                    disabled={locked}
                    onClick={() =>
                      onView({ kind: "delete", node, bookmarkName: name })
                    }
                  >
                    删除存档
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {page?.cursor !== undefined && (
          <button
            type="button"
            className="button small secondary"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {loading ? "正在读取…" : "加载更多存档"}
          </button>
        )}
      </div>
    </Modal>
  );
}

function NodeAction({
  view,
  title,
  branchName,
  locked,
  onView,
  onBookmarkChange,
  onBranch,
}: Props & { view: Exclude<StorySaveView, { kind: "list" }> }) {
  const { kind, node, bookmarkName } = view;
  const [name, setName] = useState(() => {
    if (kind === "branch") return branchName;
    if (bookmarkName) return bookmarkName;
    return `第 ${node.round} 轮 · ${node.summary.slice(0, 45)}`;
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const branchAttempt = useRef<{ name: string; requestId: string } | undefined>(
    undefined,
  );
  const path = `/api/roleplay/sessions/${node.storyId}`;
  const heading = {
    save: "保存这一刻",
    branch: "从这里创建分支",
    rename: "重命名存档",
    delete: "删除存档",
  }[kind];
  const returnToList = () =>
    onView(bookmarkName === undefined ? undefined : { kind: "list" });
  async function submit() {
    const value = name.trim();
    if (submitting.current || locked || (kind !== "delete" && !value)) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      if (kind === "branch") {
        if (branchAttempt.current?.name !== value)
          branchAttempt.current = {
            name: value,
            requestId: crypto.randomUUID(),
          };
        const result = await request<{ id: string }>(
          `${path}/messages/${node.messageId}/branch`,
          branchAttempt.current,
        );
        await onBranch(result.id);
      } else {
        const url = `${path}/bookmarks/${node.messageId}`;
        if (kind === "delete") await request(url, undefined, "DELETE");
        else
          await request(
            url,
            { name: value },
            kind === "save" ? "PUT" : "PATCH",
          );
        onBookmarkChange(
          node.messageId,
          kind !== "delete",
          kind === "delete"
            ? "已删除存档书签"
            : kind === "rename"
              ? "存档已重命名"
              : "已保存这一刻",
        );
        returnToList();
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  const label = kind === "branch" ? "分支名称" : "存档名称";
  return (
    <Modal
      title={heading}
      onClose={() => {
        if (!submitting.current) onView();
      }}
    >
      <form
        className="story-saves-content story-save-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="story-save-node">
          <strong>
            {title} · 第 {node.round} 轮之后
          </strong>
          <p>{node.summary}</p>
        </div>
        {kind === "branch" && (
          <p>分支将作为独立的纯文字故事打开，可从这个节点继续。</p>
        )}
        {kind === "delete" ? (
          <p>删除「{bookmarkName}」的书签，故事和分支会保留。</p>
        ) : (
          <Field label={label}>
            <input
              aria-label={label}
              value={name}
              maxLength={100}
              required
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="notice notice-pink">
            {error}
          </p>
        )}
        <div className="story-view-actions">
          <button
            type="button"
            className="button secondary"
            disabled={pending}
            onClick={returnToList}
          >
            取消
          </button>
          <button
            className="button primary"
            disabled={pending || locked || (kind !== "delete" && !name.trim())}
          >
            {pending
              ? "处理中…"
              : kind === "branch"
                ? "确认创建分支"
                : kind === "delete"
                  ? "确认删除存档"
                  : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
