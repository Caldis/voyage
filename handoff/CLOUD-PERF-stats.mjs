// 云步进逐像素计数：受光采样数（有云的采样点）、重密度求值数（占据网格说「可能有云」后真正求雷暴 / 台风密度的次数，
// 含受光步进）、主步进步数。改 marchMat 源码后重编，读回 raw（R/G/B = 三个计数）。
// 用法：node apps/voyage/handoff/CLOUD-PERF-stats.mjs --port 5250 [--only a,b] [--grid 0|1] [--out tmp/screenshot/stats]
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
const only = args.only ? args.only.split(",") : ["storm-day", "typhoon-eye", "typhoon-bands", "typhoon-outer"];
const outDir = path.join(ROOT, args.out || "tmp/screenshot/stats");
fs.mkdirSync(outDir, { recursive: true });
const REPS = [
  ["bool cloudWeatherMaybe(vec2 xz, float alt) {", "float gHeavy = 0.0;\nbool cloudWeatherMaybe(vec2 xz, float alt) {"],
  ["if (!cloudWeatherMaybe(xz, alt)) return d;", "if (!cloudWeatherMaybe(xz, alt)) return d;\n    gHeavy += 1.0;"],
  ["float lastEmpty = seg.x;", "float lastEmpty = seg.x; float cLit = 0.0, cSteps = 0.0;"],
  ["float dens = cloudDensity(p, lod, t < 150.0);", "float dens = cloudDensity(p, lod, t < 150.0); cSteps += 1.0;"],
  ["    if (dens > 0.002) {\n      wasEmpty = false;", "    if (dens > 0.002) {\n      wasEmpty = false; cLit += 1.0;"],
  ["  if (wSum <= 0.0) return;\n  float depth = depthSum / wSum;", "  gl_FragColor = vec4(cLit, gHeavy, cSteps, 1.0); return;\n  float depth = depthSum / wSum;"],
];
if (args.extra) REPS.push(...JSON.parse(fs.readFileSync(args.extra, "utf8")));
const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror] " + e.message));
  await page.goto(`http://127.0.0.1:${port}/?st=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate((reps) => {
    const m = window.__voyage.clouds.marchMat;
    let s = m.fragmentShader;
    for (const [a, b] of reps) { if (!s.includes(a)) throw new Error("pattern miss: " + a); s = s.split(a).join(b); }
    m.fragmentShader = s;
    m.needsUpdate = true;
  }, REPS);
  for (const sc of pickScenes(only)) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    await page.waitForFunction(() => window.__voyage.clouds.occState === "ready", null, { timeout: 180000, polling: 250 });
    await page.waitForTimeout(1000);
    const res = await page.evaluate((grid) => {
      const c = window.__voyage.clouds;
      const r = c.pass.renderer;
      const m = c.marchMat;
      c.updateOccupancy();
      m.uniforms.uOccValid.value = grid;
      const w = c.raw.width, h = c.raw.height;
      c.pass.render(m, c.raw);
      const b = new Uint16Array(w * h * 4);
      r.readRenderTargetPixels(c.raw, 0, 0, w, h, b);
      const hf = (x) => { const e = (x >> 10) & 31, f = x & 1023; return e === 0 ? f * 2 ** -24 : (1 + f / 1024) * 2 ** (e - 15); };
      let lit = 0, heavy = 0, steps = 0, pxLit = 0;
      const img = new ImageData(w, h);
      const hs = [];
      for (let i = 0; i < w * h; i++) {
        const a = hf(b[i * 4]), g = hf(b[i * 4 + 1]), s = hf(b[i * 4 + 2]);
        lit += a; heavy += g; steps += s; if (a > 0) pxLit++;
        hs.push(g);
        const k = ((h - 1 - Math.floor(i / w)) * w + (i % w)) * 4;
        img.data[k] = Math.min(255, g); img.data[k + 1] = Math.min(255, a * 8); img.data[k + 2] = Math.min(255, s); img.data[k + 3] = 255;
      }
      hs.sort((x, y) => x - y);
      const pct = (q) => hs[Math.floor(q * (hs.length - 1))];
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h; cv.getContext("2d").putImageData(img, 0, 0);
      return { n: w * h, lit, heavy, steps, pxLit, p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), png: cv.toDataURL("image/png") };
    }, +(args.grid ?? 1));
    fs.writeFileSync(path.join(outDir, `${sc.name}-g${args.grid ?? 1}.png`), Buffer.from(res.png.split(",")[1], "base64"));
    console.log(`${sc.name} grid=${args.grid ?? 1}: 每像素 主步 ${(res.steps / res.n).toFixed(1)}  受光采样 ${(res.lit / res.n).toFixed(2)}（有云像素 ${(100 * res.pxLit / res.n).toFixed(1)}%）  重密度求值 ${(res.heavy / res.n).toFixed(1)}（p50 ${res.p50} p90 ${res.p90} p99 ${res.p99}）`);
  }
} finally {
  await closeBrowserSafely(browser);
}
process.exit(0);
