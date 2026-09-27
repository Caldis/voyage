/**
 * G07：clipmap 影像 / 水体纹理的 mip 链在 Worker 里按层生成（road-raster.ts 的 buildGroundLevel 末尾调用）。
 *
 * 为什么不用 gl.generateMipmap：它作用于整个 TEXTURE_2D_ARRAY——每传一层就把 7 层 × 12 级全部重算一遍（6 层白做），
 * 2048² 时一次约 2 × 7 × 21 MB 的 GPU 活，G06 实测 1× 巡航 2 分钟有 7–11 帧 > 16.7 ms（主线程空闲、在 GPU 侧），集显上会成倍放大。
 * 现在 Worker 里只算这一层的 mip，主线程按层、按级 texSubImage3D（clipmap.ts 的 uploadDirect），不再调 generateMipmap。
 *
 * 滤波：2×2 盒滤波（和 D3D11 GenerateMips 对 2 的幂尺寸的做法一致），逐级从上一级的浮点结果往下算（不在每级量化后再平均，误差不累积）。
 * - 影像（SRGBColorSpace）：RGB 先解码到线性再平均、再编码回 sRGB（GPU 对 sRGB 纹理生成 mip 也是在线性空间做）。
 * - 水体（线性 RGBA8：R 水面、G 海洋、B 夜光）：RGB 直接平均。
 *
 * A 通道（两张纹理的 A 都是编码值，见 README 速查表「影像 A 通道语义」）：着色器里读 A 的编码（道路照亮宽度 / 有向距离）
 * 一律 textureLod(…, 0.0) 只读第 0 级；mip 级的 A 只需要「编码合法、且对唯一会读到 mip A 的地方有意义」：
 * - 影像：唯一读 mip A 的是 groundSampleAniso 的缺瓦片回退 `min(A·2, 1)`（= 有影像的比例）。第 0 级每个纹素先解码成
 *   有影像比例 c（A ≥ 128 → 1，否则 A·2/255），逐级平均；编码回去时 c = 1 写 128（「有影像、照亮宽度 0」，合法），
 *   c < 1 写 round(c·127.5) 且不超过 127（「缺影像比例 / 2」）。这样 min(A·2, 1) 在 mip 上恰好是覆盖比例，
 *   不再像 GPU 平均那样把「有路纹素 A ≈ 1」混进来抬高（G06 审查 §4 记的偏差），而误读成宽度时得到的是 0（不亮）。
 * - 水体：mip 的 A 没有人读，一律写 255（有向距离 +ROAD_SD_RANGE =「附近没有路」，合法）。
 */

/** sRGB 8 位 → 线性 */
const SRGB_TO_LIN = new Float32Array(256).map((_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** 线性 → sRGB 8 位的查表（线性按 1/65535 量化；最暗端一级 sRGB 约对应 20 个表项，精度够） */
const LIN_STEPS = 65535;
let linToSrgb: Uint8Array | null = null;
function linToSrgbTable() {
  if (linToSrgb) return linToSrgb;
  const t = new Uint8Array(LIN_STEPS + 1);
  for (let i = 0; i <= LIN_STEPS; i++) {
    const l = i / LIN_STEPS;
    const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
    t[i] = Math.round(Math.min(Math.max(s, 0), 1) * 255);
  }
  return (linToSrgb = t);
}

/** 第 1 级到最后一级（1×1）的总字节数（RGBA8） */
export function mipChainBytes(res: number) {
  let n = 0;
  for (let w = res >> 1; w >= 1; w >>= 1) n += w * w * 4;
  return n;
}

/**
 * 生成第 1 级到 1×1 的 mip，按级连续放在一个 Uint8Array 里（第 L 级的起点 = 前面各级 (res>>l)²·4 之和）。
 * kind：albedo（sRGB，A = 有影像比例）/ water（线性，A = 255）
 */
export function buildMipChain(px: Uint8ClampedArray, res: number, kind: "albedo" | "water"): Uint8Array {
  const out = new Uint8Array(mipChainBytes(res));
  const srgb = kind === "albedo";
  const enc = srgb ? linToSrgbTable() : null;
  // 第 1 级直接从第 0 级的 8 位像素解码（线性 RGB + 覆盖比例）并平均，之后每级从上一级的浮点结果平均。
  // 不先把第 0 级整个转成浮点：2048² × 4 个 float 是 64 MB 的临时缓冲
  const cov0 = (a: number) => (a >= 128 ? 1 : (a * 2) / 255);
  let w = res;
  let cur: Float32Array | null = null;
  let off = 0;
  while (w > 1) {
    const h = w >> 1;
    const next = new Float32Array(h * h * 4);
    for (let y = 0; y < h; y++) {
      const r0 = 2 * y * w, r1 = r0 + w;
      for (let x = 0; x < h; x++) {
        const a = (r0 + 2 * x) * 4, b = a + 4, c = (r1 + 2 * x) * 4, d = c + 4;
        const o = (y * h + x) * 4;
        if (cur) {
          next[o] = 0.25 * (cur[a] + cur[b] + cur[c] + cur[d]);
          next[o + 1] = 0.25 * (cur[a + 1] + cur[b + 1] + cur[c + 1] + cur[d + 1]);
          next[o + 2] = 0.25 * (cur[a + 2] + cur[b + 2] + cur[c + 2] + cur[d + 2]);
          next[o + 3] = 0.25 * (cur[a + 3] + cur[b + 3] + cur[c + 3] + cur[d + 3]);
        } else if (srgb) {
          const L = SRGB_TO_LIN;
          next[o] = 0.25 * (L[px[a]] + L[px[b]] + L[px[c]] + L[px[d]]);
          next[o + 1] = 0.25 * (L[px[a + 1]] + L[px[b + 1]] + L[px[c + 1]] + L[px[d + 1]]);
          next[o + 2] = 0.25 * (L[px[a + 2]] + L[px[b + 2]] + L[px[c + 2]] + L[px[d + 2]]);
          next[o + 3] = 0.25 * (cov0(px[a + 3]) + cov0(px[b + 3]) + cov0(px[c + 3]) + cov0(px[d + 3]));
        } else {
          next[o] = 0.25 * (px[a] + px[b] + px[c] + px[d]);
          next[o + 1] = 0.25 * (px[a + 1] + px[b + 1] + px[c + 1] + px[d + 1]);
          next[o + 2] = 0.25 * (px[a + 2] + px[b + 2] + px[c + 2] + px[d + 2]);
        }
      }
    }
    // 量化写出这一级
    const n = h * h;
    if (enc) {
      for (let i = 0; i < n; i++) {
        const i4 = i * 4, q = off + i4;
        out[q] = enc[Math.round(next[i4] * LIN_STEPS)];
        out[q + 1] = enc[Math.round(next[i4 + 1] * LIN_STEPS)];
        out[q + 2] = enc[Math.round(next[i4 + 2] * LIN_STEPS)];
        const cov = next[i4 + 3];
        out[q + 3] = cov >= 1 - 1e-6 ? 128 : Math.min(127, Math.round(cov * 127.5));
      }
    } else {
      for (let i = 0; i < n; i++) {
        const i4 = i * 4, q = off + i4;
        out[q] = Math.round(next[i4]);
        out[q + 1] = Math.round(next[i4 + 1]);
        out[q + 2] = Math.round(next[i4 + 2]);
        out[q + 3] = 255;
      }
    }
    off += n * 4;
    cur = next;
    w = h;
  }
  return out;
}
