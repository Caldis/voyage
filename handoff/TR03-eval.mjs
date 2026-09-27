// TR03 自测：打开页面、应用一个火车场景，再依次执行 --js 文件里的脚本（导出 STEPS = [{ name, js, shot? }]，js 的参数 v = window.__voyage），
// 打印每步返回值；shot: true 时截一张图到 --out/<name>.png。一次冷编译里做多组对照，省得每组都重开浏览器。
// 用法：node apps/voyage/handoff/TR03-eval.mjs --port 5203 --scene rail-oito-default --js <steps.mjs> --out tmp/screenshot/TR03/eval
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULTS, SCENES, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely, resolveRepoPath } from "../scripts/lib/chrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const port = opt("port", "5203");
const out = resolveRepoPath(repo, opt("out", "tmp/screenshot/TR03/eval"));
fs.mkdirSync(out, { recursive: true });
const { STEPS } = await import(pathToFileURL(path.resolve(opt("js"))).href);
const sc = SCENES.find((s) => s.name === opt("scene", "rail-oito-default"));

const browser = await launchBrowser(chromium, { angle: opt("angle", "d3d11") });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.on("console", (m) => m.type() === "error" && console.log("[console error]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${port}/?tr03=${Date.now()}`, { waitUntil: "commit", timeout: 300000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => window.__voyage.weather && ((window.__voyage.weather.hold = true), (window.__voyage.weather.heldIntensity = 0)));
  console.log("scene:", await page.evaluate(applyScene, { sc, defaults: DEFAULTS }));
  for (const st of STEPS) {
    const r = await page.evaluate(async (js) => await new (async () => {}).constructor("v", js)(window.__voyage), st.js);
    console.log(`${st.name}:`, typeof r === "string" ? r : JSON.stringify(r));
    if (st.shot) await page.screenshot({ path: path.join(out, `${st.name}.png`) });
  }
} finally {
  await closeBrowserSafely(browser);
}
