/**
 * 云间层奇观的接口（W00）：奇观插进云的光线步进（clouds.ts 的 MARCH_FRAG），和云互相遮挡、一起做时间累积。
 * 设计依据 research/WONDERS.md §3.3 方案 A。给 W02（雾海灯城）、W03（浮空古城）用，说明见 handoff/W00.md。
 *
 * 一个云间层奇观（「种类」，WonderCloudKind）可以提供三样东西，都在**奇观局部坐标**里（km；原点在奇观锚点正下方的海平面，
 * x 东、y 天顶、z 南，和窗外坐标同一套朝向约定），全部可选：
 *  - 表面（sdf + shade）：解析距离场。步进前沿视线在包围盒里球面追踪一次，得到命中深度 tW、覆盖率 α（按像素张角解析抗锯齿）
 *    和预乘辐亮度；云的步进走到 tW 时插进去：L += T·Lw，T *= 1 − α。α = 1 时身后的云不再步进（省步数）。
 *  - 介质（medium）：消光系数 σ（1/km）+ 单次散射反照率 + 体积自发光（辐亮度 / km）。在包围盒里和云的密度一起步进，
 *    受光用云自己的那一套（朝主光源的受光步进 = 云在它上面投的影、多次散射近似、天空光），所以雾罩和云的光照天然一致。
 *  - 投影（caster）：一个椭球，挡住云（和奇观自己的介质）受到的直射光——「岛在云海上投下影子」。
 * 没有云间层奇观时（uWonderVol = 0）步进只多几次 uniform 判断，不增加步数；普通场景的像素结果与改动前一致。
 *
 * 加一个种类：在下面的 WONDER_CLOUD_KINDS 里加一项（glsl 源码 + 函数名），catalog.ts 里给奇观写 volume.kind。
 * 函数一律带模块前缀（GLSL 没有命名空间，见 README 坑点）；分派函数各只调用一处，FXC 按调用点内联，冷编译随种类数线性增长。
 */

import * as THREE from "three";

/** 云间层奇观的 uniform（WonderSystem 持有、每帧写；clouds.ts 的步进材质先铺一份默认值，再被场景共用的这份覆盖） */
export function createWonderCloudUniforms() {
  return {
    uWonderVol: { value: 0 },
    uWonderUse: { value: new THREE.Vector2(0, 0) },
    uWonderCam: { value: new THREE.Vector3() },
    uWonderToLocal: { value: new THREE.Matrix3() },
    uWonderBoxMin: { value: new THREE.Vector3() },
    uWonderBoxMax: { value: new THREE.Vector3() },
    uWonderParams: { value: new THREE.Vector4() },
    uWonderCaster: { value: new THREE.Vector4() },
    uWonderCasterR: { value: new THREE.Vector3(1, 1, 1) },
    uWonderStep: { value: 0.25 },
  };
}

export interface WonderCloudKind {
  /** 种类编号（uWonderVol 的值），从 1 开始 */
  id: number;
  /** 注释用的名字 */
  name: string;
  /** 定义下面几个函数的 GLSL 源码（可以读 CLOUD_COMMON / LIGHTS_COMMON / ATMOSPHERE_COMMON 里的一切，和 uWonderParams） */
  glsl: string;
  /** `float f(vec3 q)`：到表面的距离（km），必须是真实距离的下界（球面追踪按它前进）；可以顺手写 gWonderMat 选材质 */
  sdf?: string;
  /** `vec3 f(vec3 q, vec3 n, vec3 pW, vec3 nW, vec3 rd)`：表面辐亮度（kcd/m²，不含空气透视——步进最后统一加）。
   *  q / n 是局部坐标的点和法线，pW / nW 是窗外坐标（相机在 (0, uCamR, 0)）；可以用 wonderLitSurface 做标准受光 */
  shade?: string;
  /** `float f(vec3 q, out vec3 albedo, out vec3 emit)`：返回消光系数 σ（1/km），albedo 单次散射反照率，emit 体积自发光（kcd/m² / km） */
  medium?: string;
}

// ---------------- 测试体（W00 验证接口用，不参与随机挑选，不进面板） ----------------
// 一块倒锥形的浮空岩（顶面 3 km 半径，锥尖在 2.5 km，顶上一层偏绿的「树冠」穹顶）+ 腰上一圈雾环（介质）+ 投影椭球。
// 只在 URL 带 ?w00probe 时编进步进程序（不让它平白增加所有人的冷编译）。
const PROBE_GLSL = /* glsl */ `
float w00ProbeCone(vec3 p, float h, float r1, float r2) {
  // 圆台（iq）：中心在原点、半高 h，底半径 r1、顶半径 r2
  vec2 q = vec2(length(p.xz), p.y);
  vec2 k1 = vec2(r2, h);
  vec2 k2 = vec2(r2 - r1, 2.0 * h);
  vec2 ca = vec2(q.x - min(q.x, q.y < 0.0 ? r1 : r2), abs(q.y) - h);
  vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}
float w00ProbeSdf(vec3 q) {
  float rock = w00ProbeCone(q - vec3(0.0, 4.25, 0.0), 1.75, 0.15, 3.0);
  // 水平层理：只往里刻，幅度小（保持距离下界）
  rock += 0.05 * (0.5 + 0.5 * sin(q.y * 11.0 + 1.7 * sin(atan(q.z, q.x) * 3.0)));
  vec3 e = (q - vec3(0.0, 6.0, 0.0)) / vec3(2.6, 0.9, 2.6);
  float crown = (length(e) - 1.0) * 0.9;
  gWonderMat = crown < rock ? 1.0 : 0.0;
  return min(rock, crown) * 0.85;
}
vec3 w00ProbeShade(vec3 q, vec3 n, vec3 pW, vec3 nW, vec3 rd) {
  vec3 albedo = gWonderMat > 0.5 ? vec3(0.06, 0.09, 0.05) : vec3(0.20, 0.18, 0.16);
  return wonderLitSurface(pW, nW, albedo);
}
float w00ProbeMedium(vec3 q, out vec3 albedo, out vec3 emit) {
  albedo = vec3(0.95);
  emit = vec3(0.0);
  float ring = length(vec2(length(q.xz) - 3.2, q.y - 4.2));
  if (ring > 0.9) return 0.0;
  float n = textureLod(uShapeNoise, q * 0.3, 0.0).r;
  return 4.0 * smoothstep(0.9, 0.3, ring) * smoothstep(0.35, 0.7, n) * uWonderParams.x;
}
`;

// 浏览器里看 URL；离线检查（check:glsl，在 Node 里）用环境变量 W00_PROBE=1 把测试体也拼进去校验
const PROBE_ENABLED =
  (typeof location !== "undefined" && /[?&]w00probe\b/.test(location.search)) ||
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.W00_PROBE === "1";

/** 已注册的云间层奇观种类。W02 / W03 往这里加 */
export const WONDER_CLOUD_KINDS: WonderCloudKind[] = [
  ...(PROBE_ENABLED
    ? [{ id: 1, name: "W00 测试体", glsl: PROBE_GLSL, sdf: "w00ProbeSdf", shade: "w00ProbeShade", medium: "w00ProbeMedium" }]
    : []),
];

/** 测试体的种类编号（catalog.ts 的调试条目用） */
export const W00_PROBE_KIND = 1;
export const W00_PROBE_COMPILED = PROBE_ENABLED;

function dispatch(kinds: WonderCloudKind[], field: "sdf" | "shade" | "medium", call: string, fallback: string) {
  const cases = kinds
    .filter((k) => k[field])
    .map((k) => `  if (k == ${k.id}) return ${k[field]}(${call});`)
    .join("\n");
  return `${cases}\n  return ${fallback};`;
}

/**
 * 云间层奇观的 GLSL（只拼进云步进程序；需要 ATMOSPHERE_COMMON、VIEW_COMMON、CLOUD_COMMON、LIGHTS_COMMON 在前面）。
 * 窗外 / 舱内 / 机翼程序都不拼它，改它只重编云步进。
 */
export function wonderCloudGlsl(kinds: WonderCloudKind[] = WONDER_CLOUD_KINDS) {
  return /* glsl */ `
uniform float uWonderVol;       // 0：没有云间层奇观；> 0：在场奇观的种类编号
uniform vec2 uWonderUse;        // x：有表面；y：有介质
uniform vec3 uWonderCam;        // 相机在奇观局部坐标里的位置（km）
uniform mat3 uWonderToLocal;    // 窗外坐标方向 → 奇观局部坐标方向（行 = 局部的东、天顶、南）
uniform vec3 uWonderBoxMin;     // 局部坐标的包围盒（km）：表面和介质都必须在里面
uniform vec3 uWonderBoxMax;
uniform vec4 uWonderParams;     // x：reveal（0..1）；y：时间（真实秒，循环）；zw：各奇观自用
uniform vec4 uWonderCaster;     // 投影椭球：xyz 中心（局部坐标），w：1 = 启用
uniform vec3 uWonderCasterR;    // 投影椭球的三个半轴（km）
uniform float uWonderStep;      // 在介质包围盒里的最大步长（km）

float gWonderMat = 0.0;         // sdf 可以写它来区分材质（命中那一刻的值传给 shade）

// 标准受光（给种类的 shade 用）：直射主光源 × 云影 + 天光 + 下方云海 / 海面的反射光。pW / nW 是窗外坐标
vec3 wonderLitSurface(vec3 pW, vec3 nW, vec3 albedo) {
  float r = length(pW);
  vec3 up = pW / r;
  // 云影图只算 3 km 以上的起点（见 cloudShadow），高于所有云时不查
  float vis = r - BOTTOM > uShellTop ? 1.0 : cloudShadow(pW, uKeyDir);
  vec3 key = keyLight(r, up) * vis;
  vec3 direct = key * max(dot(nW, uKeyDir), 0.0);
  float upness = dot(nW, up);
  vec3 sky = skyIrradiance(r, up) * (0.5 + 0.5 * upness);
  // 朝下的面看到的是被照亮的云海 / 海面：反照率按云量粗估（和云步进的 albedoBelow 同一量级）
  vec3 below = keyLight(BOTTOM + 1.0, up) * max(dot(up, uKeyDir), 0.0) * (0.06 + 0.5 * uCoverage) * (0.5 - 0.5 * upness);
  return albedo / M_PI * (direct + sky + below);
}

// ---- 各种类的函数（要在分派函数之前定义）----
${kinds.map((k) => `// ---- 种类 ${k.id}：${k.name} ----\n${k.glsl}`).join("\n")}

// ---- 分派（各只有一个调用点）----
float wonderSdf(vec3 q) {
  int k = int(uWonderVol + 0.5);
${dispatch(kinds, "sdf", "q", "1e9")}
}
vec3 wonderShade(vec3 q, vec3 n, vec3 pW, vec3 nW, vec3 rd) {
  int k = int(uWonderVol + 0.5);
${dispatch(kinds, "shade", "q, n, pW, nW, rd", "vec3(0.0)")}
}
float wonderMedium(vec3 q, out vec3 albedo, out vec3 emit) {
  albedo = vec3(0.0);
  emit = vec3(0.0);
  int k = int(uWonderVol + 0.5);
${dispatch(kinds, "medium", "q, albedo, emit", "0.0")}
}

// 视线（从相机出发，窗外坐标方向 rd）穿过奇观包围盒的区间 [t0, t1]；穿不过时 t1 < t0。被地球挡住的部分截掉
vec2 wonderInterval(vec3 ro, vec3 rd) {
  vec3 d = uWonderToLocal * rd;
  vec3 inv = 1.0 / (d + vec3(1e-9));
  vec3 a = (uWonderBoxMin - uWonderCam) * inv;
  vec3 b = (uWonderBoxMax - uWonderCam) * inv;
  vec3 tn = min(a, b), tf = max(a, b);
  float t0 = max(max(tn.x, tn.y), max(tn.z, 0.0));
  float t1 = min(min(tf.x, tf.y), tf.z);
  vec2 g = raySphere2(ro, rd, BOTTOM);
  if (g.x > 0.0) t1 = min(t1, g.x);
  return vec2(t0, t1);
}

// 窗外坐标的点（相机相对，相机在 ro）→ 奇观局部坐标
vec3 wonderLocal(vec3 p, vec3 ro) { return uWonderCam + uWonderToLocal * (p - ro); }

// 表面：在 [seg.x, seg.y] 里球面追踪。返回 (预乘辐亮度, 覆盖率 α)，tHit 为插入深度（km）。
// pixAng：一个像素的张角（弧度）。抗锯齿：命中 α = 1；没命中时按视线离表面最近处的「距离 / 像素足迹」给覆盖率，
// 在那一点着色（轮廓外半个像素的渐变，和 wing / traffic 的解析覆盖同一思路）。
// 追踪和法线的 4 次取样放在同一个循环里：wonderSdf 只有一个调用点（FXC 按调用点内联）；上界依赖 uniform，不展开
const int WONDER_TRACE_STEPS = 80;
vec4 wonderSurface(vec3 ro, vec3 rd, vec2 seg, float pixAng, out float tHit) {
  tHit = 1e9;
  if (uWonderUse.x < 0.5) return vec4(0.0);
  vec3 o = uWonderCam;
  vec3 d = uWonderToLocal * rd;
  float t = seg.x;
  float bestR = 1e9;   // 最近处的「距离 / 像素足迹」
  float bestT = seg.x;
  float bestMat = 0.0;
  bool shading = false;
  bool hit = false;
  vec3 qS = o;
  float eps = 0.001;
  vec3 n = vec3(0.0);
  int tap = 0;
  float mat = 0.0;
  for (int i = 0; i < WONDER_TRACE_STEPS + 4 + min(uStormCount, 0); i++) {
    vec3 q;
    if (shading) {
      // 四面体法线：(+,−,−) (−,−,+) (−,+,−) (+,+,+)
      vec3 e = tap == 0 ? vec3(1.0, -1.0, -1.0) : tap == 1 ? vec3(-1.0, -1.0, 1.0) : tap == 2 ? vec3(-1.0, 1.0, -1.0) : vec3(1.0);
      q = qS + e * eps;
      n += e * wonderSdf(q);
      tap++;
      if (tap == 4) break;
      continue;
    }
    q = o + d * t;
    float dist = wonderSdf(q);
    float fp = max(t * pixAng, 1e-4);
    float ratio = dist / fp;
    if (ratio < bestR) { bestR = ratio; bestT = t; bestMat = gWonderMat; }
    bool done = false;
    if (dist < 0.2 * fp) { hit = true; done = true; bestT = t; mat = gWonderMat; }
    else {
      t += max(dist, 0.3 * fp);
      if (t > seg.y || i >= WONDER_TRACE_STEPS - 1) { done = true; mat = bestMat; }
    }
    if (done) {
      // 没命中、也没擦到像素足迹以内：不用算法线了
      if (!hit && bestR > 0.5) return vec4(0.0);
      shading = true;
      qS = o + d * bestT;
      eps = max(0.5 * bestT * pixAng, 0.002);
    }
  }
  if (!shading) return vec4(0.0);
  float alpha = hit ? 1.0 : clamp(0.5 - bestR, 0.0, 1.0);
  n = normalize(n + vec3(1e-9));
  vec3 nW = transpose(uWonderToLocal) * n;
  tHit = bestT;
  gWonderMat = mat;
  vec3 pW = ro + rd * bestT;
  return vec4(wonderShade(qS, n, pW, nW, rd) * alpha, alpha);
}

// 投影：视线上的点朝主光源看，被投影椭球挡住多少。按「光线离椭球中心的最近距离」m（椭球归一化后）软化半影：
// m < 0.8 全影、> 1.15 没挡。视线上的点 p(t) 在归一化空间里是 t 的线性函数，m² 就是 t 的二次式，
// 所以每条视线在步进前算一次「在影子柱里的区间」和二次式系数（shSeg、shQ），循环里只做区间判断和一次开方。
// 以前逐采样点做完整的椭球测试：即使没有奇观（分支不走），云步进也从 0.35 涨到 0.71 ms（寄存器 / 编译器排布，W00 实测）
const float WONDER_PENUMBRA_OUT = 1.15;
vec2 wonderCasterSegment(vec3 rd, out vec3 shQ) {
  shQ = vec3(1e9, 0.0, 0.0);
  if (uWonderCaster.w < 0.5) return vec2(1e9, -1e9);
  vec3 A = (uWonderCam - uWonderCaster.xyz) / uWonderCasterR;
  vec3 B = (uWonderToLocal * rd) / uWonderCasterR;
  vec3 D = (uWonderToLocal * uKeyDir) / uWonderCasterR;
  float D2 = dot(D, D);
  // 垂直于光线的分量：P(t) = P0 + P1·t
  vec3 P0 = A - D * (dot(A, D) / D2);
  vec3 P1 = B - D * (dot(B, D) / D2);
  shQ = vec3(dot(P0, P0), 2.0 * dot(P0, P1), dot(P1, P1));
  // m² < 外沿² 的区间
  float c = shQ.x - WONDER_PENUMBRA_OUT * WONDER_PENUMBRA_OUT;
  float a = max(shQ.z, 1e-12);
  float disc = shQ.y * shQ.y - 4.0 * a * c;
  if (disc <= 0.0) return vec2(1e9, -1e9);
  float sq = sqrt(disc);
  vec2 seg = vec2((-shQ.y - sq) / (2.0 * a), (-shQ.y + sq) / (2.0 * a));
  // 只在椭球背光的一侧（点到椭球中心的向量和光线方向相反）：dot(A + B·t, D) < 0
  float s0 = dot(A, D), s1 = dot(B, D);
  if (abs(s1) > 1e-9) {
    float tz = -s0 / s1;
    if (s1 > 0.0) seg.y = min(seg.y, tz); else seg.x = max(seg.x, tz);
  } else if (s0 >= 0.0) return vec2(1e9, -1e9);
  seg.x = max(seg.x, 0.0);
  return seg;
}
float wonderCasterVis(float t, vec3 shQ) {
  return smoothstep(0.8, WONDER_PENUMBRA_OUT, sqrt(max(shQ.x + t * (shQ.y + t * shQ.z), 0.0)));
}
`;
}
