// G08-STITCH：离页实验——同一组瓦片、同样的小数矩形，分别画在 GPU 画布（G07b 做法）、CPU 画布直接 drawImage、
// CPU 画布 drawTileCrisp（tile-compose.ts）上，比较 A 通道（接缝是否 < 255）与 RGB 差。
// 用法（apps/voyage 下）：node handoff/G08-seam.mjs <端口>
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";

const [port] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
try {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/src/ground/tile-compose.ts`, { waitUntil: "commit" }).catch(() => {});
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });
  const r = await page.evaluate(async () => {
    const tc = await import("/src/ground/tile-compose.ts");
    const z = 12, X = 3626, Y = 1617; // 富士山附近
    const blobs = [];
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 3; i++) {
        const url = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/${z}/${Y + j}/${X + i}.jpg`;
        const b = await (await fetch(url, { mode: "cors" })).blob();
        blobs.push({ i, j, url, b });
      }
    const RES = 700;
    // 小数矩形：瓦片 213.37 px 见方，起点 7.31；第 2 列往右挪 0.6 px（缝隙）、第 3 列往左挪 0.8 px（重叠），模拟本地坐标的不对接
    const S = 213.37;
    const tiles = blobs.map(({ i, j, url, b }) => ({ key: url, blob: b, x: 7.31 + i * S + (i === 1 ? 0.6 : i === 2 ? -0.8 : 0), y: 5.17 + j * S, w: S, h: S }));
    const bmps = await Promise.all(tiles.map((t) => createImageBitmap(t.blob)));
    const draw = (ctx, crisp) => {
      ctx.imageSmoothingQuality = "high";
      tiles.forEach((t, k) => (crisp ? null : ctx.drawImage(bmps[k], t.x, t.y, t.w, t.h)));
    };
    const gpu = new OffscreenCanvas(RES, RES).getContext("2d");
    draw(gpu, false);
    const cpu = new OffscreenCanvas(RES, RES).getContext("2d", { willReadFrequently: true });
    draw(cpu, false);
    const crisp = (await tc.composeTiles({ kind: "compose", res: RES, fill: null, tiles }, null)).px;
    const G = gpu.getImageData(0, 0, RES, RES).data, C = cpu.getImageData(0, 0, RES, RES).data;
    const stat = (A, B) => {
      let partialA = 0, partialB = 0, maxd = 0, sum = 0, n = 0, over8 = 0;
      const inside = (x, y) => x >= 10 && y >= 8 && x < 7.31 + 3 * S - 3 && y < 5.17 + 3 * S - 3;
      for (let y = 0; y < RES; y++)
        for (let x = 0; x < RES; x++) {
          if (!inside(x, y)) continue;
          const k = (y * RES + x) * 4;
          if (A[k + 3] > 0 && A[k + 3] < 255) partialA++;
          if (B[k + 3] > 0 && B[k + 3] < 255) partialB++;
          const d = Math.max(Math.abs(A[k] - B[k]), Math.abs(A[k + 1] - B[k + 1]), Math.abs(A[k + 2] - B[k + 2]), Math.abs(A[k + 3] - B[k + 3]));
          maxd = Math.max(maxd, d); sum += d; n++; if (d > 8) over8++;
        }
      return { partialA, partialB, maxd, mean: +(sum / n).toFixed(3), over8 };
    };
    // 列 / 行接缝处的 A
    const colA = (P, y) => [...Array(700).keys()].filter((x) => P[(y * RES + x) * 4 + 3] < 255 && x > 5 && x < 650).map((x) => `${x}:${P[(y * RES + x) * 4 + 3]}`).join(" ");
    return { gpuVsCpu: stat(G, C), gpuVsCrisp: stat(G, crisp), rowGpu: colA(G, 300), rowCpu: colA(C, 300), rowCrisp: colA(crisp, 300) };
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await browser.close();
}
