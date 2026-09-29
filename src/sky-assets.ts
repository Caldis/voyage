import * as THREE from "three";

/**
 * 夜空的数据资源：
 * - 星表格子：public/data/bsc5.json（耶鲁亮星表，由 scripts/build_stars.py 生成）按 J2000 赤道坐标放进「每格最多一颗星」的格子（RGB，
 *   格式见 buildStarMap；T41 前是溅射成辐亮度的等距柱状图，星点被放大成方块）
 * - 银河（T09）：public/data/milkyway_4k.jpg（NASA SVS Deep Star Maps 2020 的「milkyway」图，只含比约 11.5 等更暗的
 *   Gaia DR2 星的积分光，由 scripts/build_milkyway.py 生成），解码后放进同一张图的 A 通道——窗外程序的 sampler 已满 16/16，
 *   不能再加纹理；A 通道原来空着，和点星共用一次采样。图里没有亮星，和 BSC5 的点星不会重复成「双重星」。
 *   6.5–11.5 等之间的星两边都没有（肉眼看不见单颗，积分光在银河带外约占一半，带内是少数），已知偏差见 handoff/T09.md。
 * - 月面：public/data/moon_2k.jpg（Solar System Scope，CC BY 4.0，基于 NASA LRO 数据）
 */

const STAR_MAP_W = 4096;
const STAR_MAP_H = 2048;
/** milkyway_4k.jpg 的对数编码下限（和 build_milkyway.py 的 LOG_MIN 一致）：code 1..255 ↔ log10(亮度) ∈ [LOG_MIN, 0] */
const MILKY_WAY_LOG_MIN = -3.5;

/**
 * 解码银河图，返回按星图行序（第 0 行 = 赤纬 −90°）排好的相对亮度（原图单位 0..1，绝对定标在 stars.glsl.ts 的 MILKY_WAY_UNIT）。
 * 8 位对数编码一级约 3%：解码时加 ±半级的确定性抖动，免得平滑的星云边缘出现等高线（同一张图每次加载都一样，截图可对比）。
 * 取不到就返回 null（没有银河，其它照常）。
 */
async function loadMilkyWay(): Promise<Float32Array | null> {
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}data/milkyway_4k.jpg`);
    if (!resp.ok) return null;
    // 灰度 JPEG 不做色彩管理，原样拿到编码值
    const bmp = await createImageBitmap(await resp.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    if (bmp.width !== STAR_MAP_W || bmp.height !== STAR_MAP_H) return null;
    const c = document.createElement("canvas");
    c.width = STAR_MAP_W;
    c.height = STAR_MAP_H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = ctx.getImageData(0, 0, STAR_MAP_W, STAR_MAP_H).data;
    const out = new Float32Array(STAR_MAP_W * STAR_MAP_H);
    const step = -MILKY_WAY_LOG_MIN / 254;
    let seed = 0x9e3779b9;
    for (let y = 0; y < STAR_MAP_H; y++) {
      const row = (STAR_MAP_H - 1 - y) * STAR_MAP_W; // 图片上北下南，星图第 0 行是南天极
      for (let x = 0; x < STAR_MAP_W; x++) {
        const code = px[(y * STAR_MAP_W + x) * 4];
        // xorshift32，每个像素一个 [-0.5, 0.5) 的抖动
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        if (code === 0) continue;
        const jitter = (seed >>> 0) / 4294967296 - 0.5;
        out[row + x] = Math.pow(10, MILKY_WAY_LOG_MIN + (code - 1 + jitter) * step);
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 星表格子的每行格数（T41）：第 j 行（赤纬带）按「靠极点那条边」的纬圈长度分格，使每一格在赤经方向的张角都不小于
 * 赤纬方向的一格（π / 2048 ≈ 5.3′），着色器查 3×3 个邻格就一定能找全核半径内的星。最多 4095 格，第 4096 个 texel 空出来存本行格数。
 */
export function starRowCells(j: number) {
  const decEdge = Math.max(Math.abs(j / STAR_MAP_H - 0.5), Math.abs((j + 1) / STAR_MAP_H - 0.5)) * Math.PI;
  return Math.min(STAR_MAP_W - 1, Math.max(1, Math.floor(STAR_MAP_W * Math.cos(decEdge))));
}

export async function buildStarMap(): Promise<THREE.DataTexture> {
  const milkyWayJob = loadMilkyWay();
  const stars: [number, number, number, number][] = await (
    await fetch(`${import.meta.env.BASE_URL}data/bsc5.json`)
  ).json();
  // T41：点星不再溅射成辐亮度图（一个 texel 5.3′ ≈ 2 个屏幕像素，双线性放大后是菱形 / 方块，高赤纬处被拉成短划线），
  // 改成「每格最多一颗星」的星表格子：R = 照度（klux × 1e12，6.5 等 ≈ 6.5、天狼星 ≈ 9800），G = 格内位置（32 × 32 级，qx + 32·qy），
  // B = B−V 色指数。着色器按屏幕像素对星点做解析的点扩散积分（stars.glsl.ts）。格子是「每行格数随赤纬减少」的等面积近似，
  // 每行格数存在该行最后一个 texel（G = 高 6 位、B = 低 6 位，半精度只精确到 2048 的整数）。
  // 同一格里撞上两颗星（相距 < 5′，肉眼也分不开）就合并：照度相加、位置和色指数按照度加权。
  const cells = new Float32Array(STAR_MAP_W * STAR_MAP_H * 4); // 累加：照度、Σe·x、Σe·y、Σe·bv
  let merged = 0;
  for (const [ra, dec, vmag, bv] of stars) {
    // 大气层外的照度：E = 10^(−0.4(m + 13.98)) lux，换成 klux
    const e = Math.pow(10, -0.4 * (vmag + 13.98)) * 1e-3;
    const fy = (0.5 + dec / 180) * STAR_MAP_H;
    const j = Math.min(Math.max(Math.floor(fy), 0), STAR_MAP_H - 1);
    const n = starRowCells(j);
    const fx = (((ra / 360) % 1) + 1) % 1 * n;
    const i = Math.min(Math.floor(fx), n - 1);
    const k = (j * STAR_MAP_W + i) * 4;
    if (cells[k] > 0) merged++;
    cells[k] += e;
    cells[k + 1] += e * (fx - i);
    cells[k + 2] += e * Math.min(Math.max(fy - j, 0), 1);
    cells[k + 3] += e * bv;
  }
  if (merged) console.info(`[星表] ${merged} 颗星与同格的星合并（相距 < 5′）`);
  // A 存银河的相对亮度（0..1，最暗处约 3e-4，半精度的正规数够用）
  const milkyWay = await milkyWayJob;
  const half = new Uint16Array(cells.length);
  for (let p = 0; p < STAR_MAP_W * STAR_MAP_H; p++) {
    const k = p * 4;
    const e = cells[k];
    let r = 0;
    let g = 0;
    let b = 0;
    if (e > 0) {
      const qx = Math.min(31, Math.floor((cells[k + 1] / e) * 32));
      const qy = Math.min(31, Math.floor((cells[k + 2] / e) * 32));
      r = Math.min(e * 1e12, 65000);
      g = qx + 32 * qy;
      b = cells[k + 3] / e;
    }
    if (p % STAR_MAP_W === STAR_MAP_W - 1) {
      const n = starRowCells((p / STAR_MAP_W) | 0);
      r = 0;
      g = n >> 6;
      b = n & 63;
    }
    half[k] = THREE.DataUtils.toHalfFloat(r);
    half[k + 1] = THREE.DataUtils.toHalfFloat(g);
    half[k + 2] = THREE.DataUtils.toHalfFloat(b);
    half[k + 3] = THREE.DataUtils.toHalfFloat(milkyWay ? milkyWay[p] : 0);
  }
  const tex = new THREE.DataTexture(half, STAR_MAP_W, STAR_MAP_H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function loadMoonTexture(): THREE.Texture {
  const tex = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}data/moon_2k.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
