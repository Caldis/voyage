// W02：按 pass 的 GPU 计时（抄自性能工程师的 tmp/perf-cloud/passes-w00.mjs，路径改成相对本 worktree，另分出「奇观pass」一栏）。
// 用法：node handoff/W02-passes.mjs --port 5202 --only wonder-fogcity-night --variants <json>（[{name, js}]，js 在场景之后执行）
// 性能工程师临时脚本：按 draw call 包 GPU timer query，按程序归类，得出各 pass 的 GPU 耗时。
// 不改 src；只在页面里 hook WebGL2 API。
// 用法：node tmp/perf/passes.mjs --port 5181 [--only a,b] [--frames 20] [--extra '<js 表达式，应用场景后执行>'] [--tag 名称]
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../package.json", import.meta.url))("playwright-core");
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOY = path.join(HERE, "..", "scripts");
const { DEFAULTS, applyScene, pickScenes } = await import("file://" + path.join(VOY, "scenarios.mjs").replace(/\\/g, "/"));
const label = (m) => { if (!m) return "?"; const u = new Set(m.uni); if (u.has("uHistory")) return "云resolve"; if (u.has("uWonderVol") && !u.has("uWeatherCull")) return "奇观pass"; if (u.has("uCloudResolution") && u.has("uFrame")) return "云步进"; if (u.has("uProbeDir")) return "云探针"; if (u.has("uShapeNoise")) return "窗外"; if ([...u].some((x) => /^uWing/.test(x))) return "机翼"; return "其他"; };
const { launchBrowser, closeBrowserSafely } = await import("file://" + path.join(VOY, "lib", "chrome.mjs").replace(/\\/g, "/"));

const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith("--")) { args[av[i].slice(2)] = av[i + 1]; i++; }
const port = args.port || "5181";
const frames = Number(args.frames || 20);
const only = args.only ? args.only.split(",") : null;
const w = Number(args.w || 1600), h = Number(args.h || 1200);

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const P = WebGL2RenderingContext.prototype;
    const srcOf = new WeakMap();
    const fragOf = new WeakMap();
    const oSS = P.shaderSource, oAS = P.attachShader, oUP = P.useProgram, oDA = P.drawArrays, oDE = P.drawElements, oBF = P.bindFramebuffer, oVP = P.viewport;
    let progId = 0;
    const progMeta = new Map();
    window.__perf = { on: false, rec: [], progMeta };
    let cur = null, curVp = [0, 0, 0, 0];
    P.shaderSource = function (s, src) { srcOf.set(s, src); return oSS.call(this, s, src); };
    P.attachShader = function (p, s) {
      const src = srcOf.get(s) || "";
      if (this.getShaderParameter && src.includes("gl_FragColor") || /out\s+(highp\s+|mediump\s+)?vec4/.test(src) || /layout\s*\(\s*location/.test(src)) {
        if (!src.includes("gl_Position")) fragOf.set(p, src);
      }
      return oAS.call(this, p, s);
    };
    P.useProgram = function (p) {
      cur = p;
      if (p && !p.__pid) {
        p.__pid = ++progId;
        const src = fragOf.get(p) || "";
        const uni = [...src.matchAll(/uniform\s+\w+\s+\w+\s+(\w+)|uniform\s+\w+\s+(\w+)/g)].map((m) => m[1] || m[2]);
        progMeta.set(p.__pid, { len: src.length, uni: [...new Set(uni)].filter((u) => !/^(modelMatrix|modelViewMatrix|projectionMatrix|viewMatrix|normalMatrix|cameraPosition|isOrthographic)$/.test(u)) });
      }
      return oUP.call(this, p);
    };
    P.viewport = function (x, y, ww, hh) { curVp = [x, y, ww, hh]; return oVP.call(this, x, y, ww, hh); };
    const wrap = (orig) => function (...a) {
      const pf = window.__perf;
      if (!pf.on) return orig.apply(this, a);
      const ext = this.__tq || (this.__tq = this.getExtension("EXT_disjoint_timer_query_webgl2"));
      const q = this.createQuery();
      this.beginQuery(ext.TIME_ELAPSED_EXT, q);
      const r = orig.apply(this, a);
      this.endQuery(ext.TIME_ELAPSED_EXT);
      pf.rec.push({ q, pid: cur ? cur.__pid : 0, vp: curVp[2] + "x" + curVp[3], gl: this });
      return r;
    };
    P.drawArrays = wrap(oDA);
    P.drawElements = wrap(oDE);
  });
  await page.goto(`http://127.0.0.1:${port}/?perf=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const out = [];
  const variants = args.variants ? JSON.parse(fs.readFileSync(args.variants, "utf8")) : [{ name: "", js: args.extra || "" }];
  for (const sc0 of pickScenes(only)) for (const vr of variants) {
    const sc = { ...sc0, name: sc0.name + (vr.name ? "/" + vr.name : "") };
    await page.evaluate(applyScene, { sc: sc0, defaults: DEFAULTS });
    // 占据网格程序在后台编译，编好之前步进照旧逐点求值：等它好了再测（master 上没有这个字段，直接跳过）
    await page.waitForFunction(() => { const c = window.__voyage.clouds; return !("occState" in c) || c.occState === "ready"; }, null, { timeout: 180000, polling: 250 });
    await page.waitForTimeout(500);
    if (vr.js) { await page.evaluate(vr.js); await page.waitForTimeout(vr.wait ?? 300); }
    await page.evaluate(() => window.__voyage.benchFrame(10));
    const res = await page.evaluate(async (n) => {
      const pf = window.__perf;
      pf.rec = [];
      pf.on = true;
      const t0 = performance.now();
      window.__voyage.benchFrame(n);
      const cpuMs = (performance.now() - t0) / n;
      pf.on = false;
      const gl = pf.rec[0]?.gl;
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      const last = pf.rec[pf.rec.length - 1].q;
      const t1 = performance.now();
      while (!gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) {
        if (performance.now() - t1 > 5000) return { err: "timeout" };
        await new Promise((r) => setTimeout(r, 5));
      }
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const agg = {};
      for (const r of pf.rec) {
        const ns = gl.getQueryParameter(r.q, gl.QUERY_RESULT);
        gl.deleteQuery(r.q);
        const k = r.pid + "@" + r.vp;
        (agg[k] ||= { pid: r.pid, vp: r.vp, ms: 0, draws: 0 }).ms += ns / 1e6 / n;
        agg[k].draws += 1 / n;
      }
      const meta = {};
      for (const [id, m] of pf.progMeta) meta[id] = m;
      return { cpuMs, disjoint, agg: Object.values(agg).sort((a, b) => b.ms - a.ms), meta };
    }, frames);
    const total = res.agg ? res.agg.reduce((s, a) => s + a.ms, 0) : null;
    console.log(`== ${sc.name}  gpuSum=${total?.toFixed(3)}ms  cpuWall=${res.cpuMs?.toFixed(3)}ms  disjoint=${res.disjoint}`);
    const cat = {};
    for (const a of res.agg || []) { const L = label(res.meta[a.pid]); cat[L] = (cat[L] || 0) + a.ms; a.label = L; }
    res.cat = cat;
    console.log("   分类: " + Object.entries(cat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v.toFixed(3)}`).join("  "));
    for (const a of (res.agg || []).slice(0, +(args.top || 0))) {
      const m = res.meta[a.pid] || { uni: [] };
      console.log(`   ${a.ms.toFixed(3).padStart(7)} ms  draws=${a.draws.toFixed(1).padStart(5)}  pid=${String(a.pid).padStart(3)}  ${a.vp.padEnd(10)} len=${m.len}  ${m.uni.slice(0, 6).join(",")}`);
    }
    out.push({ scene: sc.name, total, ...res, time: new Date().toISOString() });
  }
  const tag = args.tag || "passes";
  fs.writeFileSync(path.join(HERE, "..", "..", "..", "tmp", `${tag}.json`), JSON.stringify(out, null, 1));
} finally {
  await closeBrowserSafely(browser);
}
process.exit(0);
