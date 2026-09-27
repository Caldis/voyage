#!/usr/bin/env node
// T43：每个场景在**同一位置、同一曝光**拍三张：正常画面、调试 24（只画道路灯带）、调试 25（去掉道路灯带）。
// 正常 − 调试 25 = 道路的贡献，交给 T43-stats.py / T43-report.py 量「道路 / 城区灯点地毯」的亮度比。
// 做法：场景稳定后冻结曝光适应、停掉主循环，之后每张图都把飞机位置拨回同一点再手动渲染几帧（benchFrame），
// 否则两张图之间飞机前进了几十米，城市灯点的格子整体错开，相减全是灯点。每个场景开一个新页面（主循环停了就不再重启）。
// 用法：node handoff/T43-shots.mjs --port 5243 [--angle vulkan] [--only night-city,route-hnd-cts-night] [--scene '<JSON>'] [--out tmp/screenshot/T43/x] [--wait 6000]
// --out 相对仓库根（worktree 根）；要写到主仓库的 tmp，用 ../../../tmp/...
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = { scene: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const n = process.argv[i + 1];
    const v = n !== undefined && !n.startsWith("--") ? (i++, n) : true;
    if (a === "--scene") args.scene.push(v); else args[a.slice(2)] = v;
  }
}
const port = args.port || 5243;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/T43/shots");
fs.mkdirSync(outDir, { recursive: true });
const scenes = [...(args.only ? pickScenes(String(args.only).split(",")) : []), ...args.scene.map((s) => JSON.parse(s))];
const wait = Number(args.wait || 6000);

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  for (const sc of scenes) {
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log(`[控制台 error] ${m.text()}`); });
    page.on("pageerror", (e) => console.log(`[页面异常] ${e.message}`));
    let fails = 0;
    page.on("requestfailed", (r) => { if (!/127\.0\.0\.1/.test(r.url())) fails++; });
    page.on("response", (r) => { if (!r.ok() && !/127\.0\.0\.1/.test(r.url())) fails++; });
    await page.goto(`http://127.0.0.1:${port}/?t43=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
    await page.waitForTimeout(1500);
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    await page.evaluate(() => { window.__voyage.wingDebug.strobe = 0; });
    await page.waitForTimeout(wait);
    await page.evaluate(() => {
      const u = window.__voyage.exposure.adaptMat.uniforms.uDt;
      Object.defineProperty(u, "value", { configurable: true, get: () => 0, set: () => {} });
      window.requestAnimationFrame = () => 0;
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.__t43O = window.__voyage.cloudUniforms.uCloudOffset.value.clone(); });
    // 停在原地再推几帧、等一等：还在路上的瓦片落地、clipmap 各级上传完，三张图的地面数据才一致
    for (let k = 0; k < 10; k++) {
      await page.evaluate(() => { const v = window.__voyage; v.cloudUniforms.uCloudOffset.value.copy(window.__t43O); v.benchFrame(1); });
      await page.waitForTimeout(400);
    }
    for (const [mode, suffix] of [[0, ""], [24, "_road"], [25, "_noroad"], ...(args.again ? [[0, "_again"]] : [])]) {
      await page.evaluate((d) => {
        const v = window.__voyage;
        v.sceneMat.uniforms.uDebug.value = d;
        for (let i = 0; i < 4; i++) { v.cloudUniforms.uCloudOffset.value.copy(window.__t43O); v.benchFrame(1); }
      }, mode);
      await page.screenshot({ path: path.join(outDir, `${sc.name}${suffix}.png`), timeout: 60000 });
    }
    console.log(`[T43-shots] ${sc.name}  外部请求失败 ${fails}`);
    await page.close();
  }
} finally {
  await closeBrowserSafely(browser);
}
