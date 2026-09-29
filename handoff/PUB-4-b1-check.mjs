// PUB-4 B1 自测（一次性脚本，用完可删）：直接调用 WeatherDirector 的私有字段 / 方法（TS 的 private
// 只在编译期检查，运行期就是普通属性）验证「连续航程第一次对齐天气、云量 < 15% 时抬到 25%-40% 积云」的 nudge。
// 用法（仓库根）：node apps/voyage/handoff/PUB-4-b1-check.mjs [端口=5304]
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const port = process.argv[2] || "5304";
const url = `http://127.0.0.1:${port}/?voyage=0`; // 先用 voyage=0 打开，避免开局立刻自动跳变，等我们手动摆好条件
const browser = await launchBrowser(chromium);
try {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("console error:", m.text()); });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(url, { waitUntil: "commit", timeout: 60000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 60000 });

  const result = await page.evaluate(() => {
    const v = window.__voyage;
    const wd = v.director.weather;
    // 1) 在一批随机经纬度、当前模拟时刻里找一个天气场判定为「clear」（coverage 应该是 0）的取样点
    const t = v.state.simTime;
    let found = null;
    for (let i = 0; i < 4000 && !found; i++) {
      const lat = -60 + Math.random() * 120;
      const lon = -180 + Math.random() * 360;
      const s = wd.field.sample(lat, lon, t);
      if (s.regime === "clear" && s.coverage < 0.15) found = { lat, lon, coverage: s.coverage, regime: s.regime };
    }
    if (!found) return { ok: false, reason: "4000 次里没找到 clear 取样点（天气场分布问题，不代表 nudge 有 bug）" };

    // 2) 模拟「连续航程第一次对齐」：直接摆好私有状态再调 sampleField（和 setActive(true, true) 触发的路径一致）
    wd.snapNext = true;
    wd.firstAlign = true;
    wd.sampleField(found.lat, found.lon, t);
    const afterFirst = { coverage: wd.cur.coverage, regime: wd.regime, firstAlign: wd.firstAlign };

    // 3) 第二次跳变（模拟中途换预设）用同一个 clear 取样点：不应该再被 nudge，云量应保持天气场给的原值（≈0）
    wd.snapNext = true;
    wd.sampleField(found.lat, found.lon, t);
    const afterSecond = { coverage: wd.cur.coverage, regime: wd.regime, firstAlign: wd.firstAlign };

    return { ok: true, found, afterFirst, afterSecond };
  });
  console.log(JSON.stringify(result, null, 2));
  await ctx.close();
} finally {
  await closeBrowserSafely(browser);
}
