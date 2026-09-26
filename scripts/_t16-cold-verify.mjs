// 复用 apps/voyage/scripts/dev-browser.mjs 的私有 headless 启动逻辑（真实 chrome.exe + d3d11，不走共享浏览器锁），
// 加一层「阶段切换时截图 + 进度条/ETA 断言」，验证 T16 返工修复（进度条不再提前封顶）。
// 用法：从主仓库 apps/voyage 目录下用 node 直接跑（相对导入 scripts/dev-browser.mjs 里的 chrome 定位逻辑）：
//   node <这个文件的绝对路径> --port 5216
import { chromium } from "playwright-core";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const VIEWPORT = { width: 1600, height: 1200 };
const REPO_ROOT = "D:/Code/opus-test";
const OUT_DIR = path.join(REPO_ROOT, "tmp/screenshot/review-t16-fix2");
fs.mkdirSync(OUT_DIR, { recursive: true });

function candidateRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  roots.push(path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright"));
  return roots.filter((r) => fs.existsSync(r));
}
function findChromeExecutable() {
  for (const root of candidateRoots()) {
    let dirs;
    try {
      dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    } catch {
      continue;
    }
    for (const d of dirs) {
      const c = path.join(root, d, "chrome-win64", "chrome.exe");
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

const port = (process.argv.find((a) => a.startsWith("--port")) ? process.argv[process.argv.indexOf(process.argv.find((a) => a === "--port")) + 1] : null) || "5216";
const origin = `http://127.0.0.1:${port}`;

async function main() {
  const executablePath = findChromeExecutable();
  if (!executablePath) throw new Error("找不到本机缓存的完整版 chrome.exe");
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--use-angle=d3d11"] });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 }); // 全新 context = 天然的「真正首次访客」，无需手动清 localStorage
    const page = await context.newPage();
    const nonce = Date.now() % 100000;
    await page.addInitScript((n) => {
      const P = WebGL2RenderingContext.prototype;
      const orig = P.shaderSource;
      P.shaderSource = function (sh, src) {
        if (src.includes("void main")) {
          src = src.replace(/void\s+main\s*\(\s*\)\s*\{/, (m) => `float nonceF_${n}(){ return ${n}.0; }\n` + m + `\n if (nonceF_${n}() < -1.0) return;\n`);
        }
        return orig.call(this, sh, src);
      };
    }, nonce);
    await page.addInitScript(() => {
      window.__t16log = [];
      const t0 = Date.now();
      setInterval(() => {
        const doneCount = document.querySelectorAll(".loading-steps li.done").length;
        const active = document.querySelector(".loading-steps li.active");
        window.__t16log.push({
          t: Date.now() - t0,
          doneCount,
          active: active ? active.dataset.stage : null,
          bar: document.getElementById("loading-bar-fill")?.style.width ?? null,
          elapsed: document.getElementById("loading-elapsed")?.textContent ?? null,
          eta: document.getElementById("loading-eta")?.textContent ?? null,
        });
      }, 100);
    });

    const t0 = Date.now();
    await page.goto(`${origin}/?coldfix2=${t0}`, { waitUntil: "commit", timeout: 180000 });
    await page.bringToFront();

    let lastDoneCount = -1;
    const shots = [];
    for (let i = 0; i < 3000; i++) {
      const hasStartup = await page.evaluate(() => !!window.__voyageStartup);
      const doneCount = await page.evaluate(() => document.querySelectorAll(".loading-steps li.done").length);
      if (doneCount !== lastDoneCount) {
        lastDoneCount = doneCount;
        const shotPath = path.join(OUT_DIR, `step-${doneCount}-done.png`);
        await page.screenshot({ path: shotPath });
        const info = await page.evaluate(() => ({
          bar: document.getElementById("loading-bar-fill")?.style.width ?? null,
          elapsed: document.getElementById("loading-elapsed")?.textContent ?? null,
          eta: document.getElementById("loading-eta")?.textContent ?? null,
        }));
        shots.push({ t: Date.now() - t0, doneCount, path: shotPath, info });
        console.log(`[verify] doneCount=${doneCount} t=${Date.now() - t0}ms bar=${info.bar} eta=${info.eta} elapsed=${info.elapsed}`);
      }
      if (hasStartup) break;
      await page.waitForTimeout(100);
    }

    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 60000, polling: 200 });
    const doneMs = Date.now() - t0;
    const startup = await page.evaluate(() => window.__voyageStartup);
    const log = await page.evaluate(() => window.__t16log || []);

    let monotonic = true;
    let prevBar = -1;
    for (const s of log) {
      const b = parseFloat((s.bar || "").replace("%", ""));
      if (Number.isFinite(b)) {
        if (b < prevBar - 0.05) monotonic = false;
        prevBar = Math.max(prevBar, b);
      }
    }
    const zeroEtaWhileIncomplete = log.filter((s) => s.doneCount < 7 && /约剩\s*0\s*秒/.test(s.eta || ""));

    console.log("========================================");
    console.log(`总耗时 doneMs=${doneMs}`);
    console.log(`monotonic=${monotonic}`);
    console.log(`zeroEtaWhileIncompleteCount=${zeroEtaWhileIncomplete.length}`);
    console.log(`sampleCount=${log.length}`);
    console.log(`startup=${JSON.stringify(startup, null, 2)}`);
    fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ doneMs, monotonic, zeroEtaWhileIncomplete, shots, startup }, null, 2));

    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[verify] 失败：", err);
  process.exit(1);
});
