import { GROUND_LEVELS } from "../ground/clipmap";

/**
 * 低空近景的程序化地面细节（GLSL）。依赖 CABIN_COMMON / PANE_COMMON（hash12 / hash22 / vnoise）。
 *
 * 卫星影像最细约 8–10 m/像素，低空（< 3 km）时一个影像像素要铺开好几个屏幕像素，只剩一片模糊的色块。
 * 这里按影像本身的颜色给每个点分类（深绿 → 树林，浅绿 / 黄褐 → 农田，灰白低饱和 → 城区；水体由水体遮罩单独处理），
 * 再叠加对应的亚像素细节：田块与田埂、垄沟；树冠的起伏、冠间阴影；城区的街道、地块上的楼、坡屋顶、楼的投影。
 *
 * 原则：
 * - 细节只「调制」影像（乘子，均值约为 1），不替换影像的颜色，远看的平均色调和影像一致；
 * - 每种细节按自己的特征尺寸和像素足迹 fp（米）淡出，线条用盒式滤波（总「墨量」守恒），远处不会闪烁；
 * - 全部由世界坐标的哈希决定，没有平铺纹理；田块、街区的走向和尺寸按几百米的 Voronoi 分区各自随机，不会出现规则重复；
 * - 不用屏幕导数（调用处在分支里），足迹用解析的「距离 × 像素张角 / 入射余弦」。
 * 这些是按航拍照片的经验调出来的外观模型，不是真实的地块 / 建筑数据。
 */
export const GROUND_DETAIL_COMMON = /* glsl */ `
const vec3 DETAIL_LUMA = vec3(0.2126, 0.7152, 0.0722);
// 恒为 1。循环上下限用它而不用常量：常量次数的循环会被 Windows 上的 FXC 整个展开（连同内联的函数），
// 冷编译时间翻倍，严重时浏览器判定 GPU 卡死、丢失 WebGL 上下文
uniform int uDetailLoop;

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// 盒式滤波后的细线覆盖率：线宽 w、到中线的距离 d、像素足迹 fp（都是米）。
// 等于宽 w 的方波与宽 fp 的盒子卷积（梯形）：远处线变淡变宽，但总「墨量」不变
float lineCov(float d, float w, float fp) {
  float m = min(w, fp);
  return clamp((0.5 * (w + fp) - d) / m, 0.0, 1.0) * m / fp;
}

// 地表分类（输入影像反照率，线性）：x = 树林，y = 农田 / 草地，z = 城区
// 在感知空间（近似 sRGB）里判断：线性空间会把色相差放大，灰黄的城区也显得「很绿」。
// 阈值按 Sentinel-2 cloudless 在日本、长江流域的实际取值定（城区灰黄 sRGB ≈ (96,103,78)、树林 ≈ (29,52,32)、农田 ≈ (66,92,51)）
vec3 landClasses(vec3 a) {
  vec3 s = pow(max(a, vec3(0.0)), vec3(1.0 / 2.2));
  float lum = dot(s, DETAIL_LUMA);
  float mx = max(max(s.r, s.g), s.b), mn = min(min(s.r, s.g), s.b);
  float sat = (mx - mn) / max(mx, 1e-4);
  float greenish = smoothstep(-0.02, 0.04, s.g - s.r);                 // 绿比红多：植被
  float veg = smoothstep(0.24, 0.36, sat) * greenish;
  float forest = veg * (1.0 - smoothstep(0.22, 0.3, lum));
  float urban = (1.0 - smoothstep(0.22, 0.34, sat)) * smoothstep(0.26, 0.34, lum);
  float field = clamp(1.0 - forest - urban, 0.0, 1.0) * smoothstep(0.12, 0.2, lum);
  return vec3(forest, field, urban);
}

// 把地面分成约 cellM 米的 Voronoi 区域：xy = 区域中心（米），zw = 区域种子 0..1。
// 田块、街区的走向和尺寸按区域各自随机（真实的农田和城区也是一片一片地换走向）
vec4 detailRegion(vec2 gm, float cellM) {
  vec2 p = gm / cellM;
  vec2 i = floor(p);
  float best = 1e9;
  vec4 r = vec4(0.0);
  for (int y = -uDetailLoop; y <= uDetailLoop; y++) {
    for (int x = -uDetailLoop; x <= uDetailLoop; x++) {
      vec2 c = i + vec2(float(x), float(y));
      vec2 ctr = c + 0.15 + 0.7 * hash22(c + 71.3);
      vec2 d = p - ctr;
      float dd = dot(d, d);
      if (dd < best) { best = dd; r = vec4(ctr * cellM, hash22(c * 1.37 + 5.1)); }
    }
  }
  return r;
}

// ---- 农田：田块的色调差、田埂、垄沟 ----
// 返回 x = 亮度偏移（均值约 0），y = 色相偏移（− 偏黄 … + 偏绿），zw = 垄沟造成的表面坡度（东、南）
vec4 fieldDetail(vec2 gm, float fp) {
  vec4 rg = detailRegion(gm, 420.0);
  float ang = rg.z * 3.14159;
  vec2 q = rot2(ang) * (gm - rg.xy);
  vec2 sz = vec2(mix(14.0, 42.0, rg.w), mix(30.0, 120.0, fract(rg.w * 7.13 + rg.z * 3.1)));
  vec2 cell = floor(q / sz);
  vec2 f = q / sz - cell;
  vec2 h = hash22(cell + rg.zw * 91.7);
  vec2 de = min(f, 1.0 - f) * sz;               // 到田块四边的距离（米）
  float dEdge = min(de.x, de.y);
  // 逐块的色调：田块只剩几个像素宽时淡出；边缘按足迹淡到平均值（等效于盒式滤波两块之间的台阶）
  float fade = 1.0 - smoothstep(0.15, 0.45, fp / sz.x);
  float edgeAA = smoothstep(0.0, fp, dEdge);
  float tone = (h.x - 0.5) * 0.8 * fade * edgeAA;
  // 色相：偏绿（长势好）… 偏黄（成熟 / 收割后）；约 12% 的地块是翻过的裸土（偏褐），色相值记成 −2
  float hue = (h.y - 0.5) * 2.0;
  hue = fract(h.x * 31.7 + h.y * 5.1) < 0.12 ? -2.0 : hue;
  hue *= fade * edgeAA;
  // 田埂、田间小路：约 1.5 m 宽，比田里亮（草埂、土路）；减去平均覆盖率，远处不改变整体亮度
  float ridge = max(lineCov(de.x, 1.5, fp), lineCov(de.y, 1.5, fp));
  tone += 0.45 * (ridge - 1.5 * (1.0 / sz.x + 1.0 / sz.y)) * (1.0 - smoothstep(0.2, 0.6, fp / sz.x));
  // 垄沟：约一半的田块有，沿田块的长边，间距 1.5–3.5 m
  float per = mix(1.5, 3.5, fract(h.x * 5.3 + h.y));
  float on = step(0.45, fract(h.y * 7.9 + h.x * 2.1));
  float ff = (1.0 - smoothstep(0.2, 0.45, fp / per)) * on * edgeAA;
  float ph = q.x / per * 6.28318;
  tone += 0.1 * ff * sin(ph);
  vec2 axis = vec2(cos(ang), sin(ang));          // q.x 方向在世界坐标里的方向
  return vec4(tone, hue, axis * (0.3 * ff * cos(ph)));
}

// ---- 树冠：抖动网格上的圆冠（冠径 4–10 m），取最高合成；冠与冠之间的缝隙低 ----
// 返回 x = 冠顶相对高度 0..1，yz = 高度梯度（每米）
const float CROWN_CELL = 6.5;
vec3 canopy(vec2 gm) {
  vec2 p = gm / CROWN_CELL;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec3 best = vec3(0.0);
  for (int y = -uDetailLoop; y <= uDetailLoop; y++) {
    for (int x = -uDetailLoop; x <= uDetailLoop; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = hash22(i + o);
      vec2 d = f - o - (0.1 + 0.8 * h);
      float r = 0.45 + 0.4 * fract(h.x * 13.7 + h.y * 3.3);
      float top = 0.6 + 0.4 * h.y;
      float ht = (1.0 - dot(d, d) / (r * r)) * top;
      if (ht > best.x) best = vec3(ht, -2.0 * d * top / (r * r * CROWN_CELL));
    }
  }
  return best;
}

// ---- 城区：每个区域一个街道走向和街区尺寸；街区按地块切开，每块上一栋楼（或空地 / 停车场）----
// q：区域局部坐标（米，已旋转），rg：区域种子，dens：密度（0 住宅区 … 1 市中心）。
// 返回 x = 楼高（米，0 = 地面），y = 地面 / 屋顶的反照率乘子，zw = 屋顶坡度（区域局部坐标）
vec4 urbanAt(vec2 q, vec4 rg, float dens, float fp, out vec3 tint) {
  vec2 B = vec2(mix(70.0, 140.0, rg.z), mix(50.0, 110.0, rg.w));
  float W = mix(7.0, 14.0, fract(rg.z * 5.7 + rg.w));
  vec2 bc = floor(q / B);
  vec2 bf = q - bc * B;
  vec2 dB = min(bf, B - bf);
  float dStreet = min(dB.x, dB.y);
  vec2 hb = hash22(bc + rg.zw * 57.0);
  // 地块：街区内部按 10–30 m 切，地块数随街区不同
  vec2 inner = B - W;
  vec2 lotN = max(floor(inner / mix(vec2(11.0, 13.0), vec2(26.0, 32.0), hb)), 1.0);
  // 约 12% 的街区是一整栋大楼（工厂、学校、商场）
  float big = step(fract(hb.x * 17.3 + hb.y * 3.1), 0.12);
  lotN = mix(lotN, vec2(1.0), big);
  vec2 lotSz = inner / lotN;
  vec2 li = bf - 0.5 * W;
  vec2 lc = clamp(floor(li / lotSz), vec2(0.0), lotN - 1.0);
  vec2 lf = li - lc * lotSz;
  vec2 hl = hash22(lc + bc * 17.0 + rg.zw * 31.0);
  vec2 hl2 = hash22(lc * 3.1 + bc * 7.0 + 13.0);
  // 退线：四边各自随机，楼不会排成整齐的方格
  vec4 gap = mix(vec4(0.8), vec4(3.5), vec4(hl2, fract(hl2 * 7.3)));
  float dIn = min(min(lf.x - gap.x, lotSz.x - lf.x - gap.y), min(lf.y - gap.z, lotSz.y - lf.y - gap.w));
  float isB = smoothstep(-0.5 * fp, 0.5 * fp, dIn) * step(0.12, hl.x) * step(0.5 * W, dStreet);
  // 楼高：住宅 5–10 m；越靠市中心，高楼（15–60 m）越多
  float tall = max(step(hl.y, 0.08 + 0.45 * dens), big);
  float h = mix(mix(5.0, 10.0, hl.y), mix(15.0, 60.0, fract(hl.x * 9.1)), tall);
  // 屋顶：随机的灰、蓝灰、红褐、浅色；平顶大楼偏浅
  float rt = fract(hl.x * 23.7 + hl.y * 3.7);
  tint = rt < 0.35 ? vec3(0.95, 0.97, 1.02) : rt < 0.55 ? vec3(0.86, 0.95, 1.2) : rt < 0.72 ? vec3(1.18, 0.95, 0.82) : vec3(1.0);
  float roofAlb = mix(0.55, 1.6, fract(hl.x * 41.3 + hl.y * 17.1)) * (tall > 0.5 ? 1.15 : 1.0);
  // 坡屋顶（低层）：屋脊沿地块长边，两坡各朝一边，坡度约 25°
  vec2 slope = vec2(0.0);
  if (tall < 0.5) {
    vec2 c = lf - 0.5 * lotSz;
    slope = lotSz.x > lotSz.y ? vec2(0.0, sign(c.y) * 0.47) : vec2(sign(c.x) * 0.47, 0.0);
    // 女儿墙 / 檐口：楼边一圈窄的暗线
    roofAlb *= 1.0 - 0.3 * lineCov(dIn, 0.8, fp);
  } else {
    roofAlb *= 1.0 - 0.35 * lineCov(dIn - 0.8, 0.7, fp);
  }
  // 地面：街道是沥青（暗），地块里的空地有院子、停车场、树
  float streetM = lineCov(dStreet, W, fp);
  float ground = mix(mix(0.85, 1.05, hl2.x), 0.55, streetM);
  // 街道中线 / 车道线：宽街上一条浅线
  ground += 0.5 * lineCov(dStreet, 0.3, fp) * step(10.0, W);
  tint = mix(vec3(1.0), tint, isB);
  return vec4(h * isB, mix(ground, roofAlb, isB), slope * isB);
}

struct GroundDetail {
  vec3 albedoMul;  // 反照率乘子（均值约 1）
  vec2 slope;      // 细节造成的表面坡度（东、南），叠加到地形法线上
  float shadow;    // 小尺度投影（树冠、楼）：0 全阴影 … 1 无
  float ao;        // 冠间缝隙、街巷里的天空光遮挡
};

// g：本地坐标（km），alb：影像反照率，fp：像素足迹（米），sun：主光源方向（世界坐标）。
// 近处所有细节都在；fp 超过约 20 m 时整个函数返回「无细节」
// lod：地面采样级别（用来查附近有没有水：海滩、河堤上不放楼）
GroundDetail groundDetail(vec2 g, vec3 alb, float fp, vec3 sun, float lod) {
  GroundDetail o;
  o.albedoMul = vec3(1.0);
  o.slope = vec2(0.0);
  o.shadow = 1.0;
  o.ao = 1.0;
  if (fp > 24.0) return o;
  vec2 gm = g * 1000.0;
  vec3 cls = landClasses(alb);
  float lum = dot(alb, DETAIL_LUMA);
  float sunH = max(length(sun.xz), 1e-3);
  vec2 sunXZ = sun.xz / sunH;
  float tanE = clamp(sun.y / sunH, 0.05, 20.0);   // 太阳高度角的正切
  bool lit = sun.y > 0.02;

  // 所有陆地共用：几米到几十米的斑驳（草、灌木、土色不匀），把影像放大后的平滑色块打散
  float mott = (vnoise(gm / 9.0) - 0.5) * (1.0 - smoothstep(2.0, 6.0, fp))
             + (vnoise(gm / 37.0 + 11.0) - 0.5) * (1.0 - smoothstep(8.0, 20.0, fp));
  o.albedoMul *= 1.0 + 0.22 * mott;

  // ---- 树林 ----
  if (cls.x > 0.02) {
    float fadeC = 1.0 - smoothstep(1.2, 3.5, fp);
    // 冠群尺度（十几到几十米）的明暗：不同树种、树龄
    float clump = (vnoise(gm / 18.0 + 3.7) - 0.5) + 0.6 * (vnoise(gm / 55.0 - 8.1) - 0.5);
    vec3 fm = vec3(1.0 + 0.45 * clump * (1.0 - smoothstep(6.0, 22.0, fp)));
    fm *= vec3(1.0 - 0.12 * clump, 1.0, 1.0 + 0.1 * clump);   // 暗处偏蓝绿，亮处偏黄绿
    vec2 sl = vec2(0.0);
    float sh = 1.0, ao = 1.0;
    if (fadeC > 0.0) {
      vec3 c0 = canopy(gm);
      const float RELIEF = 3.5;       // 冠的起伏（米）
      sl = clamp(c0.yz * RELIEF, vec2(-1.6), vec2(1.6)) * fadeC;
      ao = mix(1.0, mix(0.45, 1.0, sqrt(max(c0.x, 0.0))), fadeC);
      if (lit) {
        // 朝太阳方向看两处：那里的冠比「这里 + 距离 × tan(高度角)」还高，这里就在它的影子里
        float hp = max(c0.x, 0.0) * RELIEF;
        float occ = -1e3;
        for (int j = 0; j < 2 * uDetailLoop; j++) {
          float d = j == 0 ? 2.5 : 5.5;
          occ = max(occ, max(canopy(gm + sunXZ * d).x, 0.0) * RELIEF - hp - d * tanE);
        }
        sh = mix(1.0, clamp(1.0 - occ / 0.8, 0.15, 1.0), fadeC);
      }
      // 影像的平均色已经包含了冠间阴影，细节出现时整体略提亮，远近过渡时平均亮度不跳
      fm *= mix(1.0, 1.22, fadeC);
    }
    o.albedoMul *= mix(vec3(1.0), fm, cls.x);
    o.slope += sl * cls.x;
    o.shadow = mix(o.shadow, sh, cls.x);
    o.ao = mix(o.ao, ao, cls.x);
  }

  // ---- 农田 ----
  if (cls.y > 0.02) {
    vec4 fd = fieldDetail(gm, fp);
    vec3 fm = vec3(1.0 + fd.x) * vec3(1.0 - 0.16 * fd.y, 1.0 + 0.03 * fd.y, 1.0 - 0.3 * fd.y);
    o.albedoMul *= mix(vec3(1.0), fm, cls.y);
    o.slope += fd.zw * cls.y;
  }

  // ---- 城区 ----
  if (cls.z > 0.02) {
    float fadeU = 1.0 - smoothstep(5.0, 16.0, fp);
    // 粗三级（近处约 60 m 像素）的水体遮罩 > 0：几十米内有海、河，是海滩、河堤、护岸，不放楼
    if (fadeU > 0.0) fadeU *= 1.0 - smoothstep(0.02, 0.15, sampleGround(uGroundWater, g, min(floor(lod) + 3.0, ${GROUND_LEVELS - 1}.0)).r);
    if (fadeU > 0.0) {
      vec4 rg = detailRegion(gm, 480.0);
      float ang = rg.z * 3.14159;
      mat2 R = rot2(ang);
      vec2 q = R * (gm - rg.xy);
      float dens = smoothstep(0.13, 0.28, lum);  // 越亮越密（大楼屋顶、混凝土）
      vec3 tint;
      vec4 u0 = urbanAt(q, rg, dens, fp, tint);
      float sh = 1.0;
      float ao = mix(0.75, 1.0, smoothstep(0.5, 4.0, u0.x));   // 街巷里看到的天空少
      if (lit) {
        // 楼的投影：朝太阳方向取几个点，有比视线更高的楼就在阴影里
        vec2 sq = R * sunXZ;
        vec3 tt;
        float occ = 0.0;
        for (int k = 0; k < 4 * uDetailLoop; k++) {
          float s = 3.0 * pow(2.2, float(k));
          float hq = urbanAt(q + sq * s, rg, dens, fp, tt).x;
          occ = max(occ, clamp((hq - u0.x - s * tanE) / 2.0 + 0.5, 0.0, 1.0));
        }
        sh = 1.0 - 0.85 * occ;
      }
      // 坡屋顶的坡度在区域局部坐标里，转回世界坐标
      vec2 sl = transpose(R) * u0.zw;
      // 城区的均值：街道偏暗、屋顶有亮有暗、还有楼影，整体按约 0.9 归一
      vec3 um = u0.y * tint / 0.9;
      o.albedoMul *= mix(vec3(1.0), um, cls.z * fadeU);
      o.slope += sl * cls.z * fadeU;
      o.shadow = mix(o.shadow, sh, cls.z * fadeU);
      o.ao = mix(o.ao, ao, cls.z * fadeU);
    }
  }
  return o;
}

// 影像取样位置的抖动：放大后的影像是平滑的双线性渐变，按几米尺度的噪声把取样点挪动不到一个影像像素，
// 色块边缘变得「碎」而不是「糊」。近处才有，fp 大于影像像素一半时停用
vec2 albedoJitterKm(vec2 g, float fp, float texelM) {
  float k = (1.0 - smoothstep(0.15, 0.5, fp / texelM)) * 0.45 * texelM;
  if (k <= 0.0) return vec2(0.0);
  vec2 gm = g * 1000.0;
  vec2 n = vec2(vnoise(gm / 4.0), vnoise(gm / 4.0 + 19.7)) + 0.5 * vec2(vnoise(gm / 1.7 + 5.3), vnoise(gm / 1.7 - 7.1));
  return (n / 1.5 - 0.5) * 2.0 * k / 1000.0;
}
`;
