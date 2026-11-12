import type { ReactNode } from "react";
import { MessageSquareText } from "lucide-react";
import {
  clueStatusLabels,
  goalStatusLabels,
  itemStatusLabels,
  type StoryChange,
  type StorySource,
  type StoryState,
} from "../shared/storyState";

function Entries<T extends { id: string }>({
  items,
  render,
}: {
  items: T[];
  render: (item: T) => ReactNode;
}) {
  const list = (entries: T[]) => (
    <ul>
      {entries.map((item) => (
        <li key={item.id}>{render(item)}</li>
      ))}
    </ul>
  );
  return (
    <>
      {list(items.slice(0, 3))}
      {items.length > 3 && (
        <details>
          <summary>再看 {items.length - 3} 项</summary>
          {list(items.slice(3))}
        </details>
      )}
    </>
  );
}

export function StoryStatePanel({
  state,
  pending,
  onSource,
}: {
  state: StoryState;
  pending: boolean;
  onSource: (source: StorySource) => void;
}) {
  const active = state.goals.filter((goal) => goal.status === "active");
  const ended = state.goals.filter((goal) => goal.status !== "active");
  const held = state.items.filter((item) => item.status === "held");
  const former = state.items.filter((item) => item.status !== "held");
  const open = state.clues.filter((clue) => clue.status === "open");
  const solved = state.clues.filter((clue) => clue.status === "solved");
  const latest = state.lastUpdate;
  const goal = (entry: StoryState["goals"][number]) => (
    <>
      <strong>{entry.title}</strong>{" "}
      <small>{goalStatusLabels[entry.status]}</small>
      <p>{entry.description}</p>
    </>
  );
  const item = (entry: StoryState["items"][number]) => (
    <>
      <strong>{entry.name}</strong>{" "}
      <small>{itemStatusLabels[entry.status]}</small>
      <p>{entry.description}</p>
    </>
  );
  const clue = (entry: StoryState["clues"][number]) => (
    <>
      {entry.content} <small>{clueStatusLabels[entry.status]}</small>
    </>
  );
  return (
    <aside className="story-state-panel" aria-labelledby="story-state-title">
      <h3 id="story-state-title">剧情状态</h3>
      <div className="story-state-notice" role="status">
        {pending
          ? "正在生成，等待本轮更新。"
          : !latest
            ? "下一次剧情回复后更新状态。"
            : ""}
      </div>
      <section>
        <h4>当前场景</h4>
        {state.scene.chapter && (
          <p>
            <strong>{state.scene.chapter}</strong>
          </p>
        )}
        <p>地点 · {state.scene.location ?? "尚未明确"}</p>
        <p>{state.scene.situation ?? "尚未明确当前局势。"}</p>
      </section>
      <section>
        <h4>当前目标</h4>
        {active.length ? (
          <Entries items={active} render={goal} />
        ) : (
          <p>暂无进行中的目标。</p>
        )}
        {ended.length > 0 && (
          <details>
            <summary>已结束目标（{ended.length}）</summary>
            <Entries items={ended} render={goal} />
          </details>
        )}
      </section>
      <section>
        <h4>本轮变化</h4>
        {!latest ? (
          <p>尚无已确认的剧情变化。</p>
        ) : !latest.changes.length ? (
          <p>本轮剧情状态无变化</p>
        ) : (
          <ul className="story-state-changes">
            {latest.changes.slice(0, 3).map((change, index) => (
              <li key={index}>
                <ChangeLink
                  change={change}
                  source={latest}
                  onSource={onSource}
                />
              </li>
            ))}
            {latest.changes.length > 3 && (
              <li>
                <details>
                  <summary>再看 {latest.changes.length - 3} 项变化</summary>
                  <ul>
                    {latest.changes.slice(3).map((change, index) => (
                      <li key={index}>
                        <ChangeLink
                          change={change}
                          source={latest}
                          onSource={onSource}
                        />
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            )}
          </ul>
        )}
      </section>
      <details>
        <summary>角色关系（{state.relationships.length}）</summary>
        {state.relationships.length ? (
          <Entries
            items={state.relationships}
            render={(entry) => (
              <>
                <strong>{entry.name}</strong>
                <p>{entry.description}</p>
                <p>最近变化原因 · {entry.reason}</p>
              </>
            )}
          />
        ) : (
          <p>尚无明确的角色关系。</p>
        )}
      </details>
      <details>
        <summary>持有物品（{held.length}）</summary>
        {held.length ? (
          <Entries items={held} render={item} />
        ) : (
          <p>尚无持有物品。</p>
        )}
        {former.length > 0 && (
          <details>
            <summary>已使用、交出或失去（{former.length}）</summary>
            <Entries items={former} render={item} />
          </details>
        )}
      </details>
      <details>
        <summary>剧情线索（{open.length} 条未解）</summary>
        {open.length ? (
          <Entries items={open} render={clue} />
        ) : (
          <p>暂无未解线索。</p>
        )}
        {solved.length > 0 && (
          <details>
            <summary>已解线索（{solved.length}）</summary>
            <Entries items={solved} render={clue} />
          </details>
        )}
      </details>
    </aside>
  );
}

function ChangeLink({
  change,
  source,
  onSource,
}: {
  change: StoryChange;
  source: StorySource;
  onSource: (source: StorySource) => void;
}) {
  return (
    <button type="button" onClick={() => onSource(source)}>
      <MessageSquareText size={15} aria-hidden="true" />
      <span>
        <strong>{change.label}</strong> · {change.detail}
        <small>查看第 {source.seq} 条回复</small>
      </span>
    </button>
  );
}
