import * as THREE from "three";

/**
 * 夜空的数据资源：
 * - 星图：public/data/bsc5.json（耶鲁亮星表，由 scripts/build_stars.py 生成）溅射成 J2000 赤道坐标的等距柱状 HDR 图（RGB）
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
    const resp = await fetch("data/milkyway_4k.jpg");
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

/** B−V 色指数 → 色温（Ballesteros 2012） */
function bvToKelvin(bv: number) {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/** 色温 → 线性 sRGB（黑体近似，Tanner Helland 拟合），按亮度归一到 1 */
function kelvinToRgb(k: number): [number, number, number] {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.7 * Math.pow(t - 60, -0.1332);
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * Math.pow(t - 60, -0.0755);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  const lin = (c: number) => {
    const s = Math.min(Math.max(c, 0), 255) / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const rgb: [number, number, number] = [lin(r), lin(g), lin(b)];
  const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [rgb[0] / y, rgb[1] / y, rgb[2] / y];
}

export async function buildStarMap(): Promise<THREE.DataTexture> {
  const milkyWayJob = loadMilkyWay();
  const stars: [number, number, number, number][] = await (await fetch("data/bsc5.json")).json();
  const acc = new Float32Array(STAR_MAP_W * STAR_MAP_H * 4);
  const dLon = (2 * Math.PI) / STAR_MAP_W;
  const dLat = Math.PI / STAR_MAP_H;
  for (const [ra, dec, vmag, bv] of stars) {
    // 大气层外的照度：E = 10^(−0.4(m + 13.98)) lux，换成 klux
    const e = Math.pow(10, -0.4 * (vmag + 13.98)) * 1e-3;
    const color = kelvinToRgb(bvToKelvin(bv));
    const fx = (ra / 360) * STAR_MAP_W - 0.5;
    const fy = (0.5 + dec / 180) * STAR_MAP_H - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    // 双线性溅射到四个像素，采样时再线性过滤，星点位置和亮度都连续
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= 1; i++) {
        const w = (i ? fx - x0 : 1 - (fx - x0)) * (j ? fy - y0 : 1 - (fy - y0));
        const x = (((x0 + i) % STAR_MAP_W) + STAR_MAP_W) % STAR_MAP_W;
        const y = Math.min(Math.max(y0 + j, 0), STAR_MAP_H - 1);
        const lat = ((y + 0.5) / STAR_MAP_H - 0.5) * Math.PI;
        const omega = dLon * dLat * Math.max(Math.cos(lat), 1e-3); // 这个像素的立体角
        const radiance = (e * w) / omega;
        const k = (y * STAR_MAP_W + x) * 4;
        acc[k] += radiance * color[0];
        acc[k + 1] += radiance * color[1];
        acc[k + 2] += radiance * color[2];
      }
    }
  }
  // RGB 存 ×1e4 的值，半精度浮点才装得下 6.5 等的暗星；A 存银河的相对亮度（0..1，最暗处约 3e-4，半精度的正规数够用）
  const milkyWay = await milkyWayJob;
  const half = new Uint16Array(acc.length);
  for (let k = 0; k < acc.length; k++) {
    half[k] = THREE.DataUtils.toHalfFloat(k % 4 === 3 ? (milkyWay ? milkyWay[k >> 2] : 0) : Math.min(acc[k] * 1e4, 65000));
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
  const tex = new THREE.TextureLoader().load("data/moon_2k.jpg");
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
