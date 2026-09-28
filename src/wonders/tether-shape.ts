import * as THREE from "three";

/**
 * 天梯的巨构尺寸（WS01，research/WONDER_SCALE.md §3.1）：每次出现按种子随机，着色见 render/wonder-sky.glsl.ts 的 skin 0。
 *
 * - 锚塔：30–40 km 高、3–4 级退台的截锥（底宽 14–18 km、顶宽 4–6 km），粗野主义混凝土；4–6 片放射状扶壁（伸出 6–9 km，高到第一级退台）。
 *   比雷暴云顶（12–18 km）高一倍多：窗里是一块实心的体量，塔顶在地平线上方约 8°。
 * - 中继站：3–5 个环形站（环半径 12–35 km、环管粗约 1–3 km，4–8 根辐条接到缆上），最低一只在塔顶上方 5–10 km，
 *   最大一只在 55–110 km 高处——从下面仰看是横在天上的扁椭圆。
 * 数字都是科幻尺度（真实的太空电梯缆索只有米级，WONDERS.md §1.1：尺度夸张到公里级本身就是「这不是真实世界」的信号）。
 */
export interface TetherShape {
  /** 塔高（km） */
  towerH: number;
  /** 底部半径、塔顶半径（km） */
  baseR: number;
  topR: number;
  /** 退台：每级 [底高, 顶高, 底半径, 顶半径]（km），从下往上 */
  tiers: [number, number, number, number][];
  /** 扶壁：片数、伸出长度、半厚（km）、方位起点（弧度） */
  fins: number;
  finLen: number;
  finHalfTh: number;
  azimuth: number;
  /** 环形站：每只 [中心高度, 环半径, 环管半径, 辐条数]（km） */
  rings: [number, number, number, number][];
}

/** mulberry32 */
function rng(seed: number) {
  let a = Math.floor(seed * 4294967296) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TETHER_MAX_TIERS = 4;
export const TETHER_MAX_RINGS = 5;

export function tetherShape(seed: number): TetherShape {
  const r = rng(seed);
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  const towerH = lerp(30, 40, r());
  const nTiers = r() < 0.5 ? 3 : 4;
  const baseR = lerp(7, 9, r());
  const topR = lerp(2, 3, r());
  // 退台高度：越往上每级越矮（下粗上细的体量感），各级高度 ±12% 随机
  const w: number[] = [];
  for (let k = 0; k < nTiers; k++) w.push(Math.pow(0.78, k) * lerp(0.88, 1.12, r()));
  const wSum = w.reduce((s, x) => s + x, 0);
  const tiers: TetherShape["tiers"] = [];
  let h = 0;
  for (let k = 0; k < nTiers; k++) {
    const h1 = k === nTiers - 1 ? towerH : h + (towerH * w[k]) / wSum;
    // 粗野主义的阶梯体量：各级底半径从 baseR 收到「顶半径 / 0.93」，每级自身只有 5–8% 的收分（墙面几乎竖直），
    // 退台处再往里收一截（下一级的底半径更小）；最上一级是一整块近乎竖直的方墩，不做尖顶
    const rb = lerp(baseR, topR / 0.93, Math.pow(k / (nTiers - 1), 0.9));
    const rt = k === nTiers - 1 ? topR : rb * lerp(0.92, 0.95, r());
    tiers.push([h, h1, rb, rt]);
    h = h1;
  }
  const fins = 4 + Math.floor(r() * 3);
  const finLen = lerp(4.5, 7, r());
  const finHalfTh = lerp(0.4, 0.6, r());
  const azimuth = r() * Math.PI * 2;
  // 环形站
  const nRings = 3 + Math.floor(r() * 3);
  const big = 1 + Math.floor(r() * Math.min(2, nRings - 1)); // 最大的一只（第 1 或第 2 只）
  const rings: TetherShape["rings"] = [];
  let hc = towerH + lerp(5, 10, r());
  for (let k = 0; k < nRings; k++) {
    let R: number;
    if (k === 0) R = lerp(12, 16, r());
    else if (k === big) {
      hc = Math.min(Math.max(hc, 55), 110);
      R = lerp(25, 35, r());
    } else R = lerp(14, 22, r());
    const tube = Math.min(3, Math.max(1, R * lerp(0.06, 0.085, r())));
    rings.push([hc, R, tube, 4 + Math.floor(r() * 5)]);
    hc *= lerp(1.6, 2.0, r());
    if (k + 1 === big) hc = Math.max(hc, 55);
  }
  return { towerH, baseR, topR, tiers, fins, finLen, finHalfTh, azimuth, rings };
}

/** 天梯的 uniform（和 WonderSystem.uniforms 合在一起，main.ts 合进场景 / 窗外共用的 uniforms） */
export function createTetherUniforms() {
  return {
    /** x 退台级数、y 环站个数、z 扶壁片数、w 塔身灯格（开发者开关，0/1） */
    uWonderSky: { value: new THREE.Vector4(0, 0, 0, 0) },
    /** x 塔高、y 底半径、z 顶半径、w 方位起点（弧度） */
    uWonderTower: { value: new THREE.Vector4(35, 8, 2.5, 0) },
    /** x 扶壁伸出长度、y 扶壁半厚（km） */
    uWonderFin: { value: new THREE.Vector4(7, 0.5, 0, 0) },
    uWonderTiers: { value: Array.from({ length: TETHER_MAX_TIERS }, () => new THREE.Vector4()) },
    uWonderRings: { value: Array.from({ length: TETHER_MAX_RINGS }, () => new THREE.Vector4()) },
  };
}

export function applyTetherUniforms(u: ReturnType<typeof createTetherUniforms>, s: TetherShape, windows: boolean) {
  u.uWonderSky.value.set(s.tiers.length, s.rings.length, s.fins, windows ? 1 : 0);
  u.uWonderTower.value.set(s.towerH, s.baseR, s.topR, s.azimuth);
  u.uWonderFin.value.set(s.finLen, s.finHalfTh, 0, 0);
  for (let k = 0; k < TETHER_MAX_TIERS; k++) {
    const t = s.tiers[k];
    if (t) u.uWonderTiers.value[k].set(...t);
    else u.uWonderTiers.value[k].set(0, 0, 0, 0);
  }
  for (let k = 0; k < TETHER_MAX_RINGS; k++) {
    const g = s.rings[k];
    if (g) u.uWonderRings.value[k].set(...g);
    else u.uWonderRings.value[k].set(0, 0, 0, 0);
  }
}
