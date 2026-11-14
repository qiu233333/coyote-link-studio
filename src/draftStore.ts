export type DraftStatus =
  "empty" | "saving" | "saved" | "error" | "invalid" | "conflict";
export type Decoder<T> = (data: unknown) => T | undefined;
type DraftView<T> = {
  value?: T;
  status: DraftStatus;
  revision: number;
  deleted?: boolean;
};
type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class DraftCell<T> {
  private raw: string | null | undefined;
  private timer?: ReturnType<typeof setTimeout>;
  private pending = false;
  private tombstonePending = false;
  private listeners = new Set<() => void>();
  private view: DraftView<T> = { status: "empty", revision: 0 };

  constructor(
    readonly key: string,
    private storage: () => StorageAccess,
    private decode: Decoder<T>,
  ) {
    this.reload();
  }
  snapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<DraftView<T>>) {
    this.view = { ...this.view, ...change };
    for (const listener of this.listeners) listener();
  }
  private read(raw: string | null) {
    if (raw === null) return { status: "empty" } as const;
    try {
      const envelope = JSON.parse(raw);
      if (envelope?.version === 1 && typeof envelope.id === "string") {
        if (envelope.deleted === true)
          return { status: "empty", deleted: true } as const;
        const value = this.decode(envelope.value);
        if (value !== undefined) return { status: "saved", value } as const;
      }
    } catch {
      // The stored copy stays in place until the user chooses to edit or discard.
    }
    return { status: "invalid" } as const;
  }
  private accept(raw: string | null) {
    clearTimeout(this.timer);
    this.raw = raw;
    this.pending = false;
    this.publish({
      value: undefined,
      deleted: false,
      ...this.read(raw),
      revision: this.view.revision + 1,
    });
  }
  reload = () => {
    if (this.view.deleted) return;
    try {
      this.accept(this.storage().getItem(this.key));
    } catch {
      this.publish({ status: "error" });
    }
  };
  externalChange() {
    if (this.view.deleted) return;
    try {
      const raw = this.storage().getItem(this.key);
      if (raw === this.raw) return;
      const remote = this.read(raw);
      if (remote.status === "empty" && "deleted" in remote && remote.deleted)
        this.accept(raw);
      else if (this.pending || this.view.value !== undefined)
        this.publish({ status: "conflict" });
      else this.accept(raw);
    } catch {
      this.publish({ status: "error" });
    }
  }
  write(value: T | undefined, revision?: number) {
    if (
      this.view.deleted ||
      (revision !== undefined && revision !== this.view.revision)
    )
      return false;
    if (Object.is(value, this.view.value) && this.view.status !== "invalid")
      return true;
    this.pending = true;
    const conflict = this.view.status === "conflict";
    this.publish({
      value,
      revision: this.view.revision + 1,
      status: conflict ? "conflict" : "saving",
    });
    clearTimeout(this.timer);
    if (!conflict) this.timer = setTimeout(this.flush, 250);
    return true;
  }
  flush = () => {
    clearTimeout(this.timer);
    if (this.tombstonePending) this.saveTombstone();
    else if (this.pending && this.view.status !== "conflict") this.save(false);
  };
  retry = () => {
    if (this.pending || this.tombstonePending) this.flush();
    else this.reload();
  };
  private save(overwrite: boolean) {
    try {
      const storage = this.storage();
      const current = storage.getItem(this.key);
      const remote = this.read(current);
      if (remote.status === "empty" && "deleted" in remote && remote.deleted) {
        this.accept(current);
        return;
      }
      if (!overwrite && current !== (this.raw ?? null)) {
        this.publish({ status: "conflict" });
        return;
      }
      const value = this.view.value;
      const safeValue = value === undefined ? undefined : this.decode(value);
      if (value !== undefined && safeValue === undefined)
        throw new Error("草稿格式无法保存。");
      const raw =
        safeValue === undefined
          ? null
          : JSON.stringify({
              version: 1,
              id: crypto.randomUUID(),
              value: safeValue,
            });
      if (raw === null) storage.removeItem(this.key);
      else storage.setItem(this.key, raw);
      this.raw = raw;
      this.pending = false;
      this.publish({ status: raw === null ? "empty" : "saved" });
    } catch {
      this.publish({ status: "error" });
    }
  }
  keepMine = () => this.save(true);
  discard = () => {
    if (this.write(undefined)) this.flush();
  };
  /** A confirmed deletion on the server invalidates pending edits in every tab. */
  deleteEntity() {
    clearTimeout(this.timer);
    const raw = JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      deleted: true,
    });
    this.accept(raw);
    this.tombstonePending = true;
    this.saveTombstone();
  }
  private saveTombstone() {
    try {
      this.storage().setItem(this.key, this.raw!);
      this.tombstonePending = false;
      this.publish({ status: "empty" });
    } catch {
      this.publish({ status: "error" });
    }
  }
}

export class DraftStore {
  private cells = new Map<string, DraftCell<unknown>>();
  private prefix: string;
  constructor(
    scope: string,
    private storage: () => StorageAccess,
  ) {
    this.prefix = `coyote:draft:${encodeURIComponent(scope)}:`;
  }
  cell<T>(key: string, decode: Decoder<T>): DraftCell<T> {
    const path = this.prefix + key;
    let cell = this.cells.get(path);
    if (!cell) {
      cell = new DraftCell(path, this.storage, decode);
      this.cells.set(path, cell);
    }
    return cell as DraftCell<T>;
  }
  storageChanged(key: string | null) {
    if (key === null)
      for (const cell of this.cells.values()) cell.externalChange();
    else this.cells.get(key)?.externalChange();
  }
  flush = () => {
    for (const cell of this.cells.values()) cell.flush();
  };
  preference<T>(key: string, decode: Decoder<T>, fallback: T): T {
    // Navigation belongs to the current tab. Restore only when it opens.
    return (
      new DraftCell(this.prefix + "nav:" + key, this.storage, decode).snapshot()
        .value ?? fallback
    );
  }
  setPreference<T>(key: string, value: T) {
    const cell = new DraftCell<T>(
      this.prefix + "nav:" + key,
      this.storage,
      (value) => value as T,
    );
    cell.write(value);
    cell.flush();
  }
}
