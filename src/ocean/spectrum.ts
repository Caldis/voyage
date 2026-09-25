/**
 * 海浪频谱（CPU）：按 JONSWAP 风浪谱 + 涌浪 + 方向扩展函数生成各级联的初始频谱 h0(k)。
 * 只在风速变化时重算（约十几毫秒），结果上传给 GPU，每帧的相位推进和逆 FFT 都在 GPU 上做。
 *
 * 约定：
 * - 长度单位一律为米，波数 k 为 rad/m，角频率 ω 为 rad/s。
 * - 平面坐标 x 朝东、z 朝南（与场景的 xz 一致）；波的传播方向角 θ 从 +x 量起，朝 +z 为正。
 * - 空间场 f(x) = Σ_k F(k)·e^{i k·x}（不除以 N），与 GPU 上不带归一化的逆 FFT 一致。
 * - h(k,t) = h0(k)·e^{−iωt} + conj(h0(−k))·e^{iωt}：波数为 k 的分量沿 +k 方向传播。
 *   时间平均下 ⟨|h(k,t)|²⟩ = |h0(k)|² + |h0(−k)|²，所以每个网格点的 E|h0|² 取 S(kx,kz)·Δk²/2，总方差才等于谱的零阶矩。
 */

export const G = 9.81;

/** 风向：风浪的主传播方向（弧度，从正东量起，朝南为正）。与旧版海面的 WIND_DIR 一致 */
export const WIND_DIR = 0.6;

/** 一个级联：平铺尺寸 L（m）与它负责的波数段 [kLo, kHi) */
export interface CascadeBand {
  size: number;
  kLo: number;
  kHi: number;
}

/** 涌浪：远处风暴传来的长浪，与本地风无关（典型值，不是某地实测） */
interface Swell {
  hs: number; // 有效波高（m）
  period: number; // 谱峰周期（s）
  dir: number; // 传播方向（弧度）
  s: number; // cos-2s 方向扩展指数，越大越窄（越「长峰」）
}

// 西太平洋开阔洋面的典型涌浪量级：主涌浪 Hs≈1.2 m、Tp≈11 s；另有一道较弱的次涌浪，与风浪交叉
const SWELLS: Swell[] = [
  { hs: 1.2, period: 11, dir: WIND_DIR + 2.2, s: 30 },
  { hs: 0.5, period: 7.5, dir: WIND_DIR - 1.25, s: 18 },
];

/** 风区长度（m）。100 km 时 7 m/s 以下的风浪已接近充分成长（PM 极限） */
const FETCH = 100e3;

/** Lanczos 近似的 ln Γ(x)，x > 0 */
function lnGamma(x: number): number {
  const c = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += c[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** cos-2s 型方向扩展 D(Δθ) = Q(s)·|cos(Δθ/2)|^{2s}，在 [−π, π] 上积分为 1；逆风方向（Δθ = π）为 0 */
function spreading(dTheta: number, s: number): number {
  const lnQ = (2 * s - 1) * Math.LN2 - Math.log(Math.PI) + 2 * lnGamma(s + 1) - lnGamma(2 * s + 1);
  const c = Math.abs(Math.cos(dTheta / 2));
  return c > 0 ? Math.exp(lnQ + 2 * s * Math.log(c)) : 0;
}

interface WindSea {
  alpha: number;
  omegaP: number;
  gamma: number;
  u: number;
}

/**
 * JONSWAP 参数（Hasselmann 等 1973 的风区关系），谱峰不低于 Pierson–Moskowitz 充分成长的极限。
 * 峰形因子 γ：风区受限（年轻的风浪）取 3.3，接近充分成长时平滑退到 1（即 PM 谱），否则 Hs 会比 PM 大一截
 */
function windSea(u: number): WindSea | null {
  if (u < 0.3) return null;
  const chi = (G * FETCH) / (u * u);
  const omegaJ = 22 * Math.cbrt((G * G) / (u * FETCH));
  const omegaPM = (0.855 * G) / u;
  const omegaP = Math.max(omegaJ, omegaPM);
  const alpha = Math.max(0.076 * Math.pow(chi, -0.22), 0.0081);
  const gamma = 1 + 2.3 * Math.min(Math.max((omegaJ / omegaPM - 1) / 0.5, 0), 1);
  return { alpha, omegaP, gamma, u };
}

/** JONSWAP 频率谱 S(ω)（m²·s） */
function jonswap(w: number, ws: WindSea): number {
  const sigma = w <= ws.omegaP ? 0.07 : 0.09;
  const r = Math.exp(-((w - ws.omegaP) ** 2) / (2 * sigma * sigma * ws.omegaP * ws.omegaP));
  const x = ws.omegaP / w;
  return ((ws.alpha * G * G) / w ** 5) * Math.exp(-1.25 * x ** 4) * Math.pow(ws.gamma, r);
}

/** Mitsuyasu 1975 / Hasselmann 1980 的方向扩展指数 s(ω)：谱峰处最窄，往高频变宽 */
function spreadS(w: number, ws: WindSea): number {
  const x = w / ws.omegaP;
  const s = x < 1 ? 6.97 * Math.pow(x, 4.06) : 9.77 * Math.pow(x, -2.33 - 1.45 * ((ws.u * ws.omegaP) / G - 1.17));
  return Math.min(Math.max(s, 0.5), 40);
}

/** 二维波数谱 S(kx, kz)（m⁴），∬ S dkx dkz = 波高方差 */
function spectrum2D(kx: number, kz: number, ws: WindSea | null): number {
  const k = Math.hypot(kx, kz);
  if (k < 1e-6) return 0;
  const w = Math.sqrt(G * k);
  const dwdk = G / (2 * w);
  const theta = Math.atan2(kz, kx);
  let s = 0;
  if (ws) s += jonswap(w, ws) * spreading(theta - WIND_DIR, spreadS(w, ws));
  for (const sw of SWELLS) {
    const wp = (2 * Math.PI) / sw.period;
    const sig = 0.08 * wp;
    if (Math.abs(w - wp) > 6 * sig) continue;
    const sOmega = ((sw.hs * sw.hs) / 16) * Math.exp(-((w - wp) ** 2) / (2 * sig * sig)) / (sig * Math.sqrt(2 * Math.PI));
    s += sOmega * spreading(theta - sw.dir, sw.s);
  }
  return (s * dwdk) / k;
}

/** 可复现的伪随机数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SpectrumResult {
  /** 图集：宽 N·级联数、高 N，RGBA = (h0(k), conj(h0(−k)))，按标准 FFT 顺序（下标 n ≥ N/2 表示负波数） */
  data: Float32Array;
  /** 每级实现出来的总斜率方差 ⟨sx² + sz²⟩（时间平均） */
  slopeVar: number[];
  /** 每级的波高方差 ⟨h²⟩（调试用：有效波高 Hs = 4·√Σ） */
  heightVar: number[];
}

/**
 * 生成所有级联的 h0。每个级联只保留自己的波数段 [kLo, kHi)，互不重叠，也就不会重复计数。
 * 随机数只取决于级联号和网格下标，风速变了之后波形态连续变化（同一组高斯随机数）。
 */
export function buildSpectrum(n: number, bands: CascadeBand[], wind: number): SpectrumResult {
  const ws = windSea(wind);
  const w = n * bands.length;
  const data = new Float32Array(w * n * 4);
  const slopeVar: number[] = [];
  const heightVar: number[] = [];
  // 先按网格生成 h0（每个网格点一对高斯随机数），再填 conj(h0(−k))
  const h0 = new Float32Array(n * n * 2);
  bands.forEach((band, c) => {
    const dk = (2 * Math.PI) / band.size;
    const rand = rng(0x9e3779b1 ^ (c * 7919 + 17));
    let sv = 0;
    let hv = 0;
    for (let y = 0; y < n; y++) {
      const mz = y < n / 2 ? y : y - n;
      for (let x = 0; x < n; x++) {
        const mx = x < n / 2 ? x : x - n;
        // 每个网格点都消耗同样多的随机数，保证随机数与下标一一对应
        const u1 = Math.max(rand(), 1e-12);
        const u2 = rand();
        const kx = mx * dk;
        const kz = mz * dk;
        const k = Math.hypot(kx, kz);
        let re = 0;
        let im = 0;
        if (k >= band.kLo && k < band.kHi) {
          const amp = Math.sqrt((spectrum2D(kx, kz, ws) * dk * dk) / 2);
          const r = Math.sqrt(-2 * Math.log(u1));
          // (ξr + iξi)/√2，E|·|² = 1
          re = (amp * r * Math.cos(2 * Math.PI * u2)) / Math.SQRT2;
          im = (amp * r * Math.sin(2 * Math.PI * u2)) / Math.SQRT2;
          const e = re * re + im * im;
          sv += k * k * e;
          hv += e;
        }
        const i = (y * n + x) * 2;
        h0[i] = re;
        h0[i + 1] = im;
      }
    }
    // 时间平均：每个 k 贡献 |h0(k)|² + |h0(−k)|²，对全网格求和正好是单边和的两倍
    slopeVar.push(2 * sv);
    heightVar.push(2 * hv);
    for (let y = 0; y < n; y++) {
      const ym = (n - y) % n;
      for (let x = 0; x < n; x++) {
        const xm = (n - x) % n;
        const i = (y * n + x) * 2;
        const j = (ym * n + xm) * 2;
        const o = (y * w + c * n + x) * 4;
        data[o] = h0[i];
        data[o + 1] = h0[i + 1];
        data[o + 2] = h0[j];
        data[o + 3] = -h0[j + 1];
      }
    }
  });
  return { data, slopeVar, heightVar };
}

/** 标准正态的上尾概率 Q(x) = P(X > x)（Börjesson–Sundberg 近似，误差约 1%）。GLSL 里有同样的实现 */
export function normalTail(x: number): number {
  const a = Math.abs(x);
  const q = Math.exp(-0.5 * a * a) / ((0.661 * a + 0.339 * Math.sqrt(a * a + 5.51)) * Math.sqrt(2 * Math.PI));
  return x >= 0 ? q : 1 - q;
}

/** Q(x) = p 的反函数（二分，和 GLSL 里用同一个近似，保证泡沫覆盖率的期望正好对上） */
export function normalTailInverse(p: number): number {
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (normalTail(mid) > p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** 白浪覆盖率（Monahan & O'Muircheartaigh 1980：W = 3.84e−6·U^3.41，上限 10%） */
export function whitecapCoverage(u: number): number {
  return Math.min(3.84e-6 * Math.pow(Math.max(u, 0), 3.41), 0.1);
}

/** Cox–Munk 1954 的总斜率方差（sx² + sz²，清洁海面） */
export function coxMunkVariance(u: number): number {
  return 0.003 + 0.00512 * u;
}
