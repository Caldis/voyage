// W03：真冷启动（着色器注入随机数破缓存），再召唤一个云间层奇观（--id，默认 floatcity），量云间层变体（奇观 pass + 步进奇观变体）后台编译到 ready 的时间。
// 用法：node handoff/W03-cold.mjs --port 5203 [--angle d3d11] [--repeat 2] [--id floatcity|fogcity]
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(new URL("../package.json", import.meta.url))("playwright-core");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { launchBrowser, closeBrowserSafely } = await import("file://" + path.join(HERE, "..", "scripts", "lib", "chrome.mjs").replace(/\\/g, "/"));

const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith("--")) { args[av[i].slice(2)] = av[i + 1]; i++; }
const port = args.port || "5203";
const wid = args.id || "floatcity";
const repeat = Number(args.repeat || 1);
const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  for (let r = 0; r < repeat; r++) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const nonce = (Date.now() + r * 7) % 100000;
    await page.addInitScript((n) => {
      const P = WebGL2RenderingContext.prototype;
      const orig = P.shaderSource;
      P.shaderSource = function (sh, src) {
        if (src.includes("void main")) src = src.replace(/void\s+main\s*\(\s*\)\s*\{/, (m) => `float nonceF_${n}(){ return ${n}.0; }\n` + m + `\n if (nonceF_${n}() < -1.0) return;\n`);
        return orig.call(this, sh, src);
      };
    }, nonce);
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/?cold=${t0}`, { waitUntil: "commit", timeout: 180000 });
    await page.bringToFront();
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 250 });
    const startupMs = Date.now() - t0;
    const st = await page.evaluate(() => window.__voyageStartup);
    const wonderMs = await page.evaluate(async (wid) => {
      const v = window.__voyage;
      v.wonders.enabled = true;
      for (let i = 0; i < 2; i++) await new Promise((res) => requestAnimationFrame(res));
      const t = performance.now();
      v.wonders.trigger(wid, { forwardOffsetDeg: 0, distKm: 90, reveal: 1, seed: 0.37 });
      while (v.clouds.wonderLayerState !== "ready" && v.clouds.wonderLayerState !== "failed" && performance.now() - t < 240000) await new Promise((res) => setTimeout(res, 100));
      return { ms: Math.round(performance.now() - t), state: v.clouds.wonderLayerState };
    }, wid);
    console.log(`#${r + 1} 冷启动 ${startupMs} ms（${JSON.stringify(st)}）；${wid} 云间层变体编译 ${wonderMs.ms} ms → ${wonderMs.state}`);
    await ctx.close();
  }
} finally {
  await closeBrowserSafely(browser);
}
process.exit(0);
