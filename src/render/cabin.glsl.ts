import { NOISE_COMMON } from "./noise.glsl";

/**
 * 舱内几何与光照（GLSL）。依赖 VIEW_COMMON 里的舷窗尺寸。
 * 窗洞内衬是一个从舱壁开口平滑收窄到窗板的「漏斗」：在舱壁处与墙面相切（形成圆润的窗沿），到窗板处收成窗板的形状。
 * 光照三部分：舱内环境光、窗板这块面光源的漫射照度、穿过窗板的直射阳光（逐点判断能不能穿过开口，所以会有清晰的光斑）。
 */
export const CABIN_COMMON = /* glsl */ `
${NOISE_COMMON}
const vec3 CABIN_LIGHT_COLOR = vec3(1.0, 0.9, 0.76); // 约 3500 K 的暖白

// 漏斗在深度 z 处的收窄进度：sqrt 使它在舱壁处与墙面相切
float funnelT(float z) { return sqrt(clamp(z / PANE_DEPTH, 0.0, 1.0)); }

// > 0 表示在内衬材料里（开口之外）
float sdFunnel(vec3 p) {
  float g = funnelT(p.z);
  return sdRoundRect(p.xy, mix(BEZEL_HALF, PANE_HALF, g), mix(BEZEL_RADIUS, PANE_RADIUS, g));
}

// 内衬表面法线，指向空气一侧
vec3 funnelNormal(vec3 p) {
  const float e = 0.0004;
  vec3 g = vec3(
    sdFunnel(p + vec3(e, 0.0, 0.0)) - sdFunnel(p - vec3(e, 0.0, 0.0)),
    sdFunnel(p + vec3(0.0, e, 0.0)) - sdFunnel(p - vec3(0.0, e, 0.0)),
    sdFunnel(p + vec3(0.0, 0.0, e)) - sdFunnel(p - vec3(0.0, 0.0, e)));
  return -normalize(g);
}

// 视线在漏斗里前进，返回打到内衬的点；一路穿到窗板返回 false
bool marchFunnel(vec3 ro, vec3 rd, out vec3 hit) {
  float zPrev = 0.0;
  const float N = 24.0;
  for (int ii = 1; ii <= 24 + uLoopGuard; ii++) {
    float v = float(ii) / N;
    float z = PANE_DEPTH * v * v; // 靠近舱壁处收窄得快，采样也密
    vec3 p = ro + rd * ((z - ro.z) / rd.z);
    if (sdFunnel(p) > 0.0) {
      float a = zPrev, b = z;
      for (int k = 0; k < 7; k++) {
        float m = 0.5 * (a + b);
        if (sdFunnel(ro + rd * ((m - ro.z) / rd.z)) > 0.0) b = m; else a = m;
      }
      hit = ro + rd * ((b - ro.z) / rd.z);
      return true;
    }
    zPrev = z;
  }
  return false;
}

// 窗板当作均匀发光的朗伯面光源，用多边形光源的解析公式（Lambert）求照度：
// E = L/2 · Σ θᵢ · (n · normalize(vᵢ × vᵢ₊₁))，vᵢ 是从 x 指向多边形顶点的单位向量。
// 圆角矩形近似成 16 边形（每个圆角 4 个点）。之前用 9 个采样点积分，贴近窗板的内衬会因为采样太粗整圈发黑。
vec3 windowVertex(int i) {
  int corner = i / 4;
  float a = (float(i - corner * 4) / 3.0 + float(corner)) * 0.5 * M_PI; // 逆时针
  vec2 sgn = vec2(corner == 0 || corner == 3 ? 1.0 : -1.0, corner < 2 ? 1.0 : -1.0);
  vec2 c = sgn * (PANE_HALF - PANE_RADIUS);
  return vec3(c + PANE_RADIUS * vec2(cos(a), sin(a)), PANE_DEPTH);
}

vec3 windowIrradiance(vec3 x, vec3 n, vec3 lWin) {
  float sum = 0.0;
  vec3 v0 = normalize(windowVertex(0) - x);
  vec3 vPrev = v0;
  for (int i = 1; i <= 16 + uLoopGuard; i++) {
    vec3 v = i >= 16 ? v0 : normalize(windowVertex(i) - x);
    vec3 c = cross(vPrev, v);
    float len = length(c);
    if (len > 1e-6) sum += acos(clamp(dot(vPrev, v), -1.0, 1.0)) * dot(n, c / len);
    vPrev = v;
  }
  // 窗板有一部分落在表面切平面之后时公式不再精确，这里只截掉负值
  return lWin * max(0.5 * sum, 0.0);
}

// 直射阳光能否从 x 穿过窗板开口（并且没被遮光板挡住），带一点点软边
float sunThroughWindow(vec3 x, vec3 sunC, float shadeBottom) {
  if (sunC.z <= 1e-4) return 0.0;
  vec3 q = x + sunC * ((PANE_DEPTH - x.z) / sunC.z);
  float open = 1.0 - smoothstep(-0.002, 0.002, sdRoundRect(q.xy, PANE_HALF, PANE_RADIUS));
  if (x.z < SHADE_DEPTH) {
    vec3 qs = x + sunC * ((SHADE_DEPTH - x.z) / sunC.z);
    open *= 1.0 - smoothstep(-0.002, 0.002, qs.y - shadeBottom);
  }
  return open;
}
`;

export const PANE_COMMON = /* glsl */ `
// ---- 窗板上的细节：划痕、油污指纹、透气孔 ----

// hash22 / fbm2 在 noise.glsl.ts（CABIN_COMMON 已经拼进去了）

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// 划痕：窗板平面（米）上的随机细线段。细划痕把光散射到以划痕走向为轴的圆锥面上，
// 只有「视线与划痕夹角 = 阳光与划痕夹角」时才亮，即 t·(v − s) = 0：亮起来的划痕围着太阳排成同心圆。
// v、s 是座舱系里的视线方向和阳光方向（都朝窗外）。返回 x = 被阳光点亮的强度，y = 覆盖率（给漫射光用）
vec2 scratches(vec2 q, vec3 v, vec3 s, float pix) {
  const float CELL = 0.012;
  const float WIDTH = 0.00008;    // 80 µm
  vec2 id = floor(q / CELL);
  float lit = 0.0;
  float cover = 0.0;
  // 越靠下划痕越多：乘客的手、清洁布都在那里
  // 用户反馈「划痕太多」：只留偶尔注意到的几道（约为最初的 1/5）
  float density = mix(0.03, 0.14, smoothstep(0.1, -0.15, q.y));
  for (int i = -1; i <= 1; i++)
  for (int j = -1; j <= 1; j++) {
    vec2 c = id + vec2(i, j);
    for (int k = 0; k < 2; k++) {
      vec2 h = hash22(c * 1.7 + float(k) * 13.1);
      vec2 h2 = hash22(c * 3.1 + float(k) * 7.7 + 5.0);
      if (h2.y > density) continue;
      // 走向：大多数是清洁时的横向擦痕，少数是随机方向
      float ang = h2.x < 0.6 ? (h.x - 0.5) * 0.5 : h.x * M_PI;
      vec2 t = vec2(cos(ang), sin(ang));
      vec2 center = (c + h) * CELL;
      float halfLen = CELL * mix(0.3, 1.6, fract(h.y * 7.3));
      float d = segDist(q, center - t * halfLen, center + t * halfLen);
      // 线宽远小于像素：按覆盖面积算强度，边缘按像素宽度抗锯齿
      float cov = (WIDTH / max(WIDTH, pix)) * (1.0 - smoothstep(0.0, max(WIDTH, pix), d));
      float mis = dot(vec3(t, 0.0), v - s);
      lit += cov * exp(-mis * mis / 0.0004);
      cover += cov;
    }
  }
  return vec2(lit, cover);
}

float paneLineCov(float d, float w, float pix) {
  float ww = max(w, pix);
  return (w / ww) * (1.0 - smoothstep(0.0, ww, d));
}

// 擦拭留下的同心弧形细纹 + 零星的微小麻点（内层防刮板被清洁布一圈圈擦过）。
// 返回覆盖率（已按像素宽度摊薄，远处自然变成极轻的一层，不闪烁）；平时只被漫射光照到，亮度只有背景的百分之几
float wipeMarks(vec2 q, float pix) {
  float cov = 0.0;
  // 两个擦拭中心，每个一组同心弧，只在部分角度上出现
  for (int i = 0; i < 2; i++) {
    vec2 c = i == 0 ? vec2(0.03, -0.06) : vec2(-0.05, 0.05);
    vec2 d = q - c;
    float r = length(d);
    float ring = floor(r / 0.0032);
    float h = hash12(vec2(ring, float(i) * 7.1));
    float ang = atan(d.y, d.x);
    float arc = smoothstep(0.0, 0.3, sin(ang * mix(1.0, 3.0, h) + h * 40.0) - 0.35);
    float dr = abs(fract(r / 0.0032) - 0.2 - 0.6 * fract(h * 13.0)) * 0.0032;
    cov += paneLineCov(dr, 0.00003, pix) * arc * step(h, 0.1) * (1.0 - smoothstep(0.05, 0.08, r));
  }
  // 麻点：约 6 mm 一格，少数格子里有一个 0.1–0.2 mm 的小坑
  vec2 cell = floor(q / 0.006);
  vec2 hp = hash22(cell + 31.7);
  if (hp.x < 0.025) {
    vec2 c = (cell + 0.2 + 0.6 * hash22(cell + 3.3)) * 0.006;
    float rp = mix(0.00005, 0.0001, hp.y);
    cov += (1.0 - smoothstep(rp - pix * 0.5, rp + pix * 0.5, length(q - c))) * min(1.0, rp * rp / max(pix * pix, 1e-12)) * 2.0;
  }
  return cov;
}

// 油污：平时看不见，阳光从附近照过来时发出朦胧的散射光。
// T20（高端机舱「刚清洁过」）：去掉了指纹——原来两枚指纹画成完整的同心圆环，在至少 6 个场景里读成「靶心」、
// 还像远处小云的重影；擦拭后残留的油膜也只剩很淡、稀疏的几片
float smudges(vec2 q) {
  return smoothstep(0.55, 0.85, fbm2(q * 18.0)) * 0.25;
}

// 窗板外侧的水：巡航速度下水不会往下流，而是被气流沿水平方向往机尾拖成细长、弯曲、粗细不均的水线；
// 另有少量没被吹走、微微颤动的圆水珠。水主要是在折射背景，所以返回的是「扰动强度」而不是白线。
// aftSign：座舱 x 轴上机尾的方向（右座 −1，左座 +1）。返回 x = 水线覆盖率，y = 水珠覆盖率（已按像素宽度摊薄）
vec2 waterOnPane(vec2 q, float pix, float aftSign, float t, float wet) {
  if (wet <= 0.001) return vec2(0.0);
  vec2 result = vec2(0.0);
  // 两层不同间距的行，错开，避免整齐的横纹
  for (int layer = 0; layer < 2; layer++) {
    float ROW = layer == 0 ? 0.011 : 0.017;
    float qy = q.y + float(layer) * 0.0043;
    float row = floor(qy / ROW);
    float h = hash12(vec2(row, 7.3 + float(layer)));
    float h2 = hash12(vec2(row, 1.9 + float(layer)));
    if (h > 0.18 + 0.35 * wet) continue; // 大多数行是空的
    float u = q.x * aftSign - t * mix(0.01, 0.05, h) + h * 13.0; // 水线整体慢慢往后爬
    float segLen = mix(0.04, 0.12, h2);
    float seg = fract(u / segLen);
    float segId = floor(u / segLen);
    float present = step(hash12(vec2(segId, row)), 0.55 * wet);
    // 沿长度方向弯曲（阵风把水拨来拨去），往后略微下垂
    float wob = (vnoise(vec2(u * 60.0, row)) - 0.5) * 0.0025;
    float y0 = (row + 0.2 + 0.6 * h2) * ROW - float(layer) * 0.0043 + wob - seg * segLen * 0.06;
    float dy = abs(q.y - y0);
    // 粗细：水珠拖出的尾巴越往后越细
    float w = mix(0.0007, 0.0002, seg) * mix(0.7, 1.3, h);
    float line = (w / max(w, pix)) * (1.0 - smoothstep(0.0, max(w, pix), dy)) * step(seg, 0.85);
    float head = (1.0 - smoothstep(0.0, max(0.0011, pix), length(vec2(seg * segLen, dy)))) * (0.0011 / max(0.0011, pix));
    result.x = max(result.x, max(line, head) * present);
  }
  // 零星的圆水珠，大小不一，在气流里微微颤动
  vec2 cell = floor(q / 0.009);
  vec2 hc = hash22(cell * 3.7 + 1.1);
  if (hc.x < 0.06 * wet) {
    vec2 c = (cell + 0.2 + 0.6 * hash22(cell + 9.2)) * 0.009 + vec2(sin(t * 9.0 + hc.y * 20.0), cos(t * 7.0 + hc.x * 11.0)) * 0.00015;
    float r = mix(0.0005, 0.0018, hc.y * hc.y);
    result.y = 1.0 - smoothstep(r - pix, r + pix, length(q - c));
  }
  return result;
}
`;
