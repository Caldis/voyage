// NIGHT-AP-1 验收：沿用 research/NIGHT_AP.md 的场景与 ROI 口径（apps/voyage/tmp/night-ap/run.mjs 改的），同页冻结 A/B。
// 变体：base = atmosphere.apMoon = false（等价改前：只有太阳一路），new = 本次实现，noAP = 云 / 远塔不做空气透视（取掩膜），new2 = new 重拍（噪声底）
// 用法：node apps/voyage/handoff/NIGHT-AP-1-run.mjs --port 5295 --scene behind|front|nomoon [--out tmp/screenshot/NIGHT-AP-1]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { applyScene, DEFAULTS } from "../scripts/scenarios.mjs";
import { acquireOrWait } from "../scripts/lib/measure-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? [...a, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : a), []));
const port = args.port || 5295;
const which = args.scene || "behind";
const outDir = path.join(REPO, args.out || "tmp/screenshot/NIGHT-AP-1", which);
fs.mkdirSync(outDir, { recursive: true });
const log = (...s) => console.log(`[nap ${which}]`, ...s);

const SCENE_JS = (heading) => `const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const w = v.director.weather; v.director.setHeading(${heading}); v.state.heading = ${heading}; v.state.bankDeg = 0; w.onJump(); await sleep(15000); w.onJump(); await sleep(3000); for (let i = 0; i < 90 && Math.abs(v.state.bankDeg) > 0.5; i++) await sleep(1000); await sleep(8000); const f = v.farTowers; const ob = (v.state.heading + (v.state.seat === 'right' ? 90 : -90)) * Math.PI / 180; const vis = f.towers.filter((t) => { const b = Math.atan2(t.x, -t.z); return Math.abs(Math.atan2(Math.sin(b - ob), Math.cos(b - ob))) < 0.44; }); return '塔 ' + f.towers.length + ' 窗内 ' + vis.length + '：' + vis.map((t) => Math.round(t.dist) + 'km/顶' + t.top.toFixed(1) + '/砧' + t.anvil.toFixed(2)).join(', ') + ' | ' + w.describe();`;

const date = which === "nomoon" ? "2026-08-12" : "2026-07-29";
const sc = { name: which, p: { preset: "scs", date, time: 1320, quality: "high" }, continuousJourney: true, wait: 4000, js: SCENE_JS(225) };

const release = await acquireOrWait(REPO, `NIGHT-AP-1 月夜空气透视验收（${which}）`, log);
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/eox|tiles|net::ERR|CORS/i.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}&voyage=0`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const renderer = await page.evaluate(() => {
    const gl = window.__voyage.clouds.pass.renderer.getContext();
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
  });
  log("GL_RENDERER", renderer);
  if (/swiftshader|warp|disabled/i.test(renderer)) throw new Error("软渲染");
  await page.evaluate(() => { const q = window.__voyage.quality; if (q && q.tier !== "high") q.setTier("high"); const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; });
  log("启动完成，摆场景（约 40 s）");
  const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
  log(info.split("\n").slice(-1)[0]);

  await page.evaluate(() => {
    const v = window.__voyage;
    const A = v.atmosphere;
    const su = v.sceneMat.uniforms;
    const pass = v.clouds.pass;
    const D3 = A.aerialInscatter.texture.constructor;
    const mk = (val) => { const t = new D3(new Float32Array(val), 1, 1, 1); t.type = 1015; t.format = 1023; t.minFilter = t.magFilter = 1006; t.needsUpdate = true; return t; };
    const black = mk([0, 0, 0, 1]), white = mk([1, 1, 1, 1]);
    const cu = v.clouds.marchMat.uniforms, fu = v.farTowers.mat.uniforms;
    const keys = ["uAerialInscatter", "uAerialTransmittance"];
    const saved = { cu: Object.fromEntries(keys.map((k) => [k, cu[k]])), fu: Object.fromEntries(keys.map((k) => [k, fu[k]])) };
    window.__nap = {
      set(o) {
        for (const [d, s] of [[cu, saved.cu], [fu, saved.fu]]) for (const k of keys) d[k] = s[k];
        A.apMoon = !o.base;
        if (o.noAP) for (const d of [cu, fu]) { d.uAerialInscatter = { value: black }; d.uAerialTransmittance = { value: white }; }
      },
      read() {
        const r = pass.renderer, t = v.hdrOutside, w = t.width, h = t.height;
        const buf = new Float32Array(w * h * 4);
        r.readRenderTargetPixels(t, 0, 0, w, h, buf);
        const w2 = w >> 1, h2 = h >> 1, o = new Float32Array(w2 * h2 * 3);
        for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) for (let c = 0; c < 3; c++) {
          const i = (a, b) => ((2 * y + b) * w + 2 * x + a) * 4 + c;
          o[(y * w2 + x) * 3 + c] = 0.25 * (buf[i(0, 0)] + buf[i(1, 0)] + buf[i(0, 1)] + buf[i(1, 1)]);
        }
        const u8 = new Uint8Array(o.buffer); let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return { w: w2, h: h2, b64: btoa(s) };
      },
      meta() {
        const md = su.uMoonDir.value;
        const az = (d) => ((Math.atan2(d.x, -d.z) * 180) / Math.PI + 360) % 360;
        return {
          moonAlt: v.moonAltDeg(), sunAlt: v.sunAltDeg(), moonAz: az(md), heading: v.state.heading, seat: v.state.seat,
          moonKlux: su.uMoonIlluminance.value.toArray(), apState: { ...A.apState }, apI: A.sharedUniforms.uApIlluminance.value.toArray(), camR: su.uCamR.value,
          towers: v.farTowers.towers.map((t) => ({ d: Math.round(t.dist), b: Math.round(((Math.atan2(t.x, -t.z) * 180) / Math.PI + 360) % 360), top: +t.top.toFixed(1) })),
        };
      },
    };
  });

  if (which === "front") {
    await page.evaluate(() => {
      const v = window.__voyage, m = window.__nap.meta();
      const h = (m.moonAz - (v.state.seat === "right" ? 90 : -90) + 360) % 360;
      v.director.setHeading(h); v.state.heading = h; v.state.bankDeg = 0;
    });
    await page.waitForTimeout(12000);
  }
  await page.evaluate(() => { window.__voyage.freeze(true, { cloudLive: true }); window.__voyage.wingDebug.strobe = 0; });
  const meta = await page.evaluate(() => window.__nap.meta());
  log(JSON.stringify(meta));
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ renderer, info, meta }, null, 1));

  const variants = [["base", { base: true }], ["new", {}], ["noAP", { noAP: true }], ["new2", {}], ["base2", { base: true }]];
  for (const [name, o] of variants) {
    await page.evaluate((o) => window.__nap.set(o), o);
    await page.evaluate(() => new Promise((r) => { let k = 0; const f = () => (++k >= 90 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    const d = await page.evaluate(() => window.__nap.read());
    fs.writeFileSync(path.join(outDir, `${name}.f32`), Buffer.from(d.b64, "base64"));
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ w: d.w, h: d.h, apState: await page.evaluate(() => ({ ...window.__voyage.atmosphere.apState })) }));
    log("拍了", name);
  }
  log("页面错误", errors.length ? errors : "无");
} finally {
  await closeBrowserSafely(browser);
  release();
}
