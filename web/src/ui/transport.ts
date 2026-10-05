import { api, col, filterParams } from "../api/client";
import type { App } from "../app";
import { CanvasPainter } from "../paint/canvas";
import type { PlayMode } from "../state/store";
import { palette } from "../theme";
import { fmt, h, icon } from "./dom";

/** Play/pause, stepping, speed, loop, a full-history scrubber, and the current commit. */
export class Transport {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private scrub: HTMLCanvasElement;
  private what: HTMLElement;
  private date: HTMLElement;
  private churn: Float64Array | null = null;
  private churnKey = "";
  private summaryTimer = 0;
  private lastSummaryAt = 0;
  private speedInput: HTMLInputElement;
  private modeSel: HTMLSelectElement;
  private loopBtn: HTMLButtonElement;

  constructor(private app: App) {
    const store = app.store;
    this.playBtn = h("button", { class: "btn icon", title: "Play / pause (Space)", "aria-label": "Play" }, icon("play"));
    this.playBtn.addEventListener("click", () => app.player.toggle());
    const prev = h("button", { class: "btn icon", title: "Previous commit (←)", "aria-label": "Previous commit" }, icon("prev"));
    prev.addEventListener("click", () => app.player.seek(store.get().cursor - 1));
    const next = h("button", { class: "btn icon", title: "Next commit (→)", "aria-label": "Next commit" }, icon("next"));
    next.addEventListener("click", () => app.player.seek(store.get().cursor + 1));
    this.loopBtn = h("button", { class: "btn icon", title: "Loop", "aria-label": "Loop" }, icon("loop"));
    this.loopBtn.addEventListener("click", () => store.setSettings({ loop: !store.get().settings.loop }));
    this.modeSel = h("select", { "aria-label": "Playback mode", title: "Playback mode" },
      h("option", { value: "fixed", text: "fixed length" }),
      h("option", { value: "commits", text: "commits / s" }),
      h("option", { value: "calendar", text: "days / s" }),
    );
    this.modeSel.addEventListener("change", () => store.setSettings({ playMode: this.modeSel.value as PlayMode }));
    this.speedInput = h("input", { type: "number", min: "0.1", step: "any", style: "width:74px", "aria-label": "Speed" });
    this.speedInput.addEventListener("change", () => {
      const v = Math.max(0.1, Number(this.speedInput.value) || 1);
      const mode = store.get().settings.playMode;
      store.setSettings(mode === "fixed" ? { fixedSeconds: v } : mode === "commits" ? { commitsPerSec: v } : { daysPerSec: v });
    });
    this.scrub = h("canvas", { "aria-label": "Timeline scrubber", role: "slider", tabindex: 0 });
    this.what = h("span", { class: "what" });
    this.date = h("span", { class: "date muted num" });
    const now = h("div", { class: "now", title: "Open commit details", role: "button", tabindex: 0 }, this.date, this.what);
    now.style.cursor = "pointer";
    now.addEventListener("click", () => app.openCommit(store.get().cursor));
    this.el = h("footer", { class: "transport" },
      h("div", { class: "ctl" }, prev, this.playBtn, next, this.loopBtn, this.modeSel, this.speedInput),
      h("div", { class: "scrub" }, this.scrub),
      now,
    );
    this.scrub.addEventListener("pointerdown", (e) => {
      this.scrub.setPointerCapture(e.pointerId);
      const seek = (ev: PointerEvent) => {
        const r = this.scrub.getBoundingClientRect();
        const t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        app.player.seek(Math.round(t * (store.get().steps - 1)));
      };
      seek(e);
      const move = (ev: PointerEvent) => seek(ev);
      const up = () => {
        this.scrub.removeEventListener("pointermove", move);
        this.scrub.removeEventListener("pointerup", up);
      };
      this.scrub.addEventListener("pointermove", move);
      this.scrub.addEventListener("pointerup", up);
    });
    new ResizeObserver(() => this.drawScrub()).observe(this.scrub);
    store.watch((s) => [s.playing, s.settings.loop, s.settings.playMode, s.settings.fixedSeconds, s.settings.commitsPerSec, s.settings.daysPerSec], () => this.syncControls(), true);
    store.watch((s) => [s.cursor, s.brush, s.search?.steps.length, s.compare, s.settings.theme], () => {
      this.drawScrub();
      this.scheduleSummary();
    });
    store.watch((s) => s.filterRev, () => this.loadChurn());
    this.loadChurn();
    this.scheduleSummary();
  }

  private syncControls() {
    const s = this.app.store.get();
    this.playBtn.replaceChildren(icon(s.playing ? "pause" : "play"));
    this.playBtn.setAttribute("aria-label", s.playing ? "Pause" : "Play");
    this.loopBtn.classList.toggle("on", s.settings.loop);
    this.modeSel.value = s.settings.playMode;
    const st = s.settings;
    this.speedInput.value = String(st.playMode === "fixed" ? st.fixedSeconds : st.playMode === "commits" ? st.commitsPerSec : st.daysPerSec);
    this.speedInput.title = st.playMode === "fixed" ? "Total run length in seconds" : st.playMode === "commits" ? "Commits per second" : "Days of history per second";
  }

  /** Churn sparkline for the whole history, one bin per scrubber pixel. */
  private loadChurn() {
    const s = this.app.store.get();
    const w = Math.max(50, Math.floor(this.scrub.getBoundingClientRect().width || 600));
    const p = filterParams(s);
    p.set("axis", "index");
    p.set("lo", "0");
    p.set("hi", String(s.steps));
    p.set("bins", String(Math.min(w, s.steps)));
    const key = p.toString();
    if (key === this.churnKey) return;
    this.churnKey = key;
    api.bars(this.app.repo, p).then((t) => {
      const bins = Math.min(w, s.steps);
      const out = new Float64Array(bins);
      const b = col(t, "bin");
      const a = col(t, "adds");
      const d = col(t, "dels");
      for (let i = 0; i < b.length; i++) out[b[i]] = a[i] + d[i];
      this.churn = out;
      this.drawScrub();
    }).catch(() => {});
  }

  private drawScrub() {
    const r = this.scrub.getBoundingClientRect();
    if (r.width < 2) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (this.scrub.width !== Math.round(r.width * dpr)) {
      this.scrub.width = Math.round(r.width * dpr);
      this.scrub.height = Math.round(r.height * dpr);
      this.loadChurn();
    }
    const p = new CanvasPainter(this.scrub.getContext("2d")!, r.width, r.height, dpr);
    const pal = palette();
    const s = this.app.store.get();
    const n = Math.max(1, s.steps);
    const x = (step: number) => ((step + 0.5) / n) * r.width;
    p.clear(pal.surface);
    const mid = r.height - 10;
    p.roundRect(0, mid - 1, r.width, 3, [1.5, 1.5, 1.5, 1.5], pal.surface3);
    if (this.churn) {
      let max = 1;
      for (const v of this.churn) max = Math.max(max, Math.sqrt(v));
      const bw = r.width / this.churn.length;
      for (let i = 0; i < this.churn.length; i++) {
        const hh = (Math.sqrt(this.churn[i]) / max) * (mid - 6);
        if (hh > 0.3) p.rect(i * bw, mid - 2 - hh, Math.max(1, bw - (bw > 3 ? 1 : 0)), hh, pal.inkMuted, 0.45);
      }
    }
    if (s.brush) {
      const x0 = x(s.brush[0]);
      const x1 = x(s.brush[1]);
      p.rect(x0, 0, x1 - x0, r.height, pal.accent, 0.1);
      p.rect(x0, mid - 1, x1 - x0, 3, pal.accent, 0.6);
    }
    for (const t of this.app.summary.tags) p.line(x(t.step), mid + 4, x(t.step), mid + 8, pal.inkMuted, 1);
    if (s.search?.steps.length) for (const st of s.search.steps) p.rect(x(st) - 0.5, mid + 3, 1, 5, pal.accent);
    if (s.compare) for (const st of [s.compare.a, s.compare.b]) p.line(x(st), 2, x(st), r.height - 2, pal.accent, 1.5);
    const cx = x(s.cursor);
    p.rect(0, mid - 1, cx, 3, pal.ink, 0.7);
    p.circle(cx, mid + 0.5, 6, pal.ink, 1, pal.surface, 2);
  }

  /** Fetch the current commit's summary (throttled during playback). */
  private scheduleSummary() {
    const s = this.app.store.get();
    const t = this.app.tl.time(s.cursor);
    this.date.textContent = `${fmt.date(t)} · #${fmt.int(s.cursor + 1)}/${fmt.int(s.steps)}`;
    clearTimeout(this.summaryTimer);
    const wait = s.playing ? Math.max(0, 250 - (performance.now() - this.lastSummaryAt)) : 120;
    this.summaryTimer = window.setTimeout(() => {
      this.lastSummaryAt = performance.now();
      const step = this.app.store.get().cursor;
      api.stepBrief(this.app.repo, step).then((d) => {
        const now = this.app.store.get();
        // While playing, a slightly stale summary beats none; when paused, only the current one.
        if (!d.commit || (!now.playing && now.cursor !== step)) return;
        const c = d.commit;
        const merged = c.side_count ? ` · merged ${fmt.int(c.side_count)} commits` : "";
        this.what.textContent = `${c.summary} — ${c.author} (+${fmt.compact(c.adds)} −${fmt.compact(c.dels)})${merged}`;
        this.what.title = c.summary;
      }).catch(() => {});
    }, wait);
  }
}
