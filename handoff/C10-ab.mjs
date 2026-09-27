// C10：同页、同姿态 A/B 云密度 / 步进的变体（改自 handoff/C12-ab.mjs）。
// 页面跑本 worktree 的代码；各变体 = 对「当前实际画的云步进变体」原文做文本替换（--vfile 导出 VARIANTS）。
// 每个变体：
//   HDR：零运动手动推进云（生产的 blend + 邻域夹取），预热 --warm 帧，读 --frames 帧云缓冲裁剪区 → relStd / relLow16；
//        --bin 时另把之后 16 帧的整幅云缓冲（左半）累加平均，存 <变体>.bin：float32 × 2 通道（不透明度 1 − T、亮度 Y(L)），GL 左下原点；
//   显示：真实 rAF 跑 48 帧后连拍 16 张裁剪截图（每张隔 2 帧）+ 一张整图；
//   变体名以 "diag" 开头：只渲染一帧、读 raw（不经 resolve），算表皮剖面的分位数（见 C10-var.mjs 的 diag）。
// 变体名后缀 @m：拍显示截图前解冻飞行 120 帧（运动相机）。
// 用法：node handoff/C10-ab.mjs --voyage <voyage 绝对路径> --port 5227 --out <目录> --jobs <jobs.json> --scenes <scenes.json>
//        --vfile handoff/C10-var.mjs --variants base,k7,... [--bin] [--warm 96] [--frames 64]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes("--" + k);
const VOYAGE = arg("voyage", "D:/Code/opus-test/.claude/worktrees/agent-a3b5f07ec8fd5ad9c/apps/voyage");
const require = createRequire(VOYAGE + "/package.json");
const { chromium } = require("playwright-core");
const { DEFAULTS, SCENES, applyScene, pinGeometry } = await import(pathToFileURL(VOYAGE + "/scripts/scenarios.mjs").href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(VOYAGE + "/scripts/lib/chrome.mjs").href);
const { VARIANTS } = await import(pathToFileURL(path.resolve(arg("vfile", VOYAGE + "/handoff/C10-var.mjs"))).href);

const port = arg("port", "5227"), OUT = arg("out");
const jobs = JSON.parse(fs.readFileSync(arg("jobs"), "utf-8"));
const extra = arg("scenes") ? JSON.parse(fs.readFileSync(arg("scenes"), "utf-8")) : [];
const VN = arg("variants", "base").split(",");
const WARM = Number(arg("warm", "96")), NS = Number(arg("frames", "64"));
const BIN = has("bin"), NOSHOT = has("noshot"), MOTION = has("motion");
const SPEED = Number(arg("speed", "0.004")), MFR = Number(arg("mframes", "160")), CHECKS = arg("checks", "100,130,160").split(",").map(Number);
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("[c10]", ...a);

const lock = "D:/Code/opus-test/tmp/measure.lock";
for (let i = 0; fs.existsSync(lock) && i < 120; i++) { if (i === 0) log("测量锁存在，等待……"); await new Promise((r) => setTimeout(r, 5000)); }

function srcOf(orig, vn) {
  const p = VARIANTS[vn.split("@")[0]];
  if (p === undefined) throw new Error("没有变体 " + vn);
  let s = orig;
  for (const [find, rep] of p) {
    if (!s.includes(find)) throw new Error(`变体 ${vn} 找不到片段 ${find.slice(0, 60)}`);
    s = s.split(find).join(rep);
  }
  return s;
}

const scOf = (j) => {
  const s = extra.find((x) => x.name === j.scene) ?? SCENES.find((x) => x.name === j.scene);
  if (!s) throw new Error("没有场景 " + j.scene);
  return j.offset ? { ...s, offset: j.offset } : s;
};

const browser = await launchBrowser(chromium, { angle: "d3d11" });
const summary = [];
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { errors.push(e.message); log("pageerror", e.message); });
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (/eox|ERR_FAILED|CORS/i.test(t)) return; errors.push(t.slice(0, 300)); log("console.error", t.slice(0, 300)); } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();
  const cache = new Map();
  for (const j of jobs) {
    const sc = scOf(j);
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
    await page.evaluate(pinGeometry, sc);
    await page.evaluate(() => window.__voyage.freeze(true, { cloudLive: true }));
    const cur = await page.evaluate(() => { const v = window.__voyage; return { key: v.clouds.marchShown, src: v.clouds.marchVariants.get(v.clouds.marchShown).mat.fragmentShader }; });
    const ck = cur.key;
    if (!cache.has(ck)) cache.set(ck, cur.src);
    const orig = cache.get(ck);
    const row = { job: j.name, key: ck, crop: j.crop, variants: {} };
    for (const vn of VN) {
      const src = srcOf(orig, vn);
      const diag = vn.startsWith("diag");
      const e0 = errors.length;
      const res = await page.evaluate(async ({ src, crop, WARM, NS, motion, diag, BIN, MOTION, SPEED, MFR, CHECKS }) => {
        const v = window.__voyage;
        const m = v.clouds.marchVariants.get(v.clouds.marchShown).mat;
        if (m.fragmentShader !== src) { m.fragmentShader = src; m.needsUpdate = true; }
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        for (let i = 0; i < 4; i++) await raf();
        const r = v.clouds.pass.renderer;
        const prog = r.properties.get(m)?.currentProgram;
        if (prog && prog.diagnostics && prog.diagnostics.runnable === false) return { shaderError: true };
        const u = v.sceneMat.uniforms;
        const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
        const b64 = (f32) => { const u8 = new Uint8Array(f32.buffer); let s = ""; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
        if (diag) {
          // 表皮剖面：读 raw（本帧步进的原始输出），R = od 到 1 的深度（m），G = od 到 3 的深度，B = 进云 100 m 处 σ（/km），A = σmax + 1（0 = 无）
          v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
          const t = v.clouds.raw;
          const W = t.width, H = t.height;
          const buf = new Float32Array(W * H * 4);
          r.readRenderTargetPixels(t, 0, 0, W, H, buf);
          const out = { W, H, data: b64(buf) };
          u.uClouds.value = v.clouds.texture;
          return out;
        }
        v.clouds.snap();
        for (let i = 0; i < WARM; i++) v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
        const t = v.clouds.history[0];
        const CW = t.width / 2, CH = t.height, sx = CW / 1600, sy = CH / 1200;
        const x = Math.round(crop[0] * sx), w = Math.round(crop[2] * sx), h = Math.round(crop[3] * sy), y = Math.round(CH - (crop[1] + crop[3]) * sy);
        const N = w * h, BX = 16;
        const series = [];
        const buf = new Float32Array(N * 4);
        for (let f = 0; f < NS; f++) {
          v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
          r.readRenderTargetPixels(t, x, y, w, h, buf);
          const L = new Float32Array(N);
          for (let k = 0; k < N; k++) L[k] = 0.2126 * buf[4 * k] + 0.7152 * buf[4 * k + 1] + 0.0722 * buf[4 * k + 2];
          series.push(L);
        }
        let sStd = 0, sLow = 0, sMean = 0, cnt = 0;
        for (let k = 0; k < N; k++) {
          let mm = 0; for (let f = 0; f < NS; f++) mm += series[f][k]; mm /= NS;
          if (!(mm > 0.02)) continue;
          let s2 = 0; for (let f = 0; f < NS; f++) s2 += (series[f][k] - mm) ** 2;
          let l2 = 0, nb = 0;
          for (let f0 = 0; f0 + BX <= NS; f0 += BX) { let a = 0; for (let f = f0; f < f0 + BX; f++) a += series[f][k]; a /= BX; l2 += (a - mm) ** 2; nb++; }
          sStd += Math.sqrt(s2 / NS) / mm; sLow += Math.sqrt(l2 / nb) / mm; sMean += mm; cnt++;
        }
        const out = { px: cnt, relStd: +(sStd / cnt).toFixed(4), relLow16: +(sLow / cnt).toFixed(4), meanHdr: +(sMean / cnt).toFixed(4) };
        if (BIN) {
          const full = new Float32Array(CW * CH * 4);
          const acc = new Float32Array(CW * CH * 2);
          const NB = 16;
          for (let f = 0; f < NB; f++) {
            v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
            r.readRenderTargetPixels(t, 0, 0, CW, CH, full);
            for (let k = 0; k < CW * CH; k++) {
              acc[2 * k] += (1 - full[4 * k + 3]) / NB;
              acc[2 * k + 1] += (0.2126 * full[4 * k] + 0.7152 * full[4 * k + 1] + 0.0722 * full[4 * k + 2]) / NB;
            }
          }
          out.W = CW; out.H = CH; out.data = b64(acc);
        }
        if (MOTION) {
          // 确定性巡航（同 C12b-ab 的 motion）：每帧 uCloudOffset += 航向 × SPEED，motion 同步，手动 render；
          // 检查点读裁剪区 (α, Y)；然后在各检查点姿态上零运动收敛（预热 WARM + 平均 32 帧）当真值
          const cu = v.cloudUniforms;
          const pose0 = { off: cu.uCloudOffset.value.clone(), c2w: u.uCabinToWorld.value.clone() };
          const rd2 = () => { const b = new Float32Array(N * 4); r.readRenderTargetPixels(t, x, y, w, h, b); const o = new Float32Array(N * 2); for (let k = 0; k < N; k++) { o[2 * k] = 1 - b[4 * k + 3]; o[2 * k + 1] = 0.2126 * b[4 * k] + 0.7152 * b[4 * k + 1] + 0.0722 * b[4 * k + 2]; } return o; };
          const hd = v.state.heading * Math.PI / 180;
          const mv = zero.clone();
          v.clouds.snap();
          v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
          const cks = {}, offs = {};
          for (let k = 1; k <= MFR; k++) {
            const dx = Math.sin(hd) * SPEED, dz = -Math.cos(hd) * SPEED;
            cu.uCloudOffset.value.x += dx; cu.uCloudOffset.value.y += dz;
            v.clouds.render(mv.set(dx, 0, dz), u.uCamBasis.value, u.uCabinToWorld.value);
            if (CHECKS.includes(k)) { cks[k] = rd2(); offs[k] = cu.uCloudOffset.value.clone(); }
          }
          out.motion = {};
          for (const k of CHECKS) {
            cu.uCloudOffset.value.copy(offs[k]);
            v.clouds.snap();
            for (let i = 0; i < WARM; i++) v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
            const acc = new Float32Array(N * 2);
            for (let f = 0; f < 32; f++) { v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value); const o = rd2(); for (let q = 0; q < N * 2; q++) acc[q] += o[q] / 32; }
            out.motion[k] = { m: b64(cks[k]), t: b64(acc) };
          }
          out.mw = w; out.mh = h;
          cu.uCloudOffset.value.copy(pose0.off);
          v.clouds.snap();
          for (let i = 0; i < 48; i++) v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
        }
        u.uClouds.value = v.clouds.texture;
        if (motion) { v.freeze(false); v.state.playRate = 1; }
        for (let i = 0; i < (motion ? 120 : 48); i++) await raf();
        return out;
      }, { src, crop: j.crop, WARM, NS, motion: vn.includes("@m"), diag, BIN, MOTION, SPEED, MFR, CHECKS });
      res.errors = errors.length - e0;
      if (res.shaderError) log("!! 变体编译失败", vn);
      const dir = path.join(OUT, j.name, vn);
      fs.mkdirSync(dir, { recursive: true });
      if (res.data) {
        fs.writeFileSync(path.join(OUT, j.name, vn + (diag ? ".diag.bin" : ".bin")), Buffer.from(res.data, "base64"));
        fs.writeFileSync(path.join(OUT, j.name, vn + ".dims.json"), JSON.stringify({ W: res.W, H: res.H, ch: diag ? 4 : 2 }));
        delete res.data;
      }
      if (res.motion) {
        const md = path.join(OUT, j.name, vn + ".motion");
        fs.mkdirSync(md, { recursive: true });
        for (const [k, o] of Object.entries(res.motion)) {
          fs.writeFileSync(path.join(md, `m${k}.bin`), Buffer.from(o.m, "base64"));
          fs.writeFileSync(path.join(md, `t${k}.bin`), Buffer.from(o.t, "base64"));
        }
        fs.writeFileSync(path.join(md, "dims.json"), JSON.stringify({ W: res.mw, H: res.mh, ch: 2, checks: Object.keys(res.motion) }));
        delete res.motion;
      }
      if (!diag && !NOSHOT) {
        for (let f = 0; f < 16; f++) {
          await page.screenshot({ path: path.join(dir, `f${String(f).padStart(2, "0")}.png`), clip: { x: j.crop[0], y: j.crop[1], width: j.crop[2], height: j.crop[3] } });
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        }
        await page.screenshot({ path: path.join(dir, "full.png") });
      }
      if (vn.includes("@m")) { await page.evaluate(pinGeometry, sc); await page.evaluate(() => window.__voyage.freeze(true, { cloudLive: true })); }
      row.variants[vn] = res;
      log(j.name, ck, vn, JSON.stringify(res));
    }
    await page.evaluate((src) => { const v = window.__voyage; const m = v.clouds.marchVariants.get(v.clouds.marchShown).mat; if (m.fragmentShader !== src) { m.fragmentShader = src; m.needsUpdate = true; } v.freeze(false); }, orig);
    summary.push(row);
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  }
} finally {
  fs.writeFileSync(path.join(OUT, "errors.json"), JSON.stringify(errors, null, 2));
  await closeBrowserSafely(browser);
}
