#!/usr/bin/env node
// PERF-3：两个端口（基线 / 本分支）同一浏览器里交替测机翼 pass 的 GPU 时间（timer query），抗 GPU 争用。
// 用法：node handoff/PERF-3-bench.mjs --ports 5244,5243 [--only a,b] [--rounds 12] [--variants 'js1;js2']
//   每个端口各开一页；每个场景两页都应用好以后，按「页 × 变体」轮流，每次渲染机翼 pass 8 遍、每遍单独一个 timer query。
//   报告每组的最小值和 25% 分位数（有别的代理占用 GPU 时，中位数会被时间片抬高，低分位更接近独占时的开销）。
//   --variants：分号分隔，每段 JS 在两页上都执行（默认只测当前状态）；例如 'EdgeAA=1' 与 'EdgeAA=0' 对照边缘超采样开销：
//     --variants "window.__voyage.wingMat.uniforms.uWingEdgeAA.value=1;window.__voyage.wingMat.uniforms.uWingEdgeAA.value=0"
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) { args[a.slice(2)] = process.argv[i + 1]; i++; }
}
const ports = String(args.ports || "5244,5243").split(",");
const rounds = Number(args.rounds || 12);
const names = args.only ? String(args.only).split(",") : ["sunset-wing", "noon-cumulus", "in-cloud", "night-city", "route-hnd-cts"];
const variants = args.variants ? String(args.variants).split(";") : [""];

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const pages = [];
  for (const port of ports) {
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log(`[${port} 控制台 error] ${m.text()}`); });
    page.on("pageerror", (e) => console.log(`[${port} 页面异常] ${e.message}`));
    await page.addInitScript(() => {
      const P = WebGL2RenderingContext.prototype;
      const wrap = (orig) => function (...a) {
        const st = window.__tq;
        if (!st || !st.on) return orig.apply(this, a);
        const ext = this.__tqExt || (this.__tqExt = this.getExtension("EXT_disjoint_timer_query_webgl2"));
        const q = this.createQuery();
        this.beginQuery(ext.TIME_ELAPSED_EXT, q);
        const r = orig.apply(this, a);
        this.endQuery(ext.TIME_ELAPSED_EXT);
        st.pending.push({ gl: this, q });
        return r;
      };
      P.drawArrays = wrap(P.drawArrays);
      P.drawElements = wrap(P.drawElements);
      window.__tq = { on: false, pending: [] };
      // 渲染 n 遍机翼 pass，每遍一个 query；等结果出来后返回毫秒数组
      window.__wingGpu = async (n) => {
        const st = window.__tq;
        st.pending = [];
        st.on = true;
        for (let i = 0; i < n; i++) window.__voyage.benchWing(1);
        st.on = false;
        const out = [];
        for (const { gl, q } of st.pending) {
          for (let k = 0; k < 200 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((r) => setTimeout(r, 5));
          out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(q);
        }
        return out;
      };
    });
    await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
    pages.push({ port, page });
  }
  for (const { page } of pages) {
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  }
  await new Promise((r) => setTimeout(r, 3000));
  for (const nm of names) {
    const sc = pickScenes([nm])[0];
    await Promise.all(pages.map(({ page }) => page.evaluate(applyScene, { sc, defaults: DEFAULTS })));
    await Promise.all(pages.map(({ page }) => page.evaluate(() => { window.__voyage.state.turbulence = 0; })));
    const res = pages.map(() => variants.map(() => []));
    for (let r = 0; r < rounds; r++) {
      for (let p = 0; p < pages.length; p++) {
        for (let v = 0; v < variants.length; v++) {
          if (variants[v]) await pages[p].page.evaluate(variants[v]);
          // benchWing(1) 里先渲染一遍再同步，所以每次调用是 2 个 draw；丢掉第一遍（切变体后的冷缓存）
          const t = await pages[p].page.evaluate(() => window.__wingGpu(8));
          res[p][v].push(...t.slice(1));
        }
      }
    }
    const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))]; };
    for (let p = 0; p < pages.length; p++) {
      for (let v = 0; v < variants.length; v++) {
        const a = res[p][v];
        const tag = (variants[v] || "当前").replace(/window\.__voyage\.wingMat\.uniforms\./g, "");
        console.log(`${nm}\t${pages[p].port}\tmin ${q(a, 0).toFixed(3)}\tp25 ${q(a, 0.25).toFixed(3)}\tp50 ${q(a, 0.5).toFixed(3)}\tn=${a.length}\t[${tag}]`);
      }
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
