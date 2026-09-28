#!/usr/bin/env node
// DX-05：把多张截图拼成一张对照图，每张左上角标文件名，可选局部放大框。
// DX-07：加 --measure，量一块区域的亮度（省得每次都要现写 Python + PIL 脚本，见
// research/ART_REVIEW_wave6.md 末尾「开发体验反馈」）。
// DX-08：加 --diff，输出两张图逐像素差的均值 / p99 / 超阈值像素比例，可选差异热图。
// DX-11：--measure 补齐平均 RGB / 平均饱和度 / 相邻像素差（棋盘纹 / 锯齿指标）/ ≥250 与 ≤5 像素比例；
//   加 --row / --col（像素曲线，找渐变色带 / 台阶）、--mask（排除区，两条命令共用）、--thumb（缩略图，
//   剪影误读检查）。
//
// 用法：
//   node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1.png> [<图2.png> ...]
//   node scripts/compare.mjs --measure x,y,w,h [--measure x2,y2,w2,h2 ...] [--mask x,y,w,h ...] [--json] <图1.png> [<图2.png> ...]
//   node scripts/compare.mjs --diff <图2.png> [--threshold 8] [--heatmap 差异.png] [--mask x,y,w,h ...] [--json] <图1.png>
//   node scripts/compare.mjs --row 600 [--row 300 ...] [--col 800 ...] [--json] <图1.png> [<图2.png> ...]
//   node scripts/compare.mjs --thumb 64 [--thumb-out tmp/screenshot/thumbs] [--json] <图1.png> [<图2.png> ...]
// 几组参数可以按需组合（同一次调用给 --out 又给 --measure/--row/--thumb 都可以）；除了「至少要有一张图」，
// --measure / --diff / --row / --col / --thumb 任一给了，--out 就不再是必填。
//
// --diff：<图1.png>（位置参数）与 --diff 的值（<图2.png>）必须尺寸相同，否则报错。每个像素按
// |ΔR|+|ΔG|+|ΔB| 除以 3（0–255）算「差异幅度」，输出：
//   mean          全图差异幅度的均值（被 --mask 排除的像素不计入）
//   p99           99 分位（排序后取 index = min(n-1, floor(0.99·n))，与 --measure 的口径一致）
//   overThresholdPct / overThresholdPixels   差异幅度 > --threshold（默认 8）的像素占比 / 个数——
//     8 这个默认值和 T08.md 验收表里「差 > 8 的像素 0.1%/0.3%」的口径一致，不是随手挑的
//   maskedPixels  被 --mask 排除、没计入上面几项统计的像素数
//   --heatmap 路径  可选：写一张假彩色差异图（黑 = 无差异，经阈值处黄，超过 2 倍阈值封顶到红，
//     --mask 排除的像素画成灰色）——找「差异到底在画面哪里」比读一堆数字直观
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
// 那两个只管拼图输出）算：
//   mean / p99          Rec.709 luma（Y = 0.2126R + 0.7152G + 0.0722B，0–255）的均值与 p99（排序后取
//                        index = min(n-1, floor(0.99·n))，与 handoff/T08-stats.py 的公式一致）
//   meanR / meanG / meanB  三个通道各自的均值（0–255）——判断偏色 / 色相漂移比只看 luma 直接
//   meanSaturation       HSL 饱和度（0–100）的均值——判断「灰蒙蒙」还是「过饱和」
//   adjacentDiff         相邻像素 luma 绝对差的均值（水平 + 垂直各算一遍一起平均）：棋盘纹 / 锯齿的
//                        指标——高频跳变多的地方这个数字会明显偏高，平滑渐变（天空、雾）应该接近 0
//   adjDiffH / adjDiffV / adjDiffDiag（DX-22）  按方向拆开的相邻像素差：横（右邻）、纵（下邻）、对角
//                        （"\" 右下邻 + "/" 左下邻一起平均）。十字纹 / 菱形纹（交叉图案）在横 / 纵方向上
//                        经常和正常纹理的高频混在一起量不出来，只有对角方向会明显偏高——DEV_SOP「测量约定」
//                        记过这条：「交叉 / 菱形纹用对角高频能量占比量，相邻像素差量不出（与横纹此消彼长）」，
//                        此前只能靠 handoff/C03-hf.py 的 FFT 频谱才能看出来，这里给一个不用离开 Node 的近似。
//   pctBright / pctDark  luma ≥ 250 / ≤ 5 的像素占比（%）——判断「死白過曝」或「死黑欠曝」的面积
//   hsvSat / rgbSpread（DX-23）  HSV 饱和度（(max−min)/max，0–100）与 RGB max−min（0–255）的均值——
//                        C / TM 系列任务的色度口径（HSL 饱和度在暗部会被放大，判断「夜里偏色」用这两个）
//   blownBlobs / blownMaxArea（DX-23）  luma ≥ 250 的 4 邻域连通块个数与最大一块的像素数——死白验收看最大块
//   streak / streakShift（DX-23）  斜纹指数：高通残差（L − 3×3 盒平均）在 10 个位移上的归一自相关最大值及其位移
//                        （C12-metrics.py 口径）。**只在静止、同机位的截图之间比**，画面结构本身也贡献自相关
//   halo（DX-23，给了 --halo <参照图> 时）  光晕指标（泛化自 handoff/TM02-halo.py）：需要 --mask-image 是云
//                        不透明度图（≥ --mask-threshold 算云内），见 haloForRegion 注释
//   maskedPixels         被 --mask 排除、没计入以上统计的像素数
//
// --mask-image <图.png> [--mask-channel alpha|luma] [--mask-threshold 128] [--mask-labels 高组,低组]（DX-22）：
// 用另一张图（和被测图同分辨率）的某个通道当逐像素分组依据，把每个 --measure 区域拆成两组分别统计——
// 例如拿 云缓冲不透明度的可视化图当 mask-image，能分别看「云区」和「非云区」各自的 adjDiffDiag，不至于
// 两边数字混在一起把问题冲淡；或者拿手绘 / probe.mjs 读出的「窗外 vs 舱内」剪影图做 mask-image，只统计
// 窗外那一部分。channel 默认 luma（0.2126R+0.7152G+0.0722B），threshold 默认 128（≥ 阈值算 --mask-labels
// 第一个名字那组，默认 "high"，< 阈值算第二个，默认 "low"；例如 --mask-labels cloud,sky）。原有的（不分组）
// 那一行统计照常输出，分组结果作为**额外**的两行追加（group 字段标出是哪一组），不影响旧脚本按字段名读数。
// mask-image 分辨率必须和被测图完全一致（不受 --crop / --zoom 影响，和 --mask 矩形同一套坐标系），
// 不一致就跳过那张图的分组统计并打印警告，不中断其余图片。
// 默认打印成人读的表格；--json 时改成打印一份 JSON（数组，每张图每个区域一条）到 stdout，不额外写文件。
//
// --mask x,y,w,h（可重复，原图像素坐标，和 --measure / --diff 同一套坐标系）：这个矩形内的像素从
// --measure 与 --diff 的统计里排除（例如遮住调试面板残留的一角、水印、HUD 文字），不影响拼图 / 缩略图
// / --row / --col 本身的像素内容，只影响「算不算进统计」。
//
// --row y（可重复）/ --col x（可重复）：对每张输入图，取第 y 行（或第 x 列）的整条像素曲线，人读模式
// 只打印 min/max/mean（完整数组太长，终端读不动），--json 时打印完整的 { image, row, width, r, g, b,
// luma } 数组——找地平线附近的色带台阶、天空渐变有没有断层用。y/x 超出图片范围时该条记录标 error，
// 不影响其它条目。
//
// --thumb N：把每张输入图等比缩小到最长边 = N 像素（默认用双线性平滑，不是 --zoom 那种保留像素边界的
// 最近邻——缩略图是为了看整体剪影，平滑掉高频细节才是目的），写一张 PNG，文件名
// `<原文件名（不含扩展名）>.thumbN.png`，默认写在原图同目录，--thumb-out <目录> 改写到别处（相对仓库根
// 解析）。剪影误读检查：远景的云团 / 岛屿 / 建筑轮廓缩到几十像素后还能一眼认出「这是什么」，才说明轮廓
// 本身站得住，不是靠细节堆出来的（3A 铁律「宁可小，不要糊」的一个快速检验法）。
//
// 泛化自 handoff/T35-crop.py（Python + Pillow）。改用 Node + Canvas2D 是为了不依赖本机 Python
// 环境（仓库里 apps/roadmap/scripts 已经因为要装 shapely 踩过 Python 环境的坑，见根 AGENTS.md；
// voyage 这边除 check:glsl 外都是纯 Node 工具链，保持单一）。用一次性的 headless 页面（复用
// lib/chrome.mjs 的 launchBrowser）做合成：不需要真实 GPU（只用 Canvas2D，不碰 WebGL），
// 复用它只是为了共用「怎么找到本机 chrome.exe」这份逻辑，不用额外装 chrome-headless-shell。
//
// --out / --heatmap / --thumb-out 相对**仓库根**解析，不是当前工作目录，和 dev-browser.mjs 的 --out 一致
// （T08 开发体验反馈踩过这个坑：以为是相对当前目录，结果写到了仓库外面）。

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely, resolveRepoPath } from "./lib/chrome.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");

// 同名参数重复出现时合并成数组（--measure / --mask / --row / --col 都要能传多次；写法与
// dev-browser.mjs 的 parseArgs 一致）。--json 是纯开关（没有值），特殊处理：不然「--json 图1.png」
// 会把 图1.png 当成 --json 的值吃掉，剩下的位置参数（图片路径）就少了一个。
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

/** --measure / --mask 共用：x,y,w,h（可重复）解析成 { x, y, w, h } 数组；不传返回 [] */
function parseRegions(args, key) {
  if (!args[key]) return [];
  const list = Array.isArray(args[key]) ? args[key] : [args[key]];
  return list.map((s) => {
    const nums = String(s).split(",").map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
      throw new Error(`--${key} 格式应为 x,y,w,h（如 --${key} 400,300,200,150），收到 "${s}"`);
    }
    const [x, y, w, h] = nums;
    return { x, y, w, h };
  });
}

/** --row / --col 共用：一串数字（可重复），不传返回 [] */
function parseLines(args, key) {
  if (!args[key]) return [];
  const list = Array.isArray(args[key]) ? args[key] : [args[key]];
  return list.map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} 应为非负整数，收到 "${s}"`);
    return Math.round(n);
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

/** --thumb 输出路径：默认和原图同目录，--thumb-out 给了就改写到那个目录（相对仓库根解析） */
function thumbPathFor(imgPath, size, outDirArg) {
  const abs = path.isAbsolute(imgPath) ? imgPath : path.join(REPO_ROOT, imgPath);
  const { name, dir } = path.parse(abs);
  const targetDir = outDirArg ? resolveRepoPath(REPO_ROOT, outDirArg) : dir;
  return path.join(targetDir, `${name}.thumb${size}.png`);
}

function usage() {
  console.error("用法：node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1> [<图2> ...]");
  console.error("      node scripts/compare.mjs --measure x,y,w,h [--measure ...] [--mask x,y,w,h ...] [--mask-image 图.png [--mask-channel alpha|luma] [--mask-threshold 128] [--mask-labels cloud,sky]] [--json] <图1> [<图2> ...]");
  console.error("      node scripts/compare.mjs --diff <图2> [--threshold 8] [--heatmap 差异.png] [--mask x,y,w,h ...] [--json] <图1>");
  console.error("      node scripts/compare.mjs --row y [--row ...] [--col x ...] [--json] <图1> [<图2> ...]");
  console.error("      node scripts/compare.mjs --thumb 64 [--thumb-out 目录] [--json] <图1> [<图2> ...]");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const images = args._;
  const regions = parseRegions(args, "measure");
  const masks = parseRegions(args, "mask");
  const rows = parseLines(args, "row");
  const cols = parseLines(args, "col");
  const thumbSize = args.thumb !== undefined ? Number(args.thumb) : null;
  if (thumbSize !== null && (!Number.isFinite(thumbSize) || thumbSize <= 0)) throw new Error(`--thumb 应为正数，收到 "${args.thumb}"`);
  // --diff 的值是第二张图，第一张图是位置参数（见文件头注释，和 --out 同一个位置参数列表）
  const diffPair = args.diff ? [images[0], String(args.diff)] : null;
  if (args.diff && !images[0]) throw new Error("--diff 需要两张图：一张是 --diff 的值，另一张作为位置参数给出");
  if (images.length === 0 && !diffPair) {
    usage();
    process.exit(1);
  }
  const hasAnyAction = args.out || regions.length > 0 || diffPair || rows.length > 0 || cols.length > 0 || thumbSize !== null;
  if (!hasAnyAction) {
    usage();
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
  // --mask-image（DX-22）：用一张图的某个通道当逐像素分组依据（例如云缓冲的不透明度、或手绘的「窗外 / 舱内」
  // 剪影遮罩），把 --measure 的每个区域按这张图分成两组分别统计——不是从统计里整体排除（那是 --mask 矩形的
  // 语义），而是「云区一份、非云区一份」都要看，才知道横纹 / 交叉纹之类的问题是不是只出在云区（见文件头注释）。
  const maskImagePath = args["mask-image"] ? resolveRepoPath(REPO_ROOT, String(args["mask-image"])) : null;
  const maskChannel = args["mask-channel"] ? String(args["mask-channel"]) : "luma";
  if (maskImagePath && maskChannel !== "luma" && maskChannel !== "alpha") throw new Error(`--mask-channel 只接受 luma | alpha，收到 "${maskChannel}"`);
  const maskThreshold = args["mask-threshold"] !== undefined ? Number(args["mask-threshold"]) : 128;
  if (maskImagePath && (!Number.isFinite(maskThreshold) || maskThreshold < 0 || maskThreshold > 255)) throw new Error(`--mask-threshold 应为 0–255，收到 "${args["mask-threshold"]}"`);
  const maskLabelsRaw = args["mask-labels"] ? String(args["mask-labels"]).split(",") : ["high", "low"];
  if (maskLabelsRaw.length !== 2) throw new Error(`--mask-labels 应为两个用逗号分开的名字（如 cloud,sky），收到 "${args["mask-labels"]}"`);
  const [maskLabelHigh, maskLabelLow] = maskLabelsRaw;
  if (maskImagePath && !fs.existsSync(maskImagePath)) throw new Error(`--mask-image 找不到图片：${args["mask-image"]}`);
  const maskImageDataUrl = maskImagePath ? `data:image/png;base64,${fs.readFileSync(maskImagePath).toString("base64")}` : null;
  // --halo <参照图>（DX-23）：光晕指标，需要 --measure 区域与 --mask-image（云不透明度图），见 haloForRegion
  const haloPath = args.halo ? resolveRepoPath(REPO_ROOT, String(args.halo)) : null;
  if (haloPath && !fs.existsSync(haloPath)) throw new Error(`--halo 找不到参照图：${args.halo}`);
  if (haloPath && (!maskImagePath || regions.length === 0)) throw new Error("--halo 需要同时给 --measure 区域与 --mask-image（云不透明度图，≥ --mask-threshold 算云内）");
  const haloDataUrl = haloPath ? `data:image/png;base64,${fs.readFileSync(haloPath).toString("base64")}` : null;

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
    const { outDataUrl, measurements, diffStats, rowCurves, colCurves, thumbs, maskImageWarnings } = await page.evaluate(
      async ({ tiles, crop, zoom, outPath, regions, masks, rows, cols, thumbSize, diffTile, threshold, wantHeatmap, maskImageDataUrl, maskChannel, maskThreshold, maskLabelHigh, maskLabelLow, haloDataUrl }) => {
        const loadImg = (src) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("图片解码失败"));
            img.src = src;
          });
        const imgs = await Promise.all(tiles.map((t) => loadImg(t.dataUrl)));
        const haloImg = haloDataUrl ? await loadImg(haloDataUrl) : null;

        // --mask-image（DX-22）：只解码一次，取满分辨率的 luma 或 alpha 通道当分组依据，和 --measure 各图
        // 各自比对分辨率（不要求和 crop/zoom 一致，要求和原图本身同尺寸，因为分组坐标系是原图像素坐标）
        let maskImg = null;
        if (maskImageDataUrl) {
          const img = await loadImg(maskImageDataUrl);
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const raw = ctx.getImageData(0, 0, c.width, c.height).data;
          const chan = new Uint8ClampedArray(c.width * c.height);
          for (let p = 0, j = 0; j < chan.length; p += 4, j++) {
            chan[j] = maskChannel === "alpha" ? raw[p + 3] : Math.round(0.2126 * raw[p] + 0.7152 * raw[p + 1] + 0.0722 * raw[p + 2]);
          }
          maskImg = { width: c.width, height: c.height, chan };
        }

        // --mask：某个原图绝对像素坐标是否落在任意一个排除区里（DX-11，--measure / --diff 共用）
        const inAnyMask = (ax, ay) => masks.some((m) => ax >= m.x && ax < m.x + m.w && ay >= m.y && ay < m.y + m.h);

        // --mask-image（DX-22）：某个原图绝对像素坐标在 maskImg 上的通道值是否 ≥ 阈值（"high" 组，例如云缓冲
        // 不透明度高 = 云区；或窗外遮罩里「窗外」那一侧画得更亮）；< 阈值是 "low" 组。maskImg 为 null 时不用管
        // （调用方只在 maskImg 存在且分辨率匹配时才会用到这个函数）。
        const maskHighAt = (ax, ay) => maskImg.chan[ay * maskImg.width + ax] >= maskThreshold;

        // --measure（DX-07，DX-11 补齐平均 RGB / 饱和度 / 相邻像素差 / 亮暗像素比例；DX-22 补分方向高频
        // 指标与 --mask-image 分组统计）：按原图像素（不受 crop/zoom 影响）算每个区域的统计；--mask 命中的
        // 像素整体排除，不计入任何一项（--mask-image 分组时也一样先排除，两者是「与」的关系）。
        // extraTest(ax, ay)：--mask-image 分组用的额外筛选（null 表示不筛，即「全部」这一组，向后兼容原有行为）。
        function statsForRegion(img, r, extraTest) {
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
          const lum = new Float64Array(sw * sh);
          const included = new Uint8Array(sw * sh);
          let sumR = 0, sumG = 0, sumB = 0, sumSat = 0, nIncluded = 0, nBright = 0, nDark = 0;
          for (let ly = 0, j = 0, p = 0; ly < sh; ly++) {
            for (let lx = 0; lx < sw; lx++, j++, p += 4) {
              const rr = data[p];
              const gg = data[p + 1];
              const bb = data[p + 2];
              const l = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
              lum[j] = l;
              if (masks.length > 0 && inAnyMask(sx + lx, sy + ly)) continue; // included[j] 保持 0
              if (extraTest && !extraTest(sx + lx, sy + ly)) continue;
              included[j] = 1;
              nIncluded++;
              sumR += rr;
              sumG += gg;
              sumB += bb;
              const mx = Math.max(rr, gg, bb) / 255;
              const mn = Math.min(rr, gg, bb) / 255;
              const L = (mx + mn) / 2;
              sumSat += L === 0 || L === 1 ? 0 : (mx - mn) / (1 - Math.abs(2 * L - 1));
              if (l >= 250) nBright++;
              if (l <= 5) nDark++;
            }
          }
          const n = Math.max(1, nIncluded);
          const lumIncluded = [];
          for (let j = 0; j < lum.length; j++) if (included[j]) lumIncluded.push(lum[j]);
          lumIncluded.sort((a, b) => a - b);
          const mean = lumIncluded.length ? lumIncluded.reduce((a, b) => a + b, 0) / lumIncluded.length : 0;
          const p99 = lumIncluded.length ? lumIncluded[Math.min(lumIncluded.length - 1, Math.floor(0.99 * lumIncluded.length))] : 0;
          // 相邻像素差（棋盘纹 / 锯齿指标，DX-22 按方向拆开）：横（同一行，右邻）、纵（同一列，下邻）、
          // 对角（"\" 右下邻 + "/" 左下邻，两个方向合并平均——十字纹 / 菱形纹在横 / 纵上量不出来，只有对角
          // 方向的相邻差会明显偏高，DEV_SOP「测量约定」记过这条：交叉 / 菱形纹用对角高频量，相邻像素差
          // 量不出（与横纹此消彼长），此前只能靠 handoff/C03-hf.py 的 FFT 才能看到）；adjacentDiff 保留原来
          // 「横 + 纵各算一遍一起平均」的口径不变（向后兼容，历史场景 / 脚本都按这个数判断过棋盘纹）。
          // 两端有一个被排除（--mask 矩形或 --mask-image 分组）就跳过这一对，不让排除区边界人为拉高数字。
          let sumH = 0, nH = 0, sumV = 0, nV = 0, sumD = 0, nD = 0;
          for (let ly = 0; ly < sh; ly++) {
            for (let lx = 0; lx < sw; lx++) {
              const j = ly * sw + lx;
              if (!included[j]) continue;
              if (lx + 1 < sw && included[j + 1]) {
                sumH += Math.abs(lum[j] - lum[j + 1]);
                nH++;
              }
              if (ly + 1 < sh && included[j + sw]) {
                sumV += Math.abs(lum[j] - lum[j + sw]);
                nV++;
              }
              if (lx + 1 < sw && ly + 1 < sh && included[j + sw + 1]) {
                sumD += Math.abs(lum[j] - lum[j + sw + 1]); // "\"
                nD++;
              }
              if (lx - 1 >= 0 && ly + 1 < sh && included[j + sw - 1]) {
                sumD += Math.abs(lum[j] - lum[j + sw - 1]); // "/"
                nD++;
              }
            }
          }
          const nAdj = nH + nV;
          const sumAdjDiff = sumH + sumV;
          // DX-23：HSV 饱和度（(max−min)/max，C / TM 系列任务用的口径；上面的 meanSaturation 是 HSL，暗部会被放大）
          // 与 RGB max−min（绝对色度，0–255，暗部不放大）
          let sumHsv = 0, sumSpread = 0;
          for (let ly = 0, p = 0, j = 0; ly < sh; ly++) {
            for (let lx = 0; lx < sw; lx++, p += 4, j++) {
              if (!included[j]) continue;
              const mx = Math.max(data[p], data[p + 1], data[p + 2]);
              const mn = Math.min(data[p], data[p + 1], data[p + 2]);
              sumSpread += mx - mn;
              sumHsv += mx > 0 ? (mx - mn) / mx : 0;
            }
          }
          // DX-23：死白连通块（luma ≥ 250，4 邻域）——死白验收看「最大一块多大」，不是总面积（散点高光无害、成片才出戏）
          const seen = new Uint8Array(sw * sh);
          let blobs = 0, blobMax = 0;
          const stack = [];
          for (let j0 = 0; j0 < sw * sh; j0++) {
            if (seen[j0] || !included[j0] || lum[j0] < 250) continue;
            blobs++;
            let area = 0;
            stack.push(j0);
            seen[j0] = 1;
            while (stack.length) {
              const q = stack.pop();
              area++;
              const qx = q % sw, qy = (q - qx) / sw;
              for (const [nx, ny] of [[qx + 1, qy], [qx - 1, qy], [qx, qy + 1], [qx, qy - 1]]) {
                if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
                const nq = ny * sw + nx;
                if (!seen[nq] && included[nq] && lum[nq] >= 250) {
                  seen[nq] = 1;
                  stack.push(nq);
                }
              }
            }
            if (area > blobMax) blobMax = area;
          }
          // DX-23：斜纹指数（C12-metrics.py 口径）：高通残差 H = L − 3×3 盒平均，对 10 个位移（横、纵、两条对角、
          // 骑士步）求归一自相关，取最大值。噪声是白的 → 接近 0 或负；有方向性的斜纹 / 横纹 → 某个位移明显为正。
          // **只适用于静止、同机位的截图**（画面内容本身的结构也会贡献自相关，只能跨变体比，不能看绝对值）。
          let streak = null, streakShift = null;
          if (sw > 12 && sh > 12) {
            const Hh = new Float64Array(sw * sh);
            let hm = 0, hn = 0;
            for (let y = 1; y < sh - 1; y++)
              for (let x = 1; x < sw - 1; x++) {
                let s = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += lum[(y + dy) * sw + x + dx];
                const v = lum[y * sw + x] - s / 9;
                Hh[y * sw + x] = v;
                hm += v;
                hn++;
              }
            hm /= Math.max(1, hn);
            const inner = (x, y) => x >= 3 && y >= 3 && x < sw - 3 && y < sh - 3;
            let v0 = 0, n0 = 0;
            for (let y = 3; y < sh - 3; y++) for (let x = 3; x < sw - 3; x++) { const j = y * sw + x; if (!included[j]) continue; v0 += (Hh[j] - hm) ** 2; n0++; }
            v0 /= Math.max(1, n0);
            if (v0 > 0) {
              for (const [dy, dx] of [[0, 1], [1, 0], [1, 1], [1, -1], [1, 2], [2, 1], [1, -2], [2, -1], [2, 2], [2, -2]]) {
                let s = 0, n = 0;
                for (let y = 3; y < sh - 3; y++)
                  for (let x = 3; x < sw - 3; x++) {
                    const j = y * sw + x, x2 = x + dx, y2 = y + dy;
                    if (!inner(x2, y2) || !included[j] || !included[y2 * sw + x2]) continue;
                    s += (Hh[j] - hm) * (Hh[y2 * sw + x2] - hm);
                    n++;
                  }
                const ac = n ? s / n / v0 : 0;
                if (streak === null || ac > streak) { streak = ac; streakShift = `${dy},${dx}`; }
              }
            }
          }
          return {
            mean: +mean.toFixed(1),
            p99: +p99.toFixed(1),
            meanR: +(sumR / n).toFixed(1),
            meanG: +(sumG / n).toFixed(1),
            meanB: +(sumB / n).toFixed(1),
            meanSaturation: +((sumSat / n) * 100).toFixed(1),
            adjacentDiff: nAdj ? +(sumAdjDiff / nAdj).toFixed(2) : 0,
            adjDiffH: nH ? +(sumH / nH).toFixed(2) : 0,
            adjDiffV: nV ? +(sumV / nV).toFixed(2) : 0,
            adjDiffDiag: nD ? +(sumD / nD).toFixed(2) : 0,
            pctBright: +((nBright / n) * 100).toFixed(2),
            pctDark: +((nDark / n) * 100).toFixed(2),
            hsvSat: +((sumHsv / n) * 100).toFixed(2),
            rgbSpread: +(sumSpread / n).toFixed(2),
            blownBlobs: blobs,
            blownMaxArea: blobMax,
            streak: streak === null ? null : +streak.toFixed(4),
            streakShift,
            maskedPixels: lum.length - nIncluded,
          };
        }

        // --halo <参照图>（DX-23，泛化自 handoff/TM02-halo.py）：局部色调映射 / 泛光类改动的光晕指标。
        // 要求 --mask-image（云不透明度图：≥ --mask-threshold 算云内）。D = 本图 luma − 参照 luma；在离云边 ≥ 25 px 的
        // 云内部，按参照 luma（每 1 级一格，≥ 20 像素才算）取 D 的中位数得到「逐点曲线」f(L)，残差 R = D − f(L_ref)；
        // 近边各距离格（云内 1–2 / 3–4 / 5–8 / 9–16 / 17–24 px）R 的均值偏离内部均值就是光晕。
        //   haloAmp   = 各近边格 |R 均值 − 内部 R 均值| 的最大值（显示级 0–255）
        //   haloWidth = 该差 > 0.5 级的最远格外沿（px），0 = 无光晕
        //   skyD      = 云外 1–2 / 3–4 / 5–8 px 的 D 均值（门控为 0 的改动应为 0）
        function haloForRegion(img, refImg, r) {
          const W = img.naturalWidth, H = img.naturalHeight;
          const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
          const w = Math.min(r.w, W - x0), h = Math.min(r.h, H - y0);
          const lumOf = (im) => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const ctx = c.getContext("2d");
            ctx.drawImage(im, x0, y0, w, h, 0, 0, w, h);
            const d = ctx.getImageData(0, 0, w, h).data;
            const L = new Float64Array(w * h);
            for (let p = 0, j = 0; j < L.length; p += 4, j++) L[j] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
            return L;
          };
          const F = lumOf(img), R0 = lumOf(refImg);
          const cloud = new Uint8Array(w * h), sky = new Uint8Array(w * h);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const hi = maskHighAt(x0 + x, y0 + y);
              cloud[y * w + x] = hi ? 1 : 0;
              sky[y * w + x] = hi ? 0 : 1;
            }
          const distIn = (m, cap) => {
            const d = new Uint8Array(w * h);
            let cur = m.slice();
            for (let i = 1; i <= cap; i++) {
              let any = false;
              const nxt = new Uint8Array(w * h);
              for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                  const j = y * w + x;
                  if (!cur[j]) continue;
                  d[j] = i;
                  const ok = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? cur[j] : cur[yy * w + xx]);
                  if (ok(x - 1, y) && ok(x + 1, y) && ok(x, y - 1) && ok(x, y + 1)) { nxt[j] = 1; any = true; }
                }
              cur = nxt;
              if (!any) break;
            }
            for (let j = 0; j < d.length; j++) if (cur[j]) d[j] = cap;
            return d;
          };
          const din = distIn(cloud, 25), dout = distIn(sky, 25);
          const D = new Float64Array(w * h);
          for (let j = 0; j < D.length; j++) D[j] = F[j] - R0[j];
          const byKey = Array.from({ length: 256 }, () => []);
          for (let j = 0; j < D.length; j++) if (din[j] >= 25) byKey[Math.min(255, Math.max(0, Math.round(R0[j])))].push(D[j]);
          const have = [], fv = new Float64Array(256);
          for (let k = 0; k < 256; k++) {
            if (byKey[k].length >= 20) {
              const s = byKey[k].sort((a, b) => a - b);
              fv[k] = s[Math.floor(s.length / 2)];
              have.push(k);
            }
          }
          if (have.length === 0) return { error: "云内部（离边 ≥ 25 px）像素太少，算不了光晕（检查 --mask-image / --mask-threshold）" };
          for (let k = 0; k < 256; k++) {
            if (byKey[k].length >= 20) continue;
            let lo = null, hi = null;
            for (const q of have) { if (q < k) lo = q; else if (hi === null && q > k) hi = q; }
            fv[k] = lo === null ? fv[hi] : hi === null ? fv[lo] : fv[lo] + ((fv[hi] - fv[lo]) * (k - lo)) / (hi - lo);
          }
          const Rr = new Float64Array(D.length);
          let base = 0, nb = 0;
          for (let j = 0; j < D.length; j++) {
            Rr[j] = D[j] - fv[Math.min(255, Math.max(0, Math.round(R0[j])))];
            if (din[j] >= 25) { base += Rr[j]; nb++; }
          }
          base /= Math.max(1, nb);
          const BINS = [[1, 2], [3, 4], [5, 8], [9, 16], [17, 24]];
          const cells = [];
          let amp = 0, width = 0;
          for (const [a, b] of BINS) {
            let s = 0, n = 0;
            for (let j = 0; j < D.length; j++) if (din[j] >= a && din[j] <= b) { s += Rr[j]; n++; }
            const v = n > 200 ? s / n : null;
            cells.push(v === null ? null : +v.toFixed(2));
            if (v !== null) {
              amp = Math.max(amp, Math.abs(v - base));
              if (Math.abs(v - base) > 0.5) width = Math.max(width, b);
            }
          }
          const skyD = BINS.slice(0, 3).map(([a, b]) => {
            let s = 0, n = 0;
            for (let j = 0; j < D.length; j++) if (dout[j] >= a && dout[j] <= b) { s += D[j]; n++; }
            return n > 200 ? +(s / n).toFixed(2) : null;
          });
          return { haloAmp: +amp.toFixed(2), haloWidth: width, innerR: +base.toFixed(2), cloudBins: cells, skyD };
        }

        const maskImageWarnings = [];
        const measurements = [];
        if (regions.length > 0) {
          for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            for (const r of regions) {
              const base = statsForRegion(img, r, null);
              let halo = null;
              if (haloImg) {
                if (!maskImg || maskImg.width !== img.naturalWidth || maskImg.height !== img.naturalHeight) halo = { error: "--halo 需要和本图同尺寸的 --mask-image（云不透明度图）" };
                else if (haloImg.naturalWidth !== img.naturalWidth || haloImg.naturalHeight !== img.naturalHeight) halo = { error: "--halo 参照图尺寸与本图不同" };
                else halo = haloForRegion(img, haloImg, r);
              }
              measurements.push({
                image: tiles[i].label,
                region: { x: r.x, y: r.y, w: r.w, h: r.h },
                ...base,
                ...(halo ? { halo } : {}),
              });
              if (maskImg) {
                if (maskImg.width !== img.naturalWidth || maskImg.height !== img.naturalHeight) {
                  maskImageWarnings.push(`${tiles[i].label}：--mask-image 分辨率 ${maskImg.width}x${maskImg.height} 与该图 ${img.naturalWidth}x${img.naturalHeight} 不一致，跳过这张图的分组统计`);
                } else {
                  const high = statsForRegion(img, r, (ax, ay) => maskHighAt(ax, ay));
                  const low = statsForRegion(img, r, (ax, ay) => !maskHighAt(ax, ay));
                  measurements.push({ image: tiles[i].label, region: { x: r.x, y: r.y, w: r.w, h: r.h }, group: maskLabelHigh, ...high });
                  measurements.push({ image: tiles[i].label, region: { x: r.x, y: r.y, w: r.w, h: r.h }, group: maskLabelLow, ...low });
                }
              }
            }
          }
        }
        // --row / --col（DX-11）：整条像素曲线，找地平线 / 天空渐变的色带台阶
        const rowCurves = [];
        const colCurves = [];
        const sampleLine = (img, fixed, isRow) => {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          const inRange = isRow ? fixed >= 0 && fixed < h : fixed >= 0 && fixed < w;
          if (!inRange) return { error: `超出范围（图片 ${w}x${h}）` };
          const len = isRow ? w : h;
          const c = document.createElement("canvas");
          c.width = isRow ? w : 1;
          c.height = isRow ? 1 : h;
          const ctx = c.getContext("2d");
          if (isRow) ctx.drawImage(img, 0, fixed, w, 1, 0, 0, w, 1);
          else ctx.drawImage(img, fixed, 0, 1, h, 0, 0, 1, h);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          const r = new Array(len);
          const g = new Array(len);
          const b = new Array(len);
          const luma = new Array(len);
          for (let k = 0, p = 0; k < len; k++, p += 4) {
            r[k] = data[p];
            g[k] = data[p + 1];
            b[k] = data[p + 2];
            luma[k] = +(0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]).toFixed(1);
          }
          return { width: len, r, g, b, luma };
        };
        for (const y of rows) {
          for (let i = 0; i < imgs.length; i++) rowCurves.push({ image: tiles[i].label, row: y, ...sampleLine(imgs[i], y, true) });
        }
        for (const x of cols) {
          for (let i = 0; i < imgs.length; i++) colCurves.push({ image: tiles[i].label, col: x, ...sampleLine(imgs[i], x, false) });
        }

        // --thumb（DX-11）：等比缩小到最长边 = thumbSize，双线性平滑（和 --zoom 的最近邻相反——
        // 这里就是要糊掉细节，只看剪影读不读得出来）
        const thumbs = [];
        if (thumbSize) {
          for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            const scale = thumbSize / Math.max(img.naturalWidth, img.naturalHeight);
            const tw = Math.max(1, Math.round(img.naturalWidth * scale));
            const th = Math.max(1, Math.round(img.naturalHeight * scale));
            const c = document.createElement("canvas");
            c.width = tw;
            c.height = th;
            const ctx = c.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, 0, 0, tw, th);
            thumbs.push({ image: tiles[i].label, width: tw, height: th, dataUrl: c.toDataURL("image/png") });
          }
        }

        // --diff：逐像素 |ΔR|+|ΔG|+|ΔB| / 3（0–255），输出均值 / p99 / 超阈值像素比例，可选差异热图；
        // --mask 命中的像素整体排除（DX-11），热图里画成灰色标出「这块不算」
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
          let m = 0; // 计入统计的像素数（排除 mask 命中的）
          let over = 0;
          let masked = 0;
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
            const y = Math.floor(i / w);
            const x = i - y * w;
            const isMasked = masks.length > 0 && inAnyMask(x, y);
            const d = (Math.abs(dataA[p] - dataB[p]) + Math.abs(dataA[p + 1] - dataB[p + 1]) + Math.abs(dataA[p + 2] - dataB[p + 2])) / 3;
            if (isMasked) masked++;
            else {
              diffs[m++] = d;
              if (d > threshold) over++;
            }
            if (wantHeatmap) {
              if (isMasked) {
                heatImgData.data[p] = heatImgData.data[p + 1] = heatImgData.data[p + 2] = 96; // 灰：排除区
                heatImgData.data[p + 3] = 255;
              } else {
                // 假彩色：0 = 黑，阈值处过渡到黄，2 倍阈值封顶到红——超过阈值的差异比线性满量程灰度显眼得多
                const t = threshold > 0 ? Math.min(1, d / threshold) : d > 0 ? 1 : 0;
                const t2 = threshold > 0 ? Math.min(1, Math.max(0, (d - threshold) / threshold)) : 0;
                heatImgData.data[p] = Math.round(255 * Math.min(1, t + t2));
                heatImgData.data[p + 1] = Math.round(255 * Math.max(0, t - t2));
                heatImgData.data[p + 2] = 0;
                heatImgData.data[p + 3] = 255;
              }
            }
          }
          const sorted = Float64Array.from(diffs.subarray(0, m)).sort();
          const mean = m ? diffs.subarray(0, m).reduce((a, b) => a + b, 0) / m : 0;
          const p99 = m ? sorted[Math.min(m - 1, Math.floor(0.99 * m))] : 0;
          const max = m ? sorted[m - 1] : 0;
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
            overThresholdPct: +((over / Math.max(1, m)) * 100).toFixed(3),
            maskedPixels: masked,
            heatDataUrl,
          };
        }

        if (!outPath) return { outDataUrl: null, measurements, diffStats, rowCurves, colCurves, thumbs, maskImageWarnings };

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
        return { outDataUrl: final.toDataURL("image/png"), measurements, diffStats, rowCurves, colCurves, thumbs, maskImageWarnings };
      },
      { tiles, crop, zoom, outPath, regions, masks, rows, cols, thumbSize, diffTile, threshold, wantHeatmap: !!heatmapPath, maskImageDataUrl, maskChannel, maskThreshold, maskLabelHigh, maskLabelLow, haloDataUrl },
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
        console.log(`[compare] 亮度 / 色彩（0–255，饱和度 / 比例 0–100%）：`);
        for (const m of measurements) {
          console.log(
            `  ${m.image}${m.group ? `[${m.group}]` : ""}  region=${m.region.x},${m.region.y},${m.region.w},${m.region.h}  luma mean=${m.mean} p99=${m.p99}  ` +
              `RGB=(${m.meanR},${m.meanG},${m.meanB})  sat=${m.meanSaturation}  adjDiff=${m.adjacentDiff}（横${m.adjDiffH}/纵${m.adjDiffV}/对角${m.adjDiffDiag}）  ` +
              `bright≥250=${m.pctBright}%  dark≤5=${m.pctDark}%${m.maskedPixels ? `  masked=${m.maskedPixels}` : ""}`,
          );
          console.log(
            `      HSV 饱和=${m.hsvSat}%  RGB max−min=${m.rgbSpread}  死白连通块 ${m.blownBlobs} 个 / 最大 ${m.blownMaxArea} px  斜纹指数=${m.streak ?? "n/a"}（位移 ${m.streakShift ?? "-"}，只在静止同机位间比）`,
          );
          if (m.halo) {
            console.log(
              m.halo.error
                ? `      光晕：${m.halo.error}`
                : `      光晕 幅度=${m.halo.haloAmp} 宽度=${m.halo.haloWidth}px  云内近边 R [1–2,3–4,5–8,9–16,17–24]=${JSON.stringify(m.halo.cloudBins)} 内部 R=${m.halo.innerR}  云外 D=${JSON.stringify(m.halo.skyD)}`,
            );
          }
        }
      }
    }
    if (maskImageWarnings && maskImageWarnings.length > 0) {
      for (const w of maskImageWarnings) console.warn(`[compare] --mask-image 警告：${w}`);
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
        console.log(`  超过阈值的像素：${printable.overThresholdPixels}（${printable.overThresholdPct}%）${printable.maskedPixels ? `，排除区 ${printable.maskedPixels} 像素` : ""}`);
        if (heatmapPath) console.log(`  差异热图：${path.relative(REPO_ROOT, heatmapPath).replace(/\\/g, "/")}`);
      }
    }
    if (rowCurves.length > 0 || colCurves.length > 0) {
      if (args.json) {
        console.log(JSON.stringify({ rows: rowCurves, cols: colCurves }, null, 2));
      } else {
        console.log(`[compare] 像素曲线（完整数据用 --json）：`);
        for (const c of [...rowCurves, ...colCurves]) {
          const label = "row" in c ? `row=${c.row}` : `col=${c.col}`;
          if (c.error) {
            console.log(`  ${c.image}  ${label}  ${c.error}`);
            continue;
          }
          const min = Math.min(...c.luma);
          const max = Math.max(...c.luma);
          const mean = c.luma.reduce((a, b) => a + b, 0) / c.luma.length;
          console.log(`  ${c.image}  ${label}  宽 ${c.width}  luma min=${min.toFixed(1)} max=${max.toFixed(1)} mean=${mean.toFixed(1)}`);
        }
      }
    }
    if (thumbs && thumbs.length > 0) {
      const thumbResults = thumbs.map((t, i) => {
        const outP = thumbPathFor(images[i], thumbSize, args["thumb-out"]);
        fs.mkdirSync(path.dirname(outP), { recursive: true });
        fs.writeFileSync(outP, Buffer.from(t.dataUrl.split(",")[1], "base64"));
        const rel = path.relative(REPO_ROOT, outP).replace(/\\/g, "/");
        console.log(`[compare] 缩略图 ${rel}（${t.width}x${t.height}）`);
        return { image: t.image, width: t.width, height: t.height, path: rel };
      });
      if (args.json) console.log(JSON.stringify(thumbResults, null, 2));
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
