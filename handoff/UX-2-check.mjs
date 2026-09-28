// UX-2 验收：连续航程接管时面板显示的值要与实际一致（云量 / 云底 / 云厚 / 海面风速 / 云型 / 天气系统 / 地点），
// 手动介入的语义（nudge / lock）符合本文件同目录 UX-2.md 里写明的行为；脚本旁路改状态后面板复选框也要跟上（P9）。
// 用法：node apps/voyage/handoff/UX-2-check.mjs <端口>（页面走默认 URL，即 voyage=1：连续航程默认开）
import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]);
if (!port) throw new Error("用法：node UX-2-check.mjs <端口>");

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "[OK]  " : "[FAIL]"} ${name}${detail !== undefined ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

/** 页面里同时读「实际值」与「面板显示值」，比较逻辑留在 Node 侧，方便打印哪里对不上 */
const readBoth = (page) =>
  page.evaluate(() => {
    const v = window.__voyage;
    const s = v.state, cu = v.cloudUniforms, d = v.director;
    const $ = (id) => document.getElementById(id);
    const badge = (id) => ({ hidden: $(id).hidden, text: $(id).textContent });
    return {
      actual: {
        active: d.active,
        weatherEnabled: d.weather.enabled,
        coverage: cu.uCoverage.value,
        cloudBase: cu.uCloudBottom.value,
        cloudThick: cu.uCloudTop.value - cu.uCloudBottom.value,
        wind: s.wind,
        regime: d.weather.regime,
        presetId: s.preset.id,
        presetName: s.preset.name,
      },
      panel: {
        coverageValue: $("coverage").value,
        coverageOut: $("coverage-out").textContent,
        baseValue: $("cloud-base").value,
        baseOut: $("cloud-base-out").textContent,
        thickValue: $("cloud-thick").value,
        thickOut: $("cloud-thick-out").textContent,
        windValue: $("wind").value,
        windOut: $("wind-out").textContent,
        cloudSelValue: $("cloud-preset").value,
        cloudSelDisabled: $("cloud-preset").disabled,
        cloudSelTitle: $("cloud-preset").title,
        weatherDisabled: $("weather").disabled,
        weatherTitle: $("weather").title,
        presetValue: $("preset").value,
        presetText: $("preset").selectedOptions[0]?.textContent ?? "",
        voyageChecked: $("voyage-on").checked,
        wondersChecked: $("wonders-on").checked,
      },
      badges: {
        coverage: badge("coverage-auto"),
        base: badge("cloud-base-auto"),
        thick: badge("cloud-thick-auto"),
        wind: badge("wind-auto"),
        weather: badge("weather-auto"),
        cloudPreset: badge("cloud-preset-auto"),
        preset: badge("preset-auto"),
      },
    };
  });

/** 每 250 ms 的同步只在「接管」时才回写；owned = 连续航程开着 + 天气场在驱动云 / 风 */
function checkConsistency(sample, label) {
  const { actual, panel, badges } = sample;
  const owned = actual.active && actual.weatherEnabled;
  ok(`${label} 云量显示 = 实际值`, !owned || panel.coverageValue === String(actual.coverage), { actual: actual.coverage, panelValue: panel.coverageValue, panelOut: panel.coverageOut });
  ok(`${label} 云底显示 = 实际值`, !owned || panel.baseValue === actual.cloudBase.toFixed(1), { actual: actual.cloudBase, panelValue: panel.baseValue });
  ok(`${label} 云厚显示 = 实际值`, !owned || panel.thickValue === actual.cloudThick.toFixed(1), { actual: actual.cloudThick, panelValue: panel.thickValue });
  ok(`${label} 海面风速显示 = 实际值`, !owned || panel.windValue === String(Math.round(actual.wind)), { actual: actual.wind, panelValue: panel.windValue, panelOut: panel.windOut });
  ok(`${label} 云型下拉 = 实际云型`, !owned || panel.cloudSelValue === actual.regime, { actual: actual.regime, panelValue: panel.cloudSelValue });
  ok(
    `${label} 地点显示当前航段`,
    !actual.presetId.startsWith("leg-") || (panel.presetValue === actual.presetId && panel.presetText === actual.presetName),
    { presetId: actual.presetId, presetName: actual.presetName, panelValue: panel.presetValue, panelText: panel.presetText },
  );
  ok(`${label} 天气系统 / 云型下拉接管时锁定`, !owned || (panel.weatherDisabled && panel.cloudSelDisabled), { weatherDisabled: panel.weatherDisabled, cloudSelDisabled: panel.cloudSelDisabled });
  ok(`${label} 锁定原因写在 title 里`, !owned || (panel.weatherTitle.includes("关掉连续航程") && panel.cloudSelTitle.includes("关掉连续航程")), { weatherTitle: panel.weatherTitle, cloudSelTitle: panel.cloudSelTitle });
  const badgesShown = badges.coverage.hidden === !owned && badges.base.hidden === !owned && badges.thick.hidden === !owned && badges.wind.hidden === !owned && badges.weather.hidden === !owned && badges.cloudPreset.hidden === !owned;
  ok(`${label} 「自动」标记与接管状态一致`, badgesShown, badges);
}

const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/eox\.at|tiles\.maps|CORS policy/i.test(t)) return; // 地面瓦片跨域错误不算（README 坑点，网络环境导致，非代码问题）
    errors.push(t);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 100 });

  // ---------- 1. 默认页面（voyage=1）：连续航程默认开，天气场驱动；1 分钟内多次抽样核对显示值 ----------
  const s0 = await readBoth(page);
  ok("默认页面连续航程已开（VOY-DEFAULT）", s0.actual.active, { active: s0.actual.active, weatherEnabled: s0.actual.weatherEnabled });
  checkConsistency(s0, "t=0s");
  for (const t of [10, 20, 30, 40, 50, 60]) {
    await page.waitForTimeout(10000);
    const s = await readBoth(page);
    checkConsistency(s, `t=${t}s`);
  }

  // ---------- 2. nudge：键盘真实改风速滑条（isTrusted），立刻标「已手动调整」，显示值紧跟新的实际值 ----------
  await page.locator("#wind").focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300); // 等一轮 250 ms 同步
  const nudged = await readBoth(page);
  ok("拖动风速后面板值仍等于实际值（没有被同步覆盖成旧值）", nudged.panel.windValue === String(Math.round(nudged.actual.wind)), { panelValue: nudged.panel.windValue, actual: nudged.actual.wind });
  ok("拖动风速后标记「自动（已手动调整）」", nudged.badges.wind.text === "自动（已手动调整）", nudged.badges.wind);
  ok("云量 / 云底 / 云厚没有被误标「已手动调整」（只碰了风速）", nudged.badges.coverage.text !== "自动（已手动调整）" && nudged.badges.base.text !== "自动（已手动调整）" && nudged.badges.thick.text !== "自动（已手动调整）", {
    coverage: nudged.badges.coverage.text,
    base: nudged.badges.base.text,
    thick: nudged.badges.thick.text,
  });

  // ---------- 3. 换航段（立即触发到达）清空「已手动调整」标记，回到「自动」 ----------
  await page.locator("#debug-arrive").click();
  await page.waitForTimeout(300);
  const afterLeg = await readBoth(page);
  ok("换航段后风速标记恢复「自动」（不再是「已手动调整」）", afterLeg.badges.wind.text === "自动", afterLeg.badges.wind);
  checkConsistency(afterLeg, "换航段后");

  // ---------- 4. 关掉连续航程：天气 / 云型解锁，「自动」标记全部消失 ----------
  await page.locator("#panel").evaluate((el) => el.classList.remove("hidden"));
  await page.locator("#voyage-on").click();
  await page.waitForTimeout(300);
  const off = await readBoth(page);
  ok("关掉连续航程后 director.active = false", !off.actual.active, off.actual.active);
  ok("关掉后天气系统 / 云型解锁", !off.panel.weatherDisabled && !off.panel.cloudSelDisabled, { weatherDisabled: off.panel.weatherDisabled, cloudSelDisabled: off.panel.cloudSelDisabled });
  ok("关掉后「自动」标记全部隐藏", off.badges.coverage.hidden && off.badges.wind.hidden && off.badges.weather.hidden && off.badges.cloudPreset.hidden && off.badges.preset.hidden, off.badges);

  // ---------- 5. P9 回归修复：脚本旁路改状态（不经过面板点击），面板复选框仍要在 250 ms 内跟上 ----------
  await page.evaluate(() => {
    window.__voyage.director.setActive(true); // 不 dispatch 事件，模拟 applyScene 的写法
    window.__voyage.wonders.enabled = true;
  });
  await page.waitForTimeout(300);
  const bypassed = await readBoth(page);
  ok("脚本直接改 director.active 后，voyage-on 复选框跟上（P9）", bypassed.panel.voyageChecked === true, bypassed.panel.voyageChecked);
  ok("脚本直接改 wonders.enabled 后，wonders-on 复选框跟上（P9）", bypassed.panel.wondersChecked === true, bypassed.panel.wondersChecked);

  ok("全程控制台零 error", errors.length === 0, errors.slice(0, 10));
} finally {
  await closeBrowserSafely(browser);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过");
process.exit(failed.length ? 1 : 0);
