// NIGHT-AP-1 暮光切换：满月夜、太阳 −6° → −14° 加速时间流逝（live，不冻结），逐 rAF 读回画布窗区均值，
// 看主导光源从太阳换成月亮的那一帧有没有跳变；再在切换时刻冻结（cloudLive），强制太阳主导 / 月亮主导各拍一张，量「镜像误差」本身。
// 用法：node apps/voyage/handoff/NIGHT-AP-1-twilight.mjs --port 5295 [--heading 225] [--rate 40]
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
const heading = +(args.heading || 225);
const rate = +(args.rate || 40);
const outDir = path.join(REPO, "tmp/screenshot/NIGHT-AP-1/twilight-" + heading);
fs.mkdirSync(outDir, { recursive: true });
const log = (...s) => console.log("[twilight]", ...s);

const sc = { name: "twilight", p: { preset: "scs", date: "2026-07-29", time: 1140, "cloud-preset": "towering", coverage: 0.35, quality: "high", seat: "right" }, wait: 4000,
  js: `v.director.setHeading(${heading}); v.state.heading = ${heading}; v.state.bankDeg = 0; return 'ok';` };

const release = await acquireOrWait(REPO, "NIGHT-AP-1 暮光切换", log);
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
  // 拨到太阳 −6°
  const t0 = await page.evaluate(async () => {
    const v = window.__voyage;
    const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let i = 0; i < 400 && v.sunAltDeg() > -6; i++) { v.state.simTime += 20000; await fr(); }
    return { sun: v.sunAltDeg(), moon: v.moonAltDeg(), ap: { ...v.atmosphere.apState } };
  });
  log("起点", JSON.stringify(t0));
  await page.waitForTimeout(6000);
  // live：逐 rAF 读回窗区均值
  const rec = await page.evaluate(async (rate) => {
    const v = window.__voyage, A = v.atmosphere;
    const gl = v.clouds.pass.renderer.getContext();
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const x0 = Math.round(W * 0.3), y0 = Math.round(H * 0.3), w = Math.round(W * 0.45), h = Math.round(H * 0.4);
    const buf = new Uint8Array(w * h * 4);
    const out = [];
    v.state.playRate = rate;
    await new Promise((resolve) => {
      const f = () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < buf.length; i += 16) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
        const n = buf.length / 16;
        const s = A.apState;
        out.push([v.sunAltDeg(), s.dominant === "moon" ? 1 : 0, s.second ? 1 : 0, s.ratio, r / n, g / n, b / n, performance.now()]);
        if (v.sunAltDeg() > -14.5) requestAnimationFrame(f); else resolve();
      };
      requestAnimationFrame(f);
    });
    v.state.playRate = 0;
    return { rect: [x0, y0, w, h], out };
  }, rate);
  fs.writeFileSync(path.join(outDir, "live.json"), JSON.stringify(rec));
  const o = rec.out;
  const sw = o.findIndex((x, i) => i > 0 && x[1] !== o[i - 1][1]);
  const on = o.findIndex((x, i) => i > 0 && x[2] !== o[i - 1][2]);
  log(`帧数 ${o.length}，次要光源开始积分的帧 ${on}（太阳 ${on >= 0 ? o[on][0].toFixed(2) : "-"}°），主导切换帧 ${sw}（太阳 ${sw >= 0 ? o[sw][0].toFixed(2) : "-"}°）`);
  const lum = (x) => 0.2126 * x[4] + 0.7152 * x[5] + 0.0722 * x[6];
  const report = (k, label) => {
    if (k <= 0) return;
    const d = (i) => lum(o[i]) - lum(o[i - 1]);
    const around = [];
    for (let i = Math.max(1, k - 40); i < Math.min(o.length, k + 40); i++) if (i !== k) around.push(Math.abs(d(i)));
    around.sort((a, b) => a - b);
    log(`${label}：这一帧窗区亮度变化 ${d(k).toFixed(3)} 级（RGB ${[4, 5, 6].map((c) => (o[k][c] - o[k - 1][c]).toFixed(3)).join("/")}），前后 ±40 帧 |变化| 中位 ${around[around.length >> 1].toFixed(3)}、p95 ${around[Math.floor(around.length * 0.95)].toFixed(3)}、最大 ${around[around.length - 1].toFixed(3)}`);
  };
  report(on, "次要光源开始积分");
  report(sw, "主导切换");
  // 切换时刻冻结，强制两种主导各拍一张
  if (sw > 0) {
    const target = o[sw][0];
    const info = await page.evaluate(async (target) => {
      const v = window.__voyage;
      const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (let i = 0; i < 200 && v.sunAltDeg() < target; i++) { v.state.simTime -= 5000; await fr(); }
      v.freeze(true, { cloudLive: true });
      return { sun: v.sunAltDeg(), moon: v.moonAltDeg(), ap: { ...v.atmosphere.apState } };
    }, target);
    log("冻结在", JSON.stringify(info));
    for (const [name, force] of [["sunDom", "sun"], ["moonDom", "moon"], ["sunDom2", "sun"], ["old", "old"]]) {
      await page.evaluate((force) => { const A = window.__voyage.atmosphere; A.apMoon = force !== "old"; A.apForce = force === "old" ? null : force; }, force);
      await page.evaluate(() => new Promise((r) => { let k = 0; const f = () => (++k >= 90 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
      await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    }
    await page.evaluate(() => { const A = window.__voyage.atmosphere; A.apMoon = true; A.apForce = null; });
  }
  log("页面错误", errors.length ? errors : "无");
} finally {
  await closeBrowserSafely(browser);
  release();
}
