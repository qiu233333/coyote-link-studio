import { ActionCard } from "./ActionCard";
import { sessionAction } from "./actionCardModel";
import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  FilePenLine,
  Hand,
  LockKeyhole,
  MessageCircle,
  Pause,
  Play,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
} from "lucide-react";
import type {
  AppSnapshot,
  ControlBounds,
  RunView,
  RunStatus,
  RunTerminationSource,
  TaskPlan,
} from "../shared/types";
import {
  type Action,
  clockTime,
  duration,
  isActive,
  requestId,
  timeLeft,
} from "./api";
import {
  Avatar,
  Badge,
  BoundsEditor,
  Card,
  Empty,
  Field,
  Modal,
  defaultBounds,
} from "./ui";
import { Monitor, StageEditor } from "./ConsolePage";
import { controlBoundsIssue, taskPlanIssue } from "./playbackLimits";
import { StageIntensityScale } from "./StageIntensityScale";
import { useStageIntensityScaling } from "./stageIntensityScaling";
import {
  DraftBar,
  useDraft,
  useDraftStore,
  useEditorPreference,
} from "./drafts";
import { rangeDraft, taskDraft, textDraft } from "./draftSchemas";

type AiProps = { state: AppSnapshot; action: Action; pending: boolean };

export function AiControlPage({ state, action, pending }: AiProps) {
  const run =
    state.run?.owner === "ai-control" && isActive(state) ? state.run : null;
  const draft = useDraft("ai:range", rangeDraft);
  const confirmed = run?.bounds;
  const rangeVersion = run ? `${run.id}:${run.boundsVersion}` : "idle";
  const editing = draft.value !== undefined;
  const changed = editing && draft.value?.base !== rangeVersion;
  const bounds =
    draft.value?.bounds ?? confirmed ?? defaultBounds(state.waveforms);
  const [review, setReview] = useState(false);
  const blocked =
    state.locked ||
    state.stopping ||
    state.stopUnconfirmed ||
    (isActive(state) && state.owner !== "ai-control");
  const canEdit = !blocked && !pending && (!run || run.status === "paused");
  const boundsIssue = controlBoundsIssue(state, bounds);
  return (
    <div className="page-content">
      <div className="section-title">
        <h1>AI 控制</h1>
      </div>
      {state.run?.owner === "ai-control" && !run && (
        <RunEndNotice run={state.run} />
      )}
      {!state.aiRuntime.ready && (
        <div className="notice notice-pink">
          <Bot size={18} />
          <span>
            AI 尚未就绪：
            {state.aiRuntime.error || "请先在系统设置中配置并测试接口。"}
          </span>
        </div>
      )}
      {blocked && (
        <div className="notice notice-pink">
          <ShieldCheck size={18} />
          <span>
            {state.locked
              ? "AI 上锁任务运行中，当前功能暂不可操作。"
              : state.stopUnconfirmed
                ? "停止状态未确认，请先恢复连接并完成清理。"
                : "其他控制模式正在运行，请先结束当前运行。"}
          </span>
        </div>
      )}
      <div className="ai-workspace">
        <Card
          title="控制范围"
          icon={<SlidersIcon />}
          actions={
            run && (
              <Badge color={run.status === "paused" ? "gray" : "blue"} dot>
                {run.status === "paused"
                  ? "已暂停"
                  : run.inferenceRecovery
                    ? "等待 AI 重试"
                    : "运行中"}
              </Badge>
            )
          }
        >
          {confirmed && editing && (
            <details className="bounds-details">
              <summary>查看后台已确认的授权范围</summary>
              <RangeReview bounds={confirmed} state={state} />
            </details>
          )}
          {editing && <p className="field-hint">下方是待确认的本地编辑。</p>}
          <DraftBar draft={draft} label="丢弃范围草稿" />
          {changed && (
            <div className="notice notice-pink" role="status">
              后台授权范围或会话已变化。请先核对当前授权。
              <button
                type="button"
                className="text-button"
                disabled={!canEdit}
                onClick={() => draft.cell.write({ bounds, base: rangeVersion })}
              >
                继续使用本地范围草稿
              </button>
            </div>
          )}
          <BoundsEditor
            bounds={bounds}
            onChange={(bounds) =>
              draft.cell.write({
                bounds,
                base: draft.value?.base ?? rangeVersion,
              })
            }
            waves={state.waveforms}
            disabled={!canEdit}
            deviceLimits={
              state.device.connected ? state.device.limits : undefined
            }
          />
          {boundsIssue && (
            <p className="playback-issue" role="status">
              {boundsIssue}
            </p>
          )}
          {!run ? (
            <button
              className="button primary full"
              disabled={
                blocked ||
                pending ||
                !state.device.connected ||
                !state.aiRuntime.ready ||
                !!boundsIssue ||
                changed
              }
              onClick={() => setReview(true)}
            >
              <Sparkles size={17} />
              确认范围，交给 AI
            </button>
          ) : (
            <>
              <div className="session-deadline">
                <Clock3 size={15} />
                <span>
                  剩余 {duration(timeLeft(run.deadlineAt))} ·
                  暂停期间截止时间继续流逝
                </span>
              </div>
              <div className="button-row wrap">
                {run.status === "running" ? (
                  <button
                    className="button primary"
                    disabled={blocked || pending}
                    onClick={() => void action("/api/ai-control/pause", {})}
                  >
                    <Pause size={16} />
                    暂停控制
                  </button>
                ) : (
                  <>
                    <button
                      className="button primary"
                      disabled={blocked || pending || editing}
                      onClick={() => void action("/api/ai-control/resume", {})}
                    >
                      <Play size={16} />
                      继续控制
                    </button>
                    <button
                      className="button secondary"
                      disabled={
                        blocked ||
                        pending ||
                        !editing ||
                        !!boundsIssue ||
                        changed
                      }
                      onClick={async () => {
                        const result = await action(
                          "/api/ai-control/bounds",
                          { bounds, expectedRange: rangeVersion },
                          "PATCH",
                          "新的控制范围已保存",
                        );
                        if (
                          result !== undefined &&
                          draft.cell.write(undefined, draft.revision)
                        )
                          draft.cell.flush();
                      }}
                    >
                      <Save size={16} />
                      确认新范围
                    </button>
                  </>
                )}
                <button
                  className="button secondary"
                  disabled={blocked || pending}
                  onClick={() =>
                    void action(
                      "/api/console/takeover",
                      {},
                      "POST",
                      "已停止 AI 并切回手动",
                    )
                  }
                >
                  <Hand size={16} />
                  接管为手动
                </button>
                <button
                  className="button danger-soft"
                  disabled={blocked || pending}
                  onClick={() => void action("/api/ai-control/stop", {})}
                >
                  <Square size={15} />
                  结束会话
                </button>
              </div>
              {run.status === "paused" && (
                <p className="field-hint">
                  暂停已清理输出。修改后确认新范围，再继续；新的会话时长以保存范围时为起点。
                </p>
              )}
            </>
          )}
        </Card>
        <div className="ai-side">
          <FeedbackPanel
            persistInput
            feedback={run?.feedback}
            thinking={run?.thinking}
            action={action}
            endpoint="/api/ai-control/feedback"
            disabled={!run || blocked || pending}
          />
          <RunSummary
            state={state}
            run={state.run?.owner === "ai-control" ? state.run : null}
          />
        </div>
      </div>
      <Monitor history={state.history} connected={state.device.connected} />
      {review && (
        <Modal title="确认 AI 控制范围" onClose={() => setReview(false)}>
          <RangeReview bounds={bounds} state={state} />
          {boundsIssue && (
            <p className="playback-issue" role="status">
              {boundsIssue}
            </p>
          )}
          <p className="field-hint">
            这是自由控制会话。开始后仍可暂停、停止、修改范围或接管为手动。
          </p>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setReview(false)}
            >
              返回修改
            </button>
            <button
              className="button primary"
              disabled={
                blocked ||
                pending ||
                !state.device.connected ||
                !state.aiRuntime.ready ||
                !!boundsIssue ||
                changed ||
                !!run
              }
              onClick={async () => {
                const result = await action("/api/ai-control/start", {
                  bounds,
                  requestId: requestId(),
                });
                if (result !== undefined) {
                  setReview(false);
                  if (draft.cell.write(undefined, draft.revision))
                    draft.cell.flush();
                }
              }}
            >
              <Sparkles size={16} />
              开启 AI 控制
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SlidersIcon() {
  return <ShieldCheck size={18} />;
}

export function LockedTaskPage({ state, action, pending }: AiProps) {
  const run =
    state.run?.owner === "locked-task" && isActive(state) ? state.run : null;
  const store = useDraftStore();
  const requestDraft = useDraft("task:new", textDraft);
  const prompt = requestDraft.value ?? "";
  const setPrompt = (text: string) =>
    requestDraft.cell.write(text || undefined);
  const [taskId, setTaskId] = useEditorPreference<string>(
    "task",
    (value) => (typeof value === "string" ? value : undefined),
    "",
  );
  const draft = useDraft(`task:${taskId}`, taskDraft);
  const remote = state.plans.find(({ id }) => id === taskId);
  const editor = draft.value?.plan.id === taskId ? draft.value : undefined;
  const outdated = !!editor && editor.baseVersion !== remote?.version;
  const useLocal = !!editor && (editor.dirty || !outdated || !remote);
  const plan = useLocal ? editor.plan : remote;
  const step = plan ? (useLocal ? editor.step : 1) : 0;
  const blocked =
    state.locked || state.stopping || state.stopUnconfirmed || isActive(state);
  const editingDisabled = blocked || pending;
  const review = step === 2 && !blocked;
  const writePlan = (
    plan: TaskPlan,
    changes: Partial<NonNullable<typeof draft.value>>,
  ) =>
    draft.cell.write({
      plan,
      baseVersion: useLocal ? editor.baseVersion : plan.version,
      dirty: useLocal ? editor.dirty : false,
      step: step === 2 ? 2 : 1,
      scaling: useLocal ? editor.scaling : undefined,
      ...changes,
    });
  const setStep = (step: 1 | 2) => {
    if (plan) writePlan(plan, { step });
  };
  const scaling = useStageIntensityScaling(
    plan?.stages ?? [],
    (stages, scaling) => {
      if (plan) writePlan({ ...plan, stages }, { dirty: true, scaling });
    },
    useLocal ? editor.scaling : undefined,
  );
  const planIssue =
    scaling.inputIssue || (plan ? taskPlanIssue(state, plan) : null);
  const missing = !!taskId && !remote;
  const versionConflict = outdated && !!editor?.dirty;
  const maySave = !!remote && !versionConflict && draft.status !== "conflict";
  const generate = async () => {
    const result = await action<TaskPlan>("/api/locked-tasks/draft", {
      prompt,
    });
    if (result?.id) {
      store.cell(`task:${result.id}`, taskDraft).write({
        plan: result,
        baseVersion: result.version,
        dirty: false,
        step: 1,
      });
      setTaskId(result.id);
    }
  };
  const patchPlan = (change: Partial<TaskPlan>) => {
    if (plan) writePlan({ ...plan, ...change }, { dirty: true });
  };
  const savePlan = async (success?: string) => {
    if (!plan || !remote || !maySave) return;
    const saved = await action<TaskPlan>(
      `/api/locked-tasks/${plan.id}`,
      { plan, expectedVersion: remote.version },
      "PATCH",
      success,
    );
    if (
      saved &&
      draft.cell.write(
        {
          plan: saved,
          baseVersion: saved.version,
          dirty: false,
          step: step === 2 ? 2 : 1,
          scaling: useLocal ? editor.scaling : undefined,
        },
        draft.revision,
      )
    )
      draft.cell.flush();
    return saved;
  };
  return (
    <div className="page-content">
      <div className="section-title">
        <h1>AI 上锁任务</h1>
      </div>
      {state.run?.owner === "locked-task" && !run && (
        <RunEndNotice run={state.run} />
      )}
      <div className="task-stepper">
        {["描述需求", "编辑任务", "确认上锁", "执行与反馈"].map((s, i) => (
          <div
            key={s}
            className={(run ? 3 : step) >= i ? "active" : ""}
            aria-current={(run ? 3 : step) === i ? "step" : undefined}
          >
            <span>
              {(run ? 3 : step) > i ? (
                <Check size={15} />
              ) : (
                String(i + 1).padStart(2, "0")
              )}
            </span>
            <strong>{s}</strong>
            {i < 3 && <ChevronRight size={15} />}
          </div>
        ))}
      </div>
      {run ? (
        <>
          <div className="locked-banner glass-card">
            <div className="locked-orb">
              <LockKeyhole size={26} />
            </div>
            <div>
              <Badge color="pink" dot>
                任务已锁定
              </Badge>
              <h2>{run.plan?.title || "AI 上锁任务"}</h2>
              <p>范围已冻结。你可以反馈感受；紧急停止始终可用。</p>
            </div>
            <div className="lock-countdown">
              <span>最晚截止倒计时</span>
              <strong>{duration(timeLeft(run.deadlineAt))}</strong>
              <small>
                {new Date(run.deadlineAt!).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </small>
            </div>
          </div>
          <div className="ai-workspace">
            <Card title="已确认的约定" icon={<ShieldCheck size={18} />}>
              <p className="task-description">{run.plan?.description}</p>
              <div className="criteria-box">
                <span>完成判定</span>
                <p>
                  {run.plan?.completionCriteria || "按阶段计时与文字反馈判定"}
                </p>
              </div>
              {run.bounds && <RangeReview bounds={run.bounds} state={state} />}
              <div className="locked-stage-list">
                {run.plan?.stages.map((s, index) => (
                  <div
                    key={s.id}
                    className={index === run.stageIndex ? "current" : ""}
                  >
                    <span>
                      {index < run.stageIndex ? (
                        <Check size={15} />
                      ) : (
                        String(index + 1).padStart(2, "0")
                      )}
                    </span>
                    <div>
                      <strong>{s.name}</strong>
                      <small>
                        {s.durationSec}s ·{" "}
                        {s.behavior === "rest"
                          ? "归零休息"
                          : s.channels
                              .map(
                                (channel) =>
                                  `${channel} ${s.behavior === "ramp" ? `${s.startIntensity[channel]} → ` : ""}${s.intensity[channel]}`,
                              )
                              .join(" · ")}{" "}
                        · {s.channels.join(" / ")}
                      </small>
                    </div>
                    {index === run.stageIndex && (
                      <Badge color="pink">当前阶段</Badge>
                    )}
                  </div>
                ))}
              </div>
              <p className="field-hint">
                完成依据计时和文字反馈。锁定任务不会验证现实行为；达到最晚截止时间将自动结束。
              </p>
            </Card>
            <div className="ai-side">
              <FeedbackPanel
                feedback={run?.feedback}
                thinking={run?.thinking}
                action={action}
                endpoint="/api/locked-tasks/feedback"
                disabled={pending || state.stopping}
              />
              <RunSummary run={run} state={state} />
            </div>
          </div>
        </>
      ) : (
        <>
          {!state.aiRuntime.ready && (
            <div className="notice notice-pink">
              <Bot size={18} />
              <span>请先在系统设置中配置 AI 接口。{state.aiRuntime.error}</span>
            </div>
          )}
          {isActive(state) && (
            <div className="notice">
              <ShieldCheck size={18} />
              <span>请先结束当前控制会话，再创建和开启上锁任务。</span>
            </div>
          )}
          <div className="task-create-layout">
            <div>
              <Card title="生成任务草稿" icon={<WandSparkles size={19} />}>
                <Field label="任务需求">
                  <textarea
                    aria-label="任务需求"
                    rows={4}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    disabled={editingDisabled}
                    placeholder="例如：一个 10 分钟的平稳体验，前面慢慢适应，中间有变化，最后安排休息。以我的文字反馈确认完成。"
                    maxLength={4000}
                  />
                </Field>
                <DraftBar
                  draft={requestDraft}
                  label="丢弃需求草稿"
                  disabled={editingDisabled}
                />
                <div className="prompt-examples">
                  {[
                    "平稳渐进，穿插休息",
                    "分三个阶段，最多 10 分钟",
                    "波形交替，以文字反馈确认",
                  ].map((t) => (
                    <button
                      key={t}
                      disabled={editingDisabled}
                      onClick={() => setPrompt(prompt ? `${prompt}；${t}` : t)}
                    >
                      {t}
                      <Plus size={12} />
                    </button>
                  ))}
                </div>
                <button
                  className="button primary"
                  disabled={
                    editingDisabled || !prompt.trim() || !state.aiRuntime.ready
                  }
                  onClick={() => void generate()}
                >
                  <WandSparkles size={16} />
                  {pending
                    ? "正在生成…"
                    : plan
                      ? "重新生成任务草稿"
                      : "生成任务草稿"}
                </button>
              </Card>
              {missing && (
                <div className="notice notice-pink" role="status">
                  后台已找不到此任务，不能保存或开启。
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      draft.cell.discard();
                      setTaskId("");
                    }}
                  >
                    关闭并丢弃本地任务草稿
                  </button>
                </div>
              )}
              {plan && (
                <Card
                  title="把草稿改成你的约定"
                  icon={<FilePenLine size={18} />}
                  className="task-plan-editor"
                >
                  <DraftBar
                    draft={draft}
                    label="丢弃任务修改"
                    disabled={editingDisabled || missing}
                  />
                  {versionConflict && remote && (
                    <div className="notice notice-pink" role="status">
                      后台任务已更新为 v{remote.version}「{remote.title}
                      」，本地仍有修改。
                      <button
                        type="button"
                        className="text-button"
                        onClick={draft.cell.discard}
                      >
                        载入后台任务
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={editingDisabled}
                        onClick={() => {
                          if (
                            confirm(
                              "保留本地任务内容？下次正式保存会覆盖当前后台版本。",
                            )
                          )
                            writePlan(plan, {
                              baseVersion: remote.version,
                              dirty: true,
                            });
                        }}
                      >
                        保留本地任务修改
                      </button>
                    </div>
                  )}
                  <Field label="任务名称">
                    <input
                      aria-label="任务名称"
                      value={plan.title}
                      disabled={editingDisabled}
                      maxLength={100}
                      onChange={(e) => patchPlan({ title: e.target.value })}
                    />
                  </Field>
                  <Field label="任务说明">
                    <textarea
                      aria-label="任务说明"
                      rows={3}
                      value={plan.description}
                      disabled={editingDisabled}
                      onChange={(e) =>
                        patchPlan({ description: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="完成判定条件">
                    <textarea
                      aria-label="完成判定条件"
                      rows={2}
                      value={plan.completionCriteria}
                      disabled={editingDisabled}
                      onChange={(e) =>
                        patchPlan({ completionCriteria: e.target.value })
                      }
                    />
                  </Field>
                  <details className="bounds-details" open>
                    <summary>授权范围与最长时间</summary>
                    <BoundsEditor
                      bounds={plan.bounds}
                      onChange={(bounds) => patchPlan({ bounds })}
                      waves={state.waveforms}
                      disabled={editingDisabled}
                      deviceLimits={
                        state.device.connected ? state.device.limits : undefined
                      }
                    />
                  </details>
                  <div className="subsection-heading">
                    <h3>阶段安排</h3>
                  </div>
                  <StageIntensityScale
                    scaling={scaling}
                    disabled={editingDisabled}
                  />
                  <StageEditor
                    stages={plan.stages}
                    setStages={scaling.updateStages}
                    waves={state.waveforms}
                    disabled={editingDisabled}
                    state={state}
                    bounds={plan.bounds}
                  />
                  {planIssue && (
                    <p className="playback-issue" role="status">
                      {planIssue}
                    </p>
                  )}
                  <div className="button-row wrap">
                    <button
                      className="button secondary"
                      disabled={editingDisabled || !!planIssue || !maySave}
                      onClick={() => void savePlan("任务草稿已正式保存")}
                    >
                      <Save size={16} />
                      保存草稿
                    </button>
                    <button
                      className="button primary"
                      disabled={
                        editingDisabled ||
                        !state.device.connected ||
                        !state.aiRuntime.ready ||
                        !plan.stages.length ||
                        !!planIssue ||
                        !maySave
                      }
                      onClick={() => {
                        setStep(2);
                      }}
                    >
                      <LockKeyhole size={16} />
                      进入上锁确认
                      <ArrowRight size={16} />
                    </button>
                  </div>
                </Card>
              )}
            </div>
            <div className="ai-side">
              <Card title="已保存的任务草稿" icon={<FilePenLine size={17} />}>
                {state.plans.length ? (
                  <div className="preset-list">
                    {state.plans
                      .slice()
                      .reverse()
                      .map((p) => (
                        <div key={p.id}>
                          <button
                            disabled={editingDisabled}
                            onClick={() => {
                              if (p.id === taskId) {
                                if (
                                  editor?.dirty &&
                                  !confirm(
                                    "载入后台任务会替换此任务尚未正式保存的修改。要继续吗？",
                                  )
                                )
                                  return;
                                draft.cell.discard();
                              }
                              setTaskId(p.id);
                            }}
                          >
                            <strong>{p.title}</strong>
                            <small>
                              {p.stages.length} 阶段 · 最多{" "}
                              {duration(p.bounds.durationSec)}
                            </small>
                          </button>
                          <ChevronRight size={15} />
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`删除任务 ${p.title}`}
                            disabled={editingDisabled}
                            onClick={async () => {
                              if (
                                !confirm(
                                  `删除后台任务「${p.title}」及其本地草稿？`,
                                )
                              )
                                return;
                              const result = await action(
                                `/api/locked-tasks/${p.id}`,
                                { expectedVersion: p.version },
                                "DELETE",
                                "任务已删除",
                              );
                              if (result === undefined) return;
                              store
                                .cell(`task:${p.id}`, taskDraft)
                                .deleteEntity();
                              if (taskId === p.id) setTaskId("");
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                  </div>
                ) : (
                  <Empty title="暂无任务草稿" />
                )}
              </Card>
            </div>
          </div>
        </>
      )}
      {review && plan && (
        <Modal
          title="确认约定并上锁"
          onClose={() => {
            setStep(1);
          }}
        >
          <div className="lock-confirm-title">
            <LockKeyhole size={25} />
            <div>
              <h3>{plan.title}</h3>
              <p>{plan.description}</p>
            </div>
          </div>
          <RangeReview bounds={plan.bounds} state={state} />
          {!maySave && (
            <p className="playback-issue" role="status">
              任务版本或本地草稿已变化，请返回修改并核对后再确认。
            </p>
          )}
          <div className="playback-stage-review" aria-label="锁定阶段强度确认">
            {plan.stages.map((stage) => (
              <p key={stage.id}>
                <strong>{stage.name}</strong>
                {" · "}
                {stage.behavior === "rest"
                  ? "归零休息"
                  : stage.channels
                      .map(
                        (channel) =>
                          `${channel} ${stage.behavior === "ramp" ? `${stage.startIntensity[channel]} → ` : ""}${stage.intensity[channel]}`,
                      )
                      .join(" · ")}
              </p>
            ))}
          </div>
          {planIssue && (
            <p className="playback-issue" role="status">
              {planIssue}
            </p>
          )}
          <div className="notice notice-pink">
            <LockKeyhole size={18} />
            <span>
              开启后不能普通暂停、修改或延时。你可以发送反馈；紧急停止随时可用。最晚将在{" "}
              {duration(plan.bounds.durationSec)} 后结束。
            </span>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => {
                setStep(1);
              }}
            >
              返回修改
            </button>
            <button
              className="button primary pink-primary"
              disabled={
                editingDisabled ||
                !state.device.connected ||
                !!planIssue ||
                !maySave
              }
              onClick={async () => {
                const saved = await savePlan();
                if (!saved) return;
                const revision = draft.cell.snapshot().revision;
                const started = await action(
                  `/api/locked-tasks/${plan.id}/start`,
                  { requestId: requestId(), expectedVersion: saved.version },
                );
                if (started !== undefined) {
                  const current = draft.cell.snapshot().value;
                  if (current)
                    draft.cell.write({ ...current, step: 1 }, revision);
                  draft.cell.flush();
                }
              }}
            >
              <LockKeyhole size={16} />
              确认开启并上锁
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RangeReview({
  bounds,
  state,
}: {
  bounds: ControlBounds;
  state: AppSnapshot;
}) {
  return (
    <>
      <div className="review-grid">
        <div>
          <span>授权通道</span>
          <strong>{bounds.channels.join(" / ") || "未选择"}</strong>
        </div>
        {bounds.channels.map((channel) => (
          <div key={channel}>
            <span>{channel} 通道强度范围</span>
            <strong>
              {bounds.minIntensity[channel]}–{bounds.maxIntensity[channel]}
            </strong>
            <small className="field-hint">
              变化速率 {bounds.rampPerSecond[channel]} / s
            </small>
          </div>
        ))}
        <div>
          <span>最长运行</span>
          <strong>{duration(bounds.durationSec)}</strong>
        </div>
        <div>
          <span>决策间隔</span>
          <strong>{bounds.decisionIntervalSec}s</strong>
        </div>
        <div>
          <span>单次动作</span>
          <strong>≤ {bounds.maxActionSec}s</strong>
        </div>
      </div>
      <Field label="授权波形">
        <div className="chip-row">
          {bounds.waveformIds.map((id) => (
            <span className="read-chip" key={id}>
              {state.waveforms.find((w) => w.id === id)?.name || "快照波形"}
            </span>
          ))}
        </div>
      </Field>
      <div className="range-permissions">
        {[
          { label: "双通道联动", value: bounds.allowSync },
          { label: "随机", value: bounds.allowRandom },
          { label: "渐变", value: bounds.allowRamp },
          { label: "休息", value: bounds.allowRest },
        ].map((p) => (
          <span key={p.label} className={p.value ? "allowed" : ""}>
            {p.value ? <Check size={12} /> : "—"}
            {p.label}
          </span>
        ))}
      </div>
    </>
  );
}

const FeedbackPanel = memo(function FeedbackPanel({
  feedback,
  thinking,
  action,
  endpoint,
  disabled,
  persistInput = false,
}: {
  feedback: RunView["feedback"] | undefined;
  thinking: boolean | undefined;
  action: Action;
  endpoint: string;
  disabled: boolean;
  persistInput?: boolean;
}) {
  const draft = useDraft("ai:feedback", textDraft);
  const [localText, setLocalText] = useState("");
  const text = persistInput ? (draft.value ?? "") : localText;
  const setText = (value: string) =>
    persistInput ? draft.cell.write(value || undefined) : setLocalText(value);
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [feedback?.length]);
  const send = async (value: string) => {
    if (!value.trim() || disabled) return;
    const result = await action(endpoint, { text: value.trim() });
    if (result !== undefined && value === text) {
      if (persistInput) {
        if (draft.cell.write(undefined, draft.revision)) draft.cell.flush();
      } else setLocalText((current) => (current === value ? "" : current));
    }
  };
  if (!feedback) {
    return (
      <Card title="文字反馈" icon={<MessageCircle size={18} />}>
        <p className="muted">开始运行后可发送反馈。</p>
      </Card>
    );
  }
  return (
    <Card
      title="文字反馈"
      icon={<MessageCircle size={18} />}
      className="feedback-card"
    >
      <div className="chat-messages" aria-live="polite">
        {feedback?.length ? (
          feedback.map((f) => (
            <div className={`chat-message ${f.role}`} key={f.id}>
              {f.role === "assistant" && <Avatar size="small" />}
              <div>
                <div className="chat-bubble">{f.text}</div>
                <time>{clockTime(f.at)}</time>
              </div>
            </div>
          ))
        ) : (
          <div className="chat-empty">
            <Avatar />
            <p>暂无反馈</p>
          </div>
        )}
        {thinking && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <small>星涟正在思考</small>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="quick-feedback">
        {["太强了", "换个波形", "多休息一下"].map((t) => (
          <button key={t} disabled={disabled} onClick={() => void send(t)}>
            {t}
          </button>
        ))}
      </div>
      {persistInput && <DraftBar draft={draft} label="丢弃反馈草稿" />}
      <form
        className="feedback-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          aria-label="给 AI 的文字反馈"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入反馈…"
          disabled={disabled}
          rows={2}
          maxLength={2000}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button
          type="submit"
          className="send-button"
          aria-label="发送反馈"
          disabled={disabled || !text.trim()}
        >
          <Send size={17} />
        </button>
      </form>
    </Card>
  );
});

const runStatusNames: Record<RunStatus, string> = {
  running: "运行中",
  paused: "已暂停",
  completed: "正常完成",
  stopped: "已停止",
  faulted: "故障终止",
  interrupted: "已中断",
};
const terminationNames: Record<RunTerminationSource, string> = {
  deadline: "已到最晚截止时间",
  "ai-finish": "AI 主动判定完成",
  "stages-completed": "任务阶段完成",
  "user-stop": "用户结束会话",
  emergency: "紧急停止",
  takeover: "手动接管",
  "device-disconnected": "设备断线",
  "device-stale": "设备遥测过期",
  "device-command": "设备指令失败",
  authorization: "授权范围校验失败",
  "ai-inference": "AI 推理失败",
  "ai-runtime": "AI 本地运行时故障",
  "stop-unconfirmed": "设备停止未确认",
  "service-shutdown": "本地服务关闭",
  "service-restart": "本地服务重启",
};

function RunEndNotice({ run }: { run: RunView }) {
  return (
    <div
      className={`notice ${run.status === "faulted" ? "notice-pink" : ""}`}
      role="status"
      aria-label="上次会话结束原因"
    >
      <Clock3 size={18} />
      <div>
        <strong>
          上次{run.owner === "locked-task" ? "任务" : "会话"}：
          {runStatusNames[run.status]}
          {run.termination
            ? ` · ${terminationNames[run.termination.source]}`
            : ""}
        </strong>
        {run.termination?.triggerSource &&
          run.termination.triggerSource !== run.termination.source && (
            <p>起因：{terminationNames[run.termination.triggerSource]}</p>
          )}
        {run.reason && <p>{run.reason}</p>}
        {run.termination && (
          <small>
            {clockTime(run.termination.at)}
            {run.termination.code ? ` · ${run.termination.code}` : ""}
            {" · "}再次开启需要重新确认。
          </small>
        )}
      </div>
    </div>
  );
}

function RunSummary({
  state,
  run,
}: {
  state: AppSnapshot;
  run: RunView | null;
}) {
  const active = run && ["running", "paused"].includes(run.status);
  const recovery = run?.inferenceRecovery;
  return (
    <Card title="会话状态" icon={<ActivityIcon />}>
      <div className="summary-line">
        <span>当前状态</span>
        <Badge color={active ? "blue" : "gray"} dot>
          {run
            ? run.status === "paused"
              ? "已暂停"
              : recovery
                ? "等待 AI 重试"
                : runStatusNames[run.status]
            : "尚未启动"}
        </Badge>
      </div>
      <div className="summary-line">
        <span>A / B 反馈强度</span>
        <strong>
          {state.device.intensities.A} / {state.device.intensities.B}
        </strong>
      </div>
      {active && (
        <div className="summary-line">
          <span>剩余时间</span>
          <strong>{duration(timeLeft(run.deadlineAt))}</strong>
        </div>
      )}
      {recovery && (
        <div
          className="notice notice-pink"
          role="status"
          aria-label="AI 推理恢复状态"
        >
          <Clock3 size={17} />
          <div>
            <strong>
              {run?.status === "paused"
                ? "已暂停，恢复控制后重试"
                : `等待重试 ${recovery.attempt}/${recovery.maxAttempts} · ${timeLeft(recovery.retryAt)} 秒后`}
            </strong>
            <p>{recovery.message}</p>
            <small>{recovery.code} · 最晚截止时间继续流逝</small>
          </div>
        </div>
      )}
      {run && sessionAction(run) && (
        <ActionCard record={sessionAction(run)!} state={state} />
      )}
    </Card>
  );
}
function ActivityIcon() {
  return <Clock3 size={17} />;
}
