// NIGHT-AP-1 逐位不变核对（同页）：cur = 本次实现；old = 把所有程序换回「改前」的等价文本
//   - 空气透视 LUT 程序：去掉两光源分支，只留原来那一行 integrateSegment（与 master 同一段代码）
//   - 消费方程序（窗外各变体、云步进各变体、远塔）：uApDir → uSunDir、uApIlluminance → uSunIlluminance（即 master 的写法）
// 比较三样：空气透视 LUT 两张 3D 图（逐 texel 读回）、云步进 raw（固定 uFrame 手动步进一次 + 远塔层）、hdrOutside。
// 用法：node apps/voyage/handoff/NIGHT-AP-1-parity.mjs --port 5295 --only noon-cumulus,sunset-wing [--js "<场景后执行的 js>"]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { applyScene, DEFAULTS, SCENES as SCENARIOS } from "../scripts/scenarios.mjs";
import { acquireOrWait } from "../scripts/lib/measure-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? [...a, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : a), []));
const port = args.port || 5295;
const only = String(args.only || "noon-cumulus").split(",");
const out = {};

const release = await acquireOrWait(REPO, "NIGHT-AP-1 逐位核对", console.log);
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  for (const name of only) {
    const sc = SCENARIOS.find((s) => s.name === name);
    if (!sc) throw new Error("未知场景 " + name);
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/eox|tiles|net::ERR|CORS/i.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}&voyage=0`, { waitUntil: "commit", timeout: 180000 });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
    await page.evaluate(() => { const q = window.__voyage.quality; if (q && q.tier !== "high") q.setTier("high"); const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; });
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: !!sc.ground });
    if (args.js) await page.evaluate(`(async () => { const v = window.__voyage; ${args.js} })()`);
    await page.evaluate(() => new Promise((r) => { let k = 0; const f = () => (++k >= 60 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
    const res = await page.evaluate(async (control) => {
      const v = window.__voyage;
      v.freeze(true);
      v.wingDebug.strobe = 0;
      const A = v.atmosphere, pass = v.clouds.pass, rr = pass.renderer, c = v.clouds;
      const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      const SM = v.sceneMat.constructor, RT = v.hdrOutside.constructor;
      const atlasT = new RT(1024, 64, { type: 1015, format: 1023, minFilter: 1003, magFilter: 1003, depthBuffer: false });
      const atlasM = new SM({
        uniforms: { uTex: { value: null } },
        vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
        fragmentShader: "precision highp sampler3D; uniform highp sampler3D uTex; void main() { ivec2 p = ivec2(gl_FragCoord.xy); gl_FragColor = texelFetch(uTex, ivec3(p.x % 32, p.y, p.x / 32), 0); }",
        depthTest: false, depthWrite: false,
      });
      const hash = (buf) => { let h = 2166136261 >>> 0; const u = new Uint32Array(buf.buffer); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
      const readT = (t, w, h) => { const b = new Float32Array(w * h * 4); rr.readRenderTargetPixels(t, 0, 0, w, h, b); return b; };
      const cmp = (a, b) => { let n = 0, mx = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { n++; const d = Math.abs(a[i] - b[i]) / Math.max(Math.abs(a[i]), Math.abs(b[i]), 1e-30); if (d > mx) mx = d; } return { diff: n, maxRel: mx }; };
      const lut = () => ["aerialInscatter", "aerialTransmittance"].map((k) => { atlasM.uniforms.uTex.value = A[k].texture; pass.render(atlasM, atlasT); return readT(atlasT, 1024, 64); });
      const cloudRaw = () => {
        const mat = (c.marchVariants.get(c.marchShown) || { mat: c.marchMat }).mat;
        mat.uniforms.uFrame.value = 7;
        pass.render(mat, c.raw);
        c.afterMarch?.(c.raw);
        return readT(c.raw, c.raw.width, c.raw.height);
      };
      const hdr = () => readT(v.hdrOutside, v.hdrOutside.width, v.hdrOutside.height);
      // 所有带 uApDir 的程序
      const mats = new Set([v.outsideMat, v.farTowers.mat, c.marchMat, v.sceneMat, v.wingMat]);
      for (const x of c.marchVariants.values()) mats.add(x.mat);
      const scan = (o, depth) => { if (!o || typeof o !== "object" || depth > 3) return; for (const k of Object.keys(o)) { const x = o[k]; if (x && x.isShaderMaterial) mats.add(x); else if (x instanceof Map) x.forEach((y) => scan(y, depth + 1)); else if (x && typeof x === "object" && !x.isTexture && !x.isWebGLRenderTarget) scan(x, depth + 1); } };
      scan(v.groundDetail, 0);
      const cons = [...mats].filter((m) => m && m.fragmentShader && m.fragmentShader.includes("uApDir"));
      const orig = new Map(cons.map((m) => [m, m.fragmentShader]));
      const lutM = A.aerialMaterial, lutOrig = lutM.fragmentShader;
      const toOld = (s) => s.replace(/uniform vec3 uApDir;\n/, "").replace(/uniform vec3 uApIlluminance;\n/, "").replace(/uApDir/g, "uSunDir").replace(/uApIlluminance/g, control ? "(uSunIlluminance * 1.001)" : "uSunIlluminance");
      let lutOld = lutOrig.replace(/  if \(uApSecondLocal\.w > 0\.5\) L = integrateSegment2\([^\n]*\n  else L = integrateSegment\(/, "  L = integrateSegment(");
      if (control) lutOld = lutOld.replace("dist, 24.0, T);", "dist, 23.0, T);");
      if (lutOld === lutOrig) return { error: "LUT 程序没替换成功" };
      const setOld = (on) => {
        for (const m of cons) { m.fragmentShader = on ? toOld(orig.get(m)) : orig.get(m); m.needsUpdate = true; }
        lutM.fragmentShader = on ? lutOld : lutOrig; lutM.needsUpdate = true;
      };
      const snap = async () => { await frames(8); return { lut: lut(), raw: cloudRaw(), hdr: (await frames(4), hdr()) }; };
      const cur = await snap();
      setOld(true);
      const old = await snap();
      setOld(false);
      const cur2 = await snap();
      setOld(true);
      const old2 = await snap();
      setOld(false);
      const rep = (a, b) => ({ lutL: cmp(a.lut[0], b.lut[0]), lutT: cmp(a.lut[1], b.lut[1]), raw: cmp(a.raw, b.raw), hdr: cmp(a.hdr, b.hdr) });
      return {
        consumers: cons.map((m) => m.name || "(无名)"), apState: { ...A.apState }, sunAlt: v.sunAltDeg(), moonAlt: v.moonAltDeg(),
        curVsOld: rep(cur, old), curVsCur2: rep(cur, cur2), cur2VsOld2: rep(cur2, old2), oldVsOld2: rep(old, old2),
        hashes: { lutL: hash(cur.lut[0]), raw: hash(cur.raw), hdr: hash(cur.hdr) },
      };
    }, !!args.control);
    res.errors = errors;
    out[name] = res;
    console.log(name, JSON.stringify(res));
    await page.context().close();
  }
  fs.mkdirSync(path.join(REPO, "tmp/screenshot/NIGHT-AP-1"), { recursive: true });
  fs.writeFileSync(path.join(REPO, "tmp/screenshot/NIGHT-AP-1", `parity-${Date.now()}.json`), JSON.stringify(out, null, 1));
} finally {
  await closeBrowserSafely(browser);
  release();
}
