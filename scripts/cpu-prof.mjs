#!/usr/bin/env node
// PERF-CPU：主线程 / GPU 进程 CPU 剖析（有头 Chrome，贴近用户环境）。
//
// 用户报告「帧率很低、CPU 打满、GPU 利用 < 40%」——典型单线程瓶颈：页面主线程 JS，或 Chrome GPU 进程
// （ANGLE D3D11 命令翻译）。这个脚本对每个场景量四样东西，一次跑完：
//   1. 帧时间：rAF 间隔中位 / p95 / 最大，以及每个 rAF 回调里主循环 JS 自己的耗时（包一层 requestAnimationFrame）；
//   2. 进程 CPU：CDP `SystemInfo.getProcessInfo` 前后差 → 浏览器 / 渲染 / GPU 进程各占几个核（%，100% = 一整核），
//      渲染进程主线程忙碌时间用 `Performance.getMetrics` 的 TaskDuration / ScriptDuration 差；
//   3. 主线程 JS 自耗时 Top N：CDP `Profiler`（采样 100 µs）按「函数 + 文件:行」聚合 self time，÷ 帧数 = 每帧 ms；
//   4. WebGL 调用统计：运行时给 WebGL2RenderingContext.prototype 的每个方法包计数 + 计时（单独一段，
//      不和 2/3 同时开，免得计数开销污染剖析），每帧次数 / 每帧 ms，另列同步阻塞类调用（getError / readPixels /
//      getParameter / getQueryParameter / clientWaitSync / checkFramebufferStatus / get*Parameter …）。
//
// 用法：
//   node scripts/cpu-prof.mjs --port 5249 [--scenes default,noon-cumulus,night-city,storm-day,in-cloud,route-1x,route-60x]
//        [--seconds 6] [--top 20] [--headless] [--viewport 1600x1200] [--dpr 1] [--out tmp/perfcpu/x.json] [--no-gl]
// 场景：scenarios.mjs 里的名字，外加 default（打开页面什么都不设）、route-1x / route-60x（hnd-cts 连续航程 1× / 60×）。
// 默认有头（headless: false）：用户用的是普通 Chrome，headless 的合成 / vsync 路径和有头不同。窗口会弹出来并置前。
import { chromium } from "playwright-core";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChromeExecutable, resolveRepoPath, closeBrowserSafely } from "./lib/chrome.mjs";
import { SCENES, DEFAULTS, applyScene } from "./scenarios.mjs";
import { acquireOrWait } from "./lib/measure-lock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

function parseArgs(argv) {
  const a = { angle: "d3d11", port: 5181, scenes: "default", seconds: 6, top: 20, headless: false, viewport: "1600x1200", dpr: 1, out: null, gl: true, warm: 4 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const nx = () => argv[++i];
    if (k === "--port") a.port = Number(nx());
    else if (k === "--scenes") a.scenes = nx();
    else if (k === "--angle") a.angle = nx(); // d3d11（默认，硬件）| warp（D3D11 软件光栅，复现「GPU 进程掉到 WARP」）
    else if (k === "--seconds") a.seconds = Number(nx());
    else if (k === "--top") a.top = Number(nx());
    else if (k === "--headless") a.headless = true;
    else if (k === "--viewport") a.viewport = nx();
    else if (k === "--dpr") a.dpr = Number(nx());
    else if (k === "--out") a.out = nx();
    else if (k === "--no-gl") a.gl = false;
    else if (k === "--warm") a.warm = Number(nx());
    else if (k === "--query") a.query = nx();
    else throw new Error(`未知参数 ${k}`);
  }
  return a;
}

const EXTRA_SCENES = {
  default: null,
  "route-1x": { name: "route-1x", p: { preset: "hnd-cts", time: 990, coverage: 0.25, "wing-pos": "8", "voyage-on": true }, continuousJourney: true, js: "v.director.rate = 1; return v.director.describe();", ground: true },
  "route-60x": { name: "route-60x", p: { preset: "hnd-cts", time: 990, coverage: 0.25, "wing-pos": "8", "voyage-on": true }, continuousJourney: true, js: "v.director.rate = 60; return v.director.describe();", ground: true },
};

function sceneOf(name) {
  if (name in EXTRA_SCENES) return EXTRA_SCENES[name];
  const s = SCENES.find((x) => x.name === name);
  if (!s) throw new Error(`未知场景 ${name}`);
  return s;
}

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};

// 页面里：rAF 包装（每个回调的 JS 耗时 + 间隔），只在 window.__cpuprof.on 时记
function initScript() {
  const rec = (window.__cpuprof = { on: false, t: [], js: [] });
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    orig((ts) => {
      if (!rec.on) return cb(ts);
      const t0 = performance.now();
      try {
        return cb(ts);
      } finally {
        rec.t.push(ts);
        rec.js.push(performance.now() - t0);
      }
    });
  const origGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = origGet.call(this, type, ...rest);
    if (type === "webgl2" && ctx) (window.__glProbes ??= []).push(ctx);
    return ctx;
  };
}

// 页面里：给 WebGL2 原型包计数 / 计时；返回卸载函数名挂在 window 上
function glCountOn() {
  const P = WebGL2RenderingContext.prototype;
  const stats = (window.__glStats = {});
  const saved = (window.__glSaved = {});
  for (const name of Object.getOwnPropertyNames(P)) {
    const d = Object.getOwnPropertyDescriptor(P, name);
    if (!d || typeof d.value !== "function" || name === "constructor") continue;
    const f = d.value;
    saved[name] = f;
    const st = (stats[name] = { n: 0, ms: 0 });
    P[name] = function (...args) {
      const t0 = performance.now();
      try {
        return f.apply(this, args);
      } finally {
        st.n++;
        st.ms += performance.now() - t0;
      }
    };
  }
  // 扩展对象上的同步查询也算上（timer query 等）
}
function glCountOff() {
  const P = WebGL2RenderingContext.prototype;
  for (const [name, f] of Object.entries(window.__glSaved || {})) P[name] = f;
  const s = window.__glStats || {};
  window.__glStats = null;
  window.__glSaved = null;
  return s;
}

const SYNC = new Set([
  "getError", "readPixels", "getParameter", "getQueryParameter", "getQuery", "clientWaitSync", "getSyncParameter", "checkFramebufferStatus",
  "getProgramParameter", "getShaderParameter", "getProgramInfoLog", "getShaderInfoLog", "getUniformLocation", "getAttribLocation", "getBufferSubData",
  "getActiveUniform", "getActiveAttrib", "getUniformBlockIndex", "getActiveUniforms", "getFramebufferAttachmentParameter", "getTexParameter",
  "getExtension", "getSupportedExtensions", "isContextLost", "getContextAttributes", "finish", "flush", "getInternalformatParameter", "getIndexedParameter",
]);

async function procCpu(bs) {
  const { processInfo } = await bs.send("SystemInfo.getProcessInfo");
  const out = {};
  for (const p of processInfo) out[`${p.type}#${p.id}`] = { type: p.type, cpu: p.cpuTime };
  return out;
}

// Windows：按线程取 CPU 时间（秒），看 GPU / 渲染进程里到底是哪几个线程在转
function threadCpu(pids) {
  if (process.platform !== "win32" || !pids.length) return {};
  const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "lib", "thread-cpu.ps1"), "-Pids", pids.join(",")], { encoding: "utf8" });
  const r = {};
  for (const line of out.split(/\r?\n/)) {
    const [p, t, s, n] = line.split("\t");
    if (s) {
      r[`${p}:${t}`] = Number(s);
      threadNames[`${p}:${t}`] = (n || "").trim();
    }
  }
  return r;
}
const threadNames = {};

function diffThreads(a, b, sec, typeOfPid, top = 8) {
  const rows = [];
  for (const [k, v] of Object.entries(b)) {
    const d = v - (a[k] ?? 0);
    if (d > 0.005 * sec) rows.push({ thread: k, type: typeOfPid[k.split(":")[0]] ?? "?", name: threadNames[k] || "", pct: +((d / sec) * 100).toFixed(1) });
  }
  return rows.sort((x, y) => y.pct - x.pct).slice(0, top);
}

function diffProc(a, b, sec) {
  const byType = {};
  for (const [k, v] of Object.entries(b)) {
    const d = v.cpu - (a[k]?.cpu ?? 0);
    byType[v.type] = (byType[v.type] ?? 0) + d;
  }
  const r = {};
  for (const [t, d] of Object.entries(byType)) r[t] = +((d / sec) * 100).toFixed(1);
  return r;
}

function aggregateProfile(profile, frames, top) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const { samples, timeDeltas } = profile;
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]);
    const dt = (timeDeltas[i + 1] ?? timeDeltas[i] ?? 0) / 1000; // ms
    const cf = n.callFrame;
    const file = (cf.url || "").replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    const key = `${cf.functionName || "(anon)"} ${file}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    total += dt;
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
  const idle = rows.filter(([k]) => /^\((idle|program|garbage collector)\)/.test(k));
  return {
    totalMs: total,
    top: rows.filter(([k]) => !/^\(idle\)/.test(k)).slice(0, top).map(([k, ms]) => ({ fn: k, msPerFrame: +(ms / frames).toFixed(3), pct: +((ms / total) * 100).toFixed(1) })),
    special: Object.fromEntries(idle.map(([k, ms]) => [k.split(" ")[0], +(ms / frames).toFixed(3)])),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const [vw, vh] = args.viewport.split("x").map(Number);
  const exe = findChromeExecutable();
  const release = await acquireOrWait(repoRoot, `cpu-prof.mjs（端口 ${args.port}, pid ${process.pid}）`);
  process.on("exit", () => release());
  const browser = await chromium.launch({
    executablePath: exe,
    headless: args.headless,
    args: [
      `--use-angle=${args.angle}`,
      `--window-size=${vw + 16},${vh + 140}`,
      "--window-position=0,0",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  });
  const results = [];
  try {
    const context = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: args.dpr });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !/eox\.at|tiles\.maps|CORS policy|net::ERR_/i.test(m.text())) errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(initScript);
    await page.goto(`http://127.0.0.1:${args.port}/?dev=${Date.now()}${args.query || ""}`, { waitUntil: "commit", timeout: 180000 });
    await page.bringToFront();
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
    const startedAt = Date.now();
    const renderer = await page.evaluate(() => {
      const gl = (window.__glProbes || []).filter((c) => !c.isContextLost()).pop();
      const e = gl && gl.getExtension("WEBGL_debug_renderer_info");
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?";
    });
    console.log(`[cpu-prof] 端口 ${args.port}，${args.headless ? "headless" : "有头"}，${vw}x${vh}@${args.dpr}，渲染器 ${renderer}`);
    const cdp = await context.newCDPSession(page);
    const bs = await browser.newBrowserCDPSession();
    await cdp.send("Performance.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });

    let prevScene = null;
    for (const name of args.scenes.split(",")) {
      // wait<N>：只等 N 秒（看随时间的变化，如启动后的后台编译 / 长时间运行的累积）；same：不重设场景再量一次
      if (/^wait\d+$/.test(name)) {
        await page.waitForTimeout(Number(name.slice(4)) * 1000);
        continue;
      }
      const sc = name === "same" ? null : sceneOf(name);
      prevScene = name === "same" ? prevScene : name;
      if (sc) {
        const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
        void info;
      }
      await page.bringToFront();
      await page.waitForTimeout(args.warm * 1000);
      const sec = args.seconds;
      // ---- 段 1：帧时间 + 进程 CPU + 剖析 ----
      const m0 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
      const p0 = await procCpu(bs);
      const typeOfPid = Object.fromEntries(Object.values(p0).length ? Object.keys(p0).map((k) => [k.split("#")[1], k.split("#")[0]]) : []);
      const pids = Object.entries(typeOfPid).filter(([, t]) => t === "GPU" || t === "renderer").map(([p]) => p);
      const th0 = threadCpu(pids);
      const tt0 = Date.now();
      await cdp.send("Profiler.start");
      await page.evaluate(() => {
        const r = window.__cpuprof;
        r.t = [];
        r.js = [];
        r.on = true;
      });
      const w0 = Date.now();
      await page.waitForTimeout(sec * 1000);
      const fr = await page.evaluate(() => {
        const r = window.__cpuprof;
        r.on = false;
        return { t: r.t, js: r.js };
      });
      const wall = (Date.now() - w0) / 1000;
      const { profile } = await cdp.send("Profiler.stop");
      const p1 = await procCpu(bs);
      const th1 = threadCpu(pids);
      const threads = diffThreads(th0, th1, (Date.now() - tt0) / 1000, typeOfPid);
      const m1 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
      const frames = Math.max(1, fr.t.length);
      const iv = fr.t.slice(1).map((t, i) => t - fr.t[i]);
      const prof = aggregateProfile(profile, frames, args.top);
      const res = {
        scene: `${prevScene}@${Math.round((w0 - startedAt) / 1000)}s`,
        frames,
        fps: +(frames / wall).toFixed(1),
        rafMedian: +pct(iv, 0.5).toFixed(2),
        rafP95: +pct(iv, 0.95).toFixed(2),
        rafMax: +Math.max(...iv).toFixed(1),
        jsMedian: +pct(fr.js, 0.5).toFixed(2),
        jsP95: +pct(fr.js, 0.95).toFixed(2),
        mainTaskPct: +(((m1.TaskDuration - m0.TaskDuration) / wall) * 100).toFixed(1),
        mainScriptPct: +(((m1.ScriptDuration - m0.ScriptDuration) / wall) * 100).toFixed(1),
        procCpuPct: diffProc(p0, p1, wall),
        threads,
        profile: prof,
      };
      // ---- 段 2：WebGL 调用统计（单独开，计数有开销）----
      if (args.gl) {
        await page.evaluate(() => {
          window.__cpuprof.t = [];
          window.__cpuprof.js = [];
          window.__cpuprof.on = true;
        });
        await page.evaluate(glCountOn);
        await page.waitForTimeout(3000);
        const stats = await page.evaluate(glCountOff);
        const gf = await page.evaluate(() => {
          window.__cpuprof.on = false;
          return window.__cpuprof.t.length;
        });
        const n = Math.max(1, gf);
        const rows = Object.entries(stats)
          .filter(([, s]) => s.n > 0)
          .map(([k, s]) => ({ fn: k, perFrame: +(s.n / n).toFixed(2), msPerFrame: +(s.ms / n).toFixed(3), sync: SYNC.has(k) }))
          .sort((a, b) => b.perFrame - a.perFrame);
        const sum = (f) => +rows.filter(f).reduce((x, r) => x + r.perFrame, 0).toFixed(1);
        res.gl = {
          frames: n,
          totalCallsPerFrame: sum(() => true),
          totalMsPerFrame: +rows.reduce((x, r) => x + r.msPerFrame, 0).toFixed(3),
          draws: sum((r) => /^draw/.test(r.fn)),
          uniforms: sum((r) => /^uniform/.test(r.fn)),
          top: rows.slice(0, 30),
          sync: rows.filter((r) => r.sync),
          bySlowest: [...rows].sort((a, b) => b.msPerFrame - a.msPerFrame).slice(0, 12),
        };
      }
      results.push(res);
      printResult(res);
    }
    if (errors.length) console.log(`[cpu-prof] console error ${errors.length} 条：\n  ${errors.slice(0, 8).join("\n  ")}`);
    else console.log("[cpu-prof] 期间 console error 0 条");
  } finally {
    await closeBrowserSafely(browser);
    release();
  }
  if (args.out) {
    const out = resolveRepoPath(repoRoot, args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(results, null, 1));
    console.log(`[cpu-prof] 写出 ${out}`);
  }
}

function printResult(r) {
  console.log(`\n=== ${r.scene} ===`);
  console.log(
    `帧 ${r.frames}（${r.fps} fps）rAF 间隔中位 ${r.rafMedian} ms / p95 ${r.rafP95} / 最大 ${r.rafMax}；主循环 JS 中位 ${r.jsMedian} ms / p95 ${r.jsP95}`,
  );
  console.log(`主线程忙 ${r.mainTaskPct}%（其中脚本 ${r.mainScriptPct}%）；进程 CPU（100% = 一核）${JSON.stringify(r.procCpuPct)}`);
  console.log(`最忙线程（进程:线程 类型 %）：${r.threads.map((t) => `${t.type}/${t.name || t.thread} ${t.pct}`).join("，")}`);
  console.log(`剖析：GC ${r.profile.special["(garbage"] ?? 0} ms/帧、(program) ${r.profile.special["(program)"] ?? 0} ms/帧`);
  for (const t of r.profile.top) console.log(`  ${t.msPerFrame.toFixed(3).padStart(7)} ms/帧 ${String(t.pct).padStart(5)}%  ${t.fn}`);
  if (r.gl) {
    const g = r.gl;
    console.log(`WebGL：每帧 ${g.totalCallsPerFrame} 次调用（draw ${g.draws}、uniform ${g.uniforms}），调用内合计 ${g.totalMsPerFrame} ms/帧`);
    console.log("  次数前列：" + g.top.slice(0, 18).map((x) => `${x.fn} ${x.perFrame}`).join("，"));
    console.log("  耗时前列：" + g.bySlowest.map((x) => `${x.fn} ${x.msPerFrame}ms×${x.perFrame}`).join("，"));
    console.log("  同步类：" + (g.sync.map((x) => `${x.fn} ${x.perFrame}/帧 ${x.msPerFrame}ms`).join("，") || "无"));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
