import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat, canEncodeVideo } from "mediabunny";
import { clock } from "../clock";
import { CanvasPainter } from "../paint/canvas";
import type { Dashboard } from "../ui/dashboard";
import { fmt, h } from "../ui/dom";
import { popover } from "../ui/popover";
import { type Target, download, fileBase, frameSize, paintFrame } from "./snapshot";

export interface RenderSpec {
  target: Target;
  /** Video length in seconds (the steps in range are spread evenly over it). */
  duration: number;
  fps: number;
  /** Output pixels per CSS pixel of the on-screen layout. */
  scale: number;
  /** Step range; defaults to the brush or the whole history. */
  from?: number;
  to?: number;
  /** Seconds to hold the final frame. */
  hold?: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Deterministic frame loop: for each frame, move the cursor, wait until the file state has
 * caught up, and paint into an offscreen canvas. Virtual time keeps eased motion frame-exact.
 */
export async function renderFrames(
  d: Dashboard,
  spec: RenderSpec,
  onFrame: (canvas: OffscreenCanvas, index: number, total: number) => Promise<void>,
  cancelled: () => boolean = () => false,
) {
  const { app } = d;
  const s0 = app.store.get();
  const [a, b] = [spec.from ?? s0.brush?.[0] ?? 0, spec.to ?? s0.brush?.[1] ?? s0.steps - 1];
  const { w, h } = frameSize(d, spec.target);
  const W = even(w * spec.scale);
  const H = even(h * spec.scale);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d")!;
  const moving = Math.max(1, Math.round(spec.duration * spec.fps));
  const total = moving + Math.round((spec.hold ?? 1) * spec.fps);
  app.player.pause();
  app.exportRate = (b - a + 1) / Math.max(0.1, spec.duration);
  const prev = { cursor: s0.cursor, pos: s0.pos };
  clock.set(0);
  try {
    for (let i = 0; i < total && !cancelled(); i++) {
      clock.set((i * 1000) / spec.fps);
      const pos = Math.min(b, a + (Math.min(i, moving - 1) / Math.max(1, moving - 1)) * (b - a));
      const cursor = Math.floor(pos);
      app.store.set({ pos, cursor, playing: i < moving - 1 });
      await app.sync.settle(cursor);
      const p = new CanvasPainter(ctx, W / spec.scale, H / spec.scale, spec.scale);
      paintFrame(d, spec.target, p);
      await onFrame(canvas, i, total);
    }
  } finally {
    clock.release();
    app.exportRate = null;
    app.store.set({ playing: false, cursor: prev.cursor, pos: prev.pos });
    void app.sync.goto(prev.cursor);
    Object.values(d.views).forEach((v) => v.invalidate());
  }
  return { width: W, height: H, frames: total };
}

/** MP4 (H.264) via WebCodecs, falling back to WebM (VP9) where AVC encoding is unavailable. */
export async function encodeVideo(d: Dashboard, spec: RenderSpec, progress: (f: number) => void, cancelled: () => boolean): Promise<{ blob: Blob; ext: string }> {
  const { w, h } = frameSize(d, spec.target);
  const W = even(w * spec.scale);
  const H = even(h * spec.scale);
  const avc = await canEncodeVideo("avc", { width: W, height: H }).catch(() => false);
  const output = new Output({ format: avc ? new Mp4OutputFormat() : new WebMOutputFormat(), target: new BufferTarget() });
  let source: CanvasSource | null = null;
  await renderFrames(d, spec, async (canvas, i, total) => {
    if (!source) {
      source = new CanvasSource(canvas, { codec: avc ? "avc" : "vp9", quality: QUALITY_HIGH });
      output.addVideoTrack(source, { frameRate: spec.fps });
      await output.start();
    }
    await source.add(i / spec.fps, 1 / spec.fps);
    progress((i + 1) / total);
  }, cancelled);
  await output.finalize();
  const buf = (output.target as BufferTarget).buffer!;
  return { blob: new Blob([buf], { type: avc ? "video/mp4" : "video/webm" }), ext: avc ? "mp4" : "webm" };
}

/** Animated GIF (per-frame 256-color palette). Keep it small: GIFs grow fast. */
export async function encodeGif(d: Dashboard, spec: RenderSpec, progress: (f: number) => void, cancelled: () => boolean): Promise<Blob> {
  const gif = GIFEncoder();
  const delay = Math.round(1000 / spec.fps);
  await renderFrames(d, spec, async (canvas, i, total) => {
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), canvas.width, canvas.height, { palette, delay });
    progress((i + 1) / total);
    if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }, cancelled);
  gif.finish();
  return new Blob([gif.bytes().slice()], { type: "image/gif" });
}

export function openVideoDialog(d: Dashboard, anchor: HTMLElement, target: Target) {
  const s = d.app.store.get();
  const [a, b] = s.brush ?? [0, s.steps - 1];
  const format = h("select", {}, h("option", { value: "mp4", text: "MP4 video" }), h("option", { value: "gif", text: "GIF (small)" }));
  const duration = h("input", { type: "number", min: "2", max: "600", value: "20", style: "width:80px" });
  const fps = h("select", {}, ...[15, 24, 30, 60].map((v) => h("option", { value: String(v), text: `${v} fps` })));
  fps.value = "30";
  const scale = h("select", {}, h("option", { value: "1", text: "1× (screen size)" }), h("option", { value: "1.5", text: "1.5×" }), h("option", { value: "2", text: "2× (sharp)" }));
  scale.value = "1";
  const status = h("div", { class: "muted num" });
  const fill = h("div", { class: "bar-fill", style: "width:0%" });
  const go = h("button", { class: "btn primary", text: "Render" });
  let cancel = false;
  const stop = h("button", { class: "btn", text: "Cancel" });
  stop.addEventListener("click", () => (cancel = true));
  const size = () => {
    const { w, h: hh } = frameSize(d, target);
    const k = Number(scale.value);
    status.textContent = `${fmt.int(b - a + 1)} commits (#${fmt.int(a + 1)}–#${fmt.int(b + 1)}) · ${even(w * k)}×${even(hh * k)} px`;
  };
  scale.addEventListener("change", size);
  size();
  go.addEventListener("click", async () => {
    go.disabled = true;
    cancel = false;
    const spec: RenderSpec = { target, duration: Number(duration.value) || 20, fps: Number(fps.value), scale: Number(scale.value), from: a, to: b };
    const prog = (f: number) => {
      fill.style.width = `${(f * 100).toFixed(1)}%`;
      status.textContent = `Rendering… ${Math.round(f * 100)}%`;
    };
    try {
      const t0 = performance.now();
      if (format.value === "gif") {
        // GIF: cap the size and frame rate.
        const { w } = frameSize(d, target);
        spec.scale = Math.min(spec.scale, 720 / w);
        spec.fps = Math.min(spec.fps, 15);
        const blob = await encodeGif(d, spec, prog, () => cancel);
        if (!cancel) download(blob, `${fileBase(d, target)}.gif`);
      } else {
        const { blob, ext } = await encodeVideo(d, spec, prog, () => cancel);
        if (!cancel) download(blob, `${fileBase(d, target)}.${ext}`);
      }
      status.textContent = cancel ? "Cancelled" : `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    } catch (e) {
      status.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      go.disabled = false;
    }
  });
  popover(anchor, h("div", {},
    h("h3", { text: "Record playback" }),
    h("label", { class: "row" }, h("span", { text: "Format" }), format),
    h("label", { class: "row" }, h("span", { text: "Length (s)" }), duration),
    h("label", { class: "row" }, h("span", { text: "Frame rate" }), fps),
    h("label", { class: "row" }, h("span", { text: "Resolution" }), scale),
    h("div", { class: "bar-track" }, fill),
    status,
    h("div", { style: "display:flex;gap:8px;margin-top:8px" }, go, stop),
    h("div", { class: "muted", style: "margin-top:8px", text: "Uses the selected range (or all history). For batch or unattended renders use `strata render`." }),
  ), 320);
}

/** Headless mode (`strata render`): fetch the job spec, stream PNG frames to the server. */
export async function runHeadlessRender(d: Dashboard, token: string) {
  const base = `/api/render/${token}`;
  const post = (path: string, body?: BodyInit) => fetch(`${base}${path}`, { method: "POST", body });
  try {
    const job = (await (await fetch(base)).json()) as { spec: RenderSpec; settings?: Record<string, unknown> };
    if (job.settings) d.app.store.setSettings(job.settings);
    // Let the charts fetch and the first layout settle.
    await d.app.sync.settle(d.app.store.get().cursor);
    await new Promise((r) => setTimeout(r, 1500));
    await renderFrames(d, job.spec, async (canvas, i, total) => {
      const png = await canvas.convertToBlob({ type: "image/png" });
      const r = await post(`/frame?i=${i}&total=${total}`, png);
      if (!r.ok) throw new Error(`frame ${i}: ${r.status}`);
    });
    await post("/done");
  } catch (e) {
    await post("/error", e instanceof Error ? e.message : String(e));
  }
}
