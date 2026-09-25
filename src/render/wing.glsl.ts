/**
 * 机翼（GLSL）：座舱系里做光线步进（米），尺寸按 A320 量级。依赖 VIEW_COMMON / CABIN_COMMON / PANE_COMMON 里的工具函数。
 *
 * 机体坐标（米）：X 朝机头，Y 向上，Z 从机身轴线朝窗外。与座舱系的换算：
 *   X = uSeatSign · x − uWingRootLE（机翼根部前缘在机头方向上相对窗口的位置），Y = y + WINDOW_HEIGHT，Z = z + CABIN_WALL_RADIUS
 * 左侧座位时座舱 x 朝机尾，所以乘 uSeatSign = −1，机翼形状不用镜像。
 */
export const WING_COMMON = /* glsl */ `
uniform float uSeatSign;       // 右侧 +1，左侧 −1
uniform float uWingRootLE;     // 翼根前缘在机头方向上相对窗口中心的距离（米），负数在身后
uniform float uWingFlex;       // 翼尖向上的弯曲（米），含静弯和湍流颤动
uniform float uStrobe;         // 频闪灯此刻的亮度 0..1

const float CABIN_WALL_RADIUS = 1.85;  // 窗口内饰面到机身轴线的距离
const float WINDOW_HEIGHT = 0.25;      // 窗口中心高出机身轴线
const float FUSELAGE_RADIUS = 1.98;
const float ROOT_Z = 1.95;
const float TIP_Z = 17.0;
const float ROOT_Y = -1.3;
const float ROOT_CHORD = 6.0;
const float TIP_CHORD = 1.6;
const float SWEEP = 0.436;     // 25°
const float DIHEDRAL = 0.087;  // 5°
const float WINGLET_H = 2.4;
const float WINGLET_SWEEP = 0.61; // 35°

vec3 cabinToAircraft(vec3 p) {
  return vec3(uSeatSign * p.x - uWingRootLE, p.y + WINDOW_HEIGHT, p.z + CABIN_WALL_RADIUS);
}

// NACA 四位数翼型的半厚度分布（相对弦长 × 相对厚度）
float nacaHalf(float xi) {
  xi = clamp(xi, 0.0, 1.0);
  return 5.0 * (0.2969 * sqrt(xi) - 0.126 * xi - 0.3516 * xi * xi + 0.2843 * xi * xi * xi - 0.1036 * xi * xi * xi * xi);
}

struct WingCoord { float xi; float s; float chord; float yMid; float halfT; };

WingCoord wingCoord(vec3 P) {
  WingCoord w;
  float span = clamp(P.z, ROOT_Z, TIP_Z) - ROOT_Z;
  w.s = span / (TIP_Z - ROOT_Z);
  float le = -span * tan(SWEEP);
  w.chord = mix(ROOT_CHORD, TIP_CHORD, w.s);
  w.xi = (le - P.x) / w.chord;
  float tc = mix(0.14, 0.11, w.s);
  float camber = w.chord * 0.02 * 4.0 * clamp(w.xi, 0.0, 1.0) * (1.0 - clamp(w.xi, 0.0, 1.0));
  w.yMid = ROOT_Y + span * tan(DIHEDRAL) + uWingFlex * w.s * w.s + camber;
  w.halfT = w.chord * tc * nacaHalf(w.xi);
  return w;
}

float sdWingMain(vec3 P) {
  WingCoord w = wingCoord(P);
  float dy = abs(P.y - w.yMid) - w.halfT;
  float dx = max(-w.xi, w.xi - 1.0) * w.chord * cos(SWEEP);
  float dz = max(ROOT_Z - P.z, P.z - TIP_Z);
  return max(max(dy, dx), dz);
}

// 鲨鳍小翼：翼尖上竖起的一片后掠薄板
float sdWinglet(vec3 P) {
  float tipLE = -(TIP_Z - ROOT_Z) * tan(SWEEP);
  float tipY = ROOT_Y + (TIP_Z - ROOT_Z) * tan(DIHEDRAL) + uWingFlex;
  float h = clamp((P.y - tipY) / WINGLET_H, 0.0, 1.0);
  float le = tipLE - h * WINGLET_H * tan(WINGLET_SWEEP);
  float c = mix(TIP_CHORD, 0.55, h);
  float xi = (le - P.x) / c;
  float thick = 0.12 * c * nacaHalf(xi);
  float dz = abs(P.z - (TIP_Z + 0.08 * h * h)) - thick;
  float dx = max(-xi, xi - 1.0) * c;
  float dyy = max(tipY - P.y, P.y - tipY - WINGLET_H);
  return max(max(dz, dx), dyy);
}

float sdWing(vec3 P) {
  return min(sdWingMain(P), sdWinglet(P));
}

// 视线（座舱系）与机翼求交，返回距离，没打到返回 −1
float wingHit(vec3 ro, vec3 rd, float tStart) {
  float t = tStart;
  for (int i = 0; i < 96; i++) {
    vec3 P = cabinToAircraft(ro + rd * t);
    float d = sdWing(P);
    if (d < 0.002 * t) return t;
    // 距离场只是近似（盒子式组合 + 翼型前缘陡），步长打折保险
    t += max(d * 0.6, 0.01);
    if (t > 60.0) break;
  }
  return -1.0;
}

vec3 wingNormal(vec3 P) {
  const vec2 e = vec2(0.004, 0.0);
  vec3 n = normalize(vec3(
    sdWing(P + e.xyy) - sdWing(P - e.xyy),
    sdWing(P + e.yxy) - sdWing(P - e.yxy),
    sdWing(P + e.yyx) - sdWing(P - e.yyx)));
  // 蒙皮在肋和桁条之间会微微鼓起（「油罐效应」），天空的倒影因此轻轻起伏。扰动约 0.5°
  vec2 q = P.xz * vec2(1.6, 2.2);
  vec2 wav = vec2(vnoise(q) - 0.5, vnoise(q + 17.3) - 0.5) * 0.018;
  return normalize(n + vec3(wav.x, 0.0, wav.y));
}

// 机身挡住阳光：从 P 朝太阳的射线是否穿过机身圆柱（轴线沿 X）
float fuselageShadow(vec3 P, vec3 l) {
  vec2 o = P.yz;
  vec2 d = l.yz;
  float a = dot(d, d);
  if (a < 1e-6) return 1.0;
  float b = dot(o, d);
  float c = dot(o, o) - FUSELAGE_RADIUS * FUSELAGE_RADIUS;
  float disc = b * b - a * c;
  if (disc < 0.0) return 1.0;
  float t = (-b - sqrt(disc)) / a;
  return t > 0.0 ? 0.0 : 1.0;
}

float ggxD(float nh, float a) {
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (M_PI * d * d);
}

float smithG(float nv, float nl, float a) {
  float k = a * 0.5;
  return (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
}

// 细线（面板缝、标线）：按像素宽度抗锯齿，返回覆盖率。
// fw 是 x 在一个像素内的变化量——由命中距离 × 像素张角解析算出，不用屏幕导数：
// 机翼着色发生在光线步进命中之后的分支里，那里的屏幕导数没有定义（D3D 会报 X3595 警告，机翼边缘可能闪烁）
float seam(float x, float width, float fw) {
  float w = max(fw, 1e-5);
  return 1.0 - smoothstep(width * 0.5, width * 0.5 + w, abs(x));
}

struct WingSurface { vec3 albedo; float metal; float rough; vec3 emit; };

// pix：命中点处一个像素对应的长度（米）
WingSurface wingSurface(vec3 P, float pix) {
  WingSurface m;
  m.albedo = vec3(0.74, 0.745, 0.75);
  m.metal = 0.0;
  m.rough = 0.25;
  m.emit = vec3(0.0);
  bool winglet = sdWinglet(P) < sdWingMain(P);
  if (winglet) {
    // 小翼涂航司的深蓝色
    m.albedo = vec3(0.03, 0.07, 0.2);
    m.rough = 0.2;
    return m;
  }
  WingCoord w = wingCoord(P);
  float xm = w.xi * w.chord;             // 沿弦向离前缘的米数
  float zm = P.z - ROOT_Z;               // 沿展向离翼根的米数
  // 前缘缝翼：裸铝
  if (w.xi < 0.1) { m.albedo = vec3(0.82, 0.83, 0.85); m.metal = 1.0; m.rough = 0.32; }
  // 后缘襟翼、扰流板区域颜色略灰
  if (w.xi > 0.72) m.albedo *= 0.92;
  // 面板缝：展向（缝翼、前后梁、扰流板铰链、襟翼前缘）+ 弦向（每块扰流板 / 襟翼的分段）
  float lines = 0.0;
  lines = max(lines, seam(w.xi - 0.1, 0.006 / w.chord, pix / w.chord));
  lines = max(lines, seam(w.xi - 0.62, 0.004 / w.chord, pix / w.chord));
  lines = max(lines, seam(w.xi - 0.72, 0.006 / w.chord, pix / w.chord));
  if (w.xi > 0.62) lines = max(lines, seam(fract(zm / 1.6 + 0.5) - 0.5, 0.004 / 1.6, pix / 1.6));
  if (w.xi < 0.1) lines = max(lines, seam(fract(zm / 2.4 + 0.5) - 0.5, 0.004 / 2.4, pix / 2.4));
  // 副翼：外侧 25% 展长、后 25% 弦长
  if (w.s > 0.72) lines = max(lines, seam(w.s - 0.72, 0.005 / (TIP_Z - ROOT_Z), pix / (TIP_Z - ROOT_Z)) * step(0.72, w.xi));
  m.albedo *= 1.0 - 0.55 * lines;
  // 每块蒙皮板的漆色略有差别（批次、补漆、老化程度不同）
  float zone = w.xi < 0.1 ? 0.0 : (w.xi < 0.62 ? 1.0 : (w.xi < 0.72 ? 2.0 : 3.0));
  float panelId = floor(zm / (w.xi > 0.62 ? 1.6 : 2.4)) + zone * 31.0;
  m.albedo *= 1.0 + (hash12(vec2(panelId, zone)) - 0.5) * 0.06;
  // 铆钉：沿前后梁的两排点，远处细于像素时淡成一条浅灰线
  for (int k = 0; k < 2; k++) {
    float spar = k == 0 ? 0.18 : 0.6;
    float row = seam(w.xi - spar, 0.006 / w.chord, pix / w.chord);
    float dots = 1.0 - smoothstep(0.002, 0.003, length(vec2(fract(zm / 0.12) - 0.5, 0.0)) * 0.12);
    float fade = 1.0 - smoothstep(0.004, 0.02, pix);
    m.albedo *= 1.0 - row * mix(0.08, 0.25 * dots, fade);
  }
  // 燃油舱检修口：沿展向每 1.5 m 一个椭圆口盖（约 45 × 30 cm），外圈一圈螺钉
  if (w.xi > 0.3 && w.xi < 0.55 && zm > 1.0 && zm < 13.0) {
    vec2 pc = vec2(xm - (0.42 * w.chord), fract(zm / 1.5 + 0.5) * 1.5 - 0.75);
    float e = length(pc / vec2(0.15, 0.225));
    float ring = seam(e - 1.0, 0.012 / 0.2, pix / 0.2);
    m.albedo *= 1.0 - 0.25 * ring;
    // 螺钉：外圈 12 颗
    float ang = atan(pc.y / 0.225, pc.x / 0.15);
    float nearRing = 1.0 - smoothstep(0.0, 0.08, abs(e - 1.18));
    float screw = nearRing * (1.0 - smoothstep(0.05, 0.12, abs(fract(ang / (2.0 * M_PI) * 12.0) - 0.5)));
    float fade = 1.0 - smoothstep(0.003, 0.012, pix);
    m.albedo *= 1.0 - 0.3 * screw * fade;
  }
  // 翼根的走道：黑色边线围出的一块区域（写着 NO STEP 的那种）
  float walk = seam(zm - 3.2, 0.05, pix) * step(0.25, w.xi) * step(w.xi, 0.6);
  walk = max(walk, (seam(w.xi - 0.25, 0.05 / w.chord, pix / w.chord) + seam(w.xi - 0.6, 0.05 / w.chord, pix / w.chord)) * step(zm, 3.2));
  m.albedo = mix(m.albedo, vec3(0.03), clamp(walk, 0.0, 1.0));
  // 顺气流方向的污渍：后缘和扰流板附近多，沿弦向拉长
  float grime = fbm2(vec2(xm * 1.5, zm * 12.0)) * smoothstep(0.4, 1.0, w.xi);
  m.albedo *= mix(vec3(1.0), vec3(0.8, 0.76, 0.7), clamp(grime * 1.3 - 0.3, 0.0, 1.0));
  m.rough = mix(m.rough, 0.5, grime);
  // 扰流板后面、襟翼上的深色排气 / 液压油污
  float streak = fbm2(vec2(xm * 0.6, zm * 25.0)) * smoothstep(0.7, 0.95, w.xi);
  m.albedo *= 1.0 - 0.35 * smoothstep(0.45, 0.75, streak);
  return m;
}
`;
