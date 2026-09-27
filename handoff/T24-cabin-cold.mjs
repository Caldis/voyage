#!/usr/bin/env node
// T24：只测舱内合成程序（scene.ts）的重编耗时。
// 同一个浏览器进程里先正常加载一次（所有程序进内存缓存），再开新上下文、只给舱内程序的源码加 nonce 破缓存，
// 第二次加载的「着色器编译（后台）」就近似等于只改舱内时的重编耗时。
// 用法（在 apps/voyage 下）：node handoff/T24-cabin-cold.mjs 5224 [5225 ...]
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

async function load(browser, port, nonce) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    if (nonce) {
      await page.addInitScript((n) => {
        const P = WebGL2RenderingContext.prototype;
        const orig = P.shaderSource;
        P.shaderSource = function (sh, src) {
          // 舱内合成程序的标志：只有它有 packWingRef
          if (src.includes("void main") && src.includes("packWingRef(")) {
            src = src.replace(/void\s+main\s*\(\s*\)\s*\{/, (m) => `float nonceF_${n}(){ return ${n}.0; }\n` + m + `\n if (nonceF_${n}() < -1.0) return;\n`);
          }
          return orig.call(this, sh, src);
        };
      }, nonce);
    }
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/?t=${t0}`, { waitUntil: "commit", timeout: 180000 });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 250 });
    const s = await page.evaluate(() => window.__voyageStartup);
    const bg = Object.entries(s).find(([k]) => k.includes("后台"));
    return { totalMs: Date.now() - t0, batchMs: bg ? bg[1] : null };
  } finally {
    await Promise.race([context.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
  }
}

const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  for (const port of process.argv.slice(2)) {
    await load(browser, port, 0);
    for (let i = 0; i < 2; i++) {
      const r = await load(browser, port, (Date.now() % 100000) + i);
      console.log(`${port} 只重编舱内 #${i + 1}: total=${r.totalMs} ms  batch=${r.batchMs} ms`);
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
