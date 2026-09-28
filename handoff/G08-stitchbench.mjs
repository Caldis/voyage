// G08-STITCH：CPU 画布拼 2048² 的耗时与画质档（imageSmoothingQuality）的关系。11×11 张 EOX z12 瓦片按 1.45 / 0.8 倍缩放拼上，
// 各档跑 3 次取中位，并与 high 比像素差（RGB 最大 / 平均）。在页面主线程里跑（和 Worker 里的 CPU 栅格同一个 Skia 路径）。
// 用法（apps/voyage 下）：node handoff/G08-stitchbench.mjs <端口>
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";

const [port] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/src/ground/geo.ts`, { waitUntil: "commit" });
  const r = await page.evaluate(async () => {
    const z = 12, X = 3620, Y = 1610, N = 11;
    const jobs = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) jobs.push(fetch(`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/${z}/${Y + j}/${X + i}.jpg`, { mode: "cors" }).then((x) => (x.ok ? x.blob() : null)).catch(() => null));
    const blobs = await Promise.all(jobs);
    const bmps = await Promise.all(blobs.map((b) => (b ? createImageBitmap(b) : null)));
    const out = {};
    let ref = null;
    for (const scale of [1.45, 0.8]) {
      const S = 256 * scale * (2048 / (256 * N * scale)) * (scale > 1 ? 1 : 0.55); // 覆盖大半张画布
      for (const q of ["high", "medium", "low"]) {
        const times = [];
        let px = null;
        for (let k = 0; k < 3; k++) {
          const t0 = performance.now();
          const ctx = new OffscreenCanvas(2048, 2048).getContext("2d", { willReadFrequently: true });
          ctx.imageSmoothingQuality = q;
          bmps.forEach((b, n) => b && ctx.drawImage(b, 3.3 + (n % N) * S, 2.7 + Math.floor(n / N) * S, S, S));
          px = ctx.getImageData(0, 0, 2048, 2048).data;
          times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        if (q === "high") ref = px;
        let mx = 0, sum = 0;
        for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(px[i + c] - ref[i + c]); mx = Math.max(mx, d); sum += d; }
        out[`${scale}x ${q}`] = { ms: Math.round(times[1]), tileSrcPx: +(S / 256).toFixed(2), maxVsHigh: mx, meanVsHigh: +(sum / (px.length * 0.75)).toFixed(3) };
      }
    }
    return { tiles: bmps.filter(Boolean).length, out };
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await browser.close();
}
