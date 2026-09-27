// G07b：画质档与地面精度解耦的端到端检查（取代 G07-tier.mjs）。
// 步骤：首载（自动）→ 改画质「低」→ 重载应回到「自动」、地面不变 → 改地面精度 1024（状态行提示下次载入）→ 重载应为 1024、面板显示 1024
//       → 改回「自动」→ 重载回到自动判定；再带 ?groundres=2048 验证 URL 压过面板。每步断言，最后打印 console error 数。
// 用法（apps/voyage 下）：node handoff/G07b-panel.mjs <端口>
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";

const [port] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
let bad = 0;
const expect = (cond, msg) => {
  if (!cond) bad++;
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  const load = async (query = "") => {
    await page.goto(`http://127.0.0.1:${port}/?g07b=${Date.now()}${query}`, { waitUntil: "commit", timeout: 180000 });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
    await page.waitForTimeout(1500);
    return page.evaluate(() => {
      const v = window.__voyage;
      return {
        tier: v.quality.tier,
        qualitySel: document.getElementById("quality").value,
        groundSel: document.getElementById("ground-res").value,
        res: v.ground.imageryStats.res,
        reason: v.quality.groundRes.reason,
        groundStatus: document.getElementById("ground-res-status").textContent,
        qualityStatus: document.getElementById("quality-status").textContent,
        storage: { groundRes: localStorage.getItem("voyage.groundRes"), quality: localStorage.getItem("voyage.quality") },
      };
    });
  };
  const pick = (id, value) =>
    page.evaluate(
      async ([id, value]) => {
        const sel = document.getElementById(id);
        sel.value = value;
        sel.dispatchEvent(new Event("change"));
        await new Promise((r) => setTimeout(r, 600));
        return { ground: document.getElementById("ground-res-status").textContent, quality: document.getElementById("quality-status").textContent };
      },
      [id, value],
    );

  // G07 残留：旧键 voyage.quality 应在载入时被清掉，且不影响画质档
  await page.goto(`http://127.0.0.1:${port}/?g07b=pre`, { waitUntil: "commit", timeout: 180000 });
  await page.evaluate(() => {
    localStorage.removeItem("voyage.groundRes");
    localStorage.setItem("voyage.quality", JSON.stringify({ tier: "low" }));
  });
  const a = await load();
  console.log("首载：", JSON.stringify(a));
  const autoRes = a.res;
  expect(a.tier === "auto" && a.qualitySel === "auto", "首载画质档为自动（G07 的旧记忆不生效）");
  expect(a.storage.quality === null, "旧键 voyage.quality 已清掉");
  expect(a.groundSel === "auto" && a.reason.startsWith("自动："), "地面精度为自动判定");

  const s1 = await pick("quality", "low");
  console.log("改画质「低」：", JSON.stringify(s1));
  expect(!/地面/.test(s1.quality), "画质状态行不再掺地面精度");
  const b = await load();
  console.log("重载：", JSON.stringify(b));
  expect(b.tier === "auto" && b.qualitySel === "auto", "重载后画质档回到自动");
  expect(b.res === autoRes, "地面精度不随画质档变");

  const other = autoRes === 2048 ? "1024" : "2048";
  const s2 = await pick("ground-res", other);
  console.log(`改地面精度 ${other}：`, JSON.stringify(s2));
  expect(s2.ground.includes(`下次载入改为 ${other}²`), "状态行提示下次载入生效");
  const c = await load();
  console.log("重载：", JSON.stringify(c));
  expect(c.res === Number(other) && c.groundSel === other && c.reason === "面板手动选", `重载后地面 ${other}²、面板显示 ${other}`);
  expect(c.tier === "auto", "画质档仍从自动起步");

  const s3 = await pick("ground-res", "auto");
  console.log("改回自动：", JSON.stringify(s3));
  expect(s3.ground.includes(`下次载入改为 ${autoRes}²`), "改回自动后提示下次载入恢复");
  const d = await load();
  console.log("重载：", JSON.stringify(d));
  expect(d.res === autoRes && d.groundSel === "auto" && d.storage.groundRes === null, "重载回到自动判定、不留存储");

  await pick("ground-res", other);
  const e = await load(`&groundres=${autoRes}`);
  console.log("URL 压过面板：", JSON.stringify(e));
  expect(e.res === autoRes && e.reason.startsWith("URL"), "?groundres= 压过面板选项");
  await pick("ground-res", "auto");

  console.log("console error：", errors.length, errors.slice(0, 3));
  expect(errors.length === 0, "控制台零 error");
} finally {
  await browser.close();
}
console.log(bad ? `${bad} 项不符` : "全部符合");
process.exit(bad ? 1 : 0);
