/**
 * 高清细节合成（G03）：「细节取高清源（国土地理院航拍），低频色调取 EOX」，在地面栅格化 Worker 里做（road-raster.ts 的 buildGroundLevel 调用）。
 *
 * 为什么不直接贴航拍：
 * - 色调：GSI 在 z14 偏灰、偏亮（实测平均 sRGB 约 (118,124,117)，EOX 约 (75,83,64)），不同航拍批次之间有直线拼接缝和色调跳变；
 *   直接换源在第 1 / 2 级交界处会出现一圈色差。
 * - 分类阈值：`landClasses`、城市灯点、路灯的聚落地毯（`urbanOf`）都是按 EOX 的色调定的（research/IMAGERY.md §3.2），
 *   色调一变，大片农田会被判成城区。
 * 做法（频率分离，只改 RGB，A 通道不碰——A 的缺影像比例 / 道路照亮宽度编码由之后的 packRoads 照旧写）：
 *   E_low、H_low = 两张图按覆盖率加权的低通（两遍盒滤波，σ ≈ 3.7 纹素，第 0 级约 30 m）；
 *   细节比 d = 1 + K·(H / H_low − 1)（逐通道，线性空间，夹到 [D_MIN, D_MAX]）；
 *   out = mix(E, E_low · d, m)。
 *   这样一片区域的平均色仍是 EOX 的（分类、灯点判据不变），30 m 以下的纹理来自航拍。
 * 权重 m（写成「这里用不用细节」，不改缺影像语义）：
 * - 高清瓦片缺失（404 / 没取到）：0；EOX 缺失：不合成（整像素保持 EOX 的缺影像状态，由着色器回退）。
 * - 水面（水体遮罩 R）：0。航拍海面有太阳耀斑、波纹斑块和拼接块（research §3.2），本项目的海面 / 湖面是程序化的，岸边也不要。
 * - 色调异常：高清低频亮度 / EOX 低频亮度 相对本级中位数偏亮 1.6 倍以上（云、耀斑、雪、白色无数据填充）或偏暗 2.5 倍以上（云影、黑边），
 *   平滑降到 0。拼接缝本身不单独检测：低频已换成 EOX，缝的台阶只剩 σ 宽的一条细带（见 README 坑点）。
 * - 最后把 m 羽化几个纹素，避免权重边界成一条硬边。
 */

const K = 0.85; // 细节强度：航拍的阴影 / 反差比 EOX 强，稍收一点
const D_MIN = 0.3;
const D_MAX = 3.0;
const EPS = 0.004; // 线性亮度，防止暗处比值炸开（约 sRGB 12）
const BLUR_R = 4; // 盒滤波半径（纹素），两遍
const FEATHER_R = 2;

const SRGB_LIN = new Float32Array(256).map((_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const LUT_N = 4096;
const LIN_SRGB = new Uint8Array(LUT_N + 1).map((_, i) => {
  const c = i / LUT_N;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(Math.max(s, 0), 1) * 255);
});
const toSrgb = (lin: number) => LIN_SRGB[Math.min(LUT_N, Math.max(0, Math.round(lin * LUT_N)))];

let bufE: Float32Array | null = null;
let bufH: Float32Array | null = null;
let bufM: Float32Array | null = null;
let line: Float32Array | null = null;

/** 就地做可分离盒滤波（半径 r，边界外按 0 计——配合覆盖率加权，缺数据的地方不会把颜色拉黑），ch 个交错通道 */
function boxBlur(buf: Float32Array, res: number, ch: number, r: number) {
  if (!line || line.length < res * ch) line = new Float32Array(res * ch);
  const tmp = line;
  const acc = new Float64Array(ch);
  const norm = 1 / (2 * r + 1);
  // 横向
  for (let y = 0; y < res; y++) {
    const row = y * res * ch;
    acc.fill(0);
    for (let x = 0; x < r && x < res; x++) for (let c = 0; c < ch; c++) acc[c] += buf[row + x * ch + c];
    for (let x = 0; x < res; x++) {
      const xa = x + r, xr = x - r - 1;
      if (xa < res) for (let c = 0; c < ch; c++) acc[c] += buf[row + xa * ch + c];
      if (xr >= 0) for (let c = 0; c < ch; c++) acc[c] -= buf[row + xr * ch + c];
      for (let c = 0; c < ch; c++) tmp[x * ch + c] = acc[c] * norm;
    }
    buf.set(tmp.subarray(0, res * ch), row);
  }
  // 纵向
  const stride = res * ch;
  for (let x = 0; x < res; x++) {
    acc.fill(0);
    for (let y = 0; y < r && y < res; y++) for (let c = 0; c < ch; c++) acc[c] += buf[y * stride + x * ch + c];
    for (let y = 0; y < res; y++) {
      const ya = y + r, yr = y - r - 1;
      if (ya < res) for (let c = 0; c < ch; c++) acc[c] += buf[ya * stride + x * ch + c];
      if (yr >= 0) for (let c = 0; c < ch; c++) acc[c] -= buf[yr * stride + x * ch + c];
      for (let c = 0; c < ch; c++) tmp[y * ch + c] = acc[c] * norm;
    }
    for (let y = 0; y < res; y++) for (let c = 0; c < ch; c++) buf[y * stride + x * ch + c] = tmp[y * ch + c];
  }
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

export interface DetailBlendResult {
  /** 实际用上细节的像素比例（m > 0.5） */
  coverage: number;
  /** 本级「高清低频亮度 / EOX 低频亮度」的中位数（诊断用：GSI 一般 1.5–2.5） */
  ratio: number;
}

/**
 * 把高清细节合进一级影像（就地改 albedo 的 RGB；A 不动）。
 * albedo / detail：RES² × RGBA（canvas 的 getImageData 结果，A = 覆盖率）；water：同一级的水体遮罩（R = 水面）
 */
export function blendDetail(albedo: Uint8ClampedArray, detail: Uint8ClampedArray, water: Uint8ClampedArray, res: number): DetailBlendResult {
  const N = res * res;
  if (!bufE || bufE.length !== N * 4) {
    bufE = new Float32Array(N * 4);
    bufH = new Float32Array(N * 4);
    bufM = new Float32Array(N);
  }
  const E = bufE, H = bufH!, M = bufM!;
  // 预乘覆盖率的线性色 + 覆盖率
  let any = 0;
  for (let i = 0; i < N; i++) {
    const i4 = i * 4;
    const we = albedo[i4 + 3] / 255, wh = detail[i4 + 3] / 255;
    E[i4] = SRGB_LIN[albedo[i4]] * we;
    E[i4 + 1] = SRGB_LIN[albedo[i4 + 1]] * we;
    E[i4 + 2] = SRGB_LIN[albedo[i4 + 2]] * we;
    E[i4 + 3] = we;
    H[i4] = SRGB_LIN[detail[i4]] * wh;
    H[i4 + 1] = SRGB_LIN[detail[i4 + 1]] * wh;
    H[i4 + 2] = SRGB_LIN[detail[i4 + 2]] * wh;
    H[i4 + 3] = wh;
    if (wh > 0.5 && we > 0.5) any++;
  }
  if (any === 0) return { coverage: 0, ratio: 0 };
  for (let p = 0; p < 2; p++) {
    boxBlur(E, res, 4, BLUR_R);
    boxBlur(H, res, 4, BLUR_R);
  }
  // 本级亮度比的中位数（对数直方图，[-3, 3]，256 格）：异常按「相对中位数」判，GSI 整体比 EOX 亮多少由它吸收
  const hist = new Uint32Array(256);
  let cnt = 0;
  for (let i = 0; i < N; i += 3) {
    const i4 = i * 4;
    if (albedo[i4 + 3] < 128 || detail[i4 + 3] < 128 || water[i4] > 64) continue;
    const le = (0.2126 * E[i4] + 0.7152 * E[i4 + 1] + 0.0722 * E[i4 + 2]) / Math.max(E[i4 + 3], 1e-4);
    const lh = (0.2126 * H[i4] + 0.7152 * H[i4 + 1] + 0.0722 * H[i4 + 2]) / Math.max(H[i4 + 3], 1e-4);
    const q = Math.log((lh + EPS) / (le + EPS));
    hist[Math.min(255, Math.max(0, Math.floor(((q + 3) / 6) * 256)))]++;
    cnt++;
  }
  let logR0 = 0;
  if (cnt > 0) {
    let s = 0;
    for (let b = 0; b < 256; b++) {
      s += hist[b];
      if (s >= cnt / 2) {
        logR0 = ((b + 0.5) / 256) * 6 - 3;
        break;
      }
    }
  }
  // 权重
  const LB = Math.log(1.6), LB1 = Math.log(2.4), LD = Math.log(2.5), LD1 = Math.log(1.7);
  for (let i = 0; i < N; i++) {
    const i4 = i * 4;
    const we = E[i4 + 3], wh = H[i4 + 3];
    if (albedo[i4 + 3] < 128 || detail[i4 + 3] < 8 || we < 1e-3 || wh < 1e-3) {
      M[i] = 0;
      continue;
    }
    const le = (0.2126 * E[i4] + 0.7152 * E[i4 + 1] + 0.0722 * E[i4 + 2]) / we;
    const lh = (0.2126 * H[i4] + 0.7152 * H[i4 + 1] + 0.0722 * H[i4 + 2]) / wh;
    const q = Math.log((lh + EPS) / (le + EPS)) - logR0;
    let m = (detail[i4 + 3] / 255) * (1 - water[i4] / 255);
    m *= 1 - smooth(LB, LB1, q); // 偏亮：云、耀斑、雪、白色无数据
    m *= smooth(-LD, -LD1, q); // 偏暗：云影、黑边
    M[i] = m;
  }
  boxBlur(M, res, 1, FEATHER_R);
  // 合成
  let used = 0;
  for (let i = 0; i < N; i++) {
    const m = M[i];
    if (m <= 1e-3) continue;
    const i4 = i * 4;
    if (albedo[i4 + 3] < 128) continue;
    const we = E[i4 + 3], wh = H[i4 + 3];
    if (we < 1e-3 || wh < 1e-3) continue;
    if (m > 0.5) used++;
    for (let c = 0; c < 3; c++) {
      const eLow = E[i4 + c] / we;
      const hLow = H[i4 + c] / wh;
      const h = SRGB_LIN[detail[i4 + c]];
      let d = 1 + K * ((h + EPS) / (hLow + EPS) - 1);
      d = d < D_MIN ? D_MIN : d > D_MAX ? D_MAX : d;
      const e = SRGB_LIN[albedo[i4 + c]];
      albedo[i4 + c] = toSrgb(e + (eLow * d - e) * m);
    }
  }
  return { coverage: used / N, ratio: Math.exp(logR0) };
}
