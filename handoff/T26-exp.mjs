#!/usr/bin/env node
// T26：私有 headless 里对云步进着色器做 A/B（不改文件，只重编译云着色器）。
// 用法：node handoff/T26-exp.mjs --port 5226 [--angle vulkan] [--tag exp1] [--variants handoff/T26-variants.mjs] [--scenes eye,eyepm]
// variants 文件导出 VARIANTS = [[名字, [[原文片段, 替换片段], ...]], ...]；不给就只截当前代码（base）。
// 截图：tmp/screenshot/T26/<tag>/<场景>-<变体>.png。冻结云场前进，各变体同一视角。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i];
}
const port = args.port || 5226;
const angle = args.angle || "vulkan";
const tag = args.tag || "exp";
const out = path.join(ROOT, "tmp/screenshot/T26", tag);
fs.mkdirSync(out, { recursive: true });

// 场景：回归表里的台风三景 + 下午逆光（time 960）+ 两个非台风对照
const TY = { preset: "wpac", coverage: 0.2, "wing-pos": "-4" };
const ALL = {
  eye: { name: "eye", p: { ...TY, time: 540, weather: "typhoon-eye" } },
  eyepm: { name: "eyepm", p: { ...TY, time: 960, weather: "typhoon-eye" } },
  eyepml: { name: "eyepml", p: { ...TY, seat: "left", time: 960, weather: "typhoon-eye" } },
  bands: { name: "bands", p: { ...TY, time: 900, weather: "typhoon-bands" } },
  outer: { name: "outer", p: { ...TY, time: 900, altitude: 13, weather: "typhoon-outer" } },
  storm: { name: "storm", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "storm", "wing-pos": "-4" } },
  noon: { name: "noon", p: { preset: "wpac", time: 720, "wing-pos": "8" } },
};
const scenes = (args.scenes ? String(args.scenes).split(",") : ["eye", "eyepm", "bands", "outer"]).map((s) => ALL[s]);
let VARIANTS = [["base", []]];
if (args.variants) VARIANTS = (await import(pathToFileURL(path.resolve(args.variants)).href)).VARIANTS;

const browser = await launchBrowser(chromium, { angle });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 400)); });
  await page.goto(`http://127.0.0.1:${port}/?t26=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => {
    const v = window.__voyage;
    window.__origFrag = v.clouds.marchMat.fragmentShader;
    const o = v.cloudUniforms.uCloudOffset.value;
    let X = o.x, Y = o.y;
    Object.defineProperty(o, "x", { get: () => X, set: (n) => { if (!window.__frz) X = n; }, configurable: true });
    Object.defineProperty(o, "y", { get: () => Y, set: (n) => { if (!window.__frz) Y = n; }, configurable: true });
    // 调试句柄里没有 renderer：从 clouds.probe(renderer, …) 的参数里截下来
    const op = v.clouds.probe.bind(v.clouds);
    v.clouds.probe = (r, h) => { window.__renderer = r; return op(r, h); };
    const orig = v.clouds.render.bind(v.clouds);
    v.clouds.render = (m, a, b) => { if (window.__frz) m.set(0, 0, 0); return orig(m, a, b); };
  });
  for (const sc of scenes) {
    await page.evaluate(() => (window.__frz = false));
    await page.evaluate(applyScene, { sc: { ...sc, wait: 200 }, defaults: DEFAULTS });
    await page.evaluate(() => (window.__frz = true));
    for (const [vn, reps] of VARIANTS) {
      const t0 = Date.now();
      const miss = await page.evaluate(async (reps) => {
        const v = window.__voyage;
        let src = window.__origFrag;
        const miss = [];
        for (const [a, b] of reps) { if (!src.includes(a)) miss.push(a.slice(0, 60)); src = src.split(a).join(b); }
        v.clouds.marchMat.fragmentShader = src;
        v.clouds.marchMat.needsUpdate = true;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        v.state.wetness = 0;
        v.state.turbulence = 0;
        v.snapAll();
        await new Promise((r) => setTimeout(r, 2500));
        return miss;
      }, reps);
      if (args.probe) {
        // --probe "x1,y1;x2,y2"：读云步进原始输出（未曝光的辐亮度 RGB + 透射率 A），坐标是 0..1 的屏幕比例（y 向下）
        const pts = String(args.probe).split(";").map((s) => s.split(",").map(Number));
        const vals = await page.evaluate((pts) => {
          const v = window.__voyage;
          const rt = v.clouds.raw;
          const buf = new Uint16Array(4);
          const h2f = (h) => {
            const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
            return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15);
          };
          return pts.map(([x, y]) => {
            window.__renderer.readRenderTargetPixels(rt, Math.floor(x * rt.width), Math.floor((1 - y) * rt.height), 1, 1, buf);
            return Array.from(buf).map((b) => +h2f(b).toPrecision(4));
          });
        }, pts);
        console.log("   probe", JSON.stringify(vals));
      }
      const f = path.join(out, `${sc.name}-${vn}.png`);
      await page.screenshot({ path: f, timeout: 60000 });
      console.log(`${sc.name}-${vn}  ${Date.now() - t0} ms${miss.length ? "  未命中: " + miss.join(" | ") : ""}`);
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
