import * as THREE from "three";

/**
 * 垂直大陆（WS09，research/WONDER_SCALE.md §3.6 候选 3「垂直大陆」、§4 WS09）：每次出现按种子随机，着色见 wonders/continent.glsl.ts。
 *
 * 一整块从海面 / 云海里竖起来的「大陆」：平面上是一块长 280–600 km、宽 90–220 km 的台地（主块，凸多边形，边是一段段几十 km 长的崖面），
 * 四周是几乎竖直（后仰 1.5–5°）的岩壁，顶沿（悬崖边）高 30–90 km——比雷暴云顶高 2–5 倍，远远高过巡航高度，要仰视。
 * 朝着飞机的一侧另有 2–4 块「岬角 / 离岸孤台」（小一些的凸块：有的贴着主壁往外凸、顶比主壁低一截，有的更高、像一只角，
 * 有的离开主壁几十 km 独自立在海上），一层层往后退、一层比一层蓝——层叠的剪影本身就是尺度。
 * 近端的「船首」（主块的一个角）放在锚点（离飞机 200–290 km），主块从这里斜着往地平线退去（长轴与视线夹 20°–60°，左右随机）：
 * 远处的一段沉到地平线以下、只剩顶沿。数字是科幻尺度（WONDERS.md §1.1：尺度夸张到公里级本身就是「这不是真实世界」的信号）。
 *
 * 坐标：锚点处的水平坐标（x 东、z 南，km），y 沿锚点的铅垂线往上（离锚点处切平面的高度）。
 * 每块按固定绕向存（着色器里外法线 = normalize(Δz, −Δx)，边向量 (Δx, Δz)，要求 Σ(x_k·z_{k+1} − x_{k+1}·z_k) > 0）。
 * 主块的顶点 0 放在离飞机最远的一端（周长坐标 u 的首尾接缝在看不见的背面）；各块的 u 错开几千 km，花纹互不相关。
 */
/** 最多几块（主块 + 岬角 / 孤台）、所有块的顶点槽位合计（每块前补一个、后补两个） */
export const CONT_BLOCKS = 5;
export const CONT_MAIN_MAX = 16;
export const CONT_SAT_MAX = 6;
export const CONT_ARRAY = CONT_MAIN_MAX + 3 + (CONT_BLOCKS - 1) * (CONT_SAT_MAX + 3);

/** 垂直大陆在 catalog 里的皮肤编号（look.skin）：0 天梯、1 建木、2 巨柱群、3 天环已被占用（分配表见 catalog.ts 顶部） */
export const CONT_SKIN = 4;

export interface ContinentBlock {
  /** 顶点：[x 东, z 南（km）, 顶沿高度（km）, 周长坐标 u（km）] */
  verts: [number, number, number, number][];
  perimeter: number;
  center: [number, number];
  radius: number;
  /** 岩壁后仰的斜率（tan） */
  lean: number;
}

export interface ContinentShape {
  blocks: ContinentBlock[];
  /** 整体的中心与包围半径（km，含航迹云等余量） */
  center: [number, number];
  bound: number;
  /** 岩石反照率（按岩性：红砂岩 / 花岗岩灰 / 玄武岩暗 / 石灰岩浅） */
  rock: [number, number, number];
  /** 层理：主层厚（km）、细层厚（km）、倾斜梯度（x、z 方向每 km 升高多少 km） */
  strata: [number, number, number, number];
  /** 冲沟：间距（km）、法线方位摆幅（弧度）；瀑布：格长（km）、每格有瀑布的概率 */
  gully: [number, number, number, number];
  /** 冰盖覆盖比例（0 = 没有冰盖）、脚下云墙高（km）、贴壁云带高（km，0 = 没有）、风向（弧度） */
  weather: [number, number, number, number];
  /** 同高度航班的航迹云：[航向（弧度，东起往南）, 过哪一点 x, z（km）, 高度（km）]，相位另存 */
  contrail: [number, number, number, number];
  contrailPhase: number;
  /** 最高的顶沿（km，面板描述用）、主块长轴全长（km） */
  maxH: number;
  lengthKm: number;
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

type P2 = [number, number];

/** 凸包（Andrew 单调链），返回 Σ(x·z' − x'·z) > 0 的绕向 */
function hull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** 顶点多于 max 时去掉转角最小的（几乎在一条直线上的） */
function decimate(poly: P2[], max: number) {
  while (poly.length > max) {
    let best = 0;
    let bestTurn = Infinity;
    for (let k = 0; k < poly.length; k++) {
      const p0 = poly[(k + poly.length - 1) % poly.length];
      const p1 = poly[k];
      const p2 = poly[(k + 1) % poly.length];
      const t =
        Math.abs((p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0])) /
        (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + 1e-9);
      if (t < bestTurn) {
        bestTurn = t;
        best = k;
      }
    }
    poly.splice(best, 1);
  }
  return poly;
}

/** 超椭圆上 n 个点（半径各自抖一点）的凸包：a、b 半轴，p 指数（越大越方），rot 旋转，c 中心 */
function blob(r: () => number, n: number, a: number, b: number, p: number, rot: number, c: P2, jitter: number): P2[] {
  const raw: P2[] = [];
  const ph0 = r() * Math.PI * 2;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let k = 0; k < n; k++) {
    const t = ph0 + ((k + 0.7 * (r() - 0.5)) / n) * Math.PI * 2;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const jr = 1 + jitter * (r() - 0.5);
    const x = a * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / p) * jr;
    const y = b * Math.sign(st) * Math.pow(Math.abs(st), 2 / p) * jr;
    raw.push([c[0] + x * cr - y * sr, c[1] + x * sr + y * cr]);
  }
  return hull(raw);
}

/**
 * seed：0..1；awayDeg：从飞机看锚点的方位角（度，从正北顺时针）；distKm：锚点离飞机多远（航迹云摆在飞机与岩壁之间）。
 */
export function continentShape(seed: number, awayDeg: number, distKm: number): ContinentShape {
  const r = rng(seed);
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  const bRad = THREE.MathUtils.degToRad(awayDeg);
  // 东、南坐标里「往远处」的方向；飞机约在 −away·dist
  const away: P2 = [Math.sin(bRad), -Math.cos(bRad)];
  const cam: P2 = [-away[0] * distKm, -away[1] * distKm];
  // 主块长轴：从视线方向往左 / 右转 20°–60°（斜着往地平线退去，近端的船首和一整面侧壁都在窗里）
  const th = (r() < 0.5 ? -1 : 1) * THREE.MathUtils.degToRad(lerp(20, 60, r()));
  const L: P2 = [away[0] * Math.cos(th) - away[1] * Math.sin(th), away[0] * Math.sin(th) + away[1] * Math.cos(th)];
  const Ll = lerp(140, 300, r());
  const Lw = lerp(45, 110, r());
  const pw = lerp(2.4, 4.0, r());
  // 船首放在锚点：主块中心在锚点沿 +L 方向 Ll 处
  const mainC: P2 = [Ll * L[0], Ll * L[1]];
  const mainPoly = decimate(blob(r, 24, Ll, Lw, pw, Math.atan2(L[1], L[0]), mainC, 0.14), CONT_MAIN_MAX);
  // 顶沿高度：沿长轴一段主峰台地（60–88 km），两头的肩部低一些（32–45 km）；每个顶点再抖 ±2.5 km
  const Hbase = lerp(32, 45, r());
  const Hmax = lerp(60, 88, r());
  // 主峰偏向近端（船首附近最高：离得最近的一段顶沿最高，仰角最大）
  const sp = lerp(-1.0, -0.2, r());
  const wid = lerp(0.35, 0.8, r());
  const heightAt = (p: P2) => {
    const s = ((p[0] - mainC[0]) * L[0] + (p[1] - mainC[1]) * L[1]) / Ll; // −1 船首 … +1 尾端
    return Hbase + (Hmax - Hbase) * Math.exp(-(((s - sp) / wid) ** 2));
  };

  const polys: { pts: P2[]; hMul: number; lean: number }[] = [{ pts: mainPoly, hMul: 1, lean: Math.tan(THREE.MathUtils.degToRad(lerp(1.5, 7, r()))) }];
  // 岬角 / 离岸孤台：挂在主块朝着飞机的那几条边上（偏近端）
  const facing: { p: P2; m: P2 }[] = [];
  for (let k = 0; k < mainPoly.length; k++) {
    const a = mainPoly[k];
    const b = mainPoly[(k + 1) % mainPoly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m: P2 = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
    const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (m[0] * (cam[0] - mid[0]) + m[1] * (cam[1] - mid[1]) > 0.2 * Math.hypot(cam[0] - mid[0], cam[1] - mid[1])) {
      // 这条边上按长度摆几个候选点
      const nC = Math.max(1, Math.round(len / 25));
      for (let j = 0; j < nC; j++) {
        const u = (j + 0.5) / nC;
        facing.push({ p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], m });
      }
    }
  }
  // 按离飞机的距离排序，偏向近端取
  facing.sort((x, y) => Math.hypot(x.p[0] - cam[0], x.p[1] - cam[1]) - Math.hypot(y.p[0] - cam[0], y.p[1] - cam[1]));
  const nSat = facing.length ? 2 + Math.floor(r() * 3) : 0; // 2–4
  const used: number[] = [];
  for (let j = 0; j < nSat; j++) {
    let idx = Math.floor(Math.pow(r(), 1.6) * facing.length);
    // 别和已有的挤在一起
    for (let tries = 0; tries < 6 && used.some((q) => Math.abs(q - idx) < 2); tries++) idx = Math.floor(r() * facing.length);
    used.push(idx);
    const f = facing[idx];
    const kind = r();
    const detached = kind < 0.3; // 离岸孤台：独自立在海上
    const tower = !detached && kind > 0.8; // 高出主壁的一只角
    const ra = detached ? lerp(6, 16, r()) : lerp(12, 34, r());
    const rb = detached ? ra * lerp(0.55, 0.95, r()) : lerp(7, 20, r());
    const out = detached ? ra + lerp(15, 45, r()) : lerp(-0.6, 0.35, r()) * rb;
    const c: P2 = [f.p[0] + f.m[0] * out, f.p[1] + f.m[1] * out];
    const rot = Math.atan2(f.m[1], f.m[0]) + Math.PI / 2 + lerp(-0.6, 0.6, r());
    const pts = decimate(blob(r, 9, ra, rb, lerp(2.2, 3.6, r()), rot, c, 0.2), CONT_SAT_MAX);
    const hMul = detached ? lerp(0.35, 0.8, r()) : tower ? lerp(1.04, 1.22, r()) : lerp(0.45, 0.85, r());
    // 贴着主壁的岬角后仰得多（8–22°：像一道从墙上伸出来的山脊 / 扶壁，不是摆在墙前的一只箱子）；离岸孤台仍是陡壁的桌状山
    polys.push({ pts, hMul, lean: Math.tan(THREE.MathUtils.degToRad(detached || tower ? lerp(1.5, 5, r()) : lerp(8, 22, r()))) });
  }

  const blocks: ContinentBlock[] = [];
  let maxH = 0;
  polys.forEach((pl, bi) => {
    let pts = pl.pts;
    let area = 0;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const q = pts[(k + 1) % pts.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    if (area < 0) pts = pts.reverse();
    // 顶点 0 放到离飞机最远的一端
    let far = 0;
    let farD = -1;
    pts.forEach((p, k) => {
      const d = Math.hypot(p[0] - cam[0], p[1] - cam[1]);
      if (d > farD) {
        farD = d;
        far = k;
      }
    });
    pts = pts.slice(far).concat(pts.slice(0, far));
    const verts: ContinentBlock["verts"] = [];
    let u = bi * 5000;
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const H = heightAt(p) * pl.hMul + 2.5 * (r() - 0.5) * 2;
      maxH = Math.max(maxH, H);
      verts.push([p[0], p[1], H, u]);
      const q = pts[(k + 1) % pts.length];
      u += Math.hypot(q[0] - p[0], q[1] - p[1]);
      cx += p[0] / pts.length;
      cz += p[1] / pts.length;
    }
    let radius = 0;
    for (const v of verts) radius = Math.max(radius, Math.hypot(v[0] - cx, v[1] - cz));
    blocks.push({ verts, perimeter: u - bi * 5000, center: [cx, cz], radius: radius + 2, lean: pl.lean });
  });
  let bound = 0;
  for (const b of blocks) bound = Math.max(bound, Math.hypot(b.center[0] - mainC[0], b.center[1] - mainC[1]) + b.radius);

  // 岩性：红砂岩 / 花岗岩灰 / 玄武岩暗 / 石灰岩浅（反照率按真实岩石的量级；偏暗的更常见——远看不发白）
  const rocks: [number, number, number][] = [
    [0.22, 0.12, 0.065],
    [0.16, 0.14, 0.12],
    [0.09, 0.08, 0.07],
    [0.26, 0.21, 0.15],
  ];
  const rk = rocks[Math.floor(r() * rocks.length) % rocks.length];
  const tint = lerp(0.9, 1.1, r());
  const rock: [number, number, number] = [rk[0] * tint, rk[1] * tint, rk[2] * tint];
  const dipA = r() * Math.PI * 2;
  const dipM = lerp(0, 0.035, r());
  const strata: ContinentShape["strata"] = [lerp(2.2, 4.5, r()), lerp(0.5, 1.0, r()), dipM * Math.cos(dipA), dipM * Math.sin(dipA)];
  const gully: ContinentShape["gully"] = [lerp(3, 7, r()), lerp(0.2, 0.38, r()), lerp(22, 40, r()), lerp(0.35, 0.7, r())];
  const weather: ContinentShape["weather"] = [r() < 0.55 ? lerp(0.35, 0.8, r()) : 0, lerp(2.0, 4.5, r()), r() < 0.65 ? lerp(8.5, 12.5, r()) : 0, r() * Math.PI * 2];
  // 航迹云：大致横穿窗口（航向与视线夹 55°–90°），在飞机与岩壁之间 90–160 km 处，高 10.3–11.8 km（和我们一样高）
  const dc = lerp(90, 160, r());
  const ca = Math.atan2(away[1], away[0]) + (r() < 0.5 ? -1 : 1) * THREE.MathUtils.degToRad(lerp(55, 90, r()));
  const contrail: ContinentShape["contrail"] = [ca, cam[0] + away[0] * dc, cam[1] + away[1] * dc, lerp(10.3, 11.8, r())];
  const contrailPhase = r();
  return { blocks, center: mainC, bound: bound + 20, rock, strata, gully, weather, contrail, contrailPhase, maxH, lengthKm: 2 * Ll };
}

/** 垂直大陆的 uniform（和 WonderSystem.uniforms 合在一起；只有窗外 OWV 变体读，开关 uContOn 不经 uWonderOn） */
export function createContinentUniforms() {
  return {
    /** 1 = 垂直大陆在场（OWV 变体才画；天梯 / 建木那段看的是 uWonderOn，互不相干） */
    uContOn: { value: 0 },
    /** 所有块的顶点：每块前补上一个、后补两个；x 东、z 南（km）、顶沿高、周长坐标 */
    uContP: { value: Array.from({ length: CONT_ARRAY }, () => new THREE.Vector4()) },
    /** 每块两格：[起始下标, 顶点数, 后仰斜率, 包围半径]、[中心 x, z, 最高顶沿（km）, 0] */
    uContB: { value: Array.from({ length: CONT_BLOCKS * 2 }, () => new THREE.Vector4()) },
    /** xyz 锚点处「东」（窗外坐标），w 块数 */
    uContE: { value: new THREE.Vector4(1, 0, 0, 0) },
    /** xyz 锚点处「南」，w 整体包围半径（km） */
    uContS: { value: new THREE.Vector4(0, 0, 1, 0) },
    /** xyz 相机在局部坐标里的位置（km，CPU 双精度算），w 种子 */
    uContC: { value: new THREE.Vector4() },
    /** xy 整体中心（km），z 未用，w 浮现前沿（km） */
    uContA: { value: new THREE.Vector4() },
    /** 层理：主层厚、细层厚、倾斜梯度 x、z */
    uContT: { value: new THREE.Vector4(3, 0.7, 0, 0) },
    /** 冲沟间距、摆幅；瀑布格长、概率 */
    uContG: { value: new THREE.Vector4(4, 0.3, 30, 0.5) },
    /** 冰盖比例、脚下云墙高、贴壁云带高、风向 */
    uContW: { value: new THREE.Vector4() },
    /** 航迹云：航向、过点 x、z、高度 */
    uContK: { value: new THREE.Vector4() },
    /** 岩石反照率 rgb，w 航迹云相位 */
    uContR: { value: new THREE.Vector4(0.3, 0.3, 0.3, 0) },
  };
}

const _pole = new THREE.Vector3();
const _east = new THREE.Vector3();
const _south = new THREE.Vector3();
const _rel = new THREE.Vector3();
/** 渲染用的地球半径（km），与着色器的 BOTTOM 一致 */
const RENDER_R_KM = 6360;

/**
 * 每帧写 uniform。axis：地心 → 锚点（窗外坐标）；latDeg / altKm：飞机的纬度与高度；front：浮现前沿（km）。
 * 锚点处的东 / 南按真实地轴算（同巨柱群），飞机飞过去时台地不会跟着转；相机的局部坐标在 CPU 上用双精度减，着色器里只拿小量。
 */
export function applyContinentUniforms(
  u: ReturnType<typeof createContinentUniforms>,
  s: ContinentShape,
  axis: THREE.Vector3,
  latDeg: number,
  altKm: number,
  front: number,
  seed: number,
) {
  const phi = THREE.MathUtils.degToRad(latDeg);
  _pole.set(0, Math.sin(phi), -Math.cos(phi));
  _east.crossVectors(_pole, axis);
  if (_east.lengthSq() < 1e-12) _east.set(1, 0, 0);
  _east.normalize();
  _south.crossVectors(_east, axis).normalize();
  _rel.set(0, RENDER_R_KM + altKm, 0).addScaledVector(axis, -RENDER_R_KM);
  u.uContE.value.set(_east.x, _east.y, _east.z, s.blocks.length);
  u.uContS.value.set(_south.x, _south.y, _south.z, s.bound);
  u.uContC.value.set(_rel.dot(_east), _rel.dot(axis), _rel.dot(_south), seed);
  u.uContA.value.set(s.center[0], s.center[1], 0, front);
  u.uContT.value.set(...s.strata);
  u.uContG.value.set(...s.gully);
  u.uContW.value.set(...s.weather);
  u.uContK.value.set(...s.contrail);
  u.uContR.value.set(s.rock[0], s.rock[1], s.rock[2], s.contrailPhase);
  let slot = 0;
  for (let bi = 0; bi < CONT_BLOCKS; bi++) {
    const b = s.blocks[bi];
    if (!b) {
      u.uContB.value[2 * bi].set(0, 0, 0, 0);
      u.uContB.value[2 * bi + 1].set(0, 0, 0, 0);
      continue;
    }
    const n = b.verts.length;
    u.uContB.value[2 * bi].set(slot, n, b.lean, b.radius);
    u.uContB.value[2 * bi + 1].set(b.center[0], b.center[1], Math.max(...b.verts.map((v) => v[2])), 0);
    // 下标 slot + i 对应第 (i − 1) mod n 个顶点（i = 0..n + 2）；补在后面的两个顶点周长坐标接着往上数（首尾那条边的 u 连续）
    for (let i = 0; i < n + 3; i++) {
      const v = b.verts[(i - 1 + n) % n];
      u.uContP.value[slot + i].set(v[0], v[1], v[2], i > n ? v[3] + b.perimeter : v[3]);
    }
    slot += n + 3;
  }
  for (let i = slot; i < CONT_ARRAY; i++) u.uContP.value[i].set(0, 0, 0, 0);
  u.uContOn.value = 1;
}
