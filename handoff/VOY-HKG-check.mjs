// VOY-HKG 验收：连续航程（voyage=1）下，每个预设的「首段」不能起终点相同，坡度也不能一直压着不回平。
// 流程：每个预设各开一个全新上下文，voyage=1 载入（走真实首载路径），再用面板「地点」下拉切到目标预设
// （和用户在 UI 上操作完全一致，不直接调 setPreset()），采样 60 s 内的 bankDeg 与 leg.from/to。
// 用法：node apps/voyage/handoff/VOY-HKG-check.mjs <端口> [--out tmp/screenshot/VOY-HKG]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const argv = process.argv.slice(2);
const port = Number(argv[0]);
const outDir = path.resolve(repoRoot, argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "tmp/screenshot/VOY-HKG");
fs.mkdirSync(outDir, { recursive: true });
if (!port) throw new Error("用法：node VOY-HKG-check.mjs <端口> [--out dir]");

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "[OK]  " : "[FAIL]"} ${name}${detail !== undefined ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

async function open(context, p, query = "?voyage=1") {
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    const url = (m.location && m.location().url) || "";
    if (/eox\.at|tiles\.maps|CORS policy/i.test(t + url) || (/net::ERR_/.test(t) && !url.startsWith(`http://127.0.0.1:${p}`))) return;
    errors.push(t);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${p}/${query}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 100 });
  return { page, errors };
}

const snap = (page) =>
  page.evaluate(() => {
    const v = window.__voyage;
    const d = v.director;
    return {
      bankDeg: +v.state.bankDeg.toFixed(2),
      heading: +v.state.heading.toFixed(1),
      leg: d.leg ? { from: d.leg.from.code, to: d.leg.to.code, distKm: Math.round(d.leg.distKm) } : null,
      preset: v.state.preset.id,
    };
  });

const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  // 先打开一次页面，从面板「地点」下拉读出全部预设 id（不硬编码，跟 src/flight.ts 的 PRESETS 保持同步）
  const probeCtx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const { page: probePage } = await open(probeCtx, port);
  const presetIds = await probePage.evaluate(() => Array.from(document.getElementById("preset").options).map((o) => o.value));
  await probeCtx.close();
  console.log(`预设列表（${presetIds.length} 个）：${presetIds.join(", ")}`);

  for (const id of presetIds) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
    const { page, errors } = await open(ctx, port);
    // 面板可能默认隐藏，先展开再用真实下拉操作切换地点（和用户在 UI 上点一致，不直接调 setPreset()）
    await page.evaluate(() => document.getElementById("panel").classList.remove("hidden"));
    await page.selectOption("#preset", id);
    const t0 = Date.now();
    const s0 = await snap(page);
    ok(`[${id}] 首段起终点不同`, !s0.leg || s0.leg.from !== s0.leg.to, s0.leg);
    await page.screenshot({ path: path.join(outDir, `${id}-start.png`) });

    // 60 s 内采样 bankDeg，找「回到 ≤5° 之后不再超过」的最早时刻（避免 t=0 时 bankDeg 恰好是 0 造成假阳性：
    // 起转前也是 0，所以要看「转弯过程中有没有一直压着不回来」）
    const samples = [];
    let recoveredAt = null;
    while (Date.now() - t0 < 60000) {
      const s = await snap(page);
      const t = Date.now() - t0;
      samples.push({ t, bankDeg: s.bankDeg, heading: s.heading });
      if (Math.abs(s.bankDeg) <= 5 && recoveredAt === null && t > 2000) recoveredAt = t; // 给最初 2 s 的起转留余量
      if (Math.abs(s.bankDeg) > 5) recoveredAt = null; // 之后又超过 5° 就不算数，继续找下一次回落
      await new Promise((r) => setTimeout(r, 1000));
    }
    const maxBank = Math.max(...samples.map((s) => Math.abs(s.bankDeg)));
    const s60 = await snap(page);
    ok(`[${id}] 60 s 内坡度回到 ≤5°`, recoveredAt !== null, { recoveredAtMs: recoveredAt, maxBankDeg: maxBank, finalBankDeg: s60.bankDeg, leg: s60.leg });
    await page.screenshot({ path: path.join(outDir, `${id}-60s.png`) });
    ok(`[${id}] 控制台零 error`, errors.length === 0, errors.slice(0, 5));
    fs.writeFileSync(path.join(outDir, `${id}-samples.json`), JSON.stringify(samples, null, 2));
    await ctx.close();
  }
} finally {
  await closeBrowserSafely(browser);
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过");
process.exit(failed.length ? 1 : 0);
