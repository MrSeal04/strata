#!/usr/bin/env node
// Smoke test: extract a fixture into a temporary cache, serve it, open the home page and the
// dashboard at desktop and phone widths, exercise every view mode, playback and zoom, the card
// header options and unlinked cards, check that phones scroll the page until a card is zoomed,
// and fail on any page, console or HTTP error.
// Usage: node tools/smoke.mjs [strata-binary] [out-dir]
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(join(root, "web/package.json"));
const puppeteer = require("puppeteer-core");

const strata = process.argv[2] ?? join(root, "target/debug/strata");
const out = process.argv[3] ?? mkdtempSync(join(tmpdir(), "strata-smoke-shots-"));
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "strata-smoke-"));
const env = { ...process.env, STRATA_HOME: home };

execFileSync("bash", [join(root, "fixtures/make.sh"), join(home, "fixtures")], { stdio: "ignore" });
execFileSync(strata, ["extract", join(home, "fixtures/kitchen"), "--progress", "none"], { env, stdio: "inherit" });

const port = 7600 + Math.floor(Math.random() * 300);
const server = spawn(strata, ["serve", "--no-open", "--port", String(port)], { env, stdio: "ignore" });
const failures = [];
try {
  await new Promise((r) => setTimeout(r, 1200));
  const { repos } = await (await fetch(`http://127.0.0.1:${port}/api/repos`)).json();
  const id = repos[0].id;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  for (const [name, url, w, h] of [
    ["home", `http://127.0.0.1:${port}/#/`, 1280, 800],
    ["dashboard-desktop", `http://127.0.0.1:${port}/#/r/${id}`, 1440, 900],
    ["dashboard-phone", `http://127.0.0.1:${port}/#/r/${id}`, 420, 1600],
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    page.on("pageerror", (e) => failures.push(`${name}: page error: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && failures.push(`${name}: console: ${m.text()}`));
    page.on("response", (r) => r.status() >= 400 && failures.push(`${name}: HTTP ${r.status()} ${r.url()}`));
    await page.goto(url, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 2000));
    if (name.startsWith("dashboard")) {
      // Exercise playback, the tree layouts and compare; everything must stay error-free.
      await page.evaluate(async () => {
        const a = window.strata.app;
        a.player.seek(0);
        a.player.play();
        await new Promise((r) => setTimeout(r, 800));
        a.player.pause();
        for (const treeLayout of ["radial", "sunburst", "icicle", "force"]) {
          a.store.setSettings({ treeLayout });
          await new Promise((r) => setTimeout(r, 200));
        }
        for (const areaSlice of ["lang", "author", "cohort", "dir"]) {
          a.store.setSettings({ areaSlice });
          await new Promise((r) => setTimeout(r, 200));
        }
        a.store.set({ compare: { a: 1, b: a.store.get().steps - 1, mode: "side" } });
        await new Promise((r) => setTimeout(r, 600));
        a.store.set({ compare: null });
        // Every way the squares can look: what they show x how they're sized x their layout.
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const colorBy of ["dir", "lang", "author", "cohort", "edited", "heat"]) {
          for (const treemapMeasure of ["size", "churn"]) {
            for (const treemapLayout of ["live", "steady"]) {
              a.store.setSettings({ colorBy, treemapMeasure, treemapLayout });
              await wait(150);
            }
          }
        }
        // Play the heaviest combination over a brushed range, then zoom everything.
        a.store.set({ brush: [2, a.store.get().steps - 1] });
        a.store.setSettings({ colorBy: "author", treemapMeasure: "churn", treemapLayout: "steady" });
        a.player.seek(2);
        a.player.play();
        await wait(800);
        a.player.pause();
        const v = window.strata.views;
        v.treemap.zoom.set(4, 60, 60);
        await wait(300);
        v.treemap.zoom.reset();
        for (const treeLayout of ["radial", "sunburst", "icicle", "force"]) {
          a.store.setSettings({ treeLayout });
          await wait(150);
          v.tree.zoom.set(3, 80, 80);
          await wait(200);
        }
        a.store.set({ brush: null });
        a.store.setSettings({ colorBy: "lang", treemapMeasure: "size", treemapLayout: "live" });
      });
      // Every option sits on its card, the gear holds only dashboard-wide ones, and unlinked
      // cards color and clip on their own (the tree handing out directory colors itself).
      const problems = await page.evaluate(async () => {
        const a = window.strata.app;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const bad = [];
        const card = (label) => document.querySelector(`.card[aria-label="${label}"] .card-head`);
        if (card("Additions and deletions per commit").querySelectorAll("select").length !== 2) bad.push("bars header should hold the scale and clip selects");
        if (![...card("File tree").querySelectorAll("button")].some((b) => b.textContent === "Actors")) bad.push("tree header should hold the Actors toggle");
        document.querySelector("[aria-label=Settings]").click();
        const panel = document.querySelector(".panel")?.textContent ?? "";
        for (const gone of ["Playback", "Tree layout", "Node budget", "Slice by"]) if (panel.includes(gone)) bad.push(`settings panel still offers ${gone}`);
        if (!panel.includes("Link shared options")) bad.push("settings panel should offer Link shared options");
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        a.store.setSettings({ linkCards: false, areaSlice: "lang", areaMode: "flow", areaClampPct: 0 });
        for (const treeColorBy of ["dir", "author", "cohort", "heat"]) {
          a.store.setSettings({ colorBy: treeColorBy === "dir" ? "lang" : "dir", treeColorBy });
          await wait(200);
        }
        const st = a.store.get().settings;
        if (st.colorBy !== "dir" || st.treeColorBy !== "heat" || st.clampPct !== 99 || st.areaClampPct !== 0) bad.push(`unlinked settings leaked across cards (${JSON.stringify(st)})`);
        a.store.setSettings({ treeLayout: "radial", actors: true, nodeBudget: 1000 });
        a.player.seek(0);
        a.player.play();
        await wait(600);
        a.player.pause();
        // (every page shares this origin's saved settings: leave the defaults behind)
        a.store.setSettings({ linkCards: true, colorBy: "lang", treeColorBy: "lang", areaSlice: "dir", areaMode: "size", clampPct: 99, treeLayout: "force", actors: false, nodeBudget: 6000 });
        return bad;
      });
      failures.push(...problems.map((p) => `${name}: ${p}`));
      await new Promise((r) => setTimeout(r, 800));
    }
    await page.screenshot({ path: join(out, `${name}.png`) });
    await page.close();
  }
  // Phones: a one-finger drag over the treemap scrolls the page until the treemap is zoomed in,
  // then it pans the treemap instead.
  {
    const page = await browser.newPage();
    page.on("pageerror", (e) => failures.push(`touch: page error: ${e.message}`));
    await page.setViewport({ width: 420, height: 700, isMobile: true, hasTouch: true });
    await page.goto(`http://127.0.0.1:${port}/#/r/${id}`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));
    const box = await (await page.$(".card canvas:last-of-type")).boundingBox();
    const drag = async () => {
      const x = box.x + box.width / 2;
      const y = box.y + box.height * 0.7;
      await page.touchscreen.touchStart(x, y);
      for (let i = 1; i <= 10; i++) await page.touchscreen.touchMove(x - i * 2, y - i * 12);
      await page.touchscreen.touchEnd();
      await new Promise((r) => setTimeout(r, 400));
    };
    const state = () => page.evaluate(() => ({ y: window.scrollY, k: window.strata.views.treemap.zoom.k, ty: window.strata.views.treemap.zoom.y }));
    await drag();
    const s1 = await state();
    if (!(s1.y > 0 && s1.k === 1)) failures.push(`touch: a drag at normal zoom should scroll the page (${JSON.stringify(s1)})`);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      window.strata.views.treemap.zoom.set(4, 100, 100);
    });
    await new Promise((r) => setTimeout(r, 300));
    const before = await state();
    await drag();
    const s2 = await state();
    if (!(s2.y === 0 && s2.ty !== before.ty)) failures.push(`touch: a drag when zoomed should pan the treemap (${JSON.stringify({ before, after: s2 })})`);
    await page.close();
  }
  await browser.close();
} finally {
  server.kill();
}
if (failures.length) {
  console.error(`smoke: ${failures.length} problem(s):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`smoke: ok (screenshots in ${out})`);
