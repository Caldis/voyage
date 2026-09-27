#!/usr/bin/env node
// T25：舱等（经济舱 / 商务舱）对照截图 + 切换测试（私有 headless，复用 scenarios.mjs 的场景表）。
// 用法：node handoff/T25-shots.mjs --port 5225 [--angle vulkan] [--only a,b] [--out tmp/screenshot/T25/x] [--switch]
// 场景名 = 回归场景名 + 可选后缀（可叠加）：
//   -econ / -biz          舱等（面板 cabin-class = economy / business；不写就是 DEFAULTS 里的值）
//   -on / -sleep / -off   舱灯三档
//   -ahead / -behind      「看前方」/「看后方」视角（右侧座位，头的位置取自 view-presets.ts）
// --switch：截图之后再测一次「商务舱 → 经济舱 → 商务舱」切换：记录变体编好的耗时、切换期间逐帧的帧间隔与画面平均亮度（查黑屏 / 跳帧）
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene, pickScenes } from "../scripts/scenarios.mjs";
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
const port = args.port || 5225;
const angle = args.angle || "d3d11";
const outDir = path.join(ROOT, args.out || "tmp/screenshot/T25/cur");
fs.mkdirSync(outDir, { recursive: true });
const DEFAULT_LIST = ["noon-cumulus-biz", "noon-cumulus-ahead-biz", "night-city-on-biz", "noon-cumulus-econ", "noon-cumulus-ahead-econ", "night-city-on-econ"];
const names = args.only ? String(args.only).split(",") : DEFAULT_LIST;
const LIGHT = { on: true, sleep: false, off: "off" };
const scenes = names.map((nm) => {
  const base = pickScenes([nm.replace(/(-(on|sleep|off|ahead|behind|econ|biz))+$/, "")])[0];
  if (!base) throw new Error(`未知场景 ${nm}`);
  const sc = { ...base, name: nm, p: { ...base.p } };
  for (const tok of nm.slice(base.name.length).split("-").filter(Boolean)) {
    if (tok in LIGHT) sc.p["cabin-light"] = LIGHT[tok];
    if (tok === "ahead") sc.head = [-0.42, 0.1, -0.5];
    if (tok === "behind") sc.head = [0.42, 0.1, -0.5];
    if (tok === "econ") sc.p["cabin-class"] = "economy";
    if (tok === "biz") sc.p["cabin-class"] = "business";
  }
  return sc;
});

const browser = await launchBrowser(chromium, { angle });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[控制台 ${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => console.log(`[页面异常] ${e.message}`));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  console.log(`启动 ${Date.now() - t0} ms`, JSON.stringify(await page.evaluate(() => window.__voyageStartup)));
  await page.waitForTimeout(2000);
  for (const sc of scenes) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    // 变体还在后台编译时等它编好（最多 120 s），截的才是目标舱等
    const want = sc.p["cabin-class"] ?? DEFAULTS["cabin-class"] ?? "business";
    await page.waitForFunction((w) => !window.__voyage.cabinClass || window.__voyage.cabinClass.shown === w, want, { timeout: 120000, polling: 250 });
    await page.evaluate(() => window.__voyage.snapAll());
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, `${sc.name}.png`), timeout: 60000 });
    const frameMs = await page.evaluate((n) => window.__voyage.benchFrame(n), 30);
    console.log(`${sc.name}: frameMs=${frameMs.toFixed(2)}`);
  }
  if (args.bench) {
    // 舱内合成 pass 的 GPU 开销：同一页面里两档交替测（benchScene(n, "cabin")），每轮每档 30 帧，取中位数
    for (const view of [null, [-0.42, 0.1, -0.5]]) {
      const sc = { ...pickScenes(["noon-cumulus"])[0], head: view ?? undefined };
      await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
      const r = await page.evaluate(async () => {
        const v = window.__voyage;
        const out = { business: [], economy: [] };
        for (let round = 0; round < 7; round++) {
          for (const c of ["business", "economy"]) {
            v.state.cabinClass = c;
            while (v.cabinClass.shown !== c) await new Promise((r) => requestAnimationFrame(r));
            await new Promise((r) => requestAnimationFrame(r));
            out[c].push(v.benchScene(30, "cabin"));
          }
        }
        const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
        return { business: +med(out.business).toFixed(3), economy: +med(out.economy).toFixed(3) };
      });
      console.log(`舱内合成 pass（${view ? "看前方" : "标准视角"}）ms：`, JSON.stringify(r));
    }
  }
  if (args.switch) {
    // 切换测试：面板改下拉 → 逐帧记录帧间隔与画面平均亮度，直到新舱等上屏后再多记 30 帧
    for (const to of ["economy", "business"]) {
      const r = await page.evaluate(async (to) => {
        const sel = document.getElementById("cabin-class");
        const cv = document.querySelector("canvas");
        const small = document.createElement("canvas");
        small.width = 16; small.height = 12;
        const ctx = small.getContext("2d", { willReadFrequently: true });
        const lum = () => {
          ctx.drawImage(cv, 0, 0, 16, 12);
          const d = ctx.getImageData(0, 0, 16, 12).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
          return s / (d.length / 4) / 3;
        };
        const t0 = performance.now();
        sel.value = to;
        sel.dispatchEvent(new Event("change"));
        const frames = [];
        let last = performance.now();
        let shownAt = -1;
        for (let i = 0; i < 2000; i++) {
          await new Promise((res) => requestAnimationFrame(res));
          const now = performance.now();
          frames.push({ dt: +(now - last).toFixed(1), lum: +lum().toFixed(1), shown: window.__voyage.cabinClass.shown });
          last = now;
          if (shownAt < 0 && window.__voyage.cabinClass.shown === to) shownAt = frames.length;
          if (shownAt >= 0 && frames.length > shownAt + 30) break;
        }
        const dts = frames.map((f) => f.dt);
        const lums = frames.map((f) => f.lum);
        return {
          to,
          readyMs: Math.round(performance.now() - t0),
          frames: frames.length,
          maxDt: Math.max(...dts),
          medianDt: dts.slice().sort((a, b) => a - b)[dts.length >> 1],
          minLum: Math.min(...lums),
          maxLum: Math.max(...lums),
          around: frames.slice(Math.max(0, shownAt - 4), shownAt + 4),
          slow: frames.map((f, i) => ({ i, ...f })).filter((f) => f.dt > 20),
        };
      }, to);
      console.log(`切换 → ${to}:`, JSON.stringify(r));
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
