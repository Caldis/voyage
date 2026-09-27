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
      // PERF-12：上限带 uLoopGuard，原来常量 7 次被 FXC 展开成 7 份 sdFunnel
      for (int k = 0; k < 7 + uLoopGuard; k++) {
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

// 直射光斜着穿过多层窗板的透射率，相对正射时（正射的 0.85 已算进 PANE_TRANSMITTANCE）。T47：
// 三层亚克力（n ≈ 1.49）共 6 个界面，每个界面按 s / p 两个偏振分别算菲涅尔透射，6 次方后取平均（忽略层间的多次反射）。
// 60° 入射还剩约 83%，80° 约 12%，83° 约 4%：太阳高高在上、几乎贴着窗面照进来时，大部分直射光在窗板上被反射掉了。
// 原来按常数 0.85 算，贴着窗面照进来的阳光在窗洞下缘内衬上照出一大块死白（看后方时 30% 的像素顶到 255，美术总监 wave6 第 8 条）
float paneSunT(float c) {
  c = clamp(c, 1e-3, 1.0);
  float ct = sqrt(1.0 - (1.0 - c * c) / 2.2201);            // 折射角的余弦（n² = 2.2201）
  float rs = (c - 1.49 * ct) / (c + 1.49 * ct);
  float rp = (1.49 * c - ct) / (1.49 * c + ct);
  float ts = 1.0 - rs * rs, tp = 1.0 - rp * rp;
  ts = ts * ts * ts; tp = tp * tp * tp;
  return 0.5 * (ts * ts + tp * tp) / 0.78966;               // 正射时 (1 − 0.0387)^6
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
  // PERF-12：3×3 格 × 每格 2 道压成一个循环（上限「常数 + uLoopGuard」；原来三层常量循环被 FXC 展开成 18 份）。
  // 格号用浮点递推（不用整数除法）：k 在 0 / 1 间交替，每两道换一格，格在 3×3 里先沿 y 后沿 x 走，和原来 i（x）外层、j（y）内层、
  // k 最内层的顺序一致，所以累加顺序、结果都不变。先只算决定「这一道有没有」的那个哈希，绝大多数（86–97%）直接跳过；
  // 再用「到中点的距离 − 半长」排除碰不到的线段，只有真正可能盖到这个像素的才算走向（三角函数）和点到线段的距离
  vec2 cc = id - 1.0;
  float k = 0.0;
  for (int n = 0; n < 18 + uLoopGuard; n++) {
    vec2 c = cc;
    float kk = k;
    if (k > 0.5) {
      cc.y += 1.0;
      if (cc.y > id.y + 1.5) { cc.y = id.y - 1.0; cc.x += 1.0; }
    }
    k = 1.0 - k;
    vec2 h2 = hash22(c * 3.1 + kk * 7.7 + 5.0);
    if (h2.y > density) continue;
    vec2 h = hash22(c * 1.7 + kk * 13.1);
    vec2 center = (c + h) * CELL;
    float halfLen = CELL * mix(0.3, 1.6, fract(h.y * 7.3));
    // 到线段的距离 ≥ 到中点的距离 − 半长；超过覆盖宽度的肯定碰不到（cov 严格为 0）
    if (length(q - center) > halfLen + max(WIDTH, pix)) continue;
    // 走向：大多数是清洁时的横向擦痕，少数是随机方向
    float ang = h2.x < 0.6 ? (h.x - 0.5) * 0.5 : h.x * M_PI;
    vec2 t = vec2(cos(ang), sin(ang));
    float d = segDist(q, center - t * halfLen, center + t * halfLen);
    // 线宽远小于像素：按覆盖面积算强度，边缘按像素宽度抗锯齿
    float cov = (WIDTH / max(WIDTH, pix)) * (1.0 - smoothstep(0.0, max(WIDTH, pix), d));
    float mis = dot(vec3(t, 0.0), v - s);
    lit += cov * exp(-mis * mis / 0.0004);
    cover += cov;
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
  for (int i = 0; i < 2 + uLoopGuard; i++) {
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

// ---- 窗板外侧的水（T29 重写）----
// 水在窗上是一片片小透镜，不是画上去的线：这里只算「水面的形状」——表面坡度、覆盖率、暗边，
// 合成时（scene.ts / wing-pass.ts）按坡度把视线偏折，读偏移后的窗外画面，所以透过水看到的是轻微偏移、
// 放大或倒转的窗外；均匀的雾里整片水几乎隐形，只剩很淡的暗边。
// 形态：低空爬升 / 下降时，水被气流推着斜向后下方流（水线），粗细、行距、长度、角度都随机，会分叉、会并在一起，
// 一段一段地停顿再往前挪；另有大小呈长尾分布（小的多、大的少）、形状不规则的水珠。
// 所有边缘都按像素足迹做盒式滤波，细到不足一个像素的水线 / 水珠按面积摊薄，不闪。
// 返回 xy = 水面坡度 ∇h（已按覆盖率加权，座舱 xy 平面），z = 覆盖率 0..1，w = 暗边（全反射）强度 0..1

// 暗边（水面陡处的全反射，映出的是暗的舱内）最多压暗多少；scene.ts 与 wing-pass.ts 共用
const float WATER_RIM = 0.22;
// 视线穿过倾斜的水面偏折的角度 ≈ (n − 1)·坡度，n = 1.33。真实的偏折能到几十度（水珠里是整片天地的倒像），
// 但按像素点采样会把那么大的视场压进几个像素，出现放射状的条纹、还读到窗板开口以外；
// 这里把偏折缩到约 1/10：水珠里仍是倒转、缩小的窗外，只是取自周围几十个像素
const float WATER_DEFLECT = 0.033;

// 一维盒式滤波：像素足迹 [x − pix/2, x + pix/2] 落在 [−w, w] 里的比例
float waterBox(float x, float w, float pix) {
  return clamp(min(x + 0.5 * pix, w) - max(x - 0.5 * pix, -w), 0.0, pix) / pix;
}

// 横截面是一段圆柱冠的水带：dv 到中线的距离，w 半宽，nrm 水带的法向（朝 dv 增大方向）
void waterBand(float dv, float w, vec2 nrm, float pix, inout vec4 acc) {
  if (w <= 0.0) return;
  float cov = waterBox(dv, w, pix);
  if (cov <= 0.0) return;
  float r = clamp(dv / w, -1.0, 1.0);
  // 分辨得出的程度：宽度不足约 1.5 像素时坡度在一个像素里正负抵消，暗边也只剩平均值
  float res = smoothstep(0.6 * pix, 2.0 * pix, w);
  // 冠高 / 半宽 ≈ 0.45（贴着玻璃被吹扁的水膜，接触角约 25°）
  float slope = -0.45 * r / sqrt(max(1.0 - r * r, 0.0) + 0.06);
  // 暗边只在下沿明显（下沿全反射映的是更暗的舱内下半部），上沿很淡——免得读成一对平行的描边
  float rim = mix(0.2, smoothstep(0.6, 1.0, abs(r)) * (r < 0.0 ? 1.0 : 0.3), res);
  acc.xy += nrm * slope * res * cov;
  acc.z = max(acc.z, cov);
  acc.w = max(acc.w, rim * cov);
}

// 不规则水珠：c 中心，r 名义半径，fu 气流方向（水珠沿气流略拉长），ph 形状随机相位
void waterDrop(vec2 q, vec2 c, float r, vec2 fu, vec2 fv, vec2 ph, float pix, inout vec4 acc) {
  vec2 d = q - c;
  vec2 dl = vec2(dot(d, fu) / 1.18, dot(d, fv));
  float dist = length(dl);
  if (dist > r * 1.3 + pix) return;
  float ang = atan(dl.y, dl.x);
  float rr = r * (1.0 + 0.13 * sin(2.0 * ang + ph.x * 6.283) + 0.07 * sin(3.0 * ang + ph.y * 6.283));
  // 半径方向的盒式滤波；比像素小的水珠按面积摊薄
  float cov = clamp((rr - dist) / pix + 0.5, 0.0, 1.0) * min(1.0, 3.14159 * rr * rr / (pix * pix));
  if (cov <= 0.0) return;
  float rho = min(dist / rr, 1.0);
  float res = smoothstep(0.8 * pix, 2.5 * pix, rr);
  // 球冠：接触角约 45°，中心平、边缘陡；坡度指向中心（∇h 朝外为负）
  vec2 dir = d / max(length(d), 1e-7);
  float slope = -0.9 * rho / sqrt(max(1.0 - rho * rho, 0.0) + 0.15);
  acc.xy += dir * slope * res * cov;
  acc.z = max(acc.z, cov);
  // 暗边是下缘的一弯月牙，上缘几乎没有——整圈的暗环会读成空心圆圈
  float cres = 0.2 + 0.8 * smoothstep(-0.1, 0.7, -dir.y);
  acc.w = max(acc.w, mix(0.2, smoothstep(0.62, 1.0, rho) * cres, res) * cov);
}

vec4 waterOnPane(vec2 q, float pix, float aftSign, float t, float wet) {
  vec4 acc = vec4(0.0);
  if (wet <= 0.001) return acc;
  // 气流方向：往机尾、向下约 12°（水线各自再偏 ±10°）。fv 垂直于气流、朝上
  vec2 fu = normalize(vec2(aftSign, -0.21));
  vec2 fv = vec2(-fu.y, fu.x) * aftSign;
  float u = dot(q, fu);
  float v = dot(q, fv);

  // ---- 水线：出云后先被吹走（比水珠消失得早）----
  float sLine = smoothstep(0.15, 0.85, wet);
  if (sLine > 0.0) {
    const float ROW = 0.0085;
    float k0 = floor(v / ROW);
    // PERF-12：上限带 uLoopGuard。原来常量上限（−2..2）被 FXC 展开成 5 份，每份 4 次 vnoise + 两次 waterBand（舱内程序的一大块）
    for (int dki = 0; dki < 5 + uLoopGuard; dki++) {
      float k = k0 + float(dki - 2);
      float hr = hash12(vec2(k, 3.17));
      // 停一停、挪一步：每行自己的节奏，挪动的距离几毫米到一厘米
      float p = t * mix(0.25, 0.7, hr) + hr * 17.0;
      float stepped = floor(p) + smoothstep(0.35, 0.95, fract(p));
      float uu = u - stepped * mix(0.003, 0.011, hash12(vec2(k, 5.53)));
      float L = mix(0.03, 0.085, hash12(vec2(k, 8.81)));
      float sid = floor(uu / L);
      vec2 hs = hash22(vec2(sid, k) + 0.37);
      if (hs.x > 0.6 * sLine) continue;
      vec2 hs2 = hash22(vec2(k, sid) + 17.1);
      vec2 hs3 = hash22(vec2(sid * 1.31 + 4.7, k * 0.77));
      // 这一段水线占格子的 [a, b]，其余是空隙
      float a = 0.04 + 0.3 * hs2.x;
      float len = mix(0.35, 0.92 - a, hs2.y) * L;
      float x = (fract(uu / L) - a) * L;       // 从水线的上游端（尾巴）量起
      if (x < -0.002 || x > len + 0.003) continue;
      float ang = (hs.y - 0.5) * 0.5;           // 相对基准方向 ±14°
      float v0 = (k + 0.5 + (hs3.x - 0.5) * 0.95) * ROW;
      // 低频弯折（阵风把水拨来拨去）+ 高频细抖
      float wob = (vnoise(vec2(x * 22.0 + sid * 3.7, k * 1.3)) - 0.5) * 0.009
                + (vnoise(vec2(x * 60.0 + sid, k * 2.1)) - 0.5) * 0.0025
                + (vnoise(vec2(x * 140.0, k + sid)) - 0.5) * 0.0005;
      float vc = v0 - ang * x + wob;
      // 粗细：半宽 0.15–0.6 mm，长尾（细的多）；沿长度方向时粗时细（串珠）；尾端渐细
      float w0 = mix(0.00015, 0.0006, hs3.y * hs3.y);
      float bead = 0.7 + 0.6 * vnoise(vec2(x * 380.0 + k, sid));
      float taper = smoothstep(-0.002, 0.35 * len, x) * (1.0 - smoothstep(len - 0.0005, len + 0.0015, x));
      waterBand(v - vc, w0 * bead * taper, fv, pix, acc);
      // 约 30% 的水线头上顶着一颗被拉长的水滴（比线宽大 1.5–2 倍）
      if (fract(hs3.x * 37.0) < 0.3) {
        float hR = w0 * mix(1.5, 2.0, fract(hs3.y * 23.0));
        vec2 dl = vec2((x - len + hR) / 1.7, v - vc);
        float dd = length(dl);
        float covH = clamp((hR - dd) / pix + 0.5, 0.0, 1.0) * min(1.0, 3.14159 * hR * hR / (pix * pix));
        if (covH > 0.0) {
          float rho = min(dd / hR, 1.0);
          float res = smoothstep(0.8 * pix, 2.5 * pix, hR);
          vec2 dir = (fu * dl.x + fv * dl.y) / max(dd, 1e-7);
          acc.xy += dir * (-0.7 * rho / sqrt(max(1.0 - rho * rho, 0.0) + 0.05)) * res * covH;
          acc.z = max(acc.z, covH);
          acc.w = max(acc.w, mix(0.2, smoothstep(0.62, 1.0, rho) * (0.2 + 0.8 * smoothstep(-0.1, 0.7, -dir.y)), res) * covH);
        }
      }
      // 约 30% 的水线在中段分出一条更陡、更细的支流
      if (hs2.x < 0.3) {
        float xb = len * mix(0.35, 0.6, hs3.x);
        float lb = len * mix(0.25, 0.5, fract(hs2.y * 13.0));
        float xr = x - xb;
        if (xr > 0.0 && xr < lb + 0.002) {
          float vcb = v0 - ang * xb + wob - (ang + 0.18) * xr;
          float wb = w0 * 0.65 * bead * (1.0 - smoothstep(lb - 0.0005, lb + 0.0015, xr)) * smoothstep(0.0, 0.004, xr + 0.001);
          waterBand(v - vcb, wb, fv, pix, acc);
        }
      }
    }
  }

  // ---- 水珠：两层网格，细密的小水珠 + 稀疏的大水珠，半径长尾分布 ----
  float sDrop = smoothstep(0.0, 0.45, wet);
  // PERF-12：两层写成一个两次的循环（上限带 uLoopGuard），waterDrop 只内联一份；每层的常数和原来逐字相同
  for (int layer = 0; layer < 2 + uLoopGuard; layer++) {
    bool big = layer == 1;
    float C = big ? 0.013 : 0.0048;
    vec2 cell = floor(q / C);
    vec2 h = hash22(cell * (big ? 2.3 : 1.7) + (big ? 7.7 : 3.1));
    if (h.x < (big ? 0.3 : 0.4) * sDrop) {
      vec2 h2 = hash22(cell + (big ? 21.9 : 11.3));
      float r = big ? min(0.0007 * pow(max(1.0 - h.y, 0.02), -0.6), 0.0022) : min(0.00018 * pow(max(1.0 - h.y, 0.02), -0.5), 0.0008);
      float margin = big ? r * 1.3 + 0.0004 : r + 0.0003;
      vec2 c = (cell + 0.5 + (h2 - 0.5) * (1.0 - 2.0 * margin / C)) * C;
      waterDrop(q, c, r, fu, fv, hash22(cell + (big ? 2.2 : 5.9)), pix, acc);
    }
  }
  return acc;
}
`;
