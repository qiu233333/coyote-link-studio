import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  AudioLines,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  Command,
  Heart,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  OctagonX,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wifi,
  X,
} from "lucide-react";
import ConsolePage from "./ConsolePage";
import { AiControlPage, LockedTaskPage } from "./AiPages";
import SettingsPage from "./SettingsPage";
import { duration, isActive, ownerNames, timeLeft, useAppState } from "./api";
import { Avatar, Badge, IconButton, Modal } from "./ui";
import { version as appVersion } from "../package.json";

type Page = "console" | "ai-control" | "locked-task" | "settings";
const pages = [
  { id: "console", label: "控制台", en: "Console", icon: LayoutDashboard },
  { id: "ai-control", label: "AI 控制", en: "AI Control", icon: Bot },
  {
    id: "locked-task",
    label: "AI 上锁任务",
    en: "Locked Tasks",
    icon: LockKeyhole,
  },
  { id: "settings", label: "系统设置", en: "Settings", icon: Settings2 },
] as const;

export default function App() {
  const {
    state,
    connection,
    error,
    toast,
    pending,
    action,
    refresh,
    dismissToast,
  } = useAppState();
  const [page, setPage] = useState<Page>("console");
  const [mobileNav, setMobileNav] = useState(false);
  const [help, setHelp] = useState(false);
  const [systemInfo, setSystemInfo] = useState(false);
  const [, tick] = useState(0);
  const [emergencyPending, setEmergencyPending] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const navigate = (to: Page) => {
    setPage(to);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: "instant" });
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
  const currentPage = pages.find((p) => p.id === page)!;

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="star-field" />
      {mobileNav && (
        <div className="nav-scrim" onClick={() => setMobileNav(false)} />
      )}
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
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
            <strong>
              星涟联动<span>✦</span>
            </strong>
            <small>COYOTE LINK STUDIO</small>
          </span>
        </a>
        <div className="sidebar-label">
          WORKSPACE <span>你的控制空间</span>
        </div>
        <nav className="main-nav" aria-label="主要模块">
          {pages.map((item, i) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => navigate(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={20} />
              <span>
                {item.label}
                <small>{item.en}</small>
              </span>
              {item.id === "locked-task" && state?.locked ? (
                <LockKeyhole className="nav-lock" size={13} />
              ) : page === item.id ? (
                <span className="nav-active-dot" />
              ) : (
                <span className="nav-index">0{i + 1}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-companion">
          <span className="companion-sparkle">✧</span>
          <Avatar size="large" />
          <Badge color="pink">YOUR LITTLE CO-PILOT</Badge>
          <strong>星涟一直在这里</strong>
          <p>
            每一次变化，
            <br />
            都从你的选择开始。
          </p>
          <button onClick={() => navigate("ai-control")}>
            一起探索 <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <span>
            <i />
            本地运行 · 数据留在身边
          </span>
          <div>
            <small>COYOTE LINK · v{appVersion}</small>
            <button
              className="system-info-trigger"
              aria-label="系统信息"
              title="系统信息"
              onClick={() => setSystemInfo(true)}
            >
              <CircleHelp size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{currentPage.label}</strong>
          </div>
          <div className="topbar-actions">
            <span
              className={`server-indicator ${connection === "live" ? "live" : ""}`}
            >
              <i />
              {connection === "live"
                ? "实时同步"
                : connection === "polling"
                  ? "轮询同步"
                  : "连接服务中"}
            </span>
            <span className="topbar-divider" />
            <button
              className="help-button"
              onClick={() => setHelp(true)}
              aria-label="使用说明"
            >
              <CircleHelp size={18} />
            </button>
            <span className="user-orb">
              <Sparkles size={17} />
            </span>
          </div>
        </header>
        <main id="main-content">
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
                    navigate(state.locked ? "locked-task" : "ai-control")
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
              {page === "settings" && (
                <SettingsPage
                  state={state}
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
        <footer className="app-footer">
          <span>
            MADE FOR YOUR OWN RHYTHM <Heart size={10} />
          </span>
          <span>
            <ShieldCheck size={12} />
            本机控制 · 明确边界 · 随时急停
          </span>
        </footer>
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
            <span>
              {active && state?.run
                ? `剩余 ${duration(timeLeft(state.run.deadlineAt))}`
                : "设备输出以实际回传为准"}
            </span>
          </div>
          {state?.locked && <LockKeyhole size={15} />}
        </div>
        <button
          className="emergency-button"
          disabled={emergencyPending}
          onClick={() => void emergency()}
        >
          <OctagonX size={21} />
          <span>
            {emergencyPending || state?.stopping ? "正在停止…" : "紧急停止"}
            <small>清队列 · 双通道归零</small>
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
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="modal glass-card"
            role="dialog"
            aria-modal="true"
            aria-label="使用说明"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-heading">
              <h2>欢迎来到星涟联动</h2>
              <IconButton label="关闭使用说明" onClick={() => setHelp(false)}>
                <X size={18} />
              </IconButton>
            </div>
            <div className="help-steps">
              <div>
                <span>01</span>
                <p>
                  <strong>连接设备</strong>在控制台打开连接管理，使用官方 APP
                  扫码。也可先使用模拟设备熟悉功能。
                </p>
              </div>
              <div>
                <span>02</span>
                <p>
                  <strong>划定边界</strong>
                  确认设备回传的 A/B
                  上限，分别设置各通道的强度、波形与播放方式。AI
                  模块需先配置兼容接口，再分别确认 A/B 控制范围。
                </p>
              </div>
              <div>
                <span>03</span>
                <p>
                  <strong>选一种节奏</strong>手动编排、可随时接管的 AI
                  控制，或确认后冻结范围的 AI 上锁任务。
                </p>
              </div>
            </div>
            <div className="notice notice-pink">
              <ShieldCheck size={18} />
              <span>
                紧急停止不依赖模型。关闭网页后后台仍继续运行；停止服务后不会自动恢复任务。
              </span>
            </div>
            <button
              className="button primary full"
              onClick={() => setHelp(false)}
            >
              开始探索
              <ArrowUpRight size={15} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
