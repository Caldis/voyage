#!/usr/bin/env node
// T33：远处雷暴 / 台风的开销，按 pass 计 GPU 时间（EXT_disjoint_timer_query_webgl2），并可截图做画面对比。
// 摆放同 T19b-storm-cost.mjs：窗外一侧一排 4 个雷暴单体 / 台风中心，距离可选。
// 用法：node handoff/T33-storm-cost.mjs --port 5231 [--dir heading|out（摆在航向 / 窗外方向）] [--angle vulkan] [--pre '<js，每个摆放前执行>'] [--tag 名称] [--shots 目录] [--rounds 3]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith("--")) { args[av[i].slice(2)] = av[i + 1]; i++; }
const rounds = Number(args.rounds || 3);
const placements = (args.place || "none,s60,s134,s200,s300,h250,h500,h750,none").split(",");
const browser = await launchBrowser(chromium, { angle: String(args.angle || "d3d11") });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  await page.addInitScript(() => {
    const P = WebGL2RenderingContext.prototype;
    const srcOf = new WeakMap(), fragOf = new WeakMap();
    const oSS = P.shaderSource, oAS = P.attachShader, oUP = P.useProgram, oDA = P.drawArrays, oDE = P.drawElements;
    window.__perf = { on: false, rec: [] };
    let cur = null;
    P.shaderSource = function (s, src) { srcOf.set(s, src); return oSS.call(this, s, src); };
    P.attachShader = function (p, s) { const src = srcOf.get(s) || ""; if (!src.includes("gl_Position")) fragOf.set(p, src); return oAS.call(this, p, s); };
    P.useProgram = function (p) {
      cur = p;
      if (p && !p.__lab) {
        const src = fragOf.get(p) || "";
        p.__lab = src.includes("uHistory") ? "云resolve" : src.includes("uCloudResolution") && src.includes("uFrame") ? "云步进"
          : src.includes("uProbeDir") ? "云探针" : src.includes("uOccLayer") ? "占据网格" : src.includes("uBuildSun") ? "云影图"
          : src.includes("uShapeNoise") ? "窗外" : /uWing/.test(src) ? "机翼" : "其他";
      }
      return oUP.call(this, p);
    };
    const wrap = (orig) => function (...a) {
      const pf = window.__perf;
      if (!pf.on) return orig.apply(this, a);
      const ext = this.__tq || (this.__tq = this.getExtension("EXT_disjoint_timer_query_webgl2"));
      const q = this.createQuery();
      this.beginQuery(ext.TIME_ELAPSED_EXT, q);
      const r = orig.apply(this, a);
      this.endQuery(ext.TIME_ELAPSED_EXT);
      pf.rec.push({ q, lab: cur ? cur.__lab : "?", gl: this });
      return r;
    };
    P.drawArrays = wrap(oDA);
    P.drawElements = wrap(oDE);
  });
  await page.goto(`http://127.0.0.1:${args.port}/?t33=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc: { name: "storm-cost", p: { preset: "wpac", time: 900, coverage: 0.3, "wing-pos": "-4" } }, defaults: DEFAULTS });
  await page.waitForFunction(() => window.__voyage.clouds.occState === "ready", null, { timeout: 180000, polling: 250 });
  const res = {};
  for (let r = 0; r < rounds; r++) for (const pl of placements) {
    if (args.pre) await page.evaluate(args.pre);
    await page.evaluate(([pl, dirMode]) => {
      const v = window.__voyage;
      v.weather.removeStorms(() => true);
      v.weather.setHurricane(null);
      let h = (v.state.heading * Math.PI) / 180;
      if (dirMode === "out") {
        // 窗外方向（座舱 +z 换到世界坐标）的水平方位
        const e = v.sceneMat.uniforms.uCabinToWorld.value.elements;
        h = Math.atan2(e[8], e[6]);
      }
      const o = v.cloudUniforms.uCloudOffset.value;
      const dist = Number(pl.slice(1));
      if (pl[0] === "s") for (let i = 0; i < 4; i++) v.weather.addStorm({ id: `t#${i}`, x: o.x + Math.cos(h) * dist + Math.sin(h) * (i - 1.5) * 16, z: o.y + Math.sin(h) * dist - Math.cos(h) * (i - 1.5) * 16, radius: 5.5, top: 13 });
      if (pl[0] === "h") v.weather.setHurricane({ id: "t", x: o.x + Math.cos(h) * dist, z: o.y + Math.sin(h) * dist, eye: 20 });
    }, [pl, String(args.dir || "heading")]);
    await page.waitForTimeout(3500); // 占据网格 / 云影图分帧建完
    await page.evaluate(() => window.__voyage.benchFrame(10));
    const one = await page.evaluate(async () => {
      const pf = window.__perf;
      const n = 20;
      pf.rec = [];
      pf.on = true;
      window.__voyage.benchFrame(n);
      pf.on = false;
      const gl = pf.rec[0].gl;
      const last = pf.rec[pf.rec.length - 1].q;
      const t1 = performance.now();
      while (!gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) {
        if (performance.now() - t1 > 5000) return { err: "timeout" };
        await new Promise((r) => setTimeout(r, 5));
      }
      const cat = {};
      let total = 0;
      for (const r of pf.rec) {
        const ms = gl.getQueryParameter(r.q, gl.QUERY_RESULT) / 1e6 / n;
        gl.deleteQuery(r.q);
        cat[r.lab] = (cat[r.lab] || 0) + ms;
        total += ms;
      }
      cat.total = total;
      return cat;
    });
    (res[pl] ||= []).push(one);
    if (args.shots && r === 0) {
      fs.mkdirSync(args.shots, { recursive: true });
      await page.evaluate(() => { for (const el of document.querySelectorAll("#panel,.panel,#hud,#info")) el.classList.add("hidden"); });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(args.shots, `${pl}.png`) });
    }
  }
  // 各摆放取中位
  const med = {};
  for (const [pl, arr] of Object.entries(res)) {
    const keys = Object.keys(arr[0]);
    med[pl] = Object.fromEntries(keys.map((k) => { const v = arr.map((a) => a[k] ?? 0).sort((a, b) => a - b); return [k, +v[Math.floor(v.length / 2)].toFixed(3)]; }));
  }
  for (const [pl, m] of Object.entries(med)) console.log(pl.padEnd(6), Object.entries(m).map(([k, v]) => `${k}=${v}`).join("  "));
  if (args.tag) fs.writeFileSync(`${args.tag}.json`, JSON.stringify({ med, res, errors }, null, 1));
  console.log("errors:", errors.length ? errors : "无");
} finally {
  await closeBrowserSafely(browser);
}
