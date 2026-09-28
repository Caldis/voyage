// T48c 复审脚本 t48crev-pulse.mjs 的副本（只改了路径参数与等锁）。复审用：不冻结、不截图，每个 rAF 后 readPixels 城区裁剪，记均值与 16×16 分块均值 + 当帧频闪相位。
// 模式轮流：cur（现行）、unwired（exposure.flash 恒 0 = T48b 即时适应 + 机翼改动）、noLocal。看频闪窗口内城区是否「跟着闪」。
import { chromium } from "playwright-core";
import fs from "node:fs";
import { DEFAULTS, applyScene, pinGeometry } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { readLock, waitForRelease } from "../scripts/lib/measure-lock.mjs";
// 用法（apps/voyage 下）：node handoff/T48c-pulse.mjs <端口> <场景,...> <输出 json>；分析：python handoff/T48c-cfg/t48c_pulsean.py <json>
const port = process.argv[2] || "5229";
const only = (process.argv[3] || "night-city-low,night-city-off").split(",");
const scenes = JSON.parse(fs.readFileSync(new URL("./T48c-cfg/scenes.json", import.meta.url), "utf8")).filter((s) => only.includes(s.name));
const crop = [450, 900, 500, 200];
if (readLock("../..")) await waitForRelease("../..", { log: (x) => console.log(`[pulse] ${x}`) });
const browser = await launchBrowser(chromium, { angle: "vulkan" });
const out = {};
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  await page.evaluate(() => {
    const v = window.__voyage, ex = v.exposure; v.weather.hold = true; v.weather.heldIntensity = 0;
    let f = 0; window.__unwired = false;
    Object.defineProperty(ex, "flash", { get: () => (window.__unwired ? 0 : f), set: (x) => { f = x; }, configurable: true });
  });
  for (const sc of scenes) {
    const e0 = errors.length;
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    await page.evaluate(pinGeometry, sc);
    await page.waitForFunction(() => !window.__voyage.ground || window.__voyage.ground.pending === 0, null, { timeout: 120000, polling: 500 }).catch(() => {});
    await page.waitForTimeout(2000);
    const modes = ["cur", "unwired", "noLocal"];
    const res = { cur: [], unwired: [], noLocal: [] };
    for (let r = 0; r < Number(process.env.T48C_ROUNDS || 6); r++) for (let j = 0; j < 3; j++) {
      const m = modes[(j + r) % 3];
      const seg = await page.evaluate(async ({ m, crop }) => {
        const v = window.__voyage, u = v.exposure.finalMat.uniforms;
        window.__unwired = m === "unwired"; u.uNightLocal.value.y = m === "noLocal" ? 0 : 0.6;
        for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));
        const cv = document.querySelector("canvas"), gl = cv.getContext("webgl2");
        const H = gl.drawingBufferHeight, [x, y0, w, h] = crop, y = H - y0 - h;
        const buf = new Uint8Array(w * h * 4), T = 16, tw = Math.floor(w / T), th = Math.floor(h / T);
        const rows = [];
        for (let i = 0; i < 160; i++) {
          const now = await new Promise((r) => requestAnimationFrame(r));
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          const tiles = new Float64Array(tw * th); let s = 0;
          for (let yy = 0; yy < th * T; yy++) for (let xx = 0; xx < tw * T; xx++) { const k = (yy * w + xx) * 4; const l = 0.2126 * buf[k] + 0.7152 * buf[k + 1] + 0.0722 * buf[k + 2]; s += l; tiles[Math.floor(yy / T) * tw + Math.floor(xx / T)] += l / (T * T); }
          rows.push({ t: now, strobe: v.wingMat.uniforms.uStrobe.value, mean: s / (tw * th * T * T), tiles: Array.from(tiles, (q) => Math.round(q * 10) / 10) });
        }
        return rows;
      }, { m, crop });
      res[m].push(seg);
    }
    await page.evaluate(() => { window.__unwired = false; window.__voyage.exposure.finalMat.uniforms.uNightLocal.value.y = 0.6; });
    out[sc.name] = res;
    const errs = errors.slice(e0);
    console.log(sc.name, "errors", errs.length, "cors", errs.filter((t) => /CORS|eox/i.test(t)).length);
  }
  fs.writeFileSync(process.argv[4] || "pulse.json", JSON.stringify(out));
} finally {
  await closeBrowserSafely(browser);
}
