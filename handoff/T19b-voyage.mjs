#!/usr/bin/env node
// T19b 天气演变验证（由 T19a-voyage.mjs 改来）：开连续航程（默认 60×），连续播放若干分钟（真实时间），按间隔截图成时间序列，
// 每 2 秒采样位置 / 高度 / 航段 / 天气（云型、云量、云顶、雷暴单体的本地坐标、台风）与帧间隔，
// 最后读导演的连续性遥测、天气日志（每次生成 / 移除 / 换云型借的是哪种遮挡）与天气遥测（渐变单步的最大台阶）。
// 用法：node handoff/T19b-voyage.mjs --port 5239 [--angle vulkan] [--rate 60] [--minutes 30] [--every 30] [--time 930] [--preset hnd-cts]
//       [--seed 20260927] [--gate]（奇观之门演示） [--out tmp/screenshot/T19b]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, applyScene } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : acc), []),
);
const port = args.port;
if (!port) throw new Error("需要 --port");
const angle = String(args.angle || "d3d11");
const rate = Number(args.rate || 60);
const minutes = Number(args.minutes || 8);
const everyS = Number(args.every || 20);
const outDir = path.join(REPO_ROOT, args.out || "tmp/screenshot/T19b");
fs.mkdirSync(outDir, { recursive: true });

const sc = { name: "voyage-start", p: { preset: args.preset || "hnd-cts", time: Number(args.time || 930), coverage: 0.3, "wing-pos": "-4" }, ground: true };

const sample = () => {
  const v = window.__voyage;
  const s = v.state;
  const [lat, lon] = v.director ? v.ground.localFrame.toGeo(v.cloudUniforms.uCloudOffset.value.x, v.cloudUniforms.uCloudOffset.value.y) : [0, 0];
  const info = document.getElementById("info").textContent;
  const sunAlt = Number((info.match(/太阳高度角 (-?[\d.]+)/) || [])[1]);
  return {
    real: performance.now() / 1000,
    simTime: s.simTime,
    local: document.getElementById("time-label").textContent,
    lat: +lat.toFixed(4),
    lon: +lon.toFixed(4),
    alt: +s.altitudeKm.toFixed(3),
    heading: +s.heading.toFixed(1),
    bank: +s.bankDeg.toFixed(1),
    sunAlt,
    phase: v.director.phase,
    leg: v.director.leg ? `${v.director.leg.from.code}-${v.director.leg.to.code}` : null,
    offsetKm: +v.cloudUniforms.uCloudOffset.value.length().toFixed(1),
    haze: s.preset.haze,
    cloud: +v.clouds.cameraDensity.toFixed(3),
    pending: v.director.pendingIds,
    wx: v.director.weather.describe(),
    regime: v.director.weather.regime,
    coverage: +v.cloudUniforms.uCoverage.value.toFixed(4),
    top: +v.cloudUniforms.uCloudTop.value.toFixed(3),
    bottom: +v.cloudUniforms.uCloudBottom.value.toFixed(3),
    storms: v.weather.storms.map((st) => ({ id: st.id ?? "manual", x: +st.x.toFixed(2), z: +st.z.toFixed(2), d: +Math.hypot(st.x - v.cloudUniforms.uCloudOffset.value.x, st.z - v.cloudUniforms.uCloudOffset.value.y).toFixed(1) })),
    hurricane: v.weather.hurricane ? { id: v.weather.hurricane.id ?? "manual", d: +Math.hypot(v.weather.hurricane.x - v.cloudUniforms.uCloudOffset.value.x, v.weather.hurricane.z - v.cloudUniforms.uCloudOffset.value.y).toFixed(0) } : null,
    frame: (() => {
      const f = window.__t19bFrames.splice(0);
      if (!f.length) return null;
      f.sort((a, b) => a - b);
      return { n: f.length, p50: +f[Math.floor(f.length / 2)].toFixed(1), p95: +f[Math.floor(f.length * 0.95)].toFixed(1), max: +f.at(-1).toFixed(1) };
    })(),
  };
};

const browser = await launchBrowser(chromium, { angle });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  // 瓦片请求计数（按主机）：加速播放时地面瓦片请求会不会把影像服务器打到限流（T19a 踩过：60× 时 EOX 返回无 CORS 头的错误）
  const requests = {};
  let counting = false;
  page.on("request", (r) => {
    if (!counting) return;
    const h = new URL(r.url()).host;
    requests[h] = (requests[h] ?? 0) + 1;
  });
  await page.goto(`http://127.0.0.1:${port}/?t19a=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
  // 帧间隔记录（rAF）
  await page.evaluate(() => {
    window.__t19bFrames = [];
    let last = performance.now();
    const loop = (t) => {
      window.__t19bFrames.push(t - last);
      last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  // 天气场种子 / 奇观之门演示
  await page.evaluate(({ seed, gate }) => {
    const w = window.__voyage.director.weather;
    if (seed) w.field.seed = seed;
    w.gateDemo = gate;
  }, { seed: args.seed ? Number(args.seed) : 0, gate: !!args.gate });
  // 开连续航程并设流速
  await page.evaluate((r) => {
    const box = document.getElementById("voyage-on");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    window.__voyage.director.rate = r;
  }, rate);

  const samples = [];
  counting = true;
  const t0 = Date.now();
  let shot = 0;
  let nextShot = 0;
  while (Date.now() - t0 < minutes * 60e3) {
    const el = (Date.now() - t0) / 1000;
    const s = await page.evaluate(sample);
    samples.push(s);
    if (el >= nextShot) {
      const name = `${String(shot).padStart(2, "0")}-${s.local.slice(0, 5).replace(":", "")}-${s.leg}-${s.regime}${s.storms.length ? `-storm${s.storms.length}` : ""}${s.hurricane ? "-ty" : ""}.png`;
      await page.screenshot({ path: path.join(outDir, name), timeout: 60000 });
      console.log(`[${el.toFixed(0)} s] ${name}  alt=${s.alt} sun=${s.sunAlt} cloud=${s.cloud} ${s.wx} frame=${JSON.stringify(s.frame)}`);
      shot++;
      nextShot += everyS;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const telemetry = await page.evaluate(() => JSON.parse(JSON.stringify(window.__voyage.director.telemetry)));
  const wx = await page.evaluate(() => JSON.parse(JSON.stringify({ log: window.__voyage.director.weather.log, telemetry: window.__voyage.director.weather.telemetry })));

  // 背景板模式：B 开启 → 面板隐藏；移动鼠标 → 提示出现；静止 3 秒 → 光标与提示隐藏；Esc 退出
  await page.mouse.move(800, 600);
  await page.keyboard.press("b");
  await page.mouse.move(820, 610);
  await new Promise((r) => setTimeout(r, 500));
  const bd1 = await page.evaluate(() => ({ body: document.body.className, panelHidden: document.getElementById("panel").classList.contains("hidden") }));
  await page.screenshot({ path: path.join(outDir, "backdrop-awake.png") });
  await new Promise((r) => setTimeout(r, 3200));
  const bd2 = await page.evaluate(() => ({ body: document.body.className, cursor: getComputedStyle(document.body).cursor }));
  await page.screenshot({ path: path.join(outDir, "backdrop-idle.png") });
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 500));
  const bd3 = await page.evaluate(() => ({ body: document.body.className, panelHidden: document.getElementById("panel").classList.contains("hidden"), active: window.__voyage.director.active }));
  await page.screenshot({ path: path.join(outDir, "backdrop-exited.png") });

  // 采样间的连续性（2 秒一次，粗检）：相邻采样的大圆距离 / 模拟时间
  const R = 6371, D2R = Math.PI / 180;
  const hav = (a, b) => 2 * R * Math.asin(Math.sqrt(Math.sin(((b.lat - a.lat) * D2R) / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(((b.lon - a.lon) * D2R) / 2) ** 2));
  let maxKmPerSimS = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].simTime - samples[i - 1].simTime) / 1000;
    if (dt > 0) maxKmPerSimS = Math.max(maxKmPerSimS, hav(samples[i - 1], samples[i]) / dt);
  }
  const summary = {
    rate,
    realMinutes: minutes,
    simHours: +((samples.at(-1).simTime - samples[0].simTime) / 3.6e6).toFixed(2),
    legs: telemetry.legs,
    switches: telemetry.switches.length,
    weatherTelemetry: wx.telemetry,
    weatherLog: wx.log.map((e) => `${new Date(e.simTime).toISOString().slice(5, 16)}Z (${e.lat}, ${e.lon}) ${e.event}${e.how ? ` [${e.how}]` : ""}`),
    frames: (() => {
      const fr = samples.map((x) => x.frame).filter(Boolean);
      const p50 = fr.map((f) => f.p50).sort((a, b) => a - b);
      const p95 = fr.map((f) => f.p95).sort((a, b) => a - b);
      const stormy = samples.filter((x) => x.frame && x.storms.length).map((x) => x.frame.p50).sort((a, b) => a - b);
      return { medianP50: p50[Math.floor(p50.length / 2)], medianP95: p95[Math.floor(p95.length / 2)], worstP95: p95.at(-1), stormyMedianP50: stormy[Math.floor(stormy.length / 2)] ?? null };
    })(),
    continuity: { maxJumpRatio: +telemetry.maxJumpRatio.toFixed(2), maxJumpKm: +telemetry.maxJumpKm.toFixed(2), maxAltRate: +telemetry.maxAltRate.toFixed(4), maxTurnRate: +telemetry.maxTurnRate.toFixed(2), frames: telemetry.frames, maxKmPerSimS_samples: +maxKmPerSimS.toFixed(3) },
    sunAltRange: [Math.min(...samples.map((s) => s.sunAlt)), Math.max(...samples.map((s) => s.sunAlt))],
    backdrop: { awake: bd1, idle: bd2, exited: bd3 },
    requestsPerRealMin: Object.fromEntries(Object.entries(requests).map(([h, n]) => [h, Math.round(n / minutes)])),
    consoleErrorCount: errors.length,
    consoleErrors: errors.slice(0, 20),
  };
  fs.writeFileSync(path.join(outDir, "samples.json"), JSON.stringify(samples, null, 1));
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await context.close();
} finally {
  await closeBrowserSafely(browser);
}
