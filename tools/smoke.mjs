#!/usr/bin/env node
// Smoke test: extract a fixture into a temporary cache, serve it, open the home page and the
// dashboard at desktop and phone widths, exercise every view mode, playback and zoom, the card
// header options and unlinked cards, check that phones scroll the page until a card is zoomed,
// drag the compare markers, use the branch history, update and then delete the repo from its
// home card, and fail on any page, console or HTTP error.
// Usage: node tools/smoke.mjs [strata-binary] [out-dir]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
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
  // Compare: A and B sit beside the Compare button, and their markers drag like an editor's
  // in/out points, on the charts and the scrubber, without moving the playhead or brushing.
  {
    const page = await browser.newPage();
    page.on("pageerror", (e) => failures.push(`compare: page error: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && failures.push(`compare: console: ${m.text()}`));
    page.on("response", (r) => r.status() >= 400 && failures.push(`compare: HTTP ${r.status()} ${r.url()}`));
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/#/r/${id}`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const get = () => page.evaluate(() => {
      const s = window.strata.app.store.get();
      return { steps: s.steps, cursor: s.cursor, brush: s.brush, ...s.compare, inputs: [...document.querySelectorAll(".filterbar .ab input")].map((i) => i.value) };
    });
    const last = await page.evaluate(() => {
      const a = window.strata.app;
      a.player.seek(a.store.get().steps - 1);
      [...document.querySelectorAll(".filterbar button")].find((b) => b.textContent === "Compare").click();
      return a.store.get().steps - 1;
    });
    await wait(600);
    let s = await get();
    if (s.a !== 0 || s.b !== last || s.inputs.join() !== `1,${last + 1}`) failures.push(`compare: A/B fields should read 1 and ${last + 1} (${JSON.stringify(s)})`);
    const drag = async (x0, y, x1) => {
      await page.mouse.move(x0, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y);
      await page.mouse.up();
      await wait(300);
    };
    // B on the bars, to the middle of the history.
    const bars = await page.evaluate((st) => {
      const v = window.strata.views.bars;
      const r = v.canvas.getBoundingClientRect();
      return { b: r.left + v.strip.stepPx(st), mid: r.left + v.strip.stepPx(Math.floor(st / 2)), y: r.top + r.height / 2 };
    }, last);
    await drag(bars.b, bars.y, bars.mid);
    s = await get();
    if (!(s.b < last && s.b > 0) || s.cursor !== last || s.brush) failures.push(`compare: dragging B on the bars should move B alone (${JSON.stringify(s)})`);
    if (s.inputs[1] !== String(s.b + 1)) failures.push(`compare: the B field should follow the drag (${JSON.stringify(s)})`);
    // A on the scrubber, past B: it stops just before B.
    const scrub = await page.evaluate((st) => {
      const c = document.querySelector(".transport .scrub canvas").getBoundingClientRect();
      return { a: c.left + (0.5 / (st + 1)) * c.width, end: c.right - 2, y: c.top + 6 };
    }, last);
    const b = s.b;
    await drag(scrub.a, scrub.y, scrub.end);
    s = await get();
    if (s.a !== b - 1 || s.b !== b || s.cursor !== last) failures.push(`compare: dragging A past B should stop it at B − 1 (${JSON.stringify(s)})`);
    // Typed values clamp the same way.
    await page.evaluate(() => {
      const [a, b] = document.querySelectorAll(".filterbar .ab input");
      a.value = "1";
      a.dispatchEvent(new Event("change"));
      b.value = "100000";
      b.dispatchEvent(new Event("change"));
    });
    await wait(300);
    s = await get();
    if (s.a !== 0 || s.b !== last || s.inputs.join() !== `1,${last + 1}`) failures.push(`compare: typed A/B should clamp to the history (${JSON.stringify(s)})`);
    const summaryInputs = await page.evaluate(async () => {
      [...document.querySelectorAll(".filterbar button")].find((b) => b.textContent === "Summary").click();
      await new Promise((r) => setTimeout(r, 200));
      const n = document.querySelectorAll(".commit-panel input").length;
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      return n;
    });
    if (summaryInputs) failures.push("compare: the Summary panel should no longer hold A/B fields");
    await page.screenshot({ path: join(out, "compare.png") });
    await page.close();
  }
  // History: the branch's commits beside Compare. Clicking one moves the cursor, a merge opens to
  // the commits it brought in, and a folder filter keeps the commits touching it (git log -- dir).
  {
    const kitchen = join(home, "fixtures/kitchen");
    const fp = execFileSync("git", ["-C", kitchen, "log", "--first-parent", "--reverse", "--format=%H"], { encoding: "utf8" }).trim().split("\n");
    const touching = execFileSync("git", ["-C", kitchen, "log", "--first-parent", "--format=%H", "--", "tool"], { encoding: "utf8" }).trim().split("\n");
    const wantTool = touching.map((sha) => String(fp.indexOf(sha)));
    for (const [w, hgt] of [[1440, 900], [420, 900]]) {
      const tag = `history-${w}`;
      const page = await browser.newPage();
      page.on("pageerror", (e) => failures.push(`${tag}: page error: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && failures.push(`${tag}: console: ${m.text()}`));
      page.on("response", (r) => r.status() >= 400 && failures.push(`${tag}: HTTP ${r.status()} ${r.url()}`));
      await page.setViewport({ width: w, height: hgt });
      await page.goto(`http://127.0.0.1:${port}/#/r/${id}`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 1500));
      const r = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const a = window.strata.app;
        const rows = (kind) => [...document.querySelectorAll(".history .hrow")].filter((r) => r.dataset.kind === kind);
        [...document.querySelectorAll(".filterbar button")].find((b) => b.textContent === "History").click();
        await sleep(1000);
        const out = { steps: a.store.get().steps, open: !document.querySelector(".history").hidden, main: rows("main").map((r) => r.dataset.step) };
        out.cur = document.querySelector(".history .hrow.cur")?.dataset.step;
        const oldest = rows("main").pop();
        oldest.click();
        await sleep(400);
        out.cursor = a.store.get().cursor;
        out.future = document.querySelectorAll(".history .hrow.future").length;
        const expand = document.querySelector(".history [data-expand]");
        const merge = expand.dataset.expand;
        out.sideCount = Number(expand.textContent.match(/\d+/)[0]);
        expand.click();
        await sleep(600);
        out.side = rows("side").filter((r) => r.dataset.step === merge).length;
        a.store.set({ root: "tool" });
        await sleep(1000);
        out.tool = rows("main").map((r) => r.dataset.step);
        out.info = document.querySelector(".history .info").textContent;
        a.store.set({ root: "" });
        await sleep(600);
        out.back = rows("main").length;
        document.querySelector(".history .hhead [aria-label='Close history']").click();
        await sleep(200);
        out.closed = document.querySelector(".history").hidden && !a.store.get().history;
        return out;
      });
      const all = Array.from({ length: r.steps }, (_, i) => String(r.steps - 1 - i));
      if (!r.open || r.main.join() !== all.join()) failures.push(`${tag}: History should list every commit, newest first (${JSON.stringify(r)})`);
      if (r.cur !== String(r.steps - 1)) failures.push(`${tag}: the cursor's commit should be marked (${JSON.stringify(r)})`);
      if (r.cursor !== 0 || r.future !== r.steps - 1) failures.push(`${tag}: clicking the oldest commit should move the cursor there and dim the rest (${JSON.stringify(r)})`);
      if (!(r.sideCount > 0) || r.side !== r.sideCount) failures.push(`${tag}: an expanded merge should list the commits it brought in (${JSON.stringify(r)})`);
      if (r.tool.join() !== wantTool.join() || !r.info.includes(`of ${r.steps}`)) failures.push(`${tag}: a folder filter should keep the commits touching it, ${wantTool} (${JSON.stringify(r)})`);
      if (r.back !== r.steps) failures.push(`${tag}: clearing the filter should bring every commit back (${JSON.stringify(r)})`);
      if (!r.closed) failures.push(`${tag}: Close should hide the history`);
      await page.screenshot({ path: join(out, `${tag}.png`) });
      await page.close();
    }
  }
  // Last, since everything above reads kitchen: update it from its home card, then delete it.
  {
    const page = await browser.newPage();
    page.on("pageerror", (e) => failures.push(`manage: page error: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && failures.push(`manage: console: ${m.text()}`));
    page.on("response", (r) => r.status() >= 400 && failures.push(`manage: HTTP ${r.status()} ${r.url()}`));
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://127.0.0.1:${port}/#/`, { waitUntil: "networkidle0" });
    const card = `.repo-card[data-repo="${id}"]`;
    const click = (text) => page.evaluate((card, text) => [...document.querySelectorAll(`${card} .actions button`)].find((b) => b.textContent === text)?.click(), card, text);
    await click("Update");
    await page
      .waitForFunction((card) => document.querySelector(card)?.textContent.includes("Already up to date"), { timeout: 30000 }, card)
      .catch(() => failures.push("manage: Update did not report the repo up to date"));
    await click("Delete");
    await click("Delete"); // the confirmation
    await page
      .waitForFunction((card) => !document.querySelector(card) && document.querySelector(".repos").textContent.includes("No repositories"), { timeout: 10000 }, card)
      .catch(() => failures.push("manage: Delete did not remove the card"));
    const meta = await fetch(`http://127.0.0.1:${port}/api/r/${id}/meta`);
    if (meta.status !== 404) failures.push(`manage: /meta after delete is HTTP ${meta.status}`);
    if (existsSync(join(home, "repos", id))) failures.push("manage: the cache directory survived");
    if (!existsSync(join(home, "fixtures/kitchen/.git/HEAD"))) failures.push("manage: delete touched the repository");
    await page.screenshot({ path: join(out, "home-deleted.png") });
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
