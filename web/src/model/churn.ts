import type { Table } from "apache-arrow";
import { api, col, filterParams } from "../api/client";
import type { App } from "../app";
import { type DecodedEvents, type FileRec, FileTree } from "./filetree";
import type { SyncLayer } from "./sync";

/**
 * The treemap's lines-changed view: every text file changed from the range start (the brush's
 * first step, or the first commit) to the cursor, sized by lines added plus deleted, including
 * files deleted since. Loaded from /churn on a jump; while playing it adds up the same /events
 * rows the file tree applies.
 */
export class ChurnTree implements SyncLayer {
  readonly tree: FileTree;

  constructor(private app: App) {
    this.tree = new FileTree(app.paths);
  }

  private wanted(): boolean {
    const s = this.app.store.get();
    return !s.compare && s.settings.treemapMeasure === "churn";
  }

  /** The window starts after this step. */
  from(): number {
    return (this.app.store.get().brush?.[0] ?? 0) - 1;
  }

  key(): string {
    return this.wanted() ? `churn|${this.from()}` : "";
  }

  snapshot(step: number): Promise<Table> {
    const p = filterParams(this.app.store.get());
    p.set("from", String(this.from()));
    p.set("to", String(step));
    return api.churn(this.app.repo, p);
  }

  chunk(): Promise<null> {
    return Promise.resolve(null);
  }

  load(data: unknown, step: number) {
    const t = data as Table;
    const id = col(t, "path_id");
    const adds = col(t, "adds");
    const dels = col(t, "dels");
    const last = col(t, "last_step");
    this.tree.clear();
    for (let i = 0; i < id.length; i++) this.tree.set(rec(id[i], adds[i], dels[i], last[i]));
    this.tree.step = step;
  }

  apply(_data: unknown, ptr: number): number {
    return ptr;
  }

  events(ev: DecodedEvents, from: number, to: number) {
    const start = this.from();
    for (let i = from; i < to; i++) {
      if (ev.step[i] <= start || ev.binary[i] === 1 || !(ev.adds[i] + ev.dels[i])) continue;
      const pid = ev.pathId[i];
      const f = this.tree.files.get(pid);
      this.tree.set(rec(pid, (f?.adds ?? 0) + ev.adds[i], (f?.dels ?? 0) + ev.dels[i], ev.step[i]));
    }
    if (to > from) this.tree.step = ev.step[to - 1];
  }

  clear() {
    this.tree.clear();
  }
}

function rec(pathId: number, adds: number, dels: number, last: number): FileRec {
  return {
    pathId, lines: adds + dels, bytes: 0, mot: 0, topAuthor: -1, topShare: 0, binary: false,
    touched: last, edited: last, lastAdds: 0, lastDels: 0, adds, dels,
  };
}
