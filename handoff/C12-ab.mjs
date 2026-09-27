// C12：同页、同姿态 A/B 各种步进抖动方案（改自 tmp/c09rev-ab.mjs）。
// 页面跑 C12 worktree 的代码；各变体 = 对当前实际画的云步进变体原文做文本替换（抖动 / gDetailRnd 两行）。
// 每个变体：HDR 手动推进云（零运动，生产的 blend + 邻域夹取），预热 96 帧，读 64 帧云缓冲裁剪区 → relStd / relLow16；
//           显示：真实 rAF 跑 48 帧后连拍 16 张裁剪截图（每张隔 2 帧）+ 一张整图。
// 用法：node c12-ab.mjs --port 5214 --out <目录> --jobs <jobs.json> --scenes <scenes.json> [--variants ign,bnphi,...] [--offsets "x,y;x,y"]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const VOYAGE = arg("voyage", "D:/Code/opus-test/.claude/worktrees/agent-a494668cedf2243a8/apps/voyage");
const require = createRequire(VOYAGE + "/package.json");
const { chromium } = require("playwright-core");
const { DEFAULTS, SCENES, applyScene, pinGeometry } = await import(pathToFileURL(VOYAGE + "/scripts/scenarios.mjs").href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(VOYAGE + "/scripts/lib/chrome.mjs").href);

const port = arg("port", "5214"), OUT = arg("out");
const jobs = JSON.parse(fs.readFileSync(arg("jobs"), "utf-8"));
const extra = arg("scenes") ? JSON.parse(fs.readFileSync(arg("scenes"), "utf-8")) : [];
const VN = arg("variants", "ign,bnphi,bnr2,bnr2phi,r2lat,white,bnphi2").split(",");
const WARM = Number(arg("warm", "96")), NS = Number(arg("frames", "64"));
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("[c12]", ...a);

// 测量锁（别的代理在测真冷启动 / FXC 时让一让）
const lock = "D:/Code/opus-test/tmp/measure.lock";
for (let i = 0; fs.existsSync(lock) && i < 120; i++) { if (i === 0) log("测量锁存在，等待……"); await new Promise((r) => setTimeout(r, 5000)); }

const J_BN = "vec2 bn = blueNoise();\n  float jitter = fract(bn.x + uFrame * 0.61803);";
const D_BN = "gDetailRnd = fract(bn.y + uFrame * 0.41421356 + float(i) * 0.6180339);";
const IGN_DEF = "float hashW(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }\nvec2 blueNoise() {";
const R2OFF = "ivec2 bnOff = ivec2(fract(uFrame * vec2(0.7548777, 0.5698403)) * 128.0);\n  vec2 bn = texelFetch(uBlueNoise, (ivec2(gl_FragCoord.xy) + bnOff) & 127, 0).rg;\n  ";
const PATCH = {
  ign: [J_BN, "vec2 bn = vec2(0.0);\n  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803);", D_BN, "gDetailRnd = fract(ign(gl_FragCoord.yx + vec2(19.0, 47.0)) + uFrame * 0.41421356 + float(i) * 0.6180339);"],
  bnphi: null,
  bnpure: ["  if (uCloudImmersion > 0.5) return vec2(ign(gl_FragCoord.xy), ign(gl_FragCoord.yx + vec2(19.0, 47.0)));\n", ""],
  bnphi2: null,
  bnr2: [J_BN, R2OFF + "float jitter = bn.x;", D_BN, "gDetailRnd = fract(bn.y + float(i) * 0.6180339);"],
  bnr2phi: [J_BN, R2OFF + "float jitter = fract(bn.x + uFrame * 0.61803);", D_BN, D_BN],
  r2lat: [J_BN, "vec2 bn = vec2(0.0);\n  float jitter = fract(dot(gl_FragCoord.xy, vec2(0.7548777, 0.5698403)) + uFrame * 0.61803);", D_BN, "gDetailRnd = fract(dot(gl_FragCoord.yx + vec2(19.0, 47.0), vec2(0.7548777, 0.5698403)) + uFrame * 0.41421356 + float(i) * 0.6180339);"],
  white: [J_BN, "vec2 bn = vec2(0.0);\n  float jitter = hashW(vec3(gl_FragCoord.xy, uFrame + 0.5));", D_BN, "gDetailRnd = fract(hashW(vec3(gl_FragCoord.yx + 71.0, uFrame + 17.5)) + float(i) * 0.6180339);"],
  // 只换主步进抖动 / 只换细节随机数（拆贡献）
  bnstep: ["stepLen * jitter", "stepLen * fract(jitter + float(i) * 0.7548777)"],
  ignstep: [J_BN, "vec2 bn = vec2(0.0);\n  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803);", D_BN, "gDetailRnd = fract(ign(gl_FragCoord.yx + vec2(19.0, 47.0)) + uFrame * 0.41421356 + float(i) * 0.6180339);", "stepLen * jitter", "stepLen * fract(jitter + float(i) * 0.7548777)"],
  jitonly: [D_BN, "gDetailRnd = fract(ign(gl_FragCoord.yx + vec2(19.0, 47.0)) + uFrame * 0.41421356 + float(i) * 0.6180339);"],
};
function srcOf(cur, vn) {
  const p = PATCH[vn.split("@")[0]];
  let s = cur.replace("vec2 blueNoise() {", IGN_DEF);
  if (!p) return s;
  for (let k = 0; k < p.length; k += 2) { if (!s.includes(p[k])) throw new Error(`变体 ${vn} 找不到片段 ${p[k].slice(0, 50)}`); s = s.split(p[k]).join(p[k + 1]); }
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
  page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text().slice(0, 300)); log("console.error", m.text().slice(0, 300)); } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();
  const cache = new Map();
  const origResolve = await page.evaluate(() => (window.__c12r = window.__voyage.clouds.resolveMat.fragmentShader));
  if (!origResolve.includes("float blend = 0.12;")) log("警告：resolve 里找不到 blend = 0.12");
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
      const bm = /@b([0-9.]+)/.exec(vn);
      const rsrc = bm ? origResolve.replace("float blend = 0.12;", "float blend = " + bm[1] + ";") : origResolve;
      const e0 = errors.length;
      const hdr = await page.evaluate(async ({ src, rsrc, crop, WARM, NS, motion }) => {
        const v = window.__voyage;
        const rm = v.clouds.resolveMat;
        if (rm.fragmentShader !== rsrc) { rm.fragmentShader = rsrc; rm.needsUpdate = true; }
        const m = v.clouds.marchVariants.get(v.clouds.marchShown).mat;
        if (m.fragmentShader !== src) { m.fragmentShader = src; m.needsUpdate = true; }
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        for (let i = 0; i < 4; i++) await raf();
        const u = v.sceneMat.uniforms;
        const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
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
          v.clouds.pass.renderer.readRenderTargetPixels(t, x, y, w, h, buf);
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
        u.uClouds.value = v.clouds.texture;
        if (motion) { v.freeze(false); v.state.playRate = 1; }
        for (let i = 0; i < (motion ? 120 : 48); i++) await raf();
        return { px: cnt, relStd: +(sStd / cnt).toFixed(4), relLow16: +(sLow / cnt).toFixed(4), meanHdr: +(sMean / cnt).toFixed(4) };
      }, { src, rsrc, crop: j.crop, WARM, NS, motion: vn.includes('@m') });
      const motionNow = vn.includes('@m');
      hdr.errors = errors.length - e0;
      const dir = path.join(OUT, j.name, vn);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 16; f++) {
        await page.screenshot({ path: path.join(dir, `f${String(f).padStart(2, "0")}.png`), clip: { x: j.crop[0], y: j.crop[1], width: j.crop[2], height: j.crop[3] } });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      }
      await page.screenshot({ path: path.join(dir, "full.png") });
      if (motionNow) { await page.evaluate(pinGeometry, sc); await page.evaluate(() => window.__voyage.freeze(true, { cloudLive: true })); }
      row.variants[vn] = hdr;
      log(j.name, ck, vn, JSON.stringify(hdr));
    }
    // 还原原文
    await page.evaluate((src) => { const v = window.__voyage; const rm = v.clouds.resolveMat; if (rm.fragmentShader !== window.__c12r) { rm.fragmentShader = window.__c12r; rm.needsUpdate = true; } const m = v.clouds.marchVariants.get(v.clouds.marchShown).mat; if (m.fragmentShader !== src) { m.fragmentShader = src; m.needsUpdate = true; } v.freeze(false); }, orig);
    summary.push(row);
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  }
  // 云步进程序的活跃 sampler 数
  const samplers = await page.evaluate(() => {
    const v = window.__voyage, r = v.clouds.pass.renderer, gl = r.getContext();
    const out = {};
    for (const [key, { mat }] of v.clouds.marchVariants) {
      const prog = r.properties.get(mat)?.currentProgram?.program;
      if (!prog) continue;
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      const names = [];
      for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(prog, i); if ([gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_2D_ARRAY, gl.SAMPLER_CUBE].includes(a.type)) names.push(a.name); }
      out[key || "默认"] = names;
    }
    return out;
  });
  log("云步进活跃 sampler：", JSON.stringify(samplers));
  fs.writeFileSync(path.join(OUT, "samplers.json"), JSON.stringify(samplers, null, 2));
} finally {
  fs.writeFileSync(path.join(OUT, "errors.json"), JSON.stringify(errors, null, 2));
  await closeBrowserSafely(browser);
}
