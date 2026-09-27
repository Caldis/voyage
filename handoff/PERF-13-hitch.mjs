// PERF-13：窗外 OW 变体（罕见光学 + 天幕层奇观）后台预编期间、第一次切过去时的帧时间（rAF 间隔，d3d11 真 GPU、全新浏览器 = 冷缓存）。
// 用法：node apps/voyage/handoff/PERF-13-hitch.mjs --port 5213 [--early]
//   默认：启动后记 20 s（首帧后约 90 帧开始预编 OW）→ 召唤天梯记 6 s（切到 OW）
//   --early：启动后立刻召唤天梯（OW 还没编完）：编好之前不画奇观、编好的下一帧出现
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = process.argv.slice(2);
const port = args[args.indexOf("--port") + 1];
const early = args.includes("--early");
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("[console.error]", m.text()));
  await page.goto(`http://127.0.0.1:${port}/?hitch=${Date.now()}`, { waitUntil: "commit" });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 250 });
  const record = (label, ms, summon) =>
    page.evaluate(
      async ({ label, ms, summon }) => {
        const v = window.__voyage;
        if (summon) {
          v.wonders.enabled = true;
          await new Promise((r) => requestAnimationFrame(r));
          v.wonders.trigger("tether", { forwardOffsetDeg: 0, distKm: 370, reveal: 1 });
        }
        const d = [];
        const states = [];
        let last = performance.now();
        const t0 = last;
        await new Promise((res) => {
          const f = (t) => {
            d.push(t - last);
            last = t;
            const s = v.groundDetail.variantStatus;
            const tag = `${s.shown}|${s.wanted}|OW:${s.variants.OW.state}`;
            if (!states.length || states[states.length - 1][1] !== tag) states.push([Math.round(t - t0), tag]);
            if (t - t0 < ms) requestAnimationFrame(f);
            else res();
          };
          requestAnimationFrame(f);
        });
        const sorted = [...d].sort((a, b) => a - b);
        const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
        return `${label}: 帧数 ${d.length}，中位 ${q(0.5)} ms，p99 ${q(0.99)} ms，最长 ${sorted[sorted.length - 1].toFixed(1)} ms，>50 ms 的帧 ${d.filter((x) => x > 50).length} 个，OW 编译 ${v.groundDetail.variantStatus.variants.OW.compileMs} ms\n    状态变化（毫秒: 画的|想要的|OW）：${states.map(([t, s]) => `${t}: ${s}`).join("  ")}`;
      },
      { label, ms, summon },
    );
  if (early) console.log(await record("启动后立刻召唤天梯", 20000, true));
  else {
    console.log(await record("启动后 20 s（后台预编 OW）", 20000, false));
    console.log(await record("召唤天梯", 6000, true));
  }
} finally {
  await closeBrowserSafely(browser);
}
