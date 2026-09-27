/**
 * 云间层奇观的接口（W00）：奇观和云互相遮挡、一起做时间累积。设计依据 research/WONDERS.md §3.3 方案 A（奇观 pass + 插进云的步进）。
 * 给 W02（雾海灯城）、W03（浮空古城）用，说明见 handoff/W00.md。
 *
 * 一个云间层奇观（「种类」，WonderCloudKind）可以提供三样东西，都在**奇观局部坐标**里（km；原点在奇观锚点正下方的海平面
 * 再抬高 baseKm，x 东、y 天顶、z 南，和窗外坐标同一套朝向约定），全部可选：
 *  - 表面（sdf + shade）：解析距离场，在包围盒里球面追踪，按像素张角解析抗锯齿；
 *  - 介质（medium）：消光系数 σ（1/km）+ 单次散射反照率 + 体积自发光（kcd/m² / km），在包围盒里步进；
 *  - 投影（caster）：一个椭球，挡住云（和奇观自己的介质）受到的直射光——「岛在云海上投下影子」。
 *
 * 管线（clouds.ts）：
 *  1. 奇观 pass（WONDER_SURF_FRAG，云分辨率）：每条视线在包围盒里追踪表面、步进介质，合成「一层」：
 *     预乘辐亮度 Lw、不透明度 αw、按不透明度加权的深度 tW。
 *  2. 云步进的奇观变体（#define WONDER_LAYER）：读这一个 texel，步进走到 tW 时插进去（L += T·Lw，T *= 1 − αw，
 *     前面的云挡它、它挡后面的云），αw ≈ 1 时身后的云不再步进；受光时对投影椭球求一次影子。
 *  3. 平时（没有云间层奇观）画的是不带 WONDER_LAYER 的步进程序，预处理后和改动前逐字相同：零开销、冷编译不变。
 * 限制：整个奇观在一条视线上只算「一层」。包围盒里和奇观介质交错的云（例如雾罩里穿插的云）顺序是近似的——
 * 云在 tW 之前的挡住整层、之后的被整层挡住。表面、介质、云分得开的场景（远处的岛、城上的雾海）不受影响。
 *
 * 加一个种类：在下面的 WONDER_CLOUD_KINDS 里加一项（glsl 源码 + 函数名），catalog.ts 里给奇观写 volume.kind。
 * 函数一律带模块前缀（GLSL 没有命名空间，见 README 坑点）；分派函数各只有一个调用点（FXC 按调用点内联）。
 * 这些代码只进奇观 pass（和步进变体的一小段），不进窗外 / 舱内 / 机翼 / 默认步进程序。
 */

import * as THREE from "three";
import { CITY_GLSL } from "./city.glsl";

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
  /** （W02）`vec2 f(vec3 o, vec3 d, vec2 seg)`：把介质的步进区间收窄到真正有介质的那段（o = 相机的局部坐标、d = 视线的局部方向，
   *  seg = 包围盒区间）。包围盒要装下光束等解析部分、比介质高得多时用它省步数；省略 = 整个包围盒 */
  mediumSeg?: string;
  /** （W02）`void f(vec3 o, vec3 d, vec2 seg, float pixAng, out vec4 e0, out vec4 e1, out vec4 e2)`：解析的发光「事件」，
   *  每个 = (预乘辐亮度 rgb, 深度 t)。介质步进走到 t 时插进去（被它前面的介质衰减），在不透明表面之后的乘表面的透过率。
   *  用于比步长细得多的发光体：地面灯带（平面求交）、光束（线积分的闭式解）、点光。没有的事件把 rgb 留 0 */
  ray?: string;
}

// ---------------- 测试体（W00 验证接口用，不参与随机挑选，不进面板） ----------------
// 一块倒锥形的浮空岩（顶面 3 km 半径，锥尖在 2.5 km，顶上一层偏绿的「树冠」穹顶）+ 腰上一圈雾环（介质）+ 投影椭球。
// 只在 URL 带 ?w00probe 时编进奇观 pass（测试用，不让它平白增加奇观变体的编译时间）。
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

/** 测试体的种类编号（catalog.ts 的调试条目用） */
export const W00_PROBE_KIND = 1;
export const W00_PROBE_COMPILED = PROBE_ENABLED;
/** 雾海灯城（W02）的种类编号 */
export const FOGCITY_KIND = 2;

/** 已注册的云间层奇观种类。W03 往这里加 */
export const WONDER_CLOUD_KINDS: WonderCloudKind[] = [
  ...(PROBE_ENABLED
    ? [{ id: W00_PROBE_KIND, name: "W00 测试体", glsl: PROBE_GLSL, sdf: "w00ProbeSdf", shade: "w00ProbeShade", medium: "w00ProbeMedium" }]
    : []),
  {
    id: FOGCITY_KIND,
    name: "雾海灯城（W02）",
    glsl: CITY_GLSL,
    sdf: "fcSdf",
    shade: "fcShade",
    medium: "fcMedium",
    mediumSeg: "fcMediumSeg",
    ray: "fcRay",
  },
];

function dispatch(kinds: WonderCloudKind[], field: "sdf" | "shade" | "medium" | "mediumSeg", call: string, fallback: string) {
  const cases = kinds
    .filter((k) => k[field])
    .map((k) => `  if (k == ${k.id}) return ${k[field]}(${call});`)
    .join("\n");
  return `${cases}\n  return ${fallback};`;
}
function dispatchVoid(kinds: WonderCloudKind[], field: "ray", call: string) {
  return kinds
    .filter((k) => k[field])
    .map((k) => `  if (k == ${k.id}) { ${k[field]}(${call}); return; }`)
    .join("\n");
}

const UNIFORMS_GLSL = /* glsl */ `
uniform float uWonderVol;       // 0：没有云间层奇观；> 0：在场奇观的种类编号
uniform vec2 uWonderUse;        // x：有表面；y：有介质
uniform vec3 uWonderCam;        // 相机在奇观局部坐标里的位置（km）
uniform mat3 uWonderToLocal;    // 窗外坐标方向 → 奇观局部坐标方向（行 = 局部的东、天顶、南）
uniform vec3 uWonderBoxMin;     // 局部坐标的包围盒（km）：表面和介质都必须在里面
uniform vec3 uWonderBoxMax;
uniform vec4 uWonderParams;     // x：reveal（0..1）；y：时间（真实秒，1 小时循环）；z：本次出现的随机种子（0..1，W02）；w：catalog 的 params[0]
uniform vec4 uWonderCaster;     // 投影椭球：xyz 中心（局部坐标），w：1 = 启用
uniform vec3 uWonderCasterR;    // 投影椭球的三个半轴（km）
uniform float uWonderStep;      // 介质的步长（km）；包围盒里另外保证 8–96 步
`;

// 投影：光线离椭球中心的最近距离 m（椭球归一化后），m < 0.8 全影、> 1.15 没挡
const CASTER_GLSL = /* glsl */ `
const float WONDER_PENUMBRA_IN = 0.8;
const float WONDER_PENUMBRA_OUT = 1.15;
// 云步进用：视线上的点 p(t) 在归一化空间里是 t 的线性函数，m² 是 t 的二次式。每条视线在步进前算一次
// 「落在影子柱里的区间」和二次式系数，循环里只做区间判断和一次开方（逐采样点做完整的椭球测试会拖慢整个步进，W00 实测）
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
  return smoothstep(WONDER_PENUMBRA_IN, WONDER_PENUMBRA_OUT, sqrt(max(shQ.x + t * (shQ.y + t * shQ.z), 0.0)));
}
`;

/** 云步进奇观变体（#define WONDER_LAYER）里要的那一小段：uniform + 投影 */
export function wonderMarchGlsl() {
  return UNIFORMS_GLSL + CASTER_GLSL;
}

/**
 * 奇观 pass 的整段 GLSL（需要 ATMOSPHERE_COMMON、VIEW_COMMON、CLOUD_COMMON、LIGHTS_COMMON 在前面），入口 wonderLayer()。
 */
export function wonderCloudGlsl(kinds: WonderCloudKind[] = WONDER_CLOUD_KINDS) {
  return /* glsl */ `
${UNIFORMS_GLSL}
${CASTER_GLSL}
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
vec2 wonderMediumSeg(vec3 o, vec3 d, vec2 seg) {
  int k = int(uWonderVol + 0.5);
${dispatch(kinds, "mediumSeg", "o, d, seg", "seg")}
}
void wonderRay(vec3 o, vec3 d, vec2 seg, float pixAng, out vec4 e0, out vec4 e1, out vec4 e2) {
  e0 = vec4(0.0, 0.0, 0.0, 1e9);
  e1 = e0;
  e2 = e0;
  int k = int(uWonderVol + 0.5);
${dispatchVoid(kinds, "ray", "o, d, seg, pixAng, e0, e1, e2")}
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

// 表面：在 [seg.x, seg.y] 里球面追踪。返回 (预乘辐亮度, 覆盖率 α)，tHit 为命中深度（km）。
// pixAng：一个像素的张角（弧度）。抗锯齿：命中 α = 1；没命中时按视线离表面最近处的「距离 / 像素足迹」给覆盖率，
// 在那一点着色（轮廓外半个像素的渐变，和 wing / traffic 的解析覆盖同一思路）。
// 追踪和法线的 4 次取样放在同一个循环里：wonderSdf 只有一个调用点；上界依赖 uniform，FXC 不展开
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

float wonderHg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * M_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// 介质的受光（每单位散射）：直射主光源 × 云影 × 投影椭球（奇观自己的影子）× 相函数（前向 + 后向两瓣），加天空光。
// 没有沿光线步进介质本身（雾罩自己的影子只由投影椭球近似）；夜里主光源是月亮
vec3 wonderMediumLight(vec3 pW, vec3 q, float cosT) {
  float r = length(pW);
  vec3 up = pW / r;
  float vis = r - BOTTOM > uShellTop ? 1.0 : cloudShadow(pW, uKeyDir);
  if (uWonderCaster.w > 0.5) {
    vec3 oq = (q - uWonderCaster.xyz) / uWonderCasterR;
    vec3 dq = (uWonderToLocal * uKeyDir) / uWonderCasterR;
    float s = max(-dot(oq, dq) / dot(dq, dq), 0.0);
    vis *= smoothstep(WONDER_PENUMBRA_IN, WONDER_PENUMBRA_OUT, length(oq + dq * s));
  }
  // 多次散射近似（和云步进同一套 Wrenninge 2013 的做法，只是光学厚度按 0 取）：每一阶更弱、相函数更平。
  // 只算单次散射时雾罩在云旁边发灰（W00 截图）
  float phase = 0.0;
  float a = 1.0, c = 1.0;
  for (int k = 0; k < 4; k++) {
    phase += a * mix(wonderHg(cosT, -0.25 * c), wonderHg(cosT, 0.8 * c), 0.7);
    a *= 0.62; c *= 0.5;
  }
  return keyLight(r, up) * vis * phase + skyIrradiance(r, up) / (2.0 * M_PI);
}

// 解析发光事件 e 在 tt 之前：插进去（乘当前的透过率 T），记下按亮度加权的深度，然后作废
#define WONDER_EVENT(e, tt) if ((e).w <= (tt)) { vec3 c_ = T * (e).rgb; L += c_; float l_ = dot(c_, vec3(0.2126, 0.7152, 0.0722)); eW += l_; eD += l_ * (e).w; (e) = vec4(0.0, 0.0, 0.0, 1e9); }

// 奇观层：表面 + 介质 + 解析发光事件合成一层。返回 (预乘辐亮度, 不透明度)，tOut = 按不透明度加权的深度（km；只有发光时按亮度加权）。
// 介质在 [seg.x, 表面) 里步进（表面完全挡住时截到表面；种类给了 mediumSeg 时再收窄），步长 uWonderStep，另外保证 8–96 步；
// jitter 让时间累积抹平步进纹。事件（W02）在步进走到它的深度时插进去
vec4 wonderLayer(vec3 ro, vec3 rd, vec2 seg, float pixAng, float jitter, out float tOut) {
  float tS;
  vec4 s = wonderSurface(ro, rd, seg, pixAng, tS);
  vec3 L = vec3(0.0);
  float T = 1.0;
  float dSum = 0.0, wSum = 0.0;
  float eW = 0.0, eD = 0.0;
  vec3 dL = uWonderToLocal * rd;
  vec4 e0, e1, e2;
  wonderRay(uWonderCam, dL, seg, pixAng, e0, e1, e2);
  // 在表面后面的事件：乘表面的透过率（表面完全不透明时就没了）
  float sT = 1.0 - s.a;
  if (e0.w > tS) e0.rgb *= sT;
  if (e1.w > tS) e1.rgb *= sT;
  if (e2.w > tS) e2.rgb *= sT;
  if (uWonderUse.y > 0.5) {
    float t1 = s.a > 0.999 ? min(seg.y, tS) : seg.y;
    vec2 ms = wonderMediumSeg(uWonderCam, dL, vec2(seg.x, t1));
    float t0 = max(ms.x, seg.x);
    t1 = min(ms.y, t1);
    float len = t1 - t0;
    float n = clamp(ceil(len / max(uWonderStep, 1e-3)), 8.0, 96.0);
    float dt = len / n;
    float cosT = dot(rd, uKeyDir);
    for (int i = 0; i < 96 + min(uStormCount, 0); i++) {
      if (float(i) >= n || T < 0.005 || len <= 0.0) break;
      float t = t0 + (float(i) + jitter) * dt;
      WONDER_EVENT(e0, t)
      WONDER_EVENT(e1, t)
      WONDER_EVENT(e2, t)
      vec3 q = uWonderCam + dL * t;
      vec3 alb, em;
      float sig = wonderMedium(q, alb, em);
      bool glow = max(em.r, max(em.g, em.b)) > 0.0;
      if (sig <= 1e-5 && !glow) continue;
      float stepT = exp(-sig * dt);
      vec3 src = em;
      if (sig > 1e-5) src += sig * alb * wonderMediumLight(ro + rd * t, q, cosT);
      L += T * src * (sig > 1e-5 ? (1.0 - stepT) / sig : dt);
      dSum += T * (1.0 - stepT) * t;
      wSum += T * (1.0 - stepT);
      T *= stepT;
    }
  }
  // 介质走完还没插的事件（在介质之后、表面之前或之后——之后的已经乘过表面的透过率）
  WONDER_EVENT(e0, 1e10)
  WONDER_EVENT(e1, 1e10)
  WONDER_EVENT(e2, 1e10)
  // 表面在介质后面（边缘像素 α < 1 时，表面后面那段介质按在前面算，差别只在 1 像素的轮廓上）
  L += T * s.rgb;
  dSum += T * s.a * tS;
  wSum += T * s.a;
  T *= 1.0 - s.a;
  tOut = wSum > 0.0 ? dSum / wSum : eW > 0.0 ? eD / eW : 0.5 * (seg.x + seg.y);
  return vec4(L, 1.0 - T);
}
`;
}
