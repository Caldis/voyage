// G08c：地形高度图 / 夜光瓦片竖缝的实测回归（源自 G08 审查 g08rev-demcrack.mjs，加了同页新旧矩形切换、heightAt 剖面、夜光扫描）。
// 每个场景：摆好、冻结、钉回机位、等瓦片；然后 ground.demNightEdgeShared = false（旧矩形）/ true（G08c）各一次：
//   ① rebuildAll 后扫真实管线的 heightCpu：某列 0 m、左右 4 像素内都 > 50 m、同列 ≥ 8 行 → 竖缝列；
//   ② heightAt 剖面：沿 x 方向过飞机 ±2 km、每 5 m 取一次，报最低值、「两边 > 300 m 中间 < 50 m」的样本数、相邻最大跳变；
//   ③ 直接调 buildNight 拼各级夜光画布（不上传），找「≥ 50% 行是纯黑 (0,0,0)、左右 3 列都不是」的整列黑缝（Black Marble 陆地底色是暗蓝，纯黑只可能是画布底色）。
// 用法（apps/voyage 下）：node handoff/G08c-seam.mjs <端口> [场景名,…]（默认 fuji-west-seam-low,night-city-low-west）
import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, applyScene, pinGeometry, pickScenes } from "../scripts/scenarios.mjs";
import { acquireMeasureLock } from "../scripts/lib/ab.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const [port, only = "fuji-west-seam-low,night-city-low-west"] = process.argv.slice(2);
if (!port) throw new Error("用法：node handoff/G08c-seam.mjs <端口> [场景名,…]");
const log = (s) => console.log(`[G08c-seam] ${s}`);
const release = await acquireMeasureLock(REPO_ROOT, `G08c-seam.mjs（端口 ${port}, pid ${process.pid}）`, log);
const browser = await launchBrowser(chromium, {});
let errors = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  page.on("pageerror", (e) => { errors++; log(`pageerror ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && !/eox\.at|tiles\.maps|CORS policy|net::ERR_FAILED/i.test(m.text())) { errors++; log(`console error ${m.text().slice(0, 200)}`); } });
  await page.goto(`http://127.0.0.1:${port}/?g08c=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  for (const sc of pickScenes(only.split(","))) {
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
    await page.evaluate(() => window.__voyage.freeze(true));
    await page.evaluate(pinGeometry, sc);
    for (const shared of [false, true]) {
      const r = await page.evaluate(async (shared) => {
        const v = window.__voyage, g = v.ground;
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        const settled = () => g.pending === 0 && g.levels.every((l) => l.valid && !l.building && !l.stale) && g.uploadQueue.length === 0;
        for (let i = 0; i < 480 && !settled(); i++) await sleep(250);
        g.demNightEdgeShared = shared;
        g.rebuildAll();
        await sleep(500);
        for (let i = 0; i < 480 && !settled(); i++) await sleep(250);
        await sleep(500);
        const H = 256, data = g.heightCpu;
        const x0 = v.cloudUniforms.uCloudOffset.value.x, z0 = v.cloudUniforms.uCloudOffset.value.y;
        const levels = [];
        for (let i = 0; i < g.levels.length; i++) {
          const l = g.levels[i];
          const base = i * H * H, cols = new Map();
          for (let y = 0; y < H; y++)
            for (let x = 4; x < H - 4; x++) {
              if (data[base + y * H + x] !== 0) continue;
              let lo = 0, hi = 0;
              for (let d = 1; d <= 4; d++) {
                if (data[base + y * H + x - d] > 0.05) lo = 1;
                if (data[base + y * H + x + d] > 0.05) hi = 1;
              }
              if (lo && hi) cols.set(x, (cols.get(x) ?? 0) + 1);
            }
          const dem = [...cols].filter(([, n]) => n >= 8).map(([x, n]) => `${x}:${n}`).join(" ");
          // 夜光：直接拼这一级的画布（和建级同一个函数、同一个开关）
          const px = await g.buildNight(l.size, l.cx, l.cz);
          const N = Math.round(Math.sqrt(px.length / 4));
          const black = new Float32Array(N);
          for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const k = (y * N + x) * 4; if (px[k] === 0 && px[k + 1] === 0 && px[k + 2] === 0) black[x]++; }
          const nightCols = [];
          for (let x = 3; x < N - 3; x++) if (black[x] >= N * 0.5 && black[x - 3] < N * 0.5 && black[x + 3] < N * 0.5) nightCols.push(x);
          // 连续列合并成带
          const bands = [];
          for (const x of nightCols) { const b = bands[bands.length - 1]; if (b && x === b[1] + 1) b[1] = x; else bands.push([x, x]); }
          // 宽带：整带都黑，上面的「左右 3 列不黑」只抓到带的两边，按连续黑列重新数带宽
          const wide = [];
          for (let x = 0; x < N; ) { if (black[x] >= N * 0.5) { let e = x; while (e + 1 < N && black[e + 1] >= N * 0.5) e++; if (e > x) wide.push([x, e]); x = e + 1; } else x++; }
          levels.push({ i, size: l.size, dem, nightBands: wide.filter(([a, b]) => a > 0 && b < N - 1).map(([a, b]) => `${a}-${b}(${(((b - a + 1) * l.size) / N).toFixed(2)} km)`).join(" ") });
        }
        // heightAt 剖面
        let min = Infinity, dips = 0, jump = 0, prev = null, minAt = 0;
        const prof = [];
        for (let dx = -2; dx <= 2 + 1e-9; dx += 0.005) {
          const h = g.heightAt(x0 + dx, z0) ?? NaN;
          prof.push(h);
          if (h < min) { min = h; minAt = dx; }
          if (prev !== null) jump = Math.max(jump, Math.abs(h - prev));
          prev = h;
        }
        for (let k = 20; k < prof.length - 20; k++) if (prof[k] < 0.05 && prof[k - 20] > 0.3 && prof[k + 20] > 0.3) dips++;
        const [lat, lon] = g.localFrame.toGeo(x0, z0);
        return { shared, lat, lon, here: g.heightAt(x0, z0), min, minAt, dips, jump, levels, pending: g.pending };
      }, shared);
      log(`${sc.name} 矩形=${shared ? "G08c 对接" : "旧"}  位置 ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}  pending=${r.pending}`);
      log(`  heightAt 正下方 ${(r.here * 1000).toFixed(0)} m；±2 km 剖面（5 m 步长）最低 ${(r.min * 1000).toFixed(0)} m @ ${(r.minAt * 1000).toFixed(0)} m，深沟样本 ${r.dips}，相邻最大跳变 ${(r.jump * 1000).toFixed(0)} m`);
      for (const l of r.levels) log(`  L${l.i} ${l.size} km：地形 0 m 竖缝列 ${l.dem || "无"}；夜光整列黑带 ${l.nightBands || "无"}`);
    }
    await page.evaluate(() => { window.__voyage.ground.demNightEdgeShared = true; window.__voyage.freeze(false); });
  }
  log(`控制台 error（瓦片跨域除外）${errors} 条`);
} finally {
  await closeBrowserSafely(browser);
  release();
}
