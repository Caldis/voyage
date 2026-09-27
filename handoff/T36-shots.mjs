#!/usr/bin/env node
// T36 专用截图：深暮光无云天空（wpac、云量 0），按太阳高度找时刻，左右座各一张。
// 用法：node handoff/T36-shots.mjs --port 5236 [--angle vulkan] [--elev -6,-10,-15,-18] [--seats left,right]
//        [--query lut16] [--table sunset-wing,...] [--cabin on] [--out tmp/screenshot/t36-5236] [--tag base]
// --query 附加到页面 URL 上（做对照实验用）；--tag 加在文件名前缀。
// 同时写一份 JSON：实际太阳高度、时刻、帧时间。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, SCENES, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : acc), []),
);
const port = args.port;
if (!port) throw new Error("需要 --port");
const angle = String(args.angle || "d3d11");
const elevs = String(args.elev || "-6,-10,-15,-18").split(",").map(Number);
const seats = String(args.seats || "left,right").split(",");
const CABIN = args.cabin === "on" ? true : "off"; // 默认关舱灯，免得舱内倒影盖住天空
const tag = args.tag ? `${args.tag}-` : "";
const outDir = path.join(REPO_ROOT, args.out || `tmp/screenshot/t36-${port}`);
fs.mkdirSync(outDir, { recursive: true });

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 300));
  });
  const q = args.query ? `&${args.query}` : "";
  await page.goto(`http://127.0.0.1:${port}/?t36=${Date.now()}${q}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });

  // 读信息栏里的太阳高度（每 250 ms 刷新）
  const elevAt = async (t) =>
    page.evaluate(async (t) => {
      const el = document.getElementById("time");
      el.value = String(t);
      el.dispatchEvent(new Event("input"));
      await new Promise((r) => setTimeout(r, 400));
      const m = document.getElementById("info").textContent.match(/太阳高度角 (-?[\d.]+)°/);
      return m ? Number(m[1]) : NaN;
    }, t);

  // --table a,b：改拍回归表里的场景（对照白天 / 黄昏 / 夜景不变），配合 --query lut16 得到改前画面
  if (args.table) {
    for (const sc of SCENES.filter((s) => String(args.table).split(",").includes(s.name))) {
      await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
      await page.screenshot({ path: path.join(outDir, `${tag}${sc.name}.png`), timeout: 60000 });
      const frameMs = await page.evaluate((n) => window.__voyage.benchFrame(n), 30);
      console.log(`${tag}${sc.name}: frame=${frameMs.toFixed(2)} ms`);
    }
    seats.length = 0;
  }
  for (const seat of seats) {
    // 先摆好场景（时刻随便给一个黄昏值），再二分找时刻
    await page.evaluate(applyScene, { sc: { name: "x", p: { preset: "wpac", seat, time: 1080, coverage: 0, "wing-pos": "-4", "cabin-light": CABIN } }, defaults: DEFAULTS });
    for (const target of elevs) {
      let lo = 1040, hi = 1260; // 黄昏段：时刻越晚太阳越低
      for (let i = 0; i < 9; i++) {
        const mid = Math.round((lo + hi) / 2);
        const e = await elevAt(mid);
        if (e > target) lo = mid;
        else hi = mid;
        if (hi - lo <= 1) break;
      }
      const eLo = await elevAt(lo);
      const eHi = await elevAt(hi);
      const t = Math.abs(eLo - target) < Math.abs(eHi - target) ? lo : hi;
      const sc = { name: "x", p: { preset: "wpac", seat, time: t, coverage: 0, "wing-pos": "-4", "cabin-light": CABIN } };
      const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
      const name = `${tag}sun${target}-${seat}`;
      await page.screenshot({ path: path.join(outDir, `${name}.png`), timeout: 60000 });
      const frameMs = await page.evaluate((n) => window.__voyage.benchFrame(n), 10);
      const elev = Number(info.match(/太阳高度角 (-?[\d.]+)°/)?.[1]);
      fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ seat, target, time: t, elev, frameMs, info }, null, 2));
      console.log(`${name}: time=${t} elev=${elev} frame=${frameMs.toFixed(2)} ms`);
    }
  }
  await context.close();
} finally {
  await closeBrowserSafely(browser);
}
