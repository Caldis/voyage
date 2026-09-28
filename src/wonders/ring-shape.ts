import * as THREE from "three";

/**
 * 天环（WS08，轨道环）的设定与每次出现的几何：着色见 wonders/ring.glsl.ts（窗外程序 OUTSIDE_WONDER 变体里）。
 *
 * 设定（依据：Paul Birch, "Orbital Ring Systems and Jacob's Ladders", JBIS 1982；research/WONDER_SCALE.md §3.6 候选 2）：
 * - 轨道环 = 绕地球一整圈的环：里面是以超过轨道速度旋转的转子，外面套着相对地面静止的护套 / 结构，
 *   静止的结构可以用缆塔（Birch 的「雅各布天梯」）一路垂到地面。环平面必须过地心（任何轨道都是），但可以倾斜：
 *   Birch 设想里靠与地面相连的缆施力让倾斜的环跟着地球一起转、相对地面静止。这里当作「环网里恰好经过你这片天空的那一条」，
 *   所以环平面按每次出现的种子取（让它从窗里横贯 / 斜贯天空），并固定在地球上（不跟飞机走）。
 * - 高度 500–1400 km：Birch 的环在低轨；从巡航高度看，这个高度的环在窗里是一道仰角 7–18° 的巨弧，
 *   离得够近（1000–2500 km）才看得出宽度，又远到横跨整个窗（附录 A 的仰角公式）。
 * - 尺寸是科幻尺度（真实的转子缆只有米级；WONDERS.md §1.1：尺度夸张到公里级本身就是「这不是真实世界」的信号）：
 *   环体宽 120–220 km、厚 8–14 km（比最大的雷暴云砧还宽），两侧边缘各一根 6–10 km 粗的转子护套（白天最亮的两道细线）。
 * - 结构层级（每级约差 4–5 倍）：主环（窗里 30–120 px 宽的带）→ 枢纽（每 1/4 个支柱间距一处，约 300–450 km）
 *   → 肋（每 1/5 个枢纽间距一道，60–90 km）→ 桁架 / 窗带 / 灯（1–7 km，按像素足迹积分）。
 * - 支柱（缆塔）：每 11–18°（沿环 1300–2200 km）一根、粗 6–10 km，从地平线以下一直升到环的腹面；
 *   相位让离飞机最近的支柱在半个间距以外（≥ 600 km，永远在地平线外、在所有云的后面）。
 */
export interface RingShape {
  /** 环体腹面（朝地面那一面）离海面的高度（km） */
  hKm: number;
  /** 环体半宽（沿环平面法线，km） */
  halfW: number;
  /** 环体厚（径向，km） */
  depth: number;
  /** 两侧转子护套的半径（km） */
  rimR: number;
  /** 支柱数（整圈） */
  pillars: number;
  /** 支柱半径（km） */
  pillarR: number;
  /** 环平面法线（地心坐标里的单位向量，x 指向 0° 经线与赤道的交点、z 指向北极；固定在地球上） */
  pole: [number, number, number];
  /** 环上的参考点（单位向量，与 pole 正交）：沿环的角度从这里起算，支柱、枢纽、肋的相位都跟着它 */
  ref: [number, number, number];
  /** 挂给奇观系统的锚点（小地图、「飞过去了就退场」的判断）：窗口方向上环附近的一个地面点 */
  anchor: [number, number];
  /** 窗口方向上环的仰角（度，出现时）与倾斜角 ψ（度：0 = 横贯，±90 = 顺着视线从地平线升起） */
  elevDeg: number;
  tiltDeg: number;
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

const EARTH_R_KM = 6371;
/** 渲染用的地球半径（与着色器的 BOTTOM 一致） */
const RENDER_R_KM = 6360;
const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;

/** 观察点的东、北、天顶（地心坐标） */
function enu(latDeg: number, lonDeg: number) {
  const p = rad(latDeg);
  const l = rad(lonDeg);
  const up = new THREE.Vector3(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p));
  const east = new THREE.Vector3(-Math.sin(l), Math.cos(l), 0);
  const north = new THREE.Vector3(-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p));
  return { up, east, north };
}

/**
 * 按种子生成一条天环：在方位 bearingDeg（窗口正对 / 相机视线的方位）上、仰角 7–18° 处放环上一点 X0，
 * 环在 X0 处的走向相对「横贯视线」转 ψ（10–70°，左右随机）——ψ 小是一道横跨窗口的缓弧，ψ 大是从地平线斜着升起、出画的巨带。
 */
export function ringShape(seed: number, latDeg: number, lonDeg: number, altKm: number, bearingDeg: number): RingShape {
  const r = rng(seed);
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  const hKm = lerp(500, 1400, r());
  const halfW = lerp(60, 110, r());
  const depth = lerp(8, 14, r());
  const rimR = lerp(3, 5, r());
  const pillars = 20 + Math.floor(r() * 13);
  const pillarR = lerp(4, 7, r());
  const elevDeg = lerp(5, 13, r());
  const tiltDeg = (r() < 0.5 ? -1 : 1) * lerp(10, 70, r());

  const { up, east, north } = enu(latDeg, lonDeg);
  const b = rad(bearingDeg);
  const e = rad(elevDeg);
  const dir = east.clone().multiplyScalar(Math.sin(b)).addScaledVector(north, Math.cos(b)).multiplyScalar(Math.cos(e)).addScaledVector(up, Math.sin(e));
  // 视线与半径 R + h 的球求交（相机在球里面，取往外那个根）
  const P = up.clone().multiplyScalar(EARTH_R_KM + altKm);
  const R1 = EARTH_R_KM + hKm;
  const pb = P.dot(dir);
  const lam = -pb + Math.sqrt(pb * pb - (P.lengthSq() - R1 * R1));
  const x0 = P.clone().addScaledVector(dir, lam).normalize();
  // X0 处与视线垂直的「横向」E1、视线竖直面内的 E2；环在 X0 处的切向 = cosψ·E1 + sinψ·E2
  const e1 = new THREE.Vector3().crossVectors(x0, dir).normalize();
  const e2 = new THREE.Vector3().crossVectors(e1, x0).normalize();
  const psi = rad(tiltDeg);
  const tng = e1.clone().multiplyScalar(Math.cos(psi)).addScaledVector(e2, Math.sin(psi));
  const pole = new THREE.Vector3().crossVectors(x0, tng).normalize();
  // 参考点 = 观察点在环平面上的投影方向：支柱排在它两侧半个间距以外
  const ref = up.clone().addScaledVector(pole, -up.dot(pole)).normalize();
  // 锚点：X0 的星下点（太远时沿同一方位收到 1200 km，系统超过 1500 km 会判「飞过去了」）
  const dKm = Math.min(EARTH_R_KM * Math.acos(THREE.MathUtils.clamp(up.dot(x0), -1, 1)), 1200);
  const d = dKm / EARTH_R_KM;
  const p1 = rad(latDeg);
  const lat2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const lon2 = rad(lonDeg) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(lat2));
  return {
    hKm,
    halfW,
    depth,
    rimR,
    pillars,
    pillarR,
    pole: [pole.x, pole.y, pole.z],
    ref: [ref.x, ref.y, ref.z],
    anchor: [deg(lat2), ((deg(lon2) + 540) % 360) - 180],
    elevDeg,
    tiltDeg,
  };
}

export function createRingUniforms() {
  return {
    uRingOn: { value: 0 },
    uRingN: { value: new THREE.Vector3(0, 0, 1) },
    uRingA: { value: new THREE.Vector3(1, 0, 0) },
    uRingGeo: { value: new THREE.Vector4(RENDER_R_KM + 1000, 80, 10, 4) },
    uRingDet: { value: new THREE.Vector4(0.25, 4, 2, 0) },
  };
}

const _n = new THREE.Vector3();
const _a = new THREE.Vector3();

/**
 * 每帧：把固定在地球上的环平面法线 / 参考点转到窗外坐标（x 东、y 天顶、−z 北，原点在地心），写 uniform。
 * reveal（0..1）是浮现前沿：环从地平线往上一段段显出来（前沿是「视线仰角的正弦」，见 ring.glsl.ts）。
 */
export function applyRingUniforms(u: ReturnType<typeof createRingUniforms>, ring: RingShape, latDeg: number, lonDeg: number, reveal: number, seed: number) {
  const { up, east, north } = enu(latDeg, lonDeg);
  const toWin = (v: [number, number, number], out: THREE.Vector3) => {
    const x = v[0] * east.x + v[1] * east.y + v[2] * east.z;
    const y = v[0] * up.x + v[1] * up.y + v[2] * up.z;
    const z = -(v[0] * north.x + v[1] * north.y + v[2] * north.z);
    return out.set(x, y, z);
  };
  const n = toWin(ring.pole, _n).normalize();
  const a = toWin(ring.ref, _a);
  a.addScaledVector(n, -a.dot(n)).normalize();
  u.uRingN.value.copy(n);
  u.uRingA.value.copy(a);
  u.uRingGeo.value.set(RENDER_R_KM + ring.hKm, ring.halfW, ring.depth, ring.rimR);
  const e = reveal * reveal * (3 - 2 * reveal);
  u.uRingDet.value.set((2 * Math.PI) / ring.pillars, ring.pillarR, -0.1 + 1.2 * e, seed);
  u.uRingOn.value = reveal > 0 ? 1 : 0;
}
