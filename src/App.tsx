import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  AudioLines,
  Bot,
  BookOpen,
  Check,
  CircleHelp,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  OctagonX,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import ConsolePage from "./ConsolePage";
import { AiControlPage, LockedTaskPage } from "./AiPages";
import SettingsPage from "./SettingsPage";
import { duration, isActive, ownerNames, timeLeft, useAppState } from "./api";
import { Avatar, Badge, IconButton, Modal } from "./ui";
import { DraftProvider, useEditorPreference } from "./drafts";
import { version as appVersion } from "../package.json";

const RoleplayPage = lazy(() => import("./RoleplayPage"));

type Page = "console" | "ai-control" | "locked-task" | "settings" | "roleplay";
const pages = [
  { id: "console", label: "控制台", icon: LayoutDashboard },
  { id: "ai-control", label: "AI 控制", icon: Bot },
  {
    id: "locked-task",
    label: "AI 上锁任务",
    icon: LockKeyhole,
  },
  { id: "roleplay", label: "情景演绎", icon: BookOpen },
  { id: "settings", label: "系统设置", icon: Settings2 },
] as const;

export default function App() {
  const transport = useAppState();
  const scope = transport.state?.draftScope ?? "loading";
  return (
    <DraftProvider scope={scope} key={scope}>
      <Workspace transport={transport} />
    </DraftProvider>
  );
}

function Workspace({
  transport,
}: {
  transport: ReturnType<typeof useAppState>;
}) {
  const {
    state,
    connection,
    error,
    toast,
    pending,
    action,
    refresh,
    dismissToast,
  } = transport;
  const [page, setPage] = useEditorPreference<Page>(
    "workspace",
    (value) => pages.find((item) => item.id === value)?.id,
    "console",
  );
  const [mobileNav, setMobileNav] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const currentNavButton = useRef<HTMLButtonElement>(null);
  const mainContent = useRef<HTMLElement>(null);
  const [help, setHelp] = useState(false);
  const [systemInfo, setSystemInfo] = useState(false);
  const [emergencyPending, setEmergencyPending] = useState(false);
  useEffect(() => {
    if (mobileNav) currentNavButton.current?.focus();
  }, [mobileNav]);
  const closeNavigation = () => {
    setMobileNav(false);
    menuButton.current?.focus();
  };
  const navigate = (to: Page) => {
    setPage(to);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: "instant" });
    mainContent.current?.focus({ preventScroll: true });
  };
  const emergency = async () => {
    setEmergencyPending(true);
    try {
      await action("/api/emergency-stop", {});
    } finally {
      setEmergencyPending(false);
    }
  };
  const active = state ? isActive(state) : false;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="star-field" />
      {mobileNav && <div className="nav-scrim" onClick={closeNavigation} />}
      <aside
        className={`sidebar ${mobileNav ? "mobile-open" : ""}`}
        id="workspace-sidebar"
        onKeyDown={(event) => {
          if (mobileNav && event.key === "Escape") closeNavigation();
        }}
      >
        {mobileNav && (
          <button
            type="button"
            className="sidebar-close icon-button"
            aria-label="收起导航"
            onClick={closeNavigation}
          >
            <X size={18} />
          </button>
        )}
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("console");
          }}
          aria-label="星涟联动首页"
        >
          <span className="brand-mark">
            <AudioLines size={25} />
            <i />
          </span>
          <span>
            <strong>星涟联动</strong>
          </span>
        </a>
        <nav className="main-nav" aria-label="主要模块">
          {pages.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              ref={page === item.id ? currentNavButton : undefined}
              onClick={() => navigate(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
              {item.id === "locked-task" && state?.locked ? (
                <LockKeyhole className="nav-lock" size={13} />
              ) : page === item.id ? (
                <span className="nav-active-dot" />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="system-info-trigger"
            aria-label="系统信息"
            onClick={() => setSystemInfo(true)}
          >
            <Avatar size="small" />
            <span>系统信息</span>
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu"
            ref={menuButton}
            aria-label={mobileNav ? "关闭导航" : "打开导航"}
            aria-expanded={mobileNav}
            aria-controls="workspace-sidebar"
            onClick={() => {
              if (mobileNav) {
                closeNavigation();
                return;
              }
              setMobileNav(true);
            }}
            onKeyDown={(event) => {
              if (mobileNav && event.key === "Escape") closeNavigation();
            }}
          >
            <Menu size={21} />
          </button>
          <div className="topbar-actions">
            <span
              className={`server-indicator ${connection === "live" ? "live" : ""}`}
            >
              <i />
              {connection === "live"
                ? "实时同步"
                : connection === "polling"
                  ? "定时同步"
                  : connection === "stale"
                    ? "状态同步中断"
                    : "连接服务中"}
            </span>
            <button
              className="help-button"
              onClick={() => setHelp(true)}
              aria-label="使用说明"
            >
              <CircleHelp size={18} />
              <span>使用说明</span>
            </button>
          </div>
        </header>
        <main id="main-content" ref={mainContent} tabIndex={-1}>
          {error && (
            <div className="global-error">
              <Radio size={17} />
              <span>服务连接异常：{error}</span>
              <button onClick={() => void refresh()}>
                <RefreshCw size={14} />
                重试
              </button>
            </div>
          )}
          {connection === "stale" && state && (
            <div className="notice notice-pink" role="status">
              <Radio size={17} />
              <span>
                状态同步中断。当前显示上次收到的状态，后台运行可能仍在继续。
              </span>
            </div>
          )}
          {state?.stopUnconfirmed && (
            <div className="critical-banner" role="alert">
              <OctagonX size={21} />
              <div>
                <strong>停止未确认</strong>
                <span>
                  后台已停止调度，但尚未收到设备归零确认。请检查设备，重新连接后完成清理。
                </span>
              </div>
            </div>
          )}
          {state ? (
            <>
              {page === "console" && (
                <ConsolePage
                  state={state}
                  action={action}
                  pending={pending > 0}
                  onNavigateAI={() =>
                    navigate(
                      state.owner === "roleplay"
                        ? "roleplay"
                        : state.locked
                          ? "locked-task"
                          : "ai-control",
                    )
                  }
                />
              )}
              {page === "ai-control" && (
                <AiControlPage
                  state={state}
                  action={action}
                  pending={pending > 0}
                />
              )}
              {page === "locked-task" && (
                <LockedTaskPage
                  state={state}
                  action={action}
                  pending={pending > 0}
                />
              )}
              {page === "roleplay" && (
                <Suspense
                  fallback={
                    <div className="app-loading">正在打开情景演绎…</div>
                  }
                >
                  <RoleplayPage state={state} action={action} />
                </Suspense>
              )}
              {page === "settings" && (
                <SettingsPage
                  settings={state.settings}
                  aiRuntime={state.aiRuntime}
                  active={active}
                  stopping={state.stopping}
                  locked={state.locked}
                  action={action}
                  pending={pending > 0}
                />
              )}
            </>
          ) : (
            <div className="app-loading">
              <span className="loading-brand">
                <AudioLines size={35} />
              </span>
              <h1>星涟联动</h1>
              <p>{error ? "还没有连上本地服务" : "正在打开你的控制空间…"}</p>
              {error ? (
                <button
                  className="button primary"
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={16} />
                  重新连接
                </button>
              ) : (
                <LoaderCircle size={23} className="spin" />
              )}
              <small>请保持本地后台服务运行</small>
            </div>
          )}
        </main>
      </div>
      <div className={`emergency-bar ${state?.locked ? "is-locked" : ""}`}>
        <div className="emergency-status">
          <span className={`status-dot ${active ? "online" : ""}`} />
          <div>
            <strong>
              {state?.locked
                ? "上锁任务执行中"
                : active && state
                  ? `${ownerNames[state.owner]}${state.run?.status === "paused" ? "已暂停" : "运行中"}`
                  : "当前待机"}
            </strong>
            {active && state?.run && (
              <span>
                {state.run.deadlineAt === null ? (
                  "无限时联动"
                ) : (
                  <Countdown deadline={state.run.deadlineAt} />
                )}
              </span>
            )}
          </div>
          {state?.locked && <LockKeyhole size={15} />}
        </div>
        <button
          className="emergency-button"
          aria-label="紧急停止"
          disabled={emergencyPending}
          onClick={() => void emergency()}
        >
          <OctagonX size={21} />
          <span>
            {emergencyPending || state?.stopping ? "正在停止…" : "紧急停止"}
          </span>
        </button>
      </div>
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <OctagonX size={18} /> : <Check size={18} />}
          <span>{toast.text}</span>
          <IconButton label="关闭提示" onClick={dismissToast}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      {systemInfo && (
        <Modal title="系统信息" onClose={() => setSystemInfo(false)}>
          <div className="system-info">
            <div className="system-info-summary">
              <span className="system-info-mark">
                <AudioLines size={28} />
              </span>
              <div>
                <h3>星涟联动</h3>
                <p>COYOTE LINK STUDIO</p>
              </div>
              <Badge color="pink">v{appVersion}</Badge>
            </div>
            <p className="system-info-description">
              本地运行的设备联动控制台，支持波形编排、AI 控制和 AI 上锁任务。
            </p>
            <dl className="system-info-details">
              <dt>作者</dt>
              <dd>秋玌</dd>
              <dt>QQ 群</dt>
              <dd>828484276</dd>
              <dt>GitHub 仓库</dt>
              <dd>
                <a
                  href="https://github.com/qiu233333/coyote-link-studio"
                  aria-label="GitHub 仓库（在新窗口打开）"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>github.com/qiu233333/coyote-link-studio</span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </a>
              </dd>
              <dt>运行方式</dt>
              <dd>本地运行 · 数据留在身边</dd>
            </dl>
            <p className="system-info-note">
              欢迎加入 QQ 群交流，或前往 GitHub 仓库查看更新、反馈问题。
            </p>
          </div>
          <button
            className="button primary full"
            onClick={() => setSystemInfo(false)}
          >
            知道了
          </button>
        </Modal>
      )}
      {help && (
        <Modal title="使用说明" onClose={() => setHelp(false)}>
          <div className="help-steps">
            <div>
              <span>01</span>
              <p>
                <strong>连接设备</strong>在控制台打开连接管理，使用官方 APP
                扫码。可选择模拟设备试用。
              </p>
            </div>
            <div>
              <span>02</span>
              <p>
                <strong>设置输出</strong>
                在实时控制中分别选择 A/B
                的波形和目标强度。播放时修改立即生效，暂停时只更新设置。
              </p>
            </div>
            <div>
              <span>03</span>
              <p>
                <strong>配置 AI</strong>
                在系统设置中保存并测试模型接口，启动联动前确认设备的控制范围。
              </p>
            </div>
          </div>
          <div className="notice notice-pink">
            <ShieldCheck size={18} />
            <span>
              紧急停止独立于模型。关闭网页后后台仍继续运行，停止服务会中断任务。
            </span>
          </div>
          <button
            className="button primary full"
            onClick={() => setHelp(false)}
          >
            知道了
          </button>
        </Modal>
      )}
    </div>
  );
}

function Countdown({ deadline }: { deadline: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>剩余 {duration(timeLeft(deadline))}</>;
}
