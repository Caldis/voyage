#!/usr/bin/env node
// DX-05：把多张截图拼成一张对照图，每张左上角标文件名，可选局部放大框。
// DX-07：加 --measure，量一块区域的亮度（省得每次都要现写 Python + PIL 脚本，见
// research/ART_REVIEW_wave6.md 末尾「开发体验反馈」）。
//
// 用法：
//   node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1.png> [<图2.png> ...]
//   node scripts/compare.mjs --measure x,y,w,h [--measure x2,y2,w2,h2 ...] [--json] <图1.png> [<图2.png> ...]
// 两组参数可以同时给（同一次调用既出对照图又量亮度）；--measure 时 --out 不再是必填。
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
import { launchBrowser, closeBrowserSafely } from "./lib/chrome.mjs";

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
  // --measure 时 --out 不再是必填（可以只量亮度、不出拼图）；两者都没给才是用法错误
  if (images.length === 0 || (!args.out && regions.length === 0)) {
    console.error("用法：node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1> [<图2> ...]");
    console.error("      node scripts/compare.mjs --measure x,y,w,h [--measure ...] [--json] <图1> [<图2> ...]");
    process.exit(1);
  }
  const crop = parseCrop(args.crop);
  const zoom = args.zoom !== undefined ? Number(args.zoom) : 1;
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error(`--zoom 应为正数，收到 "${args.zoom}"`);
  const outPath = args.out ? (path.isAbsolute(args.out) ? args.out : path.join(REPO_ROOT, args.out)) : null;
  if (outPath) fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const tiles = images.map((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
    if (!fs.existsSync(abs)) throw new Error(`找不到图片：${p}`);
    return { label: labelFor(p), dataUrl: `data:image/png;base64,${fs.readFileSync(abs).toString("base64")}` };
  });

  const browser = await launchBrowser(chromium, {});
  try {
    const page = await (await browser.newContext()).newPage();
    const { outDataUrl, measurements } = await page.evaluate(
      async ({ tiles, crop, zoom, outPath, regions }) => {
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

        if (!outPath) return { outDataUrl: null, measurements };

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
        return { outDataUrl: final.toDataURL("image/png"), measurements };
      },
      { tiles, crop, zoom, outPath, regions },
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
  } finally {
    await closeBrowserSafely(browser);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[compare] 失败：${err.message}`);
  process.exit(1);
});
