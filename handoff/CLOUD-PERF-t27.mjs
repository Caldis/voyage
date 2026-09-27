// T27 自测：海面耀斑被云影切出的硬边色块。截 sunset-wing / storm-day / typhoon-outer，并按美术总监的坐标放大裁切。
// --pre x.json：替换窗外程序源码（[["找","换"],...]）后重编，对照实验用（例如让 cloudShadow 恒为 1）。
// --frames N：连续 N 帧的同一裁切（看边缘是否逐帧闪）
// 用法：node apps/voyage/handoff/CLOUD-PERF-t27.mjs --port 5250 [--angle vulkan] [--pre x.json] [--out tmp/screenshot/t27/base]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");  // 放在 apps/voyage/handoff/ 下
const VOY = path.join(ROOT, "apps", "voyage", "scripts");
const { chromium } = createRequire(path.join(ROOT, "apps", "voyage", "package.json"))("playwright-core");
const { DEFAULTS, applyScene, pickScenes } = await import("file://" + path.join(VOY, "scenarios.mjs").replace(/\\/g, "/"));
const { launchBrowser, closeBrowserSafely } = await import("file://" + path.join(VOY, "lib", "chrome.mjs").replace(/\\/g, "/"));
const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith("--")) { args[av[i].slice(2)] = av[i + 1]; i++; }
const port = args.port || "5250";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/t27/run");
fs.mkdirSync(outDir, { recursive: true });
const CROPS = {
  "sunset-wing": [{ x: 700, y: 820, w: 250, h: 170, z: 3 }],
  "storm-day": [{ x: 390, y: 560, w: 440, h: 300, z: 2 }],
  "typhoon-outer": [{ x: 400, y: 700, w: 800, h: 450, z: 1 }],
};
const only = args.only ? args.only.split(",") : Object.keys(CROPS);
const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("[pageerror] " + e.message));
  await page.goto(`http://127.0.0.1:${port}/?t27=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  if (args.pre) {
    const reps = JSON.parse(fs.readFileSync(args.pre, "utf8"));
    await page.evaluate((reps) => {
      const m = window.__voyage.outsideMat;
      let s = m.fragmentShader;
      for (const [a, b] of reps) { if (!s.includes(a)) throw new Error("pattern miss: " + a); s = s.split(a).join(b); }
      m.fragmentShader = s;
      m.needsUpdate = true;
    }, reps);
  }
  if (args.spre) {
    const reps = JSON.parse(fs.readFileSync(args.spre, "utf8"));
    await page.evaluate((reps) => {
      const c = window.__voyage.clouds;
      const m = c.shadowMat;
      let s = m.fragmentShader;
      for (const [a, b] of reps) { if (!s.includes(a)) throw new Error("pattern miss: " + a); s = s.split(a).join(b); }
      m.fragmentShader = s;
      m.needsUpdate = true;
      c.shadowKey = "";
    }, reps);
  }
  for (const sc of pickScenes(only)) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    await page.waitForTimeout(1500);
    const frames = +(args.frames || 1);
    for (let f = 0; f < frames; f++) {
      const suffix = frames > 1 ? `-f${f}` : "";
      await page.screenshot({ path: path.join(outDir, `${sc.name}${suffix}.png`) });
      for (const [i, c] of (CROPS[sc.name] || []).entries()) {
        await page.screenshot({ path: path.join(outDir, `${sc.name}-crop${i}${suffix}.png`), clip: { x: c.x, y: c.y, width: c.w, height: c.h } });
      }
      if (frames > 1) await page.waitForTimeout(16);
    }
    console.log(sc.name, "完成");
  }
} finally {
  console.log("控制台 error：" + (errors.length ? "\n  " + errors.slice(0, 20).join("\n  ") : "无"));
  await closeBrowserSafely(browser);
}
process.exit(0);
