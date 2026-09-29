// NIGHT-AP-1 审查：主导切换点的镜像误差按 HDR 量（截图在 ×40 时间下曝光没跟上、几乎全黑，看不出差）。
// 上弦月 2026-07-21，太阳拨到 −14.2°（切换点），正常时间下等曝光稳定 → 冻结（cloudLive）→ 强制 sun / moon 主导、改前（old）各读回 hdrOutside。
// 用法：node handoff/NAP1rev-switch-hdr.mjs --port 5367 --heading 57 [--sun -14.2] [--date 2026-07-21]
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
const port = args.port || 5367;
const heading = +(args.heading || 57);
const sunT = +(args.sun || -14.2);
const date = args.date || "2026-07-21";
const outDir = path.join(REPO, `tmp/screenshot/NIGHT-AP-1-review/switch-${date}-${heading}`);
fs.mkdirSync(outDir, { recursive: true });
const log = (...s) => console.log("[switch]", ...s);
const sc = { name: "sw", p: { preset: "scs", date, time: 1140, "cloud-preset": "towering", coverage: 0.35, quality: "high", seat: "right" }, wait: 4000,
  js: `v.director.setHeading(${heading}); v.state.heading = ${heading}; v.state.bankDeg = 0; return 'ok';` };

const release = await acquireOrWait(REPO, "NIGHT-AP-1 审查 切换点 HDR", log);
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/eox|tiles|net::ERR|CORS/i.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}&voyage=0`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();
  await page.evaluate(() => { const q = window.__voyage.quality; if (q && q.tier !== "high") q.setTier("high"); const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; window.__voyage.wingDebug.strobe = 0; });
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
  const info = await page.evaluate(async (sunT) => {
    const v = window.__voyage;
    const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let i = 0; i < 800 && v.sunAltDeg() > sunT; i++) { v.state.simTime += 10000; await fr(); }
    return { sun: v.sunAltDeg(), moon: v.moonAltDeg(), ap: { ...v.atmosphere.apState } };
  }, sunT);
  log("到位", JSON.stringify(info));
  await page.waitForTimeout(20000); // 曝光适应
  await page.evaluate(() => { window.__voyage.freeze(true, { cloudLive: true }); });
  const res = {};
  for (const name of ["sun", "moon", "sun2", "old"]) {
    const buf = await page.evaluate(async (name) => {
      const v = window.__voyage, A = v.atmosphere;
      A.apMoon = name !== "old"; A.apForce = name === "old" ? null : name.replace("2", "");
      await new Promise((r) => { let k = 0; const f = () => (++k >= 90 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      const r = v.clouds.pass.renderer, t = v.hdrOutside, w = t.width, h = t.height;
      const b = new Float32Array(w * h * 4);
      r.readRenderTargetPixels(t, 0, 0, w, h, b);
      const u8 = new Uint8Array(b.buffer); let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return { w, h, b64: btoa(s) };
    }, name);
    fs.writeFileSync(path.join(outDir, `${name}.f32`), Buffer.from(buf.b64, "base64"));
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ w: buf.w, h: buf.h }));
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    log("读了", name);
  }
  await page.evaluate(() => { const A = window.__voyage.atmosphere; A.apMoon = true; A.apForce = null; });
  log("页面错误", errors.length ? errors : "无");
} finally {
  await closeBrowserSafely(browser);
  release();
}
