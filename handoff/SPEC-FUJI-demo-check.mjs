// SPEC-FUJI：验证 URL 演示入口 ?fujiCap=1——打开页面（连续航程照默认开启）后自动切到「骏河湾上空」+ 面板天气「富士山笠云（演示）」，
// 云步进画的是 L 变体，截一张图。用法（apps/voyage 下）：node handoff/SPEC-FUJI-demo-check.mjs <端口> [输出 png]
import { chromium } from "playwright-core";
import { closeBrowserSafely, launchBrowser } from "../scripts/lib/chrome.mjs";

const port = process.argv[2] ?? "5273";
const out = process.argv[3] ?? "../../tmp/screenshot/SPEC-FUJI/demo-url.png";
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/?fujiCap=1`);
  await page.waitForFunction(() => window.__voyage?.clouds?.variantStatus?.shown === "L" || window.__voyage?.clouds?.variantStatus?.shown?.includes("L"), null, { timeout: 180000 });
  await page.waitForTimeout(4000);
  const st = await page.evaluate(() => ({
    preset: document.getElementById("preset").value,
    weather: document.getElementById("weather").value,
    lens: !!window.__voyage.weather.lenticular,
    shown: window.__voyage.clouds.variantStatus.shown,
  }));
  await page.screenshot({ path: out });
  console.log(JSON.stringify(st), "pageerror:", errors.length);
} finally {
  await closeBrowserSafely(browser);
}
