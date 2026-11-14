import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { DraftStore, type Decoder, type DraftStatus } from "./draftStore";

const Context = createContext<DraftStore | null>(null);

export function DraftProvider({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const store = useMemo(
    () => new DraftStore(scope, () => localStorage),
    [scope],
  );
  useEffect(() => {
    const onStorage = (event: StorageEvent) => store.storageChanged(event.key);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") store.flush();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", store.flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      store.flush();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", store.flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useDraftStore() {
  const store = useContext(Context);
  if (!store) throw new Error("草稿管理尚未初始化。");
  return store;
}

export function useDraft<T>(key: string, decode: Decoder<T>) {
  const store = useDraftStore();
  const cell = store.cell(key, decode);
  const view = useSyncExternalStore(
    cell.subscribe,
    cell.snapshot,
    cell.snapshot,
  );
  useEffect(() => cell.flush, [cell]);
  return { ...view, cell };
}

export function useEditorPreference<T>(
  key: string,
  decode: Decoder<T>,
  fallback: T,
) {
  const store = useDraftStore();
  const [value, setValue] = useState(() =>
    store.preference(key, decode, fallback),
  );
  return [
    value,
    (next: T) => {
      setValue(next);
      store.setPreference(key, next);
    },
  ] as const;
}

type DraftControlsProps = {
  status: DraftStatus;
  discard?: () => void;
  reload: () => void;
  keepMine: () => void;
  retry: () => void;
  label?: string;
};
const draftMessages: Record<DraftStatus, string> = {
  empty: "本地自动保存",
  saving: "保存中…",
  saved: "本地草稿已保存",
  error: "本地保存失败。请保留此页面并重试。",
  invalid: "本地草稿已损坏或版本不受支持，可继续编辑或丢弃。",
  conflict: "其他标签页已更新此草稿。请选择要保留的版本。",
};
export function DraftControls({
  status,
  discard,
  reload,
  keepMine,
  retry,
  label = "丢弃草稿",
}: DraftControlsProps) {
  return (
    <div
      className={`draft-controls ${["error", "invalid", "conflict"].includes(status) ? "draft-attention" : ""}`}
    >
      <span role="status">{draftMessages[status]}</span>
      {status === "conflict" ? (
        <>
          <button type="button" className="text-button" onClick={reload}>
            载入其他标签页版本
          </button>
          <button type="button" className="text-button" onClick={keepMine}>
            保存当前版本
          </button>
        </>
      ) : (
        <>
          {status === "error" && (
            <button type="button" className="text-button" onClick={retry}>
              重试保存
            </button>
          )}
          {discard && status !== "empty" && (
            <button type="button" className="text-button" onClick={discard}>
              {label}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function DraftBar<T>({
  draft,
  label,
  disabled,
  onDiscard,
  onReload,
}: {
  draft: ReturnType<typeof useDraft<T>>;
  label?: string;
  disabled?: boolean;
  onDiscard?: () => void;
  onReload?: () => void;
}) {
  return (
    <DraftControls
      status={draft.status}
      label={label}
      discard={
        disabled
          ? undefined
          : () => {
              draft.cell.discard();
              onDiscard?.();
            }
      }
      reload={() => {
        draft.cell.reload();
        onReload?.();
      }}
      keepMine={draft.cell.keepMine}
      retry={draft.cell.retry}
    />
  );
}
