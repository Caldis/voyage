// W-LAMP：机翼灯光的同页 A/B 工具（由 W-STAIR-diag.mjs 改来）。同一页面、同一冻结时刻，依次套用若干「变体」
// （一段 js：改 uniform、换机翼着色器原文等），每个变体截整屏 + 若干放大区；可选把 hdrWing 读回存盘。
// 与 W-STAIR-diag 的不同：
//   - 冻结后等 ground.pending === 0 再多等 30 帧（DEV_SOP 测量约定），闪电钉灭；
//   - 变体可带 "hdr": "rgb" 把 hdrWing 整张（自上而下、RGB f32）存成 <变体>/hdr_<w>x<h>.f32；
//   - --base <端口>：从对照服务器读机翼着色器原文，变体里 __wsPatch([], __wsBase) 整段换上；
//   - --live <job 名>：不冻结，飞机照常飞，页面里每个 rAF（主循环渲染之后）readPixels 一块裁剪区，
//     只留频闪亮的帧（uStrobe > 0.5），存成 live_<变体>.u8（每帧 w*h*4 字节，自上而下），见 jobs 里的 live 字段。
// 用法：node handoff/W-LAMP-ab.mjs --port 5232 [--base 5292] --out D:/.../dir --jobs jobs.json
// jobs.json：[{ name, scene: 场景名或场景对象, offset?, zoom?: [[x,y,w,h]], variants: [{ name, js, hdr? }],
//              compare?: [[a, b, mask]], live?: { crop: [x,y,w,h], frames: 600, variants: ["old","new"] } }]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VOYAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(VOYAGE, "package.json"));
const { chromium } = require("playwright-core");
const { DEFAULTS, SCENES, applyScene, pinGeometry } = await import(pathToFileURL(path.join(VOYAGE, "scripts/scenarios.mjs")).href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(path.join(VOYAGE, "scripts/lib/chrome.mjs")).href);
const { readLock, waitForRelease } = await import(pathToFileURL(path.join(VOYAGE, "scripts/lib/measure-lock.mjs")).href);

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const port = arg("port", "5232"), OUT = arg("out");
const jobs = JSON.parse(fs.readFileSync(arg("jobs"), "utf-8"));
const only = arg("only") ? arg("only").split(",") : null;
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("[wlamp]", ...a);

const repoRoot = path.resolve(VOYAGE, "../..");
// 截图不受别人测量的影响，只有带 bench 的 job（计时）才等测量锁（同 dev-browser shots 的约定：查锁只提示）
if (readLock(repoRoot)) {
  if (jobs.some((j) => j.bench)) { log("测量锁存在，等待释放（有计时 job）"); await waitForRelease(repoRoot, { log }); }
  else log("测量锁存在（别的代理在计时），本次只截图、不计时，不等");
}

const browser = await launchBrowser(chromium, { angle: arg("angle", "d3d11") });
let errCount = 0;
try {
  let baseSrc = null;
  if (arg("base")) {
    const bctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    const bp = await bctx.newPage();
    await bp.goto(`http://127.0.0.1:${arg("base")}/`, { waitUntil: "commit", timeout: 180000 });
    await bp.waitForFunction(() => window.__voyage?.wingMat, null, { timeout: 300000, polling: 500 });
    baseSrc = await bp.evaluate(() => window.__voyage.wingMat.fragmentShader);
    await bctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { errCount++; log("pageerror", e.message); });
  page.on("console", (m) => { if (m.type() === "error" && !/eox|ERR_FAILED|CORS/.test(m.text())) { errCount++; log("console.error", m.text().slice(0, 400)); } });
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();
  log("GL_RENDERER", await page.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; }));
  await page.evaluate(() => { const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; });
  if (baseSrc) {
    const same = await page.evaluate((s) => { window.__wsBase = s; return s === window.__voyage.wingMat.fragmentShader; }, baseSrc);
    log("对照着色器与本分支相同？", same);
  }
  await page.evaluate(() => {
    const v = window.__voyage;
    window.__wsOrig = v.wingMat.fragmentShader;
    window.__wsMats = () => [v.wingMat, v.wingVariant.wet].filter(Boolean);
    window.__wsOrigDbg = { d: v.sceneMat.uniforms.uWingDebug.value, e: v.sceneMat.uniforms.uWingEdgeAA.value };
    window.__wsPatch = (pairs, src) => {
      let s = src ?? window.__wsOrig;
      for (const [a, b] of pairs) {
        if (!s.includes(a)) throw new Error("patch 找不到：" + a.slice(0, 80));
        s = s.split(a).join(b);
      }
      for (const m of window.__wsMats()) { m.fragmentShader = s; m.needsUpdate = true; }
    };
    // 换着色器并等编好（链接失败直接报错）
    window.__wsApply = async (js) => {
      for (const m of window.__wsMats()) if (m.fragmentShader !== window.__wsOrig) { m.fragmentShader = window.__wsOrig; m.needsUpdate = true; }
      v.sceneMat.uniforms.uWingDebug.value = window.__wsOrigDbg.d;
      v.sceneMat.uniforms.uWingEdgeAA.value = window.__wsOrigDbg.e;
      await (new Function("v", `return (async () => { ${js} })()`))(v);
      const renderer = v.clouds.pass.renderer, P = v.clouds.pass;
      for (const m of window.__wsMats()) {
        const prevMat = P.mesh.material, prevT = renderer.getRenderTarget();
        P.mesh.material = m;
        renderer.setRenderTarget(v.hdrWing);
        await renderer.compileAsync(P.scene, P.camera);
        P.mesh.material = prevMat;
        renderer.setRenderTarget(prevT);
      }
      for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
      for (const m of window.__wsMats()) {
        const dg = renderer.properties.get(m)?.currentProgram?.diagnostics;
        if (dg && dg.runnable === false) throw new Error("机翼着色器编译失败：" + (dg.fragmentShader.log || dg.programLog));
      }
    };
  });
  for (const j of jobs) {
    if (only && !only.includes(j.name)) continue;
    let sc = typeof j.scene === "string" ? SCENES.find((x) => x.name === j.scene) : j.scene;
    if (j.offset) sc = { ...sc, offset: j.offset };
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: !!sc.ground });
    await page.evaluate(pinGeometry, sc);
    if (j.live) {
      // 飞行中：不冻结，频闪按正常节奏闪；每个变体录 frames 帧，只留频闪亮的帧
      for (const vn of j.live.variants) {
        const vr = j.variants.find((x) => x.name === vn);
        await page.evaluate(async (js) => { window.__voyage.wingDebug.strobe = null; await window.__wsApply(js); window.__voyage.wingDebug.strobe = null; }, vr.js ?? "");
        const res = await page.evaluate(async ({ crop, frames }) => {
          const v = window.__voyage;
          const gl = v.clouds.pass.renderer.getContext();
          const [x, y, w, h] = crop;
          const H = gl.drawingBufferHeight;
          const out = [];
          const buf = new Uint8Array(w * h * 4);
          let lit = 0;
          for (let f = 0; f < frames; f++) {
            await new Promise((r) => requestAnimationFrame(r));   // 主循环的回调先于本回调注册，这里读到的是本帧画好的画面
            if (v.sceneMat.uniforms.uStrobe.value < 0.5) continue;
            lit++;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.readPixels(x, H - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            const flip = new Uint8Array(w * h * 4);
            for (let r = 0; r < h; r++) flip.set(buf.subarray((h - 1 - r) * w * 4, (h - r) * w * 4), r * w * 4);
            let s = ""; for (let i = 0; i < flip.length; i += 0x8000) s += String.fromCharCode.apply(null, flip.subarray(i, i + 0x8000));
            out.push(btoa(s));
          }
          return { lit, frames: out };
        }, j.live);
        const bufs = res.frames.map((b) => Buffer.from(b, "base64"));
        fs.mkdirSync(path.join(OUT, j.name), { recursive: true });
        fs.writeFileSync(path.join(OUT, j.name, `live_${vn}_${j.live.crop[2]}x${j.live.crop[3]}.u8`), Buffer.concat(bufs));
        log(j.name, "live", vn, "频闪帧", res.lit);
      }
      continue;
    }
    await page.evaluate(async () => {
      const v = window.__voyage;
      for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 600 && v.wingVariant.state === "compiling"; i++) await new Promise((r) => requestAnimationFrame(r));
      window.__wsT0 = performance.now();
      const pn = performance.now; performance.now = () => window.__wsT0;
      try { v.freeze(true); } finally { performance.now = pn; }
      v.wingDebug.strobe = 0;
      for (let i = 0; i < 1200 && v.ground.pending > 0; i++) await new Promise((r) => setTimeout(r, 100));
      for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
    });
    const pend = await page.evaluate(() => window.__voyage.ground.pending);
    for (const vr of j.variants) {
      const dir = path.join(OUT, j.name, vr.name);
      fs.mkdirSync(dir, { recursive: true });
      await page.evaluate(async (js) => { window.__voyage.wingDebug.strobe = 0; await window.__wsApply(js); for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r)); }, vr.js ?? "");
      await page.screenshot({ path: path.join(dir, "full.png") });
      for (let z = 0; z < (j.zoom ?? []).length; z++) {
        const c = j.zoom[z];
        await page.screenshot({ path: path.join(dir, `z${z}.png`), clip: { x: c[0], y: c[1], width: c[2], height: c[3] } });
      }
      if (j.bench) {
        const ms = await page.evaluate(() => { const r = []; for (let i = 0; i < 7; i++) r.push(window.__voyage.benchWing(30)); return r.sort((a, b) => a - b); });
        const rec = { job: j.name, variant: vr.name, median: +ms[3].toFixed(4), min: +ms[0].toFixed(4) };
        log("计时", JSON.stringify(rec));
        fs.appendFileSync(path.join(OUT, "bench.jsonl"), JSON.stringify(rec) + "\n");
      }
      if (vr.hdr || j.compare) {
        const b64 = await page.evaluate(({ keep, name, want }) => {
          const v = window.__voyage;
          const t = v.hdrWing;
          const W = t.width, H = t.height;
          const buf = new Float32Array(W * H * 4);
          v.clouds.pass.renderer.readRenderTargetPixels(t, 0, 0, W, H, buf);
          if (keep) (window.__wsBufs ??= {})[name] = buf;
          if (!want) return null;
          const rgb = new Float32Array(W * H * 3);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const s = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 3;
            rgb[d] = buf[s]; rgb[d + 1] = buf[s + 1]; rgb[d + 2] = buf[s + 2];
          }
          const bytes = new Uint8Array(rgb.buffer);
          let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return { w: W, h: H, d: btoa(s) };
        }, { keep: !!j.compare, name: vr.name, want: !!vr.hdr });
        if (b64) fs.writeFileSync(path.join(dir, `hdr_${b64.w}x${b64.h}.f32`), Buffer.from(b64.d, "base64"));
      }
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ pendingAtFreeze: pend, pending: await page.evaluate(() => window.__voyage.ground.pending), errCount, quality: await page.evaluate(() => ({ tier: window.__voyage.quality.tier, level: window.__voyage.quality.level })) }));
      log(j.name, vr.name, "完成");
    }
    // compare: [[a, b, mask]]：mask 变体（不画机翼）与 b 逐位相同的像素算「非机翼」，报告这些像素上 a 与 b 的差
    for (const [a, b, mk] of j.compare ?? []) {
      const r = await page.evaluate(({ a, b, mk }) => {
        const A = window.__wsBufs[a], B = window.__wsBufs[b], M = mk ? window.__wsBufs[mk] : null;
        const pts = []; let nonWing = 0, nonWingDiffPx = 0, nonWingMax = 0, diffPx = 0, maxAll = 0;
        for (let p = 0; p < A.length; p += 4) {
          let d = 0, isNon = !!M;
          for (let c = 0; c < 4; c++) {
            d = Math.max(d, Math.abs(A[p + c] - B[p + c]));
            if (M && M[p + c] !== B[p + c]) isNon = false;
          }
          if (d > 0) { diffPx++; maxAll = Math.max(maxAll, d); }
          if (isNon) { nonWing++; if (d > 0) { nonWingDiffPx++; nonWingMax = Math.max(nonWingMax, d); if (pts.length < 12) { const q = p / 4, W = window.__voyage.hdrWing.width, H = window.__voyage.hdrWing.height; pts.push([q % W, H - 1 - Math.floor(q / W), +d.toPrecision(3)]); } } }
        }
        return { a, b, mask: mk, nonWing, nonWingDiffPx, nonWingMax, diffPx, maxAll, nonWingPts: pts };
      }, { a, b, mk });
      log(j.name, "对照", JSON.stringify(r));
      fs.appendFileSync(path.join(OUT, "compare.jsonl"), JSON.stringify({ job: j.name, ...r }) + "\n");
    }
    await page.evaluate(() => { window.__wsBufs = {}; window.__voyage.freeze(false); window.__voyage.wingDebug.strobe = null; });
  }
  log("console error 计数", errCount);
  await ctx.close();
} finally {
  await closeBrowserSafely(browser);
}
