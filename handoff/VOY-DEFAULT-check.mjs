// VOY-DEFAULT 验收：连续航程默认开启 / 记住手动关闭 / ?voyage=0|1 强制 / 首载数字。
// 用法：node apps/voyage/handoff/VOY-DEFAULT-check.mjs <端口> [--base <对照端口>] [--out tmp/screenshot/VOY-DEFAULT]
// 每一步都用全新的浏览器上下文（localStorage 为空），走真实 GPU（d3d11）。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const argv = process.argv.slice(2);
const port = Number(argv[0]);
const base = argv.includes("--base") ? Number(argv[argv.indexOf("--base") + 1]) : null;
const outDir = path.resolve(repoRoot, argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "tmp/screenshot/VOY-DEFAULT");
fs.mkdirSync(outDir, { recursive: true });
if (!port) throw new Error("用法：node VOY-DEFAULT-check.mjs <端口> [--base <对照端口>]");

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "[OK]  " : "[FAIL]"} ${name}${detail !== undefined ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

async function open(context, p, query = "") {
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
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${p}/${query}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 100 });
  const loadMs = Date.now() - t0;
  return { page, errors, loadMs };
}

const state = (page) =>
  page.evaluate(() => {
    const v = window.__voyage;
    const d = v.director;
    return {
      active: d.active,
      rate: d.rate,
      checked: document.getElementById("voyage-on").checked,
      ratesHidden: document.getElementById("voyage-rates").hidden,
      leg: d.leg ? `${d.leg.from.code}->${d.leg.to.code} ${Math.round(d.leg.distKm)}km cruise ${d.leg.cruiseKm}` : null,
      regime: d.weather.regime,
      log: d.weather.log.slice(0, 3).map((e) => e.event),
      cloud: v.clouds.params(),
      storms: v.weather.storms.length,
      alt: +v.state.altitudeKm.toFixed(2),
      cabinLight: document.getElementById("cabin-light").value,
      pref: localStorage.getItem("voyage.continuousJourney"),
      startup: window.__voyageStartup,
    };
  });

/** 首载后 10 s 内的帧间隔：长帧（> 50 ms）个数与最长一帧——看默认开启连续航程会不会在首屏后引来编译卡顿 */
const jank = (page, ms = 10000) =>
  page.evaluate(async (ms) => {
    const gaps = [];
    let last = performance.now();
    const t0 = last;
    await new Promise((resolve) => {
      const f = (t) => {
        gaps.push(t - last);
        last = t;
        if (t - t0 < ms) requestAnimationFrame(f);
        else resolve();
      };
      requestAnimationFrame(f);
    });
    gaps.sort((a, b) => b - a);
    return { frames: gaps.length, over50: gaps.filter((g) => g > 50).length, over100: gaps.filter((g) => g > 100).length, max: Math.round(gaps[0]), p99: Math.round(gaps[Math.floor(gaps.length * 0.01)]) };
  }, ms);

const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  // 1. 全新页面：默认开启
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
    const { page, errors, loadMs } = await open(ctx, port);
    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const e = gl.getExtension("WEBGL_debug_renderer_info");
      return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
    });
    ok("硬件渲染", !/SwiftShader|WARP|Basic Render/i.test(renderer), renderer);
    const s = await state(page);
    ok("新页面默认开启连续航程", s.active && s.checked && !s.ratesHidden, { active: s.active, checked: s.checked });
    ok("默认 1× 流速", s.rate === 1, s.rate);
    ok("天气场驱动云（首帧对齐天气场）", s.log.some((e) => e.startsWith("对齐天气场")), { regime: s.regime, log: s.log, cloud: s.cloud, storms: s.storms });
    ok("接入航线网", !!s.leg, s.leg);
    ok("没有写 localStorage", s.pref === null, s.pref);
    console.log(`    首载 ${loadMs} ms；startup=${JSON.stringify(s.startup)}`);
    console.log(`    舱灯 ${s.cabinLight}，高度 ${s.alt} km`);
    const j = await jank(page);
    console.log(`    首载后 10 s 帧间隔：${JSON.stringify(j)}`);
    await page.screenshot({ path: path.join(outDir, `default-${port}.png`) });
    const s2 = await state(page);
    console.log(`    10 s 后：regime ${s2.regime}，storms ${s2.storms}，cloud ${JSON.stringify(s2.cloud)}，高度 ${s2.alt}`);
    ok("控制台零 error（默认开启）", errors.length === 0, errors.slice(0, 5));

    // 2. 用户手动关掉（真实点击 = isTrusted）→ 记住 → 刷新后保持关
    await page.evaluate(() => document.getElementById("panel").classList.remove("hidden"));
    await page.locator("#voyage-on").click();
    const s3 = await state(page);
    ok("手动关闭生效并记住", !s3.active && s3.pref === "0", { active: s3.active, pref: s3.pref });
    await page.reload({ waitUntil: "commit" });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 100 });
    const s4 = await state(page);
    ok("刷新后保持关闭", !s4.active && !s4.checked, { active: s4.active, checked: s4.checked });
    // 3. ?voyage=1 覆盖记住的关闭（且不改写记住的选择）
    await page.goto(`http://127.0.0.1:${port}/?voyage=1`, { waitUntil: "commit" });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 100 });
    const s5 = await state(page);
    ok("?voyage=1 强制开启（不改记住的选择）", s5.active && s5.checked && s5.pref === "0", { active: s5.active, pref: s5.pref });
    // 4. 脚本 dispatchEvent 的切换不写 localStorage
    await page.evaluate(() => {
      const el = document.getElementById("voyage-on");
      el.checked = false;
      el.dispatchEvent(new Event("change"));
      el.checked = true;
      el.dispatchEvent(new Event("change"));
    });
    const s6 = await state(page);
    ok("脚本切换不写 localStorage", s6.pref === "0", s6.pref);
    // 5. 再手动打开 → 记成 1 → 刷新保持开
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 100 });
    await page.evaluate(() => document.getElementById("panel").classList.remove("hidden"));
    await page.locator("#voyage-on").click();
    await page.reload({ waitUntil: "commit" });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 100 });
    const s7 = await state(page);
    ok("手动重新打开后刷新保持开", s7.active && s7.pref === "1", { active: s7.active, pref: s7.pref });
    await ctx.close();
  }
  // 6. 全新页面 ?voyage=0
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
    const { page, errors } = await open(ctx, port, "?voyage=0");
    const s = await state(page);
    ok("?voyage=0 强制关闭", !s.active && !s.checked && s.pref === null, { active: s.active, pref: s.pref });
    ok("控制台零 error（voyage=0）", errors.length === 0, errors.slice(0, 5));
    await ctx.close();
  }
  // 7. 首载对照：同一浏览器、各自全新上下文，交替测 3 轮（热缓存，看 JS 侧有没有变慢；真冷编译用 dev-browser cold）
  if (base) {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      for (const p of [port, base]) {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
        const { page, loadMs } = await open(ctx, p);
        const st = await page.evaluate(() => window.__voyageStartup);
        const j = await jank(page, 8000);
        rows.push({ port: p, loadMs, firstFrame: st["首帧渲染"], j });
        console.log(`    轮 ${i + 1} 端口 ${p}：首载 ${loadMs} ms，首帧渲染 ${st["首帧渲染"]} ms，8 s 帧间隔 ${JSON.stringify(j)}`);
        if (i === 0) await page.screenshot({ path: path.join(outDir, `first-${p}.png`) });
        await ctx.close();
      }
    }
    fs.writeFileSync(path.join(outDir, "load-compare.json"), JSON.stringify(rows, null, 2));
  }
} finally {
  await closeBrowserSafely(browser);
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过");
process.exit(failed.length ? 1 : 0);
