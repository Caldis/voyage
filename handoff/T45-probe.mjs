// T45 / T44 定位用：打开页面 → 应用一个场景 → 依次执行若干「变体」JS（页面内换着色器 / 改 uniform）→ 每个变体截一张图，
// 并可在截图后执行一段读数 JS（例如读回云的历史缓冲某一点的 RGBA），把结果打印出来。
// 用法：node handoff/T45-probe.mjs --port 5244 --scene '<JSON>' --variants <文件.mjs> --out tmp/screenshot/T45/probe [--angle vulkan]
//   变体文件导出 VARIANTS = [{ name, js?, read?, wait? }]；js 在截图前执行（可 async），read 在截图后执行、返回值 JSON 打印。
//   页面内可用的小工具（addInitScript 注入）：__t45.replaceMarch(pairs) / __t45.replaceOutside(pairs) / __t45.restore()
//   / __t45.readCloud(x, y)（窗口像素坐标，左上为原点；读云历史缓冲 RGBA）。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOY = path.join(HERE, "..");
const REPO = path.join(VOY, "..", "..");
const { DEFAULTS, applyScene } = await import(pathToFileURL(path.join(VOY, "scripts", "scenarios.mjs")).href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(path.join(VOY, "scripts", "lib", "chrome.mjs")).href);

const args = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith("--")) { args[av[i].slice(2)] = av[i + 1]; i++; }
const port = args.port || "5244";
const sc = JSON.parse(args.scene);
const { VARIANTS } = args.variants ? await import(pathToFileURL(path.resolve(args.variants)).href) : { VARIANTS: [{ name: "base" }] };
// 截图放主仓库的 tmp/screenshot（worktree 在主仓库的 .claude/worktrees/<名>/ 下，往上三级）；也可给绝对路径
const MAIN = path.resolve(REPO, "..", "..", "..");
const outDir = path.resolve(fs.existsSync(path.join(MAIN, "tmp")) ? MAIN : REPO, args.out || "tmp/screenshot/T45/probe");
fs.mkdirSync(outDir, { recursive: true });

const browser = await launchBrowser(chromium, { angle: args.angle || "vulkan" });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 400)); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => {
    const v = window.__voyage;
    const orig = new Map();
    const rep = (mat, pairs) => {
      if (!orig.has(mat)) orig.set(mat, mat.fragmentShader);
      let s = orig.get(mat);
      for (const [a, b] of pairs) {
        if (!s.includes(a)) throw new Error("miss " + a.slice(0, 80));
        s = s.split(a).join(b);
      }
      mat.fragmentShader = s;
      mat.needsUpdate = true;
    };
    window.__t45 = {
      replaceMarch: (pairs) => rep(v.clouds.marchMat, pairs),
      replaceOutside: (pairs) => rep(v.outsideMat, pairs),
      replaceShadow: (pairs) => { rep(v.clouds.shadowMat, pairs); v.clouds.shadowKey = "x"; },
      restore: () => { for (const [m, s] of orig) { m.fragmentShader = s; m.needsUpdate = true; } v.clouds.shadowKey = "x"; },
      readCloud: (x, y) => {
        const c = v.clouds;
        const t = c.history[0];
        const r = c.pass.renderer;
        const sx = Math.round((x / window.innerWidth) * t.width);
        const sy = Math.round((1 - y / window.innerHeight) * t.height);
        const buf = new Uint16Array(4);
        r.readRenderTargetPixels(t, sx, sy, 1, 1, buf);
        const h2f = (h) => { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024); };
        return Array.from(buf, h2f);
      },
    };
  });
  const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
  console.log(info.replace(/\n/g, " | "));
  for (const vr of VARIANTS) {
    if (vr.js) {
      await page.evaluate(vr.js);
      // 等页面内换上的着色器编译完（vulkan 几秒），再重新摆一次场景：天气按飞机此刻位置重摆，各变体画面可比
      await page.waitForTimeout(vr.wait ?? 6000);
    }
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS });
    const file = path.join(outDir, `${sc.name}-${vr.name}.png`);
    await page.screenshot({ path: file });
    let r = "";
    if (vr.read) r = JSON.stringify(await page.evaluate(vr.read));
    console.log(`${vr.name}: ${path.relative(REPO, file)} ${r}`);
    if (vr.restore !== false && vr.js) await page.evaluate(() => window.__t45.restore());
  }
} finally {
  await closeBrowserSafely(browser);
}
process.exit(0);
