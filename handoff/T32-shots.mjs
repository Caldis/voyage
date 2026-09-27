#!/usr/bin/env node
// T32：云层规则重复纹理的定位 / 对照截图（私有 headless）。
// 用法：node apps/voyage/handoff/T32-shots.mjs --port 5232 [--angle vulkan] [--out tmp/screenshot/T32/cur]
//       [--dbg 0,1,2]（定位用：依次把 uT32Dbg 设成这些值各拍一张；分支上没有这个 uniform 时只拍 0）
//       [--only sc-top,cu-top]（只拍这几个视角）  [--burst]（每个视角再连拍 4 张，看闪烁）
// 视角：用户截图（13.png）的复现——wpac 巡航 10.7 km、贴窗往下看中远处的一片云海：
//   sc-*：层积云云海（stratocumulus，覆盖度 0.85）；cu-*：积云（cumulus，覆盖度 0.8）
//   *-top 看斜下方中远处（画面中心斜距约 15–25 km），*-far 看更远（接近地平线）
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const n = process.argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { args[a.slice(2)] = n; i++; } else args[a.slice(2)] = true;
  }
}
const port = args.port || 5232;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/T32/cur");
const dbgs = String(args.dbg ?? "0").split(",").map(Number);
fs.mkdirSync(outDir, { recursive: true });

const P = { preset: "wpac", time: 960, altitude: 10.7, "wing-pos": "8" };
const VIEWS = [
  { name: "sc-top", p: { ...P, "cloud-preset": "stratocumulus", coverage: 0.85 }, head: [0, 0.16, -0.08], offset: [11, 23] },
  { name: "cu-top", p: { ...P, "cloud-preset": "cumulus", coverage: 0.8 }, head: [0, 0.16, -0.08], offset: [11, 23] },
  { name: "sc-far", p: { ...P, "cloud-preset": "stratocumulus", coverage: 0.85 }, head: [0, 0.06, -0.08], offset: [11, 23] },
  { name: "cu-far", p: { ...P, "cloud-preset": "cumulus", coverage: 0.8 }, head: [0, 0.06, -0.08], offset: [11, 23] },
  // 贴近地平线（50–150 km）：看形状噪声 7 km 周期会不会露出来
  { name: "sc-hor", p: { ...P, "cloud-preset": "stratocumulus", coverage: 0.85 }, head: [0, -0.01, -0.08], offset: [11, 23] },
  { name: "cu-hor", p: { ...P, "cloud-preset": "cumulus", coverage: 0.8 }, head: [0, -0.01, -0.08], offset: [11, 23] },
  // 探索：用户截图的光线（傍晚、地平线发粉）、积云高覆盖度，换几处云场位置
  ...[[0, 0], [37, -12], [-60, 45], [120, 80]].map((o, i) => ({
    name: `ex${i}-far`, p: { ...P, time: 1040, "cloud-preset": "cumulus", coverage: 0.8 }, head: [0, 0.06, -0.08], offset: o,
  })),
];
const only = args.only ? String(args.only).split(",") : null;
const views = only ? VIEWS.filter((v) => only.includes(v.name)) : VIEWS;

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 400)); });
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 600000, polling: 500 });
  for (const v of views) {
    for (const dbg of dbgs) {
      await page.evaluate((d) => {
        const u = window.__voyage.cloudUniforms;
        if (u.uT32Dbg) u.uT32Dbg.value = d;
      }, dbg);
      // 视角固定：飞机不动（每次都重设偏移），时间累积重新开始
      await page.evaluate(applyScene, { sc: { ...v, wait: 3500 }, defaults: DEFAULTS });
      const f = path.join(outDir, `${v.name}${dbgs.length > 1 || dbg ? `-d${dbg}` : ""}.png`);
      await page.screenshot({ path: f });
      console.log("  ", path.relative(ROOT, f));
      // --burst：再连拍 4 张（约 100 ms 一张）看时间稳定性（受光步进随机挑格点的噪点有没有被时间累积抹平）
      if (args.burst) {
        for (let k = 0; k < 4; k++) {
          await new Promise((r) => setTimeout(r, 100));
          await page.screenshot({ path: f.replace(/\.png$/, `-burst${k}.png`) });
        }
      }
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
