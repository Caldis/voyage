#!/usr/bin/env node
// TR07：在真实页面里验证火车声音的接入（点击开声音 → 切火车 → 声场换成火车、广播字幕、道口、终点停车、接缝开关、M 键、切回飞机），收集控制台报错。
// 听不见声音，只看 __voyage.audio.debug() 的目标值与计数。用法：node apps/voyage/handoff/TR07-live.mjs [--port 5277]
// 跑之前：node apps/voyage/scripts/measure-lock.mjs check（有人在测量就等）
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const port = Number(arg("port", 5277));
const browser = await launchBrowser(chromium, { angle: arg("angle", "d3d11"), extraArgs: ["--autoplay-policy=user-gesture-required"] });
const errors = [];
const brief = (d) => JSON.stringify({ state: d.state, train: d.train, caption: d.caption, rail: d.rail && { rollDb: +d.rail.rollDb.toFixed(1), motorHz: Math.round(d.rail.motorHz), pulses: d.rail.motorPulses, joints: d.rail.jointsScheduled, bellsOn: d.rail.bellsOn, bellStrikes: d.rail.bellStrikes, friction: +d.rail.frictionLin.toFixed(2), rate: d.rail.rateEst, fast: d.rail.fastForward }, planeAir: d.targets && +d.targets.airDb.toFixed(1) });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("done"), null, { timeout: 240000 });
  const dbg = async () => brief(await page.evaluate(() => window.__voyage.audio.debug()));
  await page.click("#sound-on");
  await page.waitForTimeout(2500);
  console.log("飞机、开声音：", await dbg());
  await page.selectOption("#vehicle", "train");
  await page.waitForFunction(() => window.__voyage.rail.active, null, { timeout: 60000 });
  await page.waitForTimeout(4500);
  console.log("切到火车 4.5 s：", await dbg(), "字幕元素：", JSON.stringify(await page.textContent("#rail-caption")), await page.evaluate(() => document.getElementById("rail-caption").classList.contains("on")));
  // 道口：s = 529 m 处有一处；从 400 m 开过去
  await page.evaluate(() => window.__voyage.rail.teleport(400, 1, 80));
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1500);
    console.log(`道口附近 +${(i + 1) * 1.5} s：`, await dbg(), "里程", await page.evaluate(() => window.__voyage.rail.train.s.toFixed(0)));
  }
  // 接缝开关
  await page.selectOption("#sound-rail-joints", "welded");
  await page.waitForTimeout(1200);
  console.log("长轨化：", await dbg());
  await page.selectOption("#sound-rail-joints", "jointed");
  // 终点前 350 m：制动、「まもなく 終点」、停车
  await page.evaluate(() => window.__voyage.rail.teleport(34700, 1, 60));
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2500);
    console.log(`进终点 +${((i + 1) * 2.5).toFixed(1)} s：`, await dbg(), "车速", await page.evaluate(() => (window.__voyage.rail.train.speed * 3.6).toFixed(1)));
  }
  await page.mouse.click(800, 600);
  await page.keyboard.press("m");
  await page.waitForTimeout(1200);
  console.log("按 M 关：", await dbg(), "字幕仍在更新：", JSON.stringify(await page.evaluate(() => window.__voyage.audio.caption)));
  await page.keyboard.press("m");
  await page.waitForTimeout(1500);
  await page.selectOption("#vehicle", "plane");
  await page.waitForTimeout(2000);
  console.log("切回飞机：", await dbg());
  const d = await page.evaluate(() => window.__voyage.audio.debug());
  console.log(`主线程 update 平均：${d.cost.calls ? ((d.cost.ms / d.cost.calls) * 1000).toFixed(1) : "-"} µs × ${d.cost.calls} 次`);
  console.log("控制台 error：", errors.length ? errors : "无");
} finally {
  await closeBrowserSafely(browser);
}
