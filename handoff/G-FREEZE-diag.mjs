// G-FREEZE：冻结后地面还在不在变。按 dev-browser ab 同样的流程摆场景、冻结、等 pending===0 + 2 s，
// 然后打开 ground.events，连续观察 --secs 秒：每秒截一张（整窗哈希），同时记各级状态、换版计数、构建 / 换上事件。
// 用法（apps/voyage 下）：node handoff/G-FREEZE-diag.mjs <端口> [场景名,…] [观察秒数]
// 场景名取 scripts/scenarios.mjs，另加 night-city-low（T48c / W-LAMP 用的 1 km 夜城）
import { chromium } from "playwright-core";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, SCENES, applyScene, pinGeometry } from "../scripts/scenarios.mjs";
import { acquireMeasureLock } from "../scripts/lib/ab.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const [port, only = "night-city-low,night-city-off", secsArg = "40"] = process.argv.slice(2);
if (!port) throw new Error("用法：node handoff/G-FREEZE-diag.mjs <端口> [场景名,…] [观察秒数]");
const secs = Number(secsArg);
const EXTRA = [
  { name: "night-city-low", p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 1, coverage: 0.15, "cabin-light": "off" }, offset: [0, -25], ground: true, head: -0.25 },
];
const all = [...SCENES, ...EXTRA];
const log = (s) => console.log(`[G-FREEZE-diag] ${s}`);
const outDir = path.join(REPO_ROOT, "tmp/screenshot/G-FREEZE/diag");
fs.mkdirSync(outDir, { recursive: true });
const release = await acquireMeasureLock(REPO_ROOT, `G-FREEZE-diag.mjs（端口 ${port}, pid ${process.pid}）`, log);
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  page.on("pageerror", (e) => log(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/eox\.at|tiles\.maps|CORS policy|net::ERR_/i.test(m.text())) log(`console error ${m.text().slice(0, 200)}`); });
  await page.goto(`http://127.0.0.1:${port}/?gfreeze=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => { const q = window.__voyage.quality; if (q && q.tier !== "high") q.setTier("high"); const w = window.__voyage.weather; w.hold = true; w.heldIntensity = 0; });
  for (const name of only.split(",")) {
    const sc = all.find((s) => s.name === name);
    if (!sc) throw new Error(`未知场景 ${name}`);
    const t0 = Date.now();
    await page.evaluate(() => { window.__voyage.ground.events = []; });
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    await page.evaluate(pinGeometry, sc);
    await page.evaluate(async () => { for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r)); });
    await page.evaluate(() => { window.__voyage.freeze(true); window.__voyage.wingDebug.strobe = 0; window.__voyage.__gfT = performance.now(); });
    await page.waitForFunction(() => window.__voyage.ground.pending === 0, null, { timeout: 120000, polling: 500 }).catch(() => log("pending 等待超时"));
    await page.waitForTimeout(2000);
    log(`${name}：冻结 + pending=0 + 2 s，用时 ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const st0 = await page.evaluate(() => window.__voyage.ground.levelState);
    log(`  起点：uploads=${st0.uploads} pending=${st0.pending} queue=${st0.queue} stitch=${st0.stitch} compose=${st0.compose} warm=${st0.warm}`);
    log(`  各级：${st0.levels.map((l, i) => `L${i}${l.valid ? "" : "!v"}${l.building ? "B" : ""}${l.fine ? "f" : "c"}${l.stale ? "S" : ""}`).join(" ")}`);
    let prevHash = null;
    const rows = [];
    for (let s = 0; s <= secs; s++) {
      const buf = await page.screenshot({ timeout: 60000 });
      const h = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 10);
      const st = await page.evaluate(() => ({ ...window.__voyage.ground.levelState, since: performance.now() - window.__voyage.__gfT }));
      const changed = prevHash !== null && h !== prevHash;
      if (changed || s === 0) fs.writeFileSync(path.join(outDir, `${name}.t${String(s).padStart(2, "0")}.png`), buf);
      rows.push({ s, h, changed, uploads: st.uploads, pending: st.pending, queue: st.queue, stitch: st.stitch, compose: st.compose, building: st.levels.map((l, i) => (l.building ? i : null)).filter((x) => x !== null).join(""), fine: st.levels.map((l) => (l.fine ? "f" : "c")).join("") });
      log(`  t+${s}s hash=${h}${changed ? " *变*" : ""} uploads=${st.uploads} pending=${st.pending} queue=${st.queue} stitch=${st.stitch} compose=${st.compose} building=[${rows.at(-1).building}] fine=${rows.at(-1).fine}`);
      prevHash = h;
      await page.waitForTimeout(1000);
    }
    const ev = await page.evaluate(() => ({ ev: window.__voyage.ground.events, fz: window.__voyage.__gfT }));
    log(`  事件（相对冻结时刻，秒）：`);
    for (const e of ev.ev) log(`    ${((e.t - ev.fz) / 1000).toFixed(2)} ${e.kind} L${e.level} ${JSON.stringify({ ...e, t: undefined, kind: undefined, level: undefined })}`);
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ rows, events: ev.ev, freezeAt: ev.fz }, null, 2));
    await page.evaluate(() => { window.__voyage.ground.events = null; window.__voyage.freeze(false); window.__voyage.wingDebug.strobe = null; });
  }
} finally {
  await closeBrowserSafely(browser);
  release();
}
