// C03 返工：运动相机（不冻结、正常飞行）下看远处云带有没有 1–4 Hz 的「呼吸」。
// 同一页面依次换 old / final 云步进片段，每个变体连拍 N 帧远处云带的裁剪区，输出每帧亮度均值序列、
// 去趋势（5 帧滑动平均之外的部分）后的标准差、以及 1–4 Hz 频段功率占比；截图帧存 <out>/<变体>-NN.png
// 用法：node handoff/C03-motion.mjs --port 5211 --out D:/Code/opus-test/tmp/screenshot/c03/motion [--frames 60] [--crop 420,300,760,200]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const VOYAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(VOYAGE + "/package.json");
const { chromium } = require("playwright-core");
const { DEFAULTS, SCENES, applyScene } = await import(pathToFileURL(VOYAGE + "/scripts/scenarios.mjs").href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(VOYAGE + "/scripts/lib/chrome.mjs").href);
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : acc), []));
const port = args.port || 5211;
const OUT = args.out || "D:/Code/opus-test/tmp/screenshot/c03/motion";
const N = +(args.frames || 60);
const [cx, cy, cw, ch] = String(args.crop || "420,300,760,200").split(",").map(Number);
const FINAL = "gDetailRnd = fract(ign(gl_FragCoord.yx + vec2(19.0, 47.0)) + uFrame * 0.41421356 + float(i) * 0.6180339);";
const VARS = { old: [[FINAL, "gDetailRnd = fract(jitter + float(i) * 0.6180339);"]], final: [] };
fs.mkdirSync(OUT, { recursive: true });
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 })).newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();
  const sc = SCENES.find((s) => s.name === "clouds-variety");
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
  await page.evaluate(() => window.__voyage.quality.setTier("high"));
  const res = {};
  for (const [vn, pairs] of Object.entries(VARS)) {
    await page.evaluate(async (pairs) => {
      const v = window.__voyage, m = v.clouds.marchVariants.get(v.clouds.marchShown).mat;
      m.userData.c03orig ??= m.fragmentShader;
      let s = m.userData.c03orig;
      for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error("找不到 " + a); s = s.split(a).join(b); }
      if (s !== m.fragmentShader) { m.fragmentShader = s; m.needsUpdate = true; }
    }, pairs);
    await page.waitForTimeout(4000);   // 编译 + 累积稳定
    const series = [];
    for (let i = 0; i < N; i++) {
      const buf = await page.screenshot({ clip: { x: cx, y: cy, width: cw, height: ch } });
      fs.writeFileSync(path.join(OUT, `${vn}-${String(i).padStart(2, "0")}.png`), buf);
      series.push(Date.now());
    }
    res[vn] = series;
  }
  fs.writeFileSync(path.join(OUT, "times.json"), JSON.stringify(res));
} finally {
  await closeBrowserSafely(browser);
}
