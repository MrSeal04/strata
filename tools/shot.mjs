#!/usr/bin/env node
// Screenshot a strata page with the system Chrome (dev tool; not part of the app).
// Usage: node tools/shot.mjs <url> <out.png> [width] [height] [waitMs] [--dark] [--eval "<js>"]
import { createRequire } from "node:module";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");

const [url, out, w = "1440", h = "900", wait = "2500", ...rest] = process.argv.slice(2);
const dark = rest.includes("--dark");
const evalIdx = rest.indexOf("--eval");
const evalJs = evalIdx >= 0 ? rest[evalIdx + 1] : null;
const selIdx = rest.indexOf("--selector");
const selector = selIdx >= 0 ? rest[selIdx + 1] : null;
const scaleIdx = rest.indexOf("--scale");
const scale = scaleIdx >= 0 ? Number(rest[scaleIdx + 1]) : 1;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: scale });
if (dark) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("response", (r) => {
  if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`);
});
await page.goto(url, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, Number(wait)));
if (evalJs) {
  const r = await page.evaluate(evalJs);
  if (r !== undefined) console.log("eval:", typeof r === "string" ? r : JSON.stringify(r));
  await new Promise((r) => setTimeout(r, Number(wait)));
}
if (selector) {
  const el = await page.$(selector);
  if (!el) throw new Error(`no element ${selector}`);
  await el.screenshot({ path: out });
} else {
  await page.screenshot({ path: out });
}
for (const l of logs) console.log(l);
await browser.close();
