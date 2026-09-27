#!/usr/bin/env node
// DX-05：把多张截图拼成一张对照图，每张左上角标文件名，可选局部放大框。
// DX-07：加 --measure，量一块区域的亮度（省得每次都要现写 Python + PIL 脚本，见
// research/ART_REVIEW_wave6.md 末尾「开发体验反馈」）。
// DX-08：加 --diff，输出两张图逐像素差的均值 / p99 / 超阈值像素比例，可选差异热图。
//
// 用法：
//   node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1.png> [<图2.png> ...]
//   node scripts/compare.mjs --measure x,y,w,h [--measure x2,y2,w2,h2 ...] [--json] <图1.png> [<图2.png> ...]
//   node scripts/compare.mjs --diff <图2.png> [--threshold 8] [--heatmap 差异.png] [--json] <图1.png>
// 三组参数可以按需组合；--measure / --diff 时 --out 不再是必填。
//
// --diff：<图1.png>（位置参数）与 --diff 的值（<图2.png>）必须尺寸相同，否则报错。每个像素按
// |ΔR|+|ΔG|+|ΔB| 除以 3（0–255）算「差异幅度」，输出：
//   mean          全图差异幅度的均值
//   p99           99 分位（排序后取 index = min(n-1, floor(0.99·n))，与 --measure 的口径一致）
//   overThresholdPct / overThresholdPixels   差异幅度 > --threshold（默认 8）的像素占比 / 个数——
//     8 这个默认值和 T08.md 验收表里「差 > 8 的像素 0.1%/0.3%」的口径一致，不是随手挑的
//   --heatmap 路径  可选：写一张假彩色差异图（黑 = 无差异，经阈值处黄，超过 2 倍阈值封顶到红），
//     找「差异到底在画面哪里」比读一堆数字直观
// **零回归判断的基准是「同一份代码跑两次」的噪声底，不是 0**：TAA、云的时间累积、海浪相位、翼尖颤动、
// 随机闪电这些都会让同代码两次截图产生非零差异（README 坑点举过 low-sea-glint 平均差 7–9/255 的例子）。
// 判断「这一版改动有没有引入真实差异」时，先跑一次「改动前 vs 改动前」（或 `__voyage.freeze` 冻结后的
// 两张截图）拿到噪声底，再和「改动前 vs 改动后」的数字比，只有明显超过噪声底才算数，不要直接看 mean/p99
// 是不是 0。`dev-browser.mjs shots --freeze` 生成的两张截图理论上噪声应为 0（连续渲染逐像素一致），
// 可以用来验证这套流程本身有没有问题。
//
// 不给 --crop 就是整图并排（原图大小，不缩放）；给了 --crop 就先裁剪成 (x,y,w,h)，
// 再按 --zoom（默认 1）用最近邻放大——保留像素边界，不做双线性模糊，这是给「看锯齿 / 闪烁 /
// 摩尔纹」这类像素级问题用的，模糊会把真正的问题糊掉。
//
// --measure x,y,w,h（可重复）：对每张输入图、每个区域，按原图像素（不受 --crop / --zoom 影响，
// 那两个只管拼图输出）算 Rec.709 luma（Y = 0.2126R + 0.7152G + 0.0722B，0–255，公式与
// handoff/T08-stats.py 一致，方便和历史数据对比）的均值与 p99（排序后取 index = min(n-1, floor(0.99·n))，
// 同一套取法）。默认打印成人读的表格；--json 时改成打印一份 JSON（数组，每张图每个区域一条）到 stdout，
// 不额外写文件。
//
// 泛化自 handoff/T35-crop.py（Python + Pillow）。改用 Node + Canvas2D 是为了不依赖本机 Python
// 环境（仓库里 apps/roadmap/scripts 已经因为要装 shapely 踩过 Python 环境的坑，见根 AGENTS.md；
// voyage 这边除 check:glsl 外都是纯 Node 工具链，保持单一）。用一次性的 headless 页面（复用
// lib/chrome.mjs 的 launchBrowser）做合成：不需要真实 GPU（只用 Canvas2D，不碰 WebGL），
// 复用它只是为了共用「怎么找到本机 chrome.exe」这份逻辑，不用额外装 chrome-headless-shell。
//
// --out（拼图输出路径）相对**仓库根**解析，不是当前工作目录，和 dev-browser.mjs 的 --out 一致
// （T08 开发体验反馈踩过这个坑：以为是相对当前目录，结果写到了仓库外面）。

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely, resolveRepoPath } from "./lib/chrome.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");

// 同名参数重复出现时合并成数组（--measure 要能传多次；写法与 dev-browser.mjs 的 parseArgs 一致）。
// --json 是纯开关（没有值），特殊处理：不然「--json 图1.png」会把 图1.png 当成 --json 的值吃掉，
// 剩下的位置参数（图片路径）就少了一个。
const BOOLEAN_ONLY_FLAGS = new Set(["json"]);
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      let val;
      if (BOOLEAN_ONLY_FLAGS.has(key)) {
        val = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          val = next;
          i++;
        } else val = true;
      }
      if (key in out) out[key] = Array.isArray(out[key]) ? [...out[key], val] : [out[key], val];
      else out[key] = val;
    } else out._.push(a);
  }
  return out;
}

/** --measure x,y,w,h（可重复）解析成 { x, y, w, h } 数组；不传返回 [] */
function parseMeasureRegions(args) {
  if (!args.measure) return [];
  const list = Array.isArray(args.measure) ? args.measure : [args.measure];
  return list.map((s) => {
    const nums = String(s).split(",").map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
      throw new Error(`--measure 格式应为 x,y,w,h（如 --measure 400,300,200,150），收到 "${s}"`);
    }
    const [x, y, w, h] = nums;
    return { x, y, w, h };
  });
}

/** --crop x,y,w,h -> { x, y, w, h }；不传返回 null（整图，不裁剪） */
function parseCrop(s) {
  if (s === undefined) return null;
  const nums = String(s).split(",").map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`--crop 格式应为 x,y,w,h（如 --crop 400,300,200,150），收到 "${s}"`);
  }
  const [x, y, w, h] = nums;
  return { x, y, w, h };
}

/** 左上角标签：仓库相对路径的最后两级（父目录/文件名），够区分「不同批次同名场景」这类常见情况 */
function labelFor(p) {
  const rel = path.isAbsolute(p) ? path.relative(REPO_ROOT, p) : p;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const images = args._;
  const regions = parseMeasureRegions(args);
  // --diff 的值是第二张图，第一张图是位置参数（见文件头注释，和 --out 同一个位置参数列表）
  const diffPair = args.diff ? [images[0], String(args.diff)] : null;
  if (args.diff && !images[0]) throw new Error("--diff 需要两张图：一张是 --diff 的值，另一张作为位置参数给出");
  // --measure / --diff 时 --out 不再是必填（可以只量数值、不出拼图）；三者都没给才是用法错误
  if (images.length === 0 && !diffPair) {
    console.error("用法：node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1> [<图2> ...]");
    console.error("      node scripts/compare.mjs --measure x,y,w,h [--measure ...] [--json] <图1> [<图2> ...]");
    console.error("      node scripts/compare.mjs --diff <图2> [--threshold 8] [--heatmap 差异.png] [--json] <图1>");
    process.exit(1);
  }
  if (!args.out && regions.length === 0 && !diffPair) {
    console.error("用法：node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1> [<图2> ...]");
    console.error("      node scripts/compare.mjs --measure x,y,w,h [--measure ...] [--json] <图1> [<图2> ...]");
    console.error("      node scripts/compare.mjs --diff <图2> [--threshold 8] [--heatmap 差异.png] [--json] <图1>");
    process.exit(1);
  }
  const crop = parseCrop(args.crop);
  const zoom = args.zoom !== undefined ? Number(args.zoom) : 1;
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error(`--zoom 应为正数，收到 "${args.zoom}"`);
  const outPath = args.out ? resolveRepoPath(REPO_ROOT, args.out) : null;
  if (outPath) fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const threshold = args.threshold !== undefined ? Number(args.threshold) : 8;
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error(`--threshold 应为非负数，收到 "${args.threshold}"`);
  const heatmapPath = args.heatmap ? resolveRepoPath(REPO_ROOT, args.heatmap) : null;
  if (heatmapPath) fs.mkdirSync(path.dirname(heatmapPath), { recursive: true });

  const tiles = images.map((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
    if (!fs.existsSync(abs)) throw new Error(`找不到图片：${p}`);
    return { label: labelFor(p), dataUrl: `data:image/png;base64,${fs.readFileSync(abs).toString("base64")}` };
  });
  // --diff 的第二张图不一定在 images（位置参数）里，单独读一份 dataUrl 传进页面
  let diffTile = null;
  if (diffPair) {
    const abs = path.isAbsolute(diffPair[1]) ? diffPair[1] : path.join(REPO_ROOT, diffPair[1]);
    if (!fs.existsSync(abs)) throw new Error(`找不到图片：${diffPair[1]}`);
    diffTile = { label: labelFor(diffPair[1]), dataUrl: `data:image/png;base64,${fs.readFileSync(abs).toString("base64")}` };
  }

  const browser = await launchBrowser(chromium, {});
  try {
    const page = await (await browser.newContext()).newPage();
    const { outDataUrl, measurements, diffStats } = await page.evaluate(
      async ({ tiles, crop, zoom, outPath, regions, diffTile, threshold, wantHeatmap }) => {
        const loadImg = (src) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("图片解码失败"));
            img.src = src;
          });
        const imgs = await Promise.all(tiles.map((t) => loadImg(t.dataUrl)));

        // --measure：按原图像素（不受 crop/zoom 影响）算每个区域的 Rec.709 luma 均值与 p99
        const measurements = [];
        if (regions.length > 0) {
          for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            for (const r of regions) {
              const sx = Math.max(0, r.x);
              const sy = Math.max(0, r.y);
              const sw = Math.max(1, Math.min(r.w - (sx - r.x), img.naturalWidth - sx));
              const sh = Math.max(1, Math.min(r.h - (sy - r.y), img.naturalHeight - sy));
              const c = document.createElement("canvas");
              c.width = sw;
              c.height = sh;
              const ctx = c.getContext("2d");
              ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
              const data = ctx.getImageData(0, 0, sw, sh).data;
              const lum = new Array(sw * sh);
              for (let p = 0, j = 0; p < data.length; p += 4, j++) {
                lum[j] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
              }
              lum.sort((a, b) => a - b);
              const n = lum.length;
              const mean = lum.reduce((a, b) => a + b, 0) / n;
              const p99 = lum[Math.min(n - 1, Math.floor(0.99 * n))];
              measurements.push({
                image: tiles[i].label,
                region: { x: r.x, y: r.y, w: r.w, h: r.h },
                mean: +mean.toFixed(1),
                p99: +p99.toFixed(1),
              });
            }
          }
        }

        // --diff：逐像素 |ΔR|+|ΔG|+|ΔB| / 3（0–255），输出均值 / p99 / 超阈值像素比例，可选差异热图
        let diffStats = null;
        if (diffTile) {
          const [imgA, imgB] = await Promise.all([loadImg(tiles[0].dataUrl), loadImg(diffTile.dataUrl)]);
          if (imgA.naturalWidth !== imgB.naturalWidth || imgA.naturalHeight !== imgB.naturalHeight) {
            throw new Error(`--diff 两张图尺寸不同：${imgA.naturalWidth}x${imgA.naturalHeight} vs ${imgB.naturalWidth}x${imgB.naturalHeight}`);
          }
          const w = imgA.naturalWidth;
          const h = imgA.naturalHeight;
          const cA = document.createElement("canvas");
          cA.width = w;
          cA.height = h;
          cA.getContext("2d").drawImage(imgA, 0, 0);
          const cB = document.createElement("canvas");
          cB.width = w;
          cB.height = h;
          cB.getContext("2d").drawImage(imgB, 0, 0);
          const dataA = cA.getContext("2d").getImageData(0, 0, w, h).data;
          const dataB = cB.getContext("2d").getImageData(0, 0, w, h).data;
          const n = w * h;
          const diffs = new Float64Array(n);
          let over = 0;
          let heatCtx = null;
          let heatImgData = null;
          if (wantHeatmap) {
            const heatCanvas = document.createElement("canvas");
            heatCanvas.width = w;
            heatCanvas.height = h;
            heatCtx = heatCanvas.getContext("2d");
            heatImgData = heatCtx.createImageData(w, h);
          }
          for (let i = 0, p = 0; i < n; i++, p += 4) {
            const d = (Math.abs(dataA[p] - dataB[p]) + Math.abs(dataA[p + 1] - dataB[p + 1]) + Math.abs(dataA[p + 2] - dataB[p + 2])) / 3;
            diffs[i] = d;
            if (d > threshold) over++;
            if (wantHeatmap) {
              // 假彩色：0 = 黑，阈值处过渡到黄，2 倍阈值封顶到红——超过阈值的差异比线性满量程灰度显眼得多
              const t = threshold > 0 ? Math.min(1, d / threshold) : d > 0 ? 1 : 0;
              const t2 = threshold > 0 ? Math.min(1, Math.max(0, (d - threshold) / threshold)) : 0;
              heatImgData.data[p] = Math.round(255 * Math.min(1, t + t2));
              heatImgData.data[p + 1] = Math.round(255 * Math.max(0, t - t2));
              heatImgData.data[p + 2] = 0;
              heatImgData.data[p + 3] = 255;
            }
          }
          const sorted = Float64Array.from(diffs).sort();
          const mean = diffs.reduce((a, b) => a + b, 0) / n;
          const p99 = sorted[Math.min(n - 1, Math.floor(0.99 * n))];
          const max = sorted[n - 1];
          let heatDataUrl = null;
          if (wantHeatmap) {
            heatCtx.putImageData(heatImgData, 0, 0);
            heatDataUrl = heatCtx.canvas.toDataURL("image/png");
          }
          diffStats = {
            width: w,
            height: h,
            threshold,
            mean: +mean.toFixed(2),
            p99: +p99.toFixed(2),
            max: +max.toFixed(2),
            overThresholdPixels: over,
            overThresholdPct: +((over / n) * 100).toFixed(3),
            heatDataUrl,
          };
        }

        if (!outPath) return { outDataUrl: null, measurements, diffStats };

        const tileCanvases = imgs.map((img, i) => {
          const sx = crop ? crop.x : 0;
          const sy = crop ? crop.y : 0;
          const sw = crop ? crop.w : img.naturalWidth;
          const sh = crop ? crop.h : img.naturalHeight;
          const dw = Math.max(1, Math.round(sw * zoom));
          const dh = Math.max(1, Math.round(sh * zoom));
          const c = document.createElement("canvas");
          c.width = dw;
          c.height = dh;
          const ctx = c.getContext("2d");
          ctx.imageSmoothingEnabled = false; // 最近邻，保留像素边界
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
          // 左上角文件名标签：黑底黄字，宽度按文本量自适应
          const label = tiles[i].label;
          ctx.font = "12px monospace";
          const textW = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(0,0,0,0.7)";
          ctx.fillRect(0, 0, Math.min(dw, textW + 8), 16);
          ctx.fillStyle = "#ffff00";
          ctx.textBaseline = "top";
          ctx.fillText(label, 4, 2);
          return c;
        });
        const gap = 4;
        const W = tileCanvases.reduce((a, c) => a + c.width, 0) + gap * (tileCanvases.length - 1);
        const H = Math.max(...tileCanvases.map((c) => c.height));
        const final = document.createElement("canvas");
        final.width = W;
        final.height = H;
        const fctx = final.getContext("2d");
        fctx.fillStyle = "#000";
        fctx.fillRect(0, 0, W, H);
        let cx = 0;
        for (const c of tileCanvases) {
          fctx.drawImage(c, cx, 0);
          cx += c.width + gap;
        }
        return { outDataUrl: final.toDataURL("image/png"), measurements, diffStats };
      },
      { tiles, crop, zoom, outPath, regions, diffTile, threshold, wantHeatmap: !!heatmapPath },
    );
    if (outPath) {
      fs.writeFileSync(outPath, Buffer.from(outDataUrl.split(",")[1], "base64"));
      const note = crop ? `crop=${crop.x},${crop.y},${crop.w},${crop.h} zoom=${zoom}` : "整图";
      console.log(`[compare] 写入 ${path.relative(REPO_ROOT, outPath).replace(/\\/g, "/")}（${images.length} 张，${note}）`);
    }
    if (regions.length > 0) {
      if (args.json) {
        console.log(JSON.stringify(measurements, null, 2));
      } else {
        console.log(`[compare] 亮度（Rec.709 luma，0–255）：`);
        for (const m of measurements) {
          console.log(`  ${m.image}  region=${m.region.x},${m.region.y},${m.region.w},${m.region.h}  mean=${m.mean}  p99=${m.p99}`);
        }
      }
    }
    if (diffStats) {
      const { heatDataUrl, ...printable } = diffStats;
      if (heatmapPath && heatDataUrl) {
        fs.writeFileSync(heatmapPath, Buffer.from(heatDataUrl.split(",")[1], "base64"));
      }
      if (args.json) {
        console.log(JSON.stringify({ a: labelFor(diffPair[0]), b: labelFor(diffPair[1]), ...printable }, null, 2));
      } else {
        console.log(`[compare] --diff ${labelFor(diffPair[0])} vs ${labelFor(diffPair[1])}（${printable.width}x${printable.height}，阈值 ${printable.threshold}）：`);
        console.log(`  平均绝对差 ${printable.mean} / 255，p99 ${printable.p99}，最大 ${printable.max}`);
        console.log(`  超过阈值的像素：${printable.overThresholdPixels}（${printable.overThresholdPct}%）`);
        if (heatmapPath) console.log(`  差异热图：${path.relative(REPO_ROOT, heatmapPath).replace(/\\/g, "/")}`);
      }
    }
  } finally {
    await closeBrowserSafely(browser);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[compare] 失败：${err.message}`);
  process.exit(1);
});
