// C11：云 resolve 的同页、同姿态 A/B（改自 C09 审查的 tmp/c09rev-ab.mjs）。
// 页面跑本分支（--port，new）；old = 从对照服务器（--base，master）活页面读出的 resolve 片元着色器原文，整段换上。
// 顺序默认 new → old → new2（new2 是噪声底）。每个变体：
//   1. 换上 resolve 原文，等几帧编好；
//   2. 确定性 HDR：snap + frame 清零，零运动手动推进云（生产的 blend 0.12 + 邻域夹取）预热 96 帧，
//      读 64 帧云缓冲裁剪区 → relStd / relLow16（逐像素时间相对标准差、16 帧块平均后的低频波动）；
//      同时把第 96 帧（预热完）整张云缓冲左半的 RGBA 存下，跨变体比最大差 / 平均差（云外应逐位为 0）；
//   3. 全冻结（云也不再画）截一张整屏 det.png：跨变体逐像素比，云外应为 0；
//   4. cloudLive：真实 rAF 跑 48 帧后连拍 16 张裁剪截图（每张隔 2 帧），给 C11_metrics.py 算相邻像素差 / 对角高频 / 显示 relStd。
// 用法：node handoff/C11-ab.mjs --port 5211 --base 5271 --out D:/.../ab --jobs jobs.json [--variants new,old,new2]
// jobs.json：[{ name, scene: 场景名或场景对象, offset?: [x, y], crop: [x, y, w, h], zoom?: [[x, y, w, h], ...] }]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VOYAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(VOYAGE, "package.json"));
const { chromium } = require("playwright-core");
const { DEFAULTS, SCENES, applyScene, pinGeometry } = await import(pathToFileURL(path.join(VOYAGE, "scripts/scenarios.mjs")).href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(path.join(VOYAGE, "scripts/lib/chrome.mjs")).href);

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const port = arg("port", "5211"), base = arg("base", "5271"), OUT = arg("out");
const jobs = JSON.parse(fs.readFileSync(arg("jobs"), "utf-8"));
const VN = arg("variants", "new,old,new2").split(",");
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("[c11]", ...a);

async function open(browser, p) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log(`[${p}] pageerror`, e.message));
  // eox 影像瓦片在 headless 下的跨域报错是已知的，折叠掉
  page.on("console", (m) => m.type() === "error" && !/eox|ERR_FAILED|CORS/.test(m.text()) && log(`[${p}] console.error`, m.text().slice(0, 300)));
  await page.goto(`http://127.0.0.1:${p}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  return { ctx, page };
}
const scOf = (j) => {
  const s = typeof j.scene === "string" ? SCENES.find((x) => x.name === j.scene) : j.scene;
  return j.offset ? { ...s, offset: j.offset } : s;
};

const browser = await launchBrowser(chromium, { angle: "d3d11" });
const summary = [];
try {
  const B = await open(browser, base);
  const oldSrc = await B.page.evaluate(() => window.__voyage.clouds.resolveMat.fragmentShader);
  await B.ctx.close();
  const A = await open(browser, port);
  await A.page.bringToFront();
  const newSrc = await A.page.evaluate(() => window.__voyage.clouds.resolveMat.fragmentShader);
  log("resolve 原文相同？", oldSrc === newSrc);
  for (const j of jobs) {
    const sc = scOf(j);
    await A.page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
    await A.page.evaluate(pinGeometry, sc);
    // 冻结时刻固定（freeze 每调用一次就把 frozenNow 重设成 performance.now()，uTime / 云偏移 / whiteout 会跟着跳一帧）：
    // 整个 job 里所有 freeze 都用同一个时刻，变体之间的时间、偏移、翼尖频闪 / 翼弯都不变
    await A.page.evaluate(() => {
      window.__c11T0 = performance.now();
      window.__c11freeze = (opts) => { const pn = performance.now; performance.now = () => window.__c11T0; try { window.__voyage.freeze(true, opts); } finally { performance.now = pn; } };
      window.__c11freeze({ cloudLive: true });
    });
    // 云影图 / 占据网格换场景后是分帧重建的：先空跑一阵，免得第一个变体量到的是重建中的状态
    await A.page.evaluate(async () => { for (let i = 0; i < 120; i++) await new Promise((r) => requestAnimationFrame(r)); });
    const row = { job: j.name, variants: {} };
    // 没写 offset 的场景：取此刻的云偏移，所有变体都钉在这里
    const offFix = sc.offset ?? await A.page.evaluate(() => { const o = window.__voyage.cloudUniforms.uCloudOffset.value; return [o.x, o.y]; });
    for (const vn of VN) {
      const src = vn.startsWith("old") ? oldSrc : newSrc;
      // 每个变体前都把云偏移 / 头部钉回去（cloudLive 期间云偏移仍会被风带着走）
      await A.page.evaluate(pinGeometry, sc);
      await A.page.evaluate(() => window.__c11freeze({ cloudLive: true }));
      const hdr = await A.page.evaluate(async ({ src, crop, vn, off }) => {
        const v = window.__voyage;
        const m = v.clouds.resolveMat;
        if (m.fragmentShader !== src) { m.fragmentShader = src; m.needsUpdate = true; }
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        for (let i = 0; i < 6; i++) await raf(); // 让新程序编好
        if (off) v.cloudUniforms.uCloudOffset.value.set(off[0], off[1]);
        const off0 = [v.cloudUniforms.uCloudOffset.value.x, v.cloudUniforms.uCloudOffset.value.y];
        const u = v.sceneMat.uniforms;
        const zero = m.uniforms.uMotion.value.clone().set(0, 0, 0);
        v.clouds.snap();
        v.clouds.frame = 0;
        const R = () => v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
        for (let i = 0; i < 96; i++) R();
        let t = v.clouds.history[0];
        const CW = t.width / 2, CH = t.height;
        const whole = new Float32Array(CW * CH * 4);
        v.clouds.pass.renderer.readRenderTargetPixels(t, 0, 0, CW, CH, whole);
        const sx = CW / 1600, sy = CH / 1200;
        const x = Math.round(crop[0] * sx), w = Math.round(crop[2] * sx), h = Math.round(crop[3] * sy), y = Math.round(CH - (crop[1] + crop[3]) * sy);
        const N = w * h, NS = 64, BX = 16;
        const series = [];
        const buf = new Float32Array(N * 4);
        for (let f = 0; f < NS; f++) {
          R();
          t = v.clouds.history[0];
          v.clouds.pass.renderer.readRenderTargetPixels(t, x, y, w, h, buf);
          const L = new Float32Array(N);
          for (let k = 0; k < N; k++) L[k] = 0.2126 * buf[4 * k] + 0.7152 * buf[4 * k + 1] + 0.0722 * buf[4 * k + 2];
          series.push(L);
        }
        let sStd = 0, sLow = 0, sMean = 0, cnt = 0;
        for (let k = 0; k < N; k++) {
          let mm = 0; for (let f = 0; f < NS; f++) mm += series[f][k]; mm /= NS;
          if (mm < 0.02) continue;
          let s2 = 0; for (let f = 0; f < NS; f++) s2 += (series[f][k] - mm) ** 2;
          let l2 = 0, nb = 0;
          for (let f0 = 0; f0 + BX <= NS; f0 += BX) { let a = 0; for (let f = f0; f < f0 + BX; f++) a += series[f][k]; a /= BX; l2 += (a - mm) ** 2; nb++; }
          sStd += Math.sqrt(s2 / NS) / mm; sLow += Math.sqrt(l2 / nb) / mm; sMean += mm; cnt++;
        }
        u.uClouds.value = v.clouds.texture;
        (window.__c11bufs ??= {})[vn] = whole;
        return {
          px: cnt, relStd: cnt ? +(sStd / cnt).toFixed(4) : null, relLow16: cnt ? +(sLow / cnt).toFixed(4) : null, meanHdr: cnt ? +(sMean / cnt).toFixed(3) : null,
          imm: +(m.uniforms.uCloudImmersion?.value ?? v.clouds.whiteout ?? -1).toFixed(3), whiteout: +(v.clouds.whiteout ?? -1).toFixed(3), camDens: +(v.clouds.cameraDensity ?? -1).toFixed(4),
          off0, off: [v.cloudUniforms.uCloudOffset.value.x, v.cloudUniforms.uCloudOffset.value.y],
          // 状态指纹：变体之间这些不该变（变了说明差异来自状态而不是 resolve）
          fp: [v.clouds.marchShown, v.clouds.shadowSlice, v.cloudUniforms.uCloudShadowCenter?.value.toArray().map((x) => +x.toFixed(4)).join(","), u.uHead.value.toArray().map((x) => +x.toFixed(5)).join(",")].join(" | "),
        };
      }, { src, crop: j.crop, vn, off: offFix });
      const dir = path.join(OUT, j.name, vn);
      fs.mkdirSync(dir, { recursive: true });
      // 全冻结（云不再画）截整屏：确定性，跨变体逐像素比
      await A.page.evaluate(async () => {
        const v = window.__voyage;
        window.__c11freeze();
        for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
      });
      await A.page.screenshot({ path: path.join(dir, "det.png") });
      // 实时：云照常渲染
      await A.page.evaluate(async () => {
        const v = window.__voyage;
        window.__c11freeze({ cloudLive: true });
        for (let i = 0; i < 48; i++) await new Promise((r) => requestAnimationFrame(r));
      });
      for (let f = 0; f < 16; f++) {
        await A.page.screenshot({ path: path.join(dir, `f${String(f).padStart(2, "0")}.png`), clip: { x: j.crop[0], y: j.crop[1], width: j.crop[2], height: j.crop[3] } });
        if (j.zoom) for (let z = 0; z < j.zoom.length; z++) {
          const c = j.zoom[z];
          await A.page.screenshot({ path: path.join(dir, `z${z}_f${String(f).padStart(2, "0")}.png`), clip: { x: c[0], y: c[1], width: c[2], height: c[3] } });
        }
        await A.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      }
      await A.page.screenshot({ path: path.join(dir, "full.png") });
      row.variants[vn] = hdr;
      log(j.name, vn, JSON.stringify(hdr));
    }
    // 云缓冲左半跨变体（两两）：最大差 / 平均差 / 非零个数
    row.bufDiff = await A.page.evaluate((VN) => {
      const bufs = window.__c11bufs, out = {};
      for (let i = 0; i < VN.length; i++) for (let k2 = i + 1; k2 < VN.length; k2++) {
        const a = bufs[VN[i]], b = bufs[VN[k2]];
        let mx = 0, sum = 0, nz = 0, rs = 0;
        for (let k = 0; k < a.length; k++) { const d = Math.abs(b[k] - a[k]); if (d > mx) mx = d; sum += d; rs += Math.abs(a[k]); if (d > 0) nz++; }
        out[VN[i] + "-" + VN[k2]] = { max: +mx.toPrecision(4), mean: +(sum / a.length).toPrecision(4), meanRef: +(rs / a.length).toPrecision(4), nonzero: nz, n: a.length };
      }
      window.__c11bufs = {};
      return out;
    }, VN);
    log(j.name, "云缓冲差", JSON.stringify(row.bufDiff));
    await A.page.evaluate(() => window.__voyage.freeze(false));
    // 换回本分支原文，免得下一个 job 从 old 开始
    await A.page.evaluate((src) => { const m = window.__voyage.clouds.resolveMat; if (m.fragmentShader !== src) { m.fragmentShader = src; m.needsUpdate = true; } }, newSrc);
    summary.push(row);
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  }
} finally {
  await closeBrowserSafely(browser);
}
