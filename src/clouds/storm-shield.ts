/**
 * 砧盾足迹的 CPU 预算（PERF-TW04）。着色器（clouds.glsl.ts 的 anvilShield）里每个雷暴单体的砧盾是一个平面扇形足迹：
 * 从被吹歪的塔顶 O = c.xy + W·0.7R 量起，a = 沿高空风的距离、b = 横风距离（中线按 k·a·fa 弯），
 * 足迹 = { (a/Lx 或 −a/Ly)² + b² / wh(a)² < 1 }，wh = 1.9R + 0.36·max(a, 0)。
 * 旧版的视线包围判断用这个扇形的外接圆（半径最大约 85–90 km）：巡航高度正在砧的高度层里，只要视线穿过这个大圆，
 * 整条都走天气路径、并在砧盾段里一路 4 倍空步走出去；而扇形只占外接圆的约 1/4–1/3（上风半圆几乎全空）。
 * 这里在 CPU 上给每个单体拟合一个沿风向的外接椭圆（uShieldEll：世界坐标圆心、1/半轴），着色器按二次方程精确求交。
 * 足迹之外 anvilShield 严格为 0，所以椭圆只要包住足迹（留一点余量）就不改画面。
 */

const f = Math.fround;
const fract = (x: number) => f(x - Math.floor(x));

/** 与 clouds.glsl.ts 的 stormHash22 同一个式子（按 float32 逐步舍入；GPU 上可能有 mad 融合，末位不保证相同，只用在带余量的包围判断上） */
export function stormHash22(px: number, py: number): [number, number] {
  let x = fract(f(px * f(0.1031)));
  let y = fract(f(py * f(0.103)));
  let z = fract(f(px * f(0.0973)));
  const d = f(f(f(x * f(y + f(33.33))) + f(y * f(z + f(33.33)))) + f(z * f(x + f(33.33))));
  x = f(x + d);
  y = f(y + d);
  z = f(z + d);
  return [fract(f(f(x + y) * z)), fract(f(f(x + z) * y))];
}

/** stormSeed2(c)：按塔身半径与砧顶取的两个随机数 */
export function stormSeed2(R: number, top: number): [number, number] {
  return stormHash22(f(f(R * f(7.13)) + f(top * f(0.37))), f(f(top * f(3.71)) + f(R * f(1.9))));
}

/** 足迹的形状参数（与 anvilShield 一致）：Lx 下风半轴、Ly 上风半轴、k 中线弯曲系数 */
export function shieldShape(R: number, top: number) {
  const [hx, hy] = stormSeed2(R, top);
  return { hx, hy, Lx: R * (6 + 11 * hx), Ly: R * (1.2 + 0.8 * hy), k: (hy - 0.5) * 0.5 };
}

/** 点 (a, l)（相对塔顶 O、沿风 / 横风）在不在足迹里：与着色器同一个判断，给单测用 */
export function shieldInsideAL(a: number, l: number, R: number, s: { Lx: number; Ly: number; k: number }): boolean {
  const fa = Math.min(Math.max(a / s.Lx, 0), 1);
  const b = l - s.k * a * fa;
  const wh = R * 1.9 + 0.36 * Math.max(a, 0);
  const u = a > 0 ? a / s.Lx : -a / s.Ly;
  return u * u + (b * b) / (wh * wh) < 1;
}

export interface ShieldEllipse {
  a0: number; // 椭圆中心相对 O 的沿风距离
  l0: number; // 横风距离
  A: number; // 沿风半轴
  B: number; // 横风半轴
}

const N_SAMPLES = 160;
/** 足迹的外接椭圆（轴沿风向）：在足迹边界上取样，搜索沿风半轴与横向中心使面积最小，再放宽一点余量 */
export function fitShieldEllipse(R: number, s: { Lx: number; Ly: number; k: number }): ShieldEllipse {
  const pts: Array<[number, number]> = [];
  let lMin = 0;
  let lMax = 0;
  for (let i = 0; i <= N_SAMPLES; i++) {
    const a = -s.Ly + ((s.Lx + s.Ly) * i) / N_SAMPLES;
    const fa = Math.min(Math.max(a / s.Lx, 0), 1);
    const u = a > 0 ? a / s.Lx : -a / s.Ly;
    const wh = R * 1.9 + 0.36 * Math.max(a, 0);
    const half = wh * Math.sqrt(Math.max(1 - u * u, 0));
    const mid = s.k * a * fa;
    pts.push([a, mid + half], [a, mid - half]);
    lMin = Math.min(lMin, mid - half);
    lMax = Math.max(lMax, mid + half);
  }
  const a0 = (s.Lx - s.Ly) / 2;
  const H = (s.Lx + s.Ly) / 2;
  let best: ShieldEllipse = { a0, l0: 0, A: H * 2, B: Math.max(-lMin, lMax) * 2 };
  let bestArea = Infinity;
  for (let si = 0; si <= 40; si++) {
    const A = H * (1.01 + si * 0.015);
    for (let li = 0; li <= 20; li++) {
      const l0 = lMin + ((lMax - lMin) * li) / 20;
      let B = 0;
      for (const [a, l] of pts) {
        const x = (a - a0) / A;
        const g = 1 - x * x;
        B = Math.max(B, Math.abs(l - l0) / Math.sqrt(Math.max(g, 1e-6)));
      }
      if (A * B < bestArea) {
        bestArea = A * B;
        best = { a0, l0, A, B };
      }
    }
  }
  // 余量：取样之间的边界、float32 哈希与 GPU 的末位差异（半轴差零点几公里），各放宽 2% + 0.5 km
  return { a0: best.a0, l0: best.l0, A: best.A * 1.02 + 0.5, B: best.B * 1.02 + 0.5 };
}

/** 伴生塔（与 clouds.glsl.ts 的 stormTowersSdf 注释里的式子一致）：相对塔心的轴线偏移、塔顶、半径、种子 */
export function satellites(R: number, top: number) {
  const [sx, sy] = stormSeed2(R, top);
  const nSat = 2 + Math.trunc(f(sx * f(2.99)));
  const flank = sy * 6.2831853;
  const out: Array<{ dx: number; dz: number; tk: number; Rk: number; hx: number; hy: number }> = [];
  for (let k = 0; k < nSat; k++) {
    const [hx, hy] = stormHash22(f(f(sx * f(37.1)) + f(k * f(1.37))), f(f(sy * f(37.1)) + f(k * f(1.37))));
    const ang = flank + (k - 0.5 * (nSat - 1)) * 1.1 + (hx - 0.5) * 0.9;
    const rr = R * (1.25 + 1.1 * hy);
    out.push({ dx: Math.cos(ang) * rr, dz: Math.sin(ang) * rr, tk: 1.2 + (top - 1.2) * (0.28 + 0.42 * hy * hy), Rk: R * (0.3 + 0.28 * hx), hx, hy });
  }
  return { sx, sy, nSat, sats: out };
}

type V4 = { set(x: number, y: number, z: number, w: number): unknown };
type V2 = { x: number; y: number };
type ShieldUniforms = {
  uStormCount: { value: number };
  uStorms: { value: Array<{ x: number; y: number; z: number; w: number }> };
  uUpperWind: { value: V2 };
  uShieldEll: { value: V4[] };
  uShieldP: { value: V4[] };
  uShieldQ: { value: V4[] };
  uStormSd: { value: V4[] };
  uSatA: { value: V4[] };
  uSatB: { value: V4[] };
};

type CellConst = { e: ShieldEllipse; s: ReturnType<typeof shieldShape>; t: ReturnType<typeof satellites> };
const cache = new Map<string, CellConst>();
/**
 * 每帧调用（Clouds.render）：按当前雷暴单体与高空风写各单体的常量（形状只随半径 / 砧顶变，按它们缓存；位置每帧跟着换原点平移）：
 *  uShieldEll = (外接椭圆中心世界 x, z, 1/沿风半轴, 1/横风半轴)；uShieldP = (塔顶 O 世界 x, z, Lx, Ly)；uShieldQ = (k, 1 + 0.6·h.x, 1.9R, 0)；
 *  uStormSd = (sd.x, sd.y, 伴生塔数, 0)；uSatA[4i + k] = (伴生塔轴世界 x, z, 塔顶, 半径)；uSatB[4i + k] = (hk.x, hk.y, 0, 0)
 */
export function updateShieldUniforms(u: ShieldUniforms) {
  // 与着色器一样直接用 uUpperWind（单位向量，weather.ts 里是常量 (0.8, 0.6)）
  const W = u.uUpperWind.value;
  const wx = W.x;
  const wz = W.y;
  for (let i = 0; i < u.uStormCount.value; i++) {
    const c = u.uStorms.value[i];
    const key = `${c.z},${c.w}`;
    let cc = cache.get(key);
    if (!cc) {
      if (cache.size > 64) cache.clear();
      const s = shieldShape(c.z, c.w);
      cc = { e: fitShieldEllipse(c.z, s), s, t: satellites(c.z, c.w) };
      cache.set(key, cc);
    }
    const { e, s, t } = cc;
    // O = c.xy + W·0.7R；椭圆中心 = O + W·a0 + P·l0，P = (−W.y, W.x)
    const ox = c.x + wx * (0.7 * c.z);
    const oz = c.y + wz * (0.7 * c.z);
    u.uShieldEll.value[i].set(ox + wx * e.a0 - wz * e.l0, oz + wz * e.a0 + wx * e.l0, 1 / e.A, 1 / e.B);
    u.uShieldP.value[i].set(ox, oz, s.Lx, s.Ly);
    u.uShieldQ.value[i].set(s.k, 1 + 0.6 * s.hx, 1.9 * c.z, 0);
    u.uStormSd.value[i].set(t.sx, t.sy, t.nSat, 0);
    for (let k = 0; k < 4; k++) {
      const sat = t.sats[k];
      if (sat) {
        u.uSatA.value[4 * i + k].set(c.x + sat.dx, c.y + sat.dz, sat.tk, sat.Rk);
        u.uSatB.value[4 * i + k].set(sat.hx, sat.hy, 0, 0);
      } else {
        u.uSatA.value[4 * i + k].set(0, 0, 0, 1);
        u.uSatB.value[4 * i + k].set(0, 0, 0, 0);
      }
    }
  }
}
