import * as THREE from "three";

/**
 * 巨柱群（WS07，research/WONDER_SCALE.md §3.6 第 1 名「垂直荒原」）：每次出现按种子随机，着色见 wonders/pillars.glsl.ts。
 *
 * - 5–12 根混凝土巨柱，从海面贯穿云海直插平流层：柱顶 30–70 km（比雷暴云顶高 2–4 倍）、柱径 2.6–7.2 km（比积云大一个量级）。
 * - 摆法：沿一条斜着往地平线退去的「行」排开（行的方向与视线夹 15°–45°，最近一根在锚点前 60–85 km，最远的在地平线外只露柱顶），间距 14–40 km 不规则，偶尔两根挨得很近，
 *   约五分之一的柱子偏离行 10–22 km——一根比一根远、一根比一根蓝，远处的柱脚沉到地平线以下、只剩柱顶。
 * - 最近三根里有一根「主柱」（56–70 km 高、半径 2.9–3.6 km），在 150 km 上下的距离上出画。
 * 数字都是科幻尺度（WONDERS.md §1.1：尺度夸张到公里级本身就是「这不是真实世界」的信号）。
 */
export const PILLAR_MAX = 12;

export interface PillarShape {
  /** 每根柱：[东偏移, 南偏移（km，锚点处的水平坐标）, 底部半径, 高度（km）]，按离行首的距离排 */
  pillars: [number, number, number, number][];
  /** 群中心（km，同上）与包围半径（km，含旗云与航迹云的余量） */
  center: [number, number];
  bound: number;
  /** 风向（弧度，东起往南）：旗云顺风拖长 */
  windAz: number;
  /** 同高度航班的航迹云：[航向（弧度，东起往南）, 离群中心的横向偏移（km，负 = 在群前面）, 高度（km）, 相位 0..1] */
  contrail: [number, number, number, number];
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

/**
 * seed：0..1；awayDeg：从飞机看锚点的方位角（度，从正北顺时针）——行按「往远处退」的方向摆，
 * 这样无论从哪边召唤，看到的都是一排往地平线退去的柱子，而不是横着一字排开的栅栏。
 */
export function pillarShape(seed: number, awayDeg: number): PillarShape {
  const r = rng(seed);
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  const n = 5 + Math.floor(r() * 8); // 5–12
  const b = THREE.MathUtils.degToRad(awayDeg);
  // 东、南坐标里「往远处」的方向
  const away: [number, number] = [Math.sin(b), -Math.cos(b)];
  const th = (r() < 0.5 ? -1 : 1) * THREE.MathUtils.degToRad(lerp(15, 45, r()));
  const dir: [number, number] = [away[0] * Math.cos(th) - away[1] * Math.sin(th), away[0] * Math.sin(th) + away[1] * Math.cos(th)];
  const perp: [number, number] = [-dir[1], dir[0]];
  const hero = Math.floor(r() * 3);
  const pillars: PillarShape["pillars"] = [];
  let u = -lerp(60, 85, r());
  let prevR = 0;
  for (let k = 0; k < n; k++) {
    const isHero = k === hero;
    const rad = isHero ? lerp(2.9, 3.6, r()) : lerp(1.3, 3.2, Math.pow(r(), 0.8));
    const H = isHero ? lerp(56, 70, r()) : lerp(30, 62, r());
    if (k > 0) {
      // 间距不规则：大多 14–40 km，四分之一的机会两根挨得很近（只留出两根的半径 + 4–8 km 的空当）
      const close = r() < 0.25;
      u += close ? prevR + rad + lerp(4, 8, r()) : Math.max(prevR + rad + 5, lerp(14, 40, r()));
    }
    const off = r() < 0.2 ? (r() < 0.5 ? -1 : 1) * lerp(10, 22, r()) : lerp(-5, 5, r());
    pillars.push([u * dir[0] + off * perp[0], u * dir[1] + off * perp[1], rad, H]);
    prevR = rad;
  }
  let cx = 0;
  let cz = 0;
  for (const p of pillars) {
    cx += p[0] / n;
    cz += p[1] / n;
  }
  let bound = 0;
  for (const p of pillars) bound = Math.max(bound, Math.hypot(p[0] - cx, p[1] - cz) + p[2]);
  // 旗云顺风拖 20–30 km（高斯尾巴到约 57 km 截断）、航迹云从群里斜穿过去（着色器里按包围半径淡出），这里留足余量
  bound += 60;
  // 航迹云大致横着穿过窗口（航向与视线夹 55°–90°），从群的前面或中间穿过：它在一些柱子前面、一些柱子后面
  const ca = Math.atan2(away[1], away[0]) + (r() < 0.5 ? -1 : 1) * THREE.MathUtils.degToRad(lerp(55, 90, r()));
  const contrail: PillarShape["contrail"] = [ca, lerp(-35, 10, r()), lerp(10.3, 11.8, r()), r()];
  const windAz = r() * Math.PI * 2;
  // 方尖碑阵变体：六成的群是同一朝向的方柱（半边长取半径的 0.85，窗里的体量和圆柱相当）；着色器按负的尺度认方柱
  if (r() < 0.6) for (const p of pillars) p[2] = -0.85 * p[2];
  return { pillars, center: [cx, cz], bound, windAz, contrail };
}

/** 巨柱群的 uniform（和 WonderSystem.uniforms 合在一起，main.ts 合进场景 / 窗外共用的 uniforms；只有窗外 OWP 变体读） */
export function createPillarUniforms() {
  return {
    /** 每根柱：x 东、y 南偏移（km），z 底部半径，w 高度（km） */
    uPillars: { value: Array.from({ length: PILLAR_MAX }, () => new THREE.Vector4()) },
    /** xyz 锚点处「东」的单位向量（窗外坐标），w 根数 */
    uPillarE: { value: new THREE.Vector4(1, 0, 0, 0) },
    /** xyz 锚点处「南」的单位向量，w 群的包围半径（km） */
    uPillarS: { value: new THREE.Vector4(0, 0, 1, 0) },
    /** x、y 群中心（km），z 风向（弧度），w 种子 */
    uPillarC: { value: new THREE.Vector4() },
    /** 航迹云：x 航向（弧度），y 横向偏移（km），z 高度（km），w 相位 */
    uPillarD: { value: new THREE.Vector4() },
  };
}

const _pole = new THREE.Vector3();
const _east = new THREE.Vector3();
const _south = new THREE.Vector3();

/**
 * 每帧写 uniform。axis：地心 → 锚点（窗外坐标）；lat：飞机的纬度（度）。
 * 锚点处的东 / 南按真实地轴算（同 WonderSystem.syncVolume），飞机飞过去时柱群不会跟着转。
 */
export function applyPillarUniforms(u: ReturnType<typeof createPillarUniforms>, s: PillarShape, axis: THREE.Vector3, latDeg: number, seed: number) {
  const phi = THREE.MathUtils.degToRad(latDeg);
  _pole.set(0, Math.sin(phi), -Math.cos(phi));
  _east.crossVectors(_pole, axis);
  if (_east.lengthSq() < 1e-12) _east.set(1, 0, 0);
  _east.normalize();
  _south.crossVectors(_east, axis).normalize();
  u.uPillarE.value.set(_east.x, _east.y, _east.z, s.pillars.length);
  u.uPillarS.value.set(_south.x, _south.y, _south.z, s.bound);
  u.uPillarC.value.set(s.center[0], s.center[1], s.windAz, seed);
  u.uPillarD.value.set(...s.contrail);
  for (let k = 0; k < PILLAR_MAX; k++) {
    const p = s.pillars[k];
    if (p) u.uPillars.value[k].set(...p);
    else u.uPillars.value[k].set(0, 0, 0, 0);
  }
}
