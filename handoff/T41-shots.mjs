// T41 自测：拍一个场景（可选 uDebug、可选注入 JS），并可连拍 N 帧、每帧把头在 x 方向挪一点（看星点闪不闪）。
// 用法（路径相对仓库根）：
//   node apps/voyage/handoff/T41-shots.mjs --port 5241 --scene night-sea-milkyway --out tmp/screenshot/T41/x \
//        [--debug 32] [--frames 4 --dx 0.0003] [--eval "js"] [--angle vulkan]
// 输出：<out>/<scene>[-dbgN]-f<i>.png。适应（uDt）钉成 0、频闪关掉，所以连拍的帧只差头位。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const port = Number(a.port || 5241);
const frames = Number(a.frames || 1);
const dx = Number(a.dx || 0);
const outDir = path.join(REPO, a.out || "tmp/screenshot/T41/x");
fs.mkdirSync(outDir, { recursive: true });
const browser = await launchBrowser(chromium, { angle: a.angle || "vulkan" });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  page.on("console", (m) => m.type() === "error" && console.log("[console.error]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const sc = pickScenes([a.scene])[0];
  if (!sc) throw new Error("没有这个场景：" + a.scene);
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
  await page.waitForTimeout(Number(a.wait || 2500));
  await page.evaluate((d) => {
    window.__voyage.wingDebug.strobe = 0;
    const u = window.__voyage.exposure.adaptMat.uniforms.uDt;
    Object.defineProperty(u, "value", { configurable: true, get: () => 0, set: () => {} });
    if (d !== undefined) window.__voyage.sceneMat.uniforms.uDebug.value = Number(d);
  }, a.debug);
  if (a.eval) await page.evaluate(a.eval);
  const tag = a.scene + (a.debug !== undefined ? `-dbg${a.debug}` : "") + (a.tag ? `-${a.tag}` : "");
  for (let f = 0; f < frames; f++) {
    if (f > 0) {
      await page.evaluate((d) => {
        const h = window.__voyage.head;
        h.x += d;
        h.tx += d;
      }, dx);
    }
    await page.waitForTimeout(400);
    const file = path.join(outDir, `${tag}-f${f}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} finally {
  await closeBrowserSafely(browser);
}
