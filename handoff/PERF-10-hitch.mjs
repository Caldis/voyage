// PERF-10：变体后台编译期间、第一次进入雷暴 / 台风时的帧时间（rAF 间隔，d3d11 真 GPU、全新浏览器 = 着色器冷缓存）。
// 用法：node apps/voyage/handoff/PERF-10-hitch.mjs --port 5210 [--early]
//   默认：启动后记录 15 s（预编雷暴 / 台风变体发生在这段里）→ 面板切「孤立雷暴」记 6 s → 切「台风眼」记 6 s → 切回 fair
//   --early：启动后立刻切雷暴（预编还没开始 / 没编完），看「编好之前」的过渡（普通云照画、雷暴稍后出现）和编译期间的帧时间
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
  const record = (label, ms, weather) =>
    page.evaluate(
      async ({ label, ms, weather }) => {
        const v = window.__voyage;
        if (weather) {
          const el = document.getElementById("weather");
          el.value = weather;
          el.dispatchEvent(new Event("change"));
        }
        const d = [];
        const states = [];
        let last = performance.now();
        const t0 = last;
        await new Promise((res) => {
          const f = (t) => {
            d.push(t - last);
            last = t;
            const s = v.clouds.variantStatus || { march: {} };
            const tag = `${s.shown}|${s.wanted}|${s.march.S}|${s.march.T}|${s.weatherAux}`;
            if (!states.length || states[states.length - 1][1] !== tag) states.push([Math.round(t - t0), tag]);
            if (t - t0 < ms) requestAnimationFrame(f);
            else res();
          };
          requestAnimationFrame(f);
        });
        const sorted = [...d].sort((a, b) => a - b);
        const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
        return `${label}: 帧数 ${d.length}，中位 ${q(0.5)} ms，p99 ${q(0.99)} ms，最长 ${sorted[sorted.length - 1].toFixed(1)} ms，>50 ms 的帧 ${d.filter((x) => x > 50).length} 个\n    状态变化（毫秒: 画的|想要的|S|T|天气小程序）：${states.map(([t, s]) => `${t}: ${s}`).join("  ")}`;
      },
      { label, ms, weather },
    );
  if (early) {
    console.log(await record("启动后立刻切雷暴", 20000, "storm"));
    console.log(await record("再切台风眼", 15000, "typhoon-eye"));
  } else {
    console.log(await record("启动后 15 s（后台预编）", 15000, null));
    console.log(await record("切孤立雷暴", 6000, "storm"));
    console.log(await record("切台风眼", 6000, "typhoon-eye"));
    console.log(await record("切回无特殊天气", 4000, "fair"));
  }
} finally {
  await closeBrowserSafely(browser);
}
