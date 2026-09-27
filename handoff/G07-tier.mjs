// G07：地面精度定档的端到端检查——自动判定结果；面板改成「低」后状态行提示「下次载入」；重新载入后按 1024 建；改回「自动」再载入恢复。
// 用法（apps/voyage 下）：node handoff/G07-tier.mjs <端口>
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";

const [port] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
  const load = async () => {
    await page.goto(`http://127.0.0.1:${port}/?g07=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
    await page.waitForTimeout(1500);
    return page.evaluate(() => {
      const v = window.__voyage;
      return { groundRes: v.quality.groundRes, res: v.ground.imageryStats.res, status: document.getElementById("quality-status").textContent };
    });
  };
  const setTier = (t) =>
    page.evaluate(async (t) => {
      const sel = document.getElementById("quality");
      sel.value = t;
      sel.dispatchEvent(new Event("change"));
      await new Promise((r) => setTimeout(r, 600));
      return document.getElementById("quality-status").textContent;
    }, t);
  console.log("首次载入：", JSON.stringify(await load()));
  console.log("面板改「低」后：", await setTier("low"));
  console.log("重新载入：", JSON.stringify(await load()));
  console.log("面板改「自动」后：", await setTier("auto"));
  console.log("重新载入：", JSON.stringify(await load()));
  console.log("console error：", errors.length, errors.slice(0, 2));
} finally {
  await browser.close();
}
