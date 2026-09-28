// UX-1a：用真实键盘事件（Playwright keyboard）核对快捷键守卫与焦点环；只看面板，不做画面测量
import { chromium } from "file:///D:/Code/opus-test/.claude/worktrees/agent-a043de4d4e48b123f/apps/voyage/node_modules/playwright-core/index.mjs";
import { launchBrowser, closeBrowserSafely } from "file:///D:/Code/opus-test/.claude/worktrees/agent-a043de4d4e48b123f/apps/voyage/scripts/lib/chrome.mjs";

const port = process.argv[2] ?? "5260";
const out = "D:/Code/opus-test/.claude/worktrees/agent-a043de4d4e48b123f/tmp/screenshot/ux1a/after";
const browser = await launchBrowser(chromium, { angle: "d3d11" });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/tiles|CORS|ERR_FAILED|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/?voyage=0`);
  await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("done"), null, { timeout: 180000 });
  await page.waitForTimeout(1500);
  const hidden = () => page.evaluate(() => document.getElementById("panel").classList.contains("hidden"));
  const r = {};
  // 1. 日期框里按 H：不隐藏
  await page.click("#date");
  await page.keyboard.press("h");
  r.hInDate = await hidden();
  // 2. 点一下复选框（奇观模式）后按 H：照常隐藏（复选框不吃字母）
  await page.click("#wonders-on");
  await page.keyboard.press("h");
  r.hAfterCheckbox = await hidden();
  await page.keyboard.press("h");
  await page.click("#wonders-on"); // 还原
  // 3. 焦点在「座位」下拉上按 ←：不转向（方向键归下拉）
  await page.focus("#seat");
  const hdg0 = await page.evaluate(() => window.__voyage.director.ap.selHeading ?? null);
  // 4. Tab 键盘导航：焦点环
  await page.focus("#date");
  await page.keyboard.press("Tab"); // → 「现在」按钮
  r.focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent);
  r.focusVisible = await page.evaluate(() => document.activeElement.matches(":focus-visible"));
  r.outline = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`; });
  await page.screenshot({ path: `${out}/ux1a-focus-ring.png`, clip: { x: 1270, y: 16, width: 330, height: 260 } });
  // 5. Ctrl+H 不隐藏
  await page.keyboard.press("Control+h").catch(() => {});
  r.ctrlH = await hidden();
  r.hdgBefore = hdg0;
  console.log(JSON.stringify(r));
} finally {
  console.log("errors:", JSON.stringify(errors));
  await closeBrowserSafely(browser);
}
