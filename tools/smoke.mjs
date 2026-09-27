#!/usr/bin/env node
// Smoke test: extract a fixture into a temporary cache, serve it, open the home page and the
// dashboard at desktop and phone widths, and fail on any page error, console error or HTTP error.
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
      });
      await new Promise((r) => setTimeout(r, 800));
    }
    await page.screenshot({ path: join(out, `${name}.png`) });
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
