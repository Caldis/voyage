#!/usr/bin/env node
// DX-05：把多张截图拼成一张对照图，每张左上角标文件名，可选局部放大框。
//
// 用法：
//   node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1.png> [<图2.png> ...]
//
// 不给 --crop 就是整图并排（原图大小，不缩放）；给了 --crop 就先裁剪成 (x,y,w,h)，
// 再按 --zoom（默认 1）用最近邻放大——保留像素边界，不做双线性模糊，这是给「看锯齿 / 闪烁 /
// 摩尔纹」这类像素级问题用的，模糊会把真正的问题糊掉。
//
// 泛化自 handoff/T35-crop.py（Python + Pillow）。改用 Node + Canvas2D 是为了不依赖本机 Python
// 环境（仓库里 apps/roadmap/scripts 已经因为要装 shapely 踩过 Python 环境的坑，见根 AGENTS.md；
// voyage 这边除 check:glsl 外都是纯 Node 工具链，保持单一）。用一次性的 headless 页面（复用
// lib/chrome.mjs 的 launchBrowser）做合成：不需要真实 GPU（只用 Canvas2D，不碰 WebGL），
// 复用它只是为了共用「怎么找到本机 chrome.exe」这份逻辑，不用额外装 chrome-headless-shell。

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "./lib/chrome.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
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
  if (images.length === 0 || !args.out) {
    console.error("用法：node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1> [<图2> ...]");
    process.exit(1);
  }
  const crop = parseCrop(args.crop);
  const zoom = args.zoom !== undefined ? Number(args.zoom) : 1;
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error(`--zoom 应为正数，收到 "${args.zoom}"`);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(REPO_ROOT, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const tiles = images.map((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
    if (!fs.existsSync(abs)) throw new Error(`找不到图片：${p}`);
    return { label: labelFor(p), dataUrl: `data:image/png;base64,${fs.readFileSync(abs).toString("base64")}` };
  });

  const browser = await launchBrowser(chromium, {});
  try {
    const page = await (await browser.newContext()).newPage();
    const outDataUrl = await page.evaluate(
      async ({ tiles, crop, zoom }) => {
        const loadImg = (src) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("图片解码失败"));
            img.src = src;
          });
        const imgs = await Promise.all(tiles.map((t) => loadImg(t.dataUrl)));
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
        return final.toDataURL("image/png");
      },
      { tiles, crop, zoom },
    );
    fs.writeFileSync(outPath, Buffer.from(outDataUrl.split(",")[1], "base64"));
    const note = crop ? `crop=${crop.x},${crop.y},${crop.w},${crop.h} zoom=${zoom}` : "整图";
    console.log(`[compare] 写入 ${path.relative(REPO_ROOT, outPath).replace(/\\/g, "/")}（${images.length} 张，${note}）`);
  } finally {
    await closeBrowserSafely(browser);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[compare] 失败：${err.message}`);
  process.exit(1);
});
