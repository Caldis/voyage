// G07：一层影像纹理上传的真实代价（同页 A/B）：G06 的做法（第 0 级分块 + 整个数组 generateMipmap）vs G07（第 0 级分块 + 这一层各级 mip）。
// 每次调用后 gl.finish() 等 GPU 做完，计挂钟时间（含 GPU）；另用 EXT_disjoint_timer_query_webgl2 计纯 GPU 时间。
// 用法（apps/voyage 下）：node handoff/G07-upbench.mjs <端口> [轮数=20] [额外 URL 参数]
// 测完 rebuildAll() 把被写乱的那一层按真实数据重建（不影响后续）。只能对 G07 分支跑（要 gpuMips 开关）。
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";

const [port, roundsS = "20", extraQ = ""] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?g07=${Date.now()}${extraQ}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup && window.__voyage.ground.levelUniform.every((u) => u.w > 0.5), null, { timeout: 300000, polling: 500 });
  const res = await page.evaluate(async (rounds) => {
    const g = window.__voyage.ground;
    const gl = g.gl;
    const RES = g.imageryStats.res;
    const tq = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const px = new Uint8ClampedArray(RES * RES * 4).map((_, i) => (i * 2654435761) >>> 24);
    let n = 0;
    for (let w = RES >> 1; w >= 1; w >>= 1) n += w * w * 4;
    const mips = new Uint8Array(n).fill(128);
    const one = async (gpuMips) => {
      g.gpuMips = gpuMips;
      gl.finish();
      const q = tq ? gl.createQuery() : null;
      if (q) gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
      const t0 = performance.now();
      g.uploadDirect(g.albedo, 6, px, gpuMips ? null : mips);
      const tCall = performance.now() - t0;
      if (q) gl.endQuery(tq.TIME_ELAPSED_EXT);
      gl.finish();
      const tAll = performance.now() - t0;
      let gpu = null;
      if (q) {
        for (let k = 0; k < 200 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((r) => setTimeout(r, 5));
        gpu = Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6;
        gl.deleteQuery(q);
      }
      return { tCall, tAll, gpu };
    };
    const out = { g06: [], g07: [] };
    for (let r = 0; r < rounds; r++) {
      out.g06.push(await one(true));
      out.g07.push(await one(false));
      await new Promise((r) => requestAnimationFrame(r));
    }
    g.gpuMips = false;
    g.rebuildAll();
    const med = (a, k) => { const s = a.map((x) => x[k]).filter((x) => x !== null).sort((x, y) => x - y); return s.length ? +s[s.length >> 1].toFixed(2) : null; };
    const max = (a, k) => +Math.max(...a.map((x) => x[k] ?? 0)).toFixed(2);
    const sum = (a) => ({ callMed: med(a, "tCall"), finishMed: med(a, "tAll"), finishMax: max(a, "tAll"), gpuMed: med(a, "gpu"), gpuMax: max(a, "gpu") });
    return { RES, renderer: window.__voyage.quality.groundRes, g06: sum(out.g06), g07: sum(out.g07) };
  }, Number(roundsS));
  console.log(JSON.stringify(res, null, 1));
} finally {
  await browser.close();
}
