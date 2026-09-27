#!/usr/bin/env node
// T11：在真实页面里验证声音开关（默认静音、点击启用、M 键切换、闪电触发雷声排程），并收集控制台报错。
// 用法：node apps/voyage/handoff/T11-live.mjs [--port 5211] [--angle vulkan]
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const port = Number(arg("port", 5211));
const browser = await launchBrowser(chromium, { angle: arg("angle", "d3d11"), extraArgs: ["--autoplay-policy=user-gesture-required"] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("done"), null, { timeout: 240000 });
  const dbg = () => page.evaluate(() => window.__voyage.audio.debug());
  console.log("加载完、未点击：", JSON.stringify(await dbg()));
  console.log("面板开关：", await page.isChecked("#sound-on"), "子项隐藏：", await page.isHidden("#sound-controls"));
  await page.click("#sound-on");
  await page.waitForTimeout(3000);
  console.log("点击后 3 s：", JSON.stringify(await dbg()));
  console.log("子项隐藏：", await page.isHidden("#sound-controls"));
  // 雷暴 + 立即闪电：看 weather.onFlash 是否把距离交给了声音（debug 里没有排程表，只看无报错）
  await page.selectOption("#weather", { index: 1 });
  const flash = await page.evaluate(async () => {
    const a = window.__voyage.audio;
    const orig = a.lightning.bind(a);
    const got = [];
    a.lightning = (d, cg) => (got.push({ 距离km: +d.toFixed(1), 云地闪: cg, 延迟s: +((d * 1000) / 340).toFixed(1) }), orig(d, cg));
    for (let i = 0; i < 3; i++) window.__voyage.weather.flashNow(0, i === 0);
    await new Promise((r) => setTimeout(r, 300));
    a.lightning = orig;
    return got;
  });
  console.log("闪电 → 雷声：", JSON.stringify(flash));
  // M 键关 / 开
  await page.mouse.click(800, 600);
  await page.keyboard.press("m");
  await page.waitForTimeout(1500);
  console.log("按 M 关：", JSON.stringify(await dbg()), "开关：", await page.isChecked("#sound-on"));
  await page.keyboard.press("m");
  await page.waitForTimeout(1500);
  console.log("再按 M 开：", JSON.stringify(await dbg()), "开关：", await page.isChecked("#sound-on"));
  // 背景板模式下保持
  await page.keyboard.press("b");
  await page.waitForTimeout(1500);
  console.log("背景板模式：", JSON.stringify(await dbg()));
  const d = await dbg();
  console.log(`主线程 update 平均：${d.cost.calls ? ((d.cost.ms / d.cost.calls) * 1000).toFixed(1) : "-"} µs × ${d.cost.calls} 次`);
  console.log("控制台 error：", errors.length ? errors : "无");
} finally {
  await closeBrowserSafely(browser);
}
