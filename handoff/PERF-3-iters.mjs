#!/usr/bin/env node
// PERF-3：统计机翼 pass 里 sdWing 的调用次数（= wingTrace 循环的迭代数），看边缘超采样的活花在哪。
// 页面里给机翼材质打补丁：中心射线 / 子射线各记迭代数，写进机翼 HDR 目标后读回（浮点），按像素和 8×4 块（≈ 一个 warp）统计。
// 用法：node handoff/PERF-3-iters.mjs --port 5243 [--only a,b] [--eval 'js']
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) { args[a.slice(2)] = process.argv[i + 1]; i++; }
}
const port = args.port || 5243;
const names = args.only ? String(args.only).split(",") : ["sunset-wing", "noon-cumulus", "in-cloud", "night-city", "route-hnd-cts"];

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`[控制台 error] ${m.text().slice(0, 400)}`); });
  await page.addInitScript(() => {
    const P = WebGL2RenderingContext.prototype;
    const len = new WeakMap();
    const oSS = P.shaderSource, oAS = P.attachShader, oUP = P.useProgram, oDA = P.drawArrays, oBF = P.bindFramebuffer;
    let prog = null, fb = null;
    P.shaderSource = function (s, src) { len.set(s, src.includes("gIterMark") ? 1 : 0); return oSS.call(this, s, src); };
    P.attachShader = function (p, sh) { p.__mark = (p.__mark || 0) + (len.get(sh) || 0); return oAS.call(this, p, sh); };
    P.bindFramebuffer = function (t, f) { if (t === this.FRAMEBUFFER || t === this.DRAW_FRAMEBUFFER) fb = f; return oBF.call(this, t, f); };
    P.useProgram = function (p) { prog = p; return oUP.call(this, p); };
    P.drawArrays = function (...a) { if (prog && prog.__mark) { window.__wingFb = fb; window.__gl = this; } return oDA.apply(this, a); };
  });
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const ok = await page.evaluate(() => {
    const m = window.__voyage.wingMat;
    let s = m.fragmentShader;
    const rep = (a, b) => { if (!s.includes(a)) throw new Error("补丁找不到：" + a); s = s.replace(a, b); };
    rep("WingTraceResult wingTrace(", "int gWingIter = 0; int gIterC = 0; float gEdgeHit = 0.0; // gIterMark\nWingTraceResult wingTrace(");
    rep("float d = sdWing(q);", "float d = sdWing(q); gWingIter++;");
    // 中心射线结束时记下迭代数（新旧两版 wingView 的锚点不同）
    if (s.includes("shC = w.shadow;")) rep("float c = single > 0.5 ? w.cov : step(1.0, w.cov);", "if (k == 0) gIterC = gWingIter; float c = single > 0.5 ? w.cov : step(1.0, w.cov);");
    else rep("if (k > 0) w.shadow = sh0;", "if (k == 0) gIterC = gWingIter; if (k > 0) w.shadow = sh0;");
    rep("single = 0.0;", "single = 0.0; gEdgeHit = 1.0;");
    // 子射线的结局：打中 / 出了包围盒 / 步数用完，各自的迭代数（B = 边缘标记 + 2 × 打中的迭代和；A = 出盒迭代和 + 300 × 用完迭代和）
    rep("int gWingIter = 0;", "int gWingIter = 0; float gHits = 0.0, gHitIt = 0.0, gExits = 0.0, gExitIt = 0.0, gLims = 0.0, gLimIt = 0.0;");
    rep("w.edge = grazed;", "w.edge = grazed; if (marchSteps != uWingSteps) { gHits += 1.0; gHitIt += float(i + 1); }");
    // 新版：步数用完被「提升」的子射线也算打中
    if (s.includes("w.promoted = true;")) rep("w.promoted = true;", "w.promoted = true; gHits += 1.0; gHitIt += float(i + 1);");
    rep("if (!extend && (t > tExit || i >= limit - 1)) {", "if (!extend && (t > tExit || i >= limit - 1)) { if (marchSteps != uWingSteps) { if (t > tExit) { gExits += 1.0; gExitIt += float(i + 1); } else { gLims += 1.0; gLimIt += float(i + 1); } }");
    rep("gl_FragColor = vec4(min(col, vec3(uHdrMax)), sc.a);", "gl_FragColor = wing.a > 0.0 ? vec4(-float(gIterC) - 1.0, float(gWingIter - gIterC) + 1000.0 * (gHits * 100.0 + gExits * 10.0 + gLims), gEdgeHit + 2.0 * gHitIt, gExitIt + 300.0 * gLimIt) : vec4(1.0);");
    m.fragmentShader = s;
    m.needsUpdate = true;
    return true;
  });
  console.log("补丁", ok);
  for (const nm of names) {
    const sc = pickScenes([nm])[0];
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    await page.evaluate(() => { window.__voyage.state.turbulence = 0; });
    if (args.eval) await page.evaluate(String(args.eval));
    await page.evaluate(() => window.__voyage.benchFrame(3));
    const r = await page.evaluate(() => {
      const gl = window.__gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, window.__wingFb);
      const W = 1600, H = 1200;
      const buf = new Float32Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const D = [0, 0, 0, 0, 0, 0];   // 边缘像素上子射线：打中条数、出盒条数、用完条数，及各自迭代和
      let wing = 0, edge = 0, sumC = 0, sumCe = 0, sumS = 0;
      const hist = new Array(8).fill(0);    // 子射线迭代数分布：0–19, 20–39, …
      const tiles = new Map();              // 块 → [最大迭代, 迭代和, 像素数, 有无边缘]
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (buf[i] >= 0.0) continue;
        const c = -buf[i] - 1, G = buf[i + 1], s = G % 1000, pk = Math.floor(G / 1000), e = buf[i + 2] % 2 > 0.5;
        wing++;
        sumC += c;
        if (e) {
          D[0] += Math.floor(pk / 100); D[1] += Math.floor(pk / 10) % 10; D[2] += pk % 10;
          D[3] += Math.floor(buf[i + 2] / 2); D[4] += buf[i + 3] % 300; D[5] += Math.floor(buf[i + 3] / 300);
          edge++; sumCe += c; sumS += s; hist[Math.min(7, Math.floor(s / 20))]++; }
        const t = (y >> 2) * 400 + (x >> 3);
        const a = tiles.get(t) || [0, 0, 0, false];
        a[0] = Math.max(a[0], c + s); a[1] += c + s; a[2]++; a[3] = a[3] || e;
        tiles.set(t, a);
      }
      // warp 成本 ≈ 块内最大迭代 × 32；边缘块的「额外」= 边缘块的最大迭代 − 同样块里不算子射线时的最大（近似用非边缘块的平均最大）
      let maxE = 0, nE = 0, maxN = 0, nN = 0;
      for (const a of tiles.values()) { if (a[3]) { maxE += a[0]; nE++; } else { maxN += a[0]; nN++; } }
      return { D, wing, edge, meanC: sumC / wing, meanCe: sumCe / Math.max(edge, 1), meanS: sumS / Math.max(edge, 1), hist, tilesE: nE, tiles: nE + nN, warpMaxE: maxE / Math.max(nE, 1), warpMaxN: maxN / Math.max(nN, 1) };
    });
    const [h, x, l, hi, xi, li] = r.D;
    const per = (a, b) => (b > 0 ? a / b : 0).toFixed(1);
    console.log(`${nm.padEnd(14)} 子射线结局（每个边缘像素平均条数 / 每条平均步数）：打中 ${(h / r.edge).toFixed(2)} / ${per(hi, h)}，` +
      `出包围盒 ${(x / r.edge).toFixed(2)} / ${per(xi, x)}，步数用完 ${(l / r.edge).toFixed(2)} / ${per(li, l)}`);
    console.log(`${nm.padEnd(14)} 机翼像素 ${r.wing}，边缘 ${r.edge}；中心射线平均迭代 ${r.meanC.toFixed(1)}（边缘像素上 ${r.meanCe.toFixed(1)}），子射线合计平均 ${r.meanS.toFixed(1)}；` +
      `子射线迭代分布（每 20 一档）${r.hist.join("/")}；含边缘的块 ${r.tilesE}/${r.tiles}，块内最大迭代 均值：含边缘 ${r.warpMaxE.toFixed(1)}，不含 ${r.warpMaxN.toFixed(1)}`);
  }
} finally {
  await closeBrowserSafely(browser);
}
