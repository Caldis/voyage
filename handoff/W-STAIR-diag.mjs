// W-STAIR：机翼边阶梯的诊断 / A/B 工具。同一页面、同一冻结时刻，依次套用若干「变体」（一段 js：改 uniform、
// 换机翼着色器原文等），每个变体截整屏 + 若干放大区，并把 hdrWing 整张读回存成 .f32（给非机翼区逐位对照用）。
// 用法：node handoff/W-STAIR-diag.mjs --port 5213 --out D:/.../dir --jobs jobs.json [--hdr] [--motion N]
// jobs.json：[{ name, scene: 场景名或场景对象, offset?: [x,y], zoom: [[x,y,w,h],...], variants: [{ name, js }] }]
//   变体 js 在页面里执行，可用 v = window.__voyage；执行后渲染 4 帧再截图。每个变体前先恢复原始机翼着色器与调试 uniform。
// --motion N：每个变体再按 0.06 mm 步进移动头部 N 帧，连拍放大区（z<k>_m<i>.png），看运动时的闪烁。
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
const port = arg("port", "5213"), OUT = arg("out");
const jobs = JSON.parse(fs.readFileSync(arg("jobs"), "utf-8"));
const wantHdr = argv.includes("--hdr");
const motion = Number(arg("motion", "0"));
const baseSrcFile = arg("base-src");   // 可选：一个文件，内容是替换用的机翼着色器原文（变体里用 window.__wsBase 取）
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("[wstair]", ...a);

const repoRoot = path.resolve(VOYAGE, "../..");
if (readLock(repoRoot)) { log("测量锁存在，等待释放"); await waitForRelease(repoRoot, { log }); }

const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  // --base <端口>：先从对照服务器的活页面读出机翼着色器原文，变体里用 __wsPatch([], __wsBase) 整段换上（同页 A/B）
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
  page.on("pageerror", (e) => log("pageerror", e.message));
  page.on("console", (m) => m.type() === "error" && !/eox|ERR_FAILED|CORS/.test(m.text()) && log("console.error", m.text().slice(0, 400)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();
  const q = await page.evaluate(() => ({ q: window.__voyage.quality?.level ?? window.__voyage.quality?.current ?? "?", dpr: window.devicePixelRatio }));
  log("画质", JSON.stringify(q));
  if (baseSrcFile) baseSrc = fs.readFileSync(baseSrcFile, "utf-8");
  if (baseSrc) {
    const same = await page.evaluate((s) => { window.__wsBase = s; return s === window.__voyage.wingMat.fragmentShader; }, baseSrc);
    log("对照着色器与本分支相同？", same);
  }
  await page.evaluate(() => {
    const v = window.__voyage;
    window.__wsOrig = v.wingMat.fragmentShader;
    // 机翼 pass 实际画的材质：窗上有水（云里）时是湿窗变体 wingVariant.wet（与 wingMat 同一段原文 + WING_WET），两个都改
    window.__wsMats = () => [v.wingMat, v.wingVariant.wet].filter(Boolean);
    window.__wsOrigDbg = { d: v.sceneMat.uniforms.uWingDebug.value, e: v.sceneMat.uniforms.uWingEdgeAA.value };
    // 变体里用：按 [查找, 替换] 对改机翼着色器原文（找不到就报错）
    window.__wsPatch = (pairs, src) => {
      let s = src ?? window.__wsOrig;
      for (const [a, b] of pairs) {
        if (!s.includes(a)) throw new Error("patch 找不到：" + a.slice(0, 80));
        s = s.split(a).join(b);
      }
      for (const m of window.__wsMats()) { m.fragmentShader = s; m.needsUpdate = true; }
    };
  });
  for (const j of jobs) {
    let sc = typeof j.scene === "string" ? SCENES.find((x) => x.name === j.scene) : j.scene;
    if (j.offset) sc = { ...sc, offset: j.offset };
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: !!sc.ground });
    await page.evaluate(pinGeometry, sc);
    if (j.pre) await page.evaluate(`(async () => { const v = window.__voyage; ${j.pre} })()`);
    await page.evaluate(async () => {
      for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
      // 湿窗变体（云里）编好再冻结，免得冻结期间换程序
      for (let i = 0; i < 600 && window.__voyage.wingVariant.state === "compiling"; i++) await new Promise((r) => requestAnimationFrame(r));
      window.__wsT0 = performance.now();
      const pn = performance.now; performance.now = () => window.__wsT0;
      try { window.__voyage.freeze(true); } finally { performance.now = pn; }
      window.__voyage.wingDebug.strobe = 0;
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    });
    for (const vr of j.variants) {
      const dir = path.join(OUT, j.name, vr.name);
      fs.mkdirSync(dir, { recursive: true });
      await page.evaluate(async (js) => {
        const v = window.__voyage;
        for (const m of window.__wsMats()) if (m.fragmentShader !== window.__wsOrig) { m.fragmentShader = window.__wsOrig; m.needsUpdate = true; }
        v.sceneMat.uniforms.uWingDebug.value = window.__wsOrigDbg.d;
        v.sceneMat.uniforms.uWingEdgeAA.value = window.__wsOrigDbg.e;
        v.wingDebug.strobe = 0;
        await (new Function("v", `return (async () => { ${js} })()`))(v);
        // 等机翼程序真正编好（同 scripts/probe.mjs 的 compileWait），链接失败直接报错
        const renderer = v.clouds.pass.renderer, P = v.clouds.pass;
        for (const m of window.__wsMats()) {
          const prevMat = P.mesh.material, prevT = renderer.getRenderTarget();
          P.mesh.material = m;
          renderer.setRenderTarget(v.hdrWing);
          await renderer.compileAsync(P.scene, P.camera);
          P.mesh.material = prevMat;
          renderer.setRenderTarget(prevT);
        }
        for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
        for (const m of window.__wsMats()) {
          const dg = renderer.properties.get(m)?.currentProgram?.diagnostics;
          if (dg && dg.runnable === false) throw new Error("机翼着色器编译失败：" + (dg.fragmentShader.log || dg.programLog));
        }
      }, vr.js ?? "");
      await page.screenshot({ path: path.join(dir, "full.png") });
      if (j.bench) {
        // 机翼 pass 批渲计时（main.ts 的 benchWing：连渲 N 次再读回 1 像素）；每次 30 帧，取 7 次的中位数与最小值
        const ms = await page.evaluate(() => { const r = []; for (let i = 0; i < 7; i++) r.push(window.__voyage.benchWing(30)); return r.sort((a, b) => a - b); });
        const rec = { job: j.name, variant: vr.name, median: +ms[3].toFixed(4), min: +ms[0].toFixed(4), all: ms.map((x) => +x.toFixed(4)) };
        log("计时", JSON.stringify(rec));
        fs.appendFileSync(path.join(OUT, "bench.jsonl"), JSON.stringify(rec) + "\n");
      }
      for (let z = 0; z < (j.zoom ?? []).length; z++) {
        const c = j.zoom[z];
        await page.screenshot({ path: path.join(dir, `z${z}.png`), clip: { x: c[0], y: c[1], width: c[2], height: c[3] } });
      }
      if (wantHdr) {
        const b64 = await page.evaluate(() => {
          const v = window.__voyage;
          const t = v.hdrWing;
          const buf = new Float32Array(t.width * t.height * 4);
          v.clouds.pass.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
          // 场景 pass 的输入也一起存（非机翼区应等于它）
          const bytes = new Uint8Array(buf.buffer);
          let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return { w: t.width, h: t.height, d: btoa(s) };
        });
        fs.writeFileSync(path.join(dir, `hdrWing_${b64.w}x${b64.h}.f32`), Buffer.from(b64.d, "base64"));
      }
      if (j.compare) {
        // 页面里留一份 hdrWing，给本 job 末尾的逐位对照用
        await page.evaluate((vn) => {
          const v = window.__voyage;
          const t = v.hdrWing;
          const buf = new Float32Array(t.width * t.height * 4);
          v.clouds.pass.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
          (window.__wsBufs ??= {})[vn] = buf;
        }, vr.name);
      }
      if (motion > 0) {
        for (let f = 0; f < motion; f++) {
          await page.evaluate(async () => {
            const v = window.__voyage;
            v.head.x += 0.00006; if ("tx" in v.head) v.head.tx = v.head.x;
            for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
          });
          for (let z = 0; z < (j.zoom ?? []).length; z++) {
            const c = j.zoom[z];
            await page.screenshot({ path: path.join(dir, `z${z}_m${String(f).padStart(2, "0")}.png`), clip: { x: c[0], y: c[1], width: c[2], height: c[3] } });
          }
        }
        await page.evaluate(async (n) => { const v = window.__voyage; v.head.x -= 0.00006 * n; if ("tx" in v.head) v.head.tx = v.head.x; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); }, motion);
      }
      log(j.name, vr.name, "完成");
    }
    // compare: [[a, b, mask], ...]：mask 变体（不画机翼）与 b 逐位相同的像素算「非机翼」，报告这些像素上 a 与 b 的最大差；
    // 另报全图 a 与 b 不同的像素数、最大差
    for (const [a, b, mk] of j.compare ?? []) {
      const r = await page.evaluate(({ a, b, mk }) => {
        const A = window.__wsBufs[a], B = window.__wsBufs[b], M = mk ? window.__wsBufs[mk] : null;
        let nonWing = 0, nonWingDiffPx = 0, nonWingMax = 0, diffPx = 0, maxAll = 0, wingPx = 0;
        for (let p = 0; p < A.length; p += 4) {
          let d = 0, isNon = !!M;
          for (let c = 0; c < 4; c++) {
            d = Math.max(d, Math.abs(A[p + c] - B[p + c]));
            if (M && M[p + c] !== B[p + c]) isNon = false;
          }
          if (d > 0) { diffPx++; maxAll = Math.max(maxAll, d); }
          if (isNon) { nonWing++; if (d > 0) { nonWingDiffPx++; nonWingMax = Math.max(nonWingMax, d); } }
          else wingPx++;
        }
        return { a, b, mask: mk, pixels: A.length / 4, nonWing, nonWingDiffPx, nonWingMax, wingOrOther: wingPx, diffPx, maxAll };
      }, { a, b, mk });
      log(j.name, "对照", JSON.stringify(r));
      fs.appendFileSync(path.join(OUT, "compare.jsonl"), JSON.stringify({ job: j.name, ...r }) + "\n");
    }
    await page.evaluate(() => { window.__wsBufs = {}; });
    await page.evaluate(() => { window.__voyage.freeze(false); window.__voyage.wingDebug.strobe = null; });
  }
  await ctx.close();
} finally {
  await closeBrowserSafely(browser);
}
