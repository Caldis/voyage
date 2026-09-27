// C12b：同页、同姿态 A/B 各 resolve 变体（改自 C12-ab.mjs）。云步进不动，只换 resolveMat.fragmentShader。
// 模式（--modes，逗号分隔）：
//   static  零运动：手动推进 96 帧预热 + 64 帧读 HDR 云缓冲裁剪区 → relStd / relLow16 / 空间噪声（单帧 − 64 帧平均）；
//           再按真实 rAF（cloudLive）连拍 16 张显示裁剪截图（对角高频等显示指标，C12-metrics 口径）。
//   motion  确定性巡航：从钉住的姿态出发，每帧 uCloudOffset += 航向 × speed、motion 同步，手动 render（uFrame 从 0 起），
//           在检查点读 HDR 裁剪区（float32 文件）；各变体航迹逐位相同。
//   turn    同 motion，另加滚转 ROLL° 与每帧偏航 YAW°（直接旋转 uCabinToWorld）。
//   exit    云里 → 爬升出云：每帧 uCamR 上升 CLIMB km，whiteout 在出云后按 τ = 0.5 s 衰减（手动写 uCloudImmersion）。
//   真值：每个检查点的姿态上静止、不夹取、等权平均 TRUTH 帧（resolve 换成 truth 变体），各变体共用。
// 用法：node C12b-ab.mjs --voyage <voyage 绝对路径> --port 5223 --out <目录> --jobs <jobs.json> --scenes <scenes.json>
//        --variants <variants.json：{名字: defines 串 | "master"}> [--modes static,motion] [--speed 0.004] [--frames 64]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const VOYAGE = arg("voyage");
const require = createRequire(VOYAGE + "/package.json");
const { chromium } = require("playwright-core");
const { DEFAULTS, SCENES, applyScene, pinGeometry } = await import(pathToFileURL(VOYAGE + "/scripts/scenarios.mjs").href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(VOYAGE + "/scripts/lib/chrome.mjs").href);
const { resolveVariant } = await import(pathToFileURL(VOYAGE + "/handoff/C12b-variants.mjs").href);

const port = arg("port", "5223"), OUT = arg("out");
const jobs = JSON.parse(fs.readFileSync(arg("jobs"), "utf-8"));
const extra = arg("scenes") ? JSON.parse(fs.readFileSync(arg("scenes"), "utf-8")) : [];
const VARS = JSON.parse(fs.readFileSync(arg("variants"), "utf-8"));
const MODES = arg("modes", "static,motion").split(",");
const WARM = Number(arg("warm", "96")), NS = Number(arg("frames", "64"));
const SPEED = Number(arg("speed", "0.004")); // km / 帧（约 240 m/s、60 fps）
const MFRAMES = Number(arg("mframes", "160"));
const CHECK = (arg("checks", "100,120,140,160")).split(",").map(Number);
const TRUTH = Number(arg("truth", "256"));
const ROLL = Number(arg("roll", "25")), YAW = Number(arg("yaw", "0.05")); // 度；0.05°/帧 = 3°/s
const CLIMB = Number(arg("climb", "0.002")); // km / 帧
const DISPLAY = arg("display", "1") === "1";
const baseResolveFile = arg("base-resolve");
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("[c12b]", ...a);

const lock = "D:/Code/opus-test/tmp/measure.lock";
for (let i = 0; fs.existsSync(lock) && i < 120; i++) { if (i === 0) log("测量锁存在，等待……"); await new Promise((r) => setTimeout(r, 5000)); }

const scOf = (j) => {
  const s = extra.find((x) => x.name === j.scene) ?? SCENES.find((x) => x.name === j.scene);
  if (!s) throw new Error("没有场景 " + j.scene);
  return j.offset ? { ...s, offset: j.offset } : s;
};

// 页面里用的工具函数（注入一次）
const PAGE_LIB = () => {
  const v = window.__voyage;
  const L = {};
  L.setResolve = (src) => {
    const rm = v.clouds.resolveMat;
    if (!rm.uniforms.uTruthK) rm.uniforms.uTruthK = { value: 0 };
    if (rm.fragmentShader !== src) { rm.fragmentShader = src; rm.needsUpdate = true; }
  };
  L.cropRect = (crop) => {
    const t = v.clouds.history[0];
    const CW = t.width / 2, CH = t.height, sx = CW / 1600, sy = CH / 1200;
    const x = Math.round(crop[0] * sx), w = Math.round(crop[2] * sx), h = Math.round(crop[3] * sy), y = Math.round(CH - (crop[1] + crop[3]) * sy);
    return { x, y, w, h };
  };
  L.readLum = (r) => {
    const t = v.clouds.history[0];
    const buf = new Float32Array(r.w * r.h * 4);
    v.clouds.pass.renderer.readRenderTargetPixels(t, r.x, r.y, r.w, r.h, buf);
    const out = new Float32Array(r.w * r.h);
    for (let k = 0; k < out.length; k++) out[k] = 0.2126 * buf[4 * k] + 0.7152 * buf[4 * k + 1] + 0.0722 * buf[4 * k + 2];
    return out;
  };
  L.b64 = (f32) => {
    const u8 = new Uint8Array(f32.buffer);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const u = v.sceneMat.uniforms;
  L.u = u;
  L.pose0 = null;
  L.savePose = () => {
    L.pose0 = { off: v.cloudUniforms.uCloudOffset.value.clone(), c2w: u.uCabinToWorld.value.clone(), camR: u.uCamR.value, imm: v.clouds.resolveMat.uniforms.uCloudImmersion.value, heading: v.state.heading };
  };
  L.setPose = (p) => {
    v.cloudUniforms.uCloudOffset.value.copy(p.off);
    u.uCabinToWorld.value.copy(p.c2w);
    u.uCamR.value = p.camR;
    v.clouds.resolveMat.uniforms.uCloudImmersion.value = p.imm;
  };
  L.render = (motion) => v.clouds.render(motion, u.uCamBasis.value, u.uCabinToWorld.value);
  // 一条确定性航迹：返回每个检查点的姿态；onCheck(k) 在检查点读数
  L.fly = (mode, P, onCheck) => {
    const T = window.THREE_ ?? null;
    const p0 = L.pose0;
    L.setPose(p0);
    const h = p0.heading * Math.PI / 180;
    const motion = v.clouds.resolveMat.uniforms.uMotion.value.clone();
    const M3 = p0.c2w.constructor;
    const rot = (axis, ang) => { // 绕世界轴 axis 旋转 ang 弧度的 Matrix3
      const [x, y, z] = axis, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
      const m = new M3();
      m.set(t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c);
      return m;
    };
    if (mode === "turn") u.uCabinToWorld.value.premultiply(rot([Math.sin(h), 0, -Math.cos(h)], P.ROLL * Math.PI / 180));
    const poses = {};
    v.clouds.frame = 0;
    v.clouds.snap();
    L.render(motion.set(0, 0, 0));
    let hd = h, immT = null;
    const top = v.cloudUniforms.uCloudTop?.value;
    for (let k = 1; k <= P.MFRAMES; k++) {
      if (mode === "turn") { hd += P.YAW * Math.PI / 180; u.uCabinToWorld.value.premultiply(rot([0, 1, 0], -P.YAW * Math.PI / 180)); }
      const dx = Math.sin(hd) * P.SPEED, dz = -Math.cos(hd) * P.SPEED;
      v.cloudUniforms.uCloudOffset.value.x += dx;
      v.cloudUniforms.uCloudOffset.value.y += dz;
      let dy = 0;
      if (mode === "exit") {
        dy = P.CLIMB;
        u.uCamR.value += dy;
        const alt = u.uCamR.value - 6360;
        const imm = v.clouds.resolveMat.uniforms.uCloudImmersion;
        if (top !== undefined && alt > top + 0.05) { if (immT === null) immT = k; imm.value *= Math.exp(-1 / 60 / 0.5); }
      }
      L.render(motion.set(dx, dy, dz));
      if (P.CHECK.includes(k)) {
        poses[k] = { off: v.cloudUniforms.uCloudOffset.value.clone(), c2w: u.uCabinToWorld.value.clone(), camR: u.uCamR.value, imm: v.clouds.resolveMat.uniforms.uCloudImmersion.value, immT };
        onCheck && onCheck(k);
      }
    }
    return poses;
  };
  window.__c12b = L;
};

const browser = await launchBrowser(chromium, { angle: "d3d11" });
const summary = [];
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { errors.push(e.message); log("pageerror", e.message); });
  page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text().slice(0, 300)); log("console.error", m.text().slice(0, 300)); } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();
  const e0start = errors.length;
  log("启动期间 console error：", e0start);
  // 变体写 "current" = 页面当前代码的 resolve 原文；--base-resolve 给 master 原文文件（改了 src 以后对照用）
  const current = await page.evaluate(() => window.__voyage.clouds.resolveMat.fragmentShader);
  let master = current;
  if (baseResolveFile) master = fs.readFileSync(baseResolveFile, "utf-8");
  fs.writeFileSync(path.join(OUT, "current-resolve.glsl"), current);
  fs.writeFileSync(path.join(OUT, "master-resolve.glsl"), master);
  await page.evaluate(PAGE_LIB);
  const truthSrc = resolveVariant(master, "truth");
  for (const j of jobs) {
    const sc = scOf(j);
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
    await page.evaluate(pinGeometry, sc);
    // 冻结时刻固定（C11 手法：freeze 每次都把 frozenNow 设成 performance.now()）
    await page.evaluate(() => {
      window.__c12bT0 = performance.now();
      const pn = performance.now; performance.now = () => window.__c12bT0;
      try { window.__voyage.freeze(true, { cloudLive: true }); } finally { performance.now = pn; }
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => window.__c12b.savePose());
    const key = await page.evaluate(() => window.__voyage.clouds.marchShown);
    const row = { job: j.name, key, crop: j.crop, variants: {} };
    const jdir = path.join(OUT, j.name);
    fs.mkdirSync(jdir, { recursive: true });
    const truthDone = {};
    for (const [vn, defs] of Object.entries(VARS)) {
      const src = defs === "current" ? current : resolveVariant(master, defs);
      const e0 = errors.length;
      const res = { errors: 0 };
      await page.evaluate(({ src }) => window.__c12b.setResolve(src), { src });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      if (MODES.includes("static")) {
        const hdr = await page.evaluate(({ crop, WARM, NS }) => {
          const v = window.__voyage, L = window.__c12b;
          L.setPose(L.pose0);
          const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
          v.clouds.frame = 0;
          v.clouds.snap();
          for (let i = 0; i < WARM; i++) L.render(zero);
          const r = L.cropRect(crop);
          const N = r.w * r.h, BX = 16;
          const series = [];
          for (let f = 0; f < NS; f++) { L.render(zero); series.push(L.readLum(r)); }
          const mean = new Float32Array(N);
          let sStd = 0, sLow = 0, sMean = 0, cnt = 0, sp2 = 0, spM = 0;
          for (let k = 0; k < N; k++) {
            let mm = 0; for (let f = 0; f < NS; f++) mm += series[f][k]; mm /= NS;
            mean[k] = mm;
            if (!(mm > 0.02)) continue;
            let s2 = 0; for (let f = 0; f < NS; f++) s2 += (series[f][k] - mm) ** 2;
            let l2 = 0, nb = 0;
            for (let f0 = 0; f0 + BX <= NS; f0 += BX) { let a = 0; for (let f = f0; f < f0 + BX; f++) a += series[f][k]; a /= BX; l2 += (a - mm) ** 2; nb++; }
            sStd += Math.sqrt(s2 / NS) / mm; sLow += Math.sqrt(l2 / nb) / mm; sMean += mm; cnt++;
            sp2 += (series[NS - 1][k] - mm) ** 2; spM += mm;
          }
          v.sceneMat.uniforms.uClouds.value = v.clouds.texture;
          return { px: cnt, relStd: +(sStd / cnt).toFixed(5), relLow16: +(sLow / cnt).toFixed(5), meanHdr: +(sMean / cnt).toFixed(5), spatRms: +(Math.sqrt(sp2 / cnt) / (spM / cnt)).toFixed(5), w: r.w, h: r.h, last: L.b64(series[NS - 1]), mean: L.b64(mean) };
        }, { crop: j.crop, WARM, NS });
        const sd = path.join(jdir, "static", vn);
        fs.mkdirSync(sd, { recursive: true });
        fs.writeFileSync(path.join(sd, "last.f32"), Buffer.from(hdr.last, "base64"));
        fs.writeFileSync(path.join(sd, "mean.f32"), Buffer.from(hdr.mean, "base64"));
        delete hdr.last; delete hdr.mean;
        res.static = hdr;
        if (DISPLAY) {
          // 显示：cloudLive 按真实 rAF（零运动）跑 48 帧再连拍 16 张
          await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n >= 48 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
          for (let f = 0; f < 16; f++) {
            await page.screenshot({ path: path.join(sd, `f${String(f).padStart(2, "0")}.png`), clip: { x: j.crop[0], y: j.crop[1], width: j.crop[2], height: j.crop[3] } });
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          }
          await page.screenshot({ path: path.join(sd, "full.png") });
        }
      }
      for (const mode of ["motion", "turn", "exit"]) {
        if (!MODES.includes(mode)) continue;
        const P = { SPEED: j.speed ?? SPEED, MFRAMES: j.mframes ?? MFRAMES, CHECK: j.checks ?? CHECK, ROLL, YAW, CLIMB: j.climb ?? CLIMB };
        const out = await page.evaluate(({ mode, P, crop }) => {
          const L = window.__c12b;
          const r = L.cropRect(crop);
          const shots = {};
          const poses = L.fly(mode, P, (k) => { shots[k] = L.b64(L.readLum(r)); });
          window.__c12bPoses = window.__c12bPoses ?? {};
          window.__c12bPoses[mode] = poses;
          window.__voyage.sceneMat.uniforms.uClouds.value = window.__voyage.clouds.texture;
          const meta = {};
          for (const k in poses) meta[k] = { imm: poses[k].imm, immT: poses[k].immT, camR: poses[k].camR };
          return { w: r.w, h: r.h, shots, meta };
        }, { mode, P, crop: j.crop });
        const md = path.join(jdir, mode, vn);
        fs.mkdirSync(md, { recursive: true });
        for (const [k, b] of Object.entries(out.shots)) fs.writeFileSync(path.join(md, `cp${k}.f32`), Buffer.from(b, "base64"));
        res[mode] = { w: out.w, h: out.h, meta: out.meta };
        // 真值（每个模式只算一次，航迹对各变体逐位相同）
        if (!truthDone[mode]) {
          truthDone[mode] = true;
          const td = path.join(jdir, mode, "_truth");
          fs.mkdirSync(td, { recursive: true });
          for (const k of P.CHECK) {
            const b = await page.evaluate(({ tsrc, k, TRUTH, crop, mode }) => {
              const v = window.__voyage, L = window.__c12b;
              const keep = v.clouds.resolveMat.fragmentShader;
              L.setResolve(tsrc);
              L.setPose(window.__c12bPoses[mode][k]);
              const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
              const tk = v.clouds.resolveMat.uniforms.uTruthK;
              v.clouds.frame = 0;
              v.clouds.snap();
              for (let i = 0; i < TRUTH; i++) { tk.value = i; L.render(zero); }
              const out = L.b64(L.readLum(L.cropRect(crop)));
              L.setResolve(keep);
              L.setPose(L.pose0);
              return out;
            }, { tsrc: truthSrc, k, TRUTH, crop: j.crop, mode });
            fs.writeFileSync(path.join(td, `cp${k}.f32`), Buffer.from(b, "base64"));
          }
        }
      }
      await page.evaluate(() => window.__c12b.setPose(window.__c12b.pose0));
      res.errors = errors.length - e0;
      row.variants[vn] = res;
      log(j.name, key || "默认", vn, JSON.stringify(res.static ?? {}), "err", res.errors);
    }
    await page.evaluate((src) => { window.__c12b.setResolve(src); window.__voyage.freeze(false); }, current);
    summary.push(row);
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ variants: VARS, modes: MODES, speed: SPEED, rows: summary }, null, 2));
  }
} finally {
  fs.writeFileSync(path.join(OUT, "errors.json"), JSON.stringify(errors, null, 2));
  await closeBrowserSafely(browser);
}
