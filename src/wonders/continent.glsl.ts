/**
 * 垂直大陆（WS09，research/WONDER_SCALE.md §3.6 候选 3、§4 WS09）：天幕层奇观，GLSL。形状由 wonders/continent-shape.ts 按种子生成。
 *
 * 画面：一整块从海面 / 云海里竖起来的台地，岩壁几乎竖直、顶沿 30–90 km 高（雷暴云顶的 2–5 倍，远高过巡航高度，要仰视），
 * 近端的「船首」在 200–290 km 外，台地斜着往地平线退去，远段的脚沉到地平线以下、只剩顶沿；朝着我们的一侧还有几块岬角 / 离岸孤台，
 * 一层层往后退、一层比一层蓝。
 * 尺度线索（三级细节，每级约差 5–10 倍）：
 * - 轮廓：一段段几十 km 的崖面（凸多边形），受光面 / 背光面大块分明；层叠的岬角剪影；顶沿起伏、孤峰、瀑布口的缺口；冰盖是顶沿上一道白边；
 * - 分段：2–4.5 km 厚的主层理（带倾角、层厚不均，缓坡层是一级级受光的台阶）、3–7 km 一道、间距不匀的冲沟与山脊（法线左右摆）、
 *   脚下的崩塌锥、从缺口倾泻下来的瀑布（落差几十 km，一路散成雾带）；
 * - 纹理：0.5–1 km 的细层、竖向水痕、几十 km 一片的色斑（都按像素足迹积分 / 淡出，远处平均成均匀的一层）。
 * 云交互：脚下一圈被岩壁挡住、堆起来的云墙；约三分之二的大陆在 8.5–12.5 km（和我们一样高）贴着岩壁挂一条云带；
 * 一架同高度航班的航迹云横在岩壁前面（尺度参照：60 m 的飞机拖出的一道白线，只到岩壁的脚踝）；
 * 比它远的真实云由 outside-pass 按 gWonderT 排到它后面，比它近的云海挡住它的脚。
 * 大气：物理空气透视（400 km 以外按远塔的办法外推），近处的岬角比远段清楚、顶沿在稀薄空气里比脚下清楚；
 * 黄昏只剩顶沿被照亮（penumbra.glsl.ts 的地影半影）；夜里是挡住星空的一整块剪影，月光下受光面淡淡可见。
 *
 * 只拼进窗外程序的 OWV 变体（OUTSIDE_WONDER + VERTICAL_CONTINENT，outside-pass.ts），垂直大陆在场时才后台编译；
 * 开关是自己的 uContOn（不写 uWonderOn / uWonderShape：天梯 / 建木那段把「不是天梯」的皮肤都画成建木，火车的 DROW 里也有它）。
 * 依赖 WONDER_SKY_COMMON 里的小工具（wonderTentCdf / wonderStrip / wonderBands / wonderCapRef / wonderIrr / wonderLum）与 uWonderAxis，只调用、不改。
 *
 * 几何：锚点处的局部坐标（x 东、y 沿锚点铅垂线往上、z 南）。每一块是凸多边形的每条边往里后仰 lean 的平面围成的凸体：
 * 视线的入射点 = 所有「朝着相机」的平面里最远的入射点（且早于所有背面平面的出射点），闭式。几块取最近的两块（按深度）从远到近合成，
 * 岬角在主壁前面的轮廓也就自然抗锯齿。
 * 抗锯齿全部解析：每块左右两端的轮廓按所有竖棱在像面上的横向区间（三角核积分），顶沿按到顶沿曲线的像素距离（含坡度），
 * 相邻崖面之间的竖棱按横向距离把两边的法线混合，花纹按足迹积分 / 淡出。循环上界写成「常数 + uLoopGuard」，FXC 不展开；
 * 重函数（透射率 / 天光 / 空气透视查表 / 封顶）与表面花纹都在最后的三步着色循环里各只有一个调用点。
 */
import { wonderPenumbraCommon } from "./penumbra.glsl";
import { CONT_ARRAY, CONT_BLOCKS, CONT_MAIN_MAX } from "./continent-shape";

export const VERTICAL_CONTINENT_COMMON = /* glsl */ `
${wonderPenumbraCommon("cont")}
uniform float uContOn;                  // 1 = 垂直大陆在场
uniform vec4 uContP[${CONT_ARRAY}];     // 所有块的顶点（每块前补一个、后补两个）：x 东、z 南（km）、顶沿高（km）、周长坐标 u（km）
uniform vec4 uContB[${CONT_BLOCKS * 2}]; // 每块两格：[起始下标, 顶点数, 后仰斜率, 包围半径]、[中心 x, z, 最高顶沿（km）, 0]
uniform vec4 uContE;                    // xyz 锚点处「东」（窗外坐标），w 块数
uniform vec4 uContS;                    // xyz 锚点处「南」，w 整体包围半径（km）
uniform vec4 uContC;                    // xyz 相机的局部坐标（km），w 种子
uniform vec4 uContA;                    // xy 整体中心（km），w 浮现前沿（km）
uniform vec4 uContT;                    // 层理：主层厚、细层厚（km）、倾斜梯度 x、z
uniform vec4 uContG;                    // 冲沟间距（km）、法线摆幅（弧度）；瀑布格长（km）、概率
uniform vec4 uContW;                    // 冰盖比例、脚下云墙高（km）、贴壁云带高（km，0 = 没有）、风向
uniform vec4 uContK;                    // 航迹云：航向（弧度，东起往南）、过点 x、z（km）、高度（km）
uniform vec4 uContR;                    // 岩石反照率 rgb，w 航迹云相位

// 一维值噪声（row 区分不同的量）：只沿一个方向变的噪声用它，hash 次数是 vnoise 的一半（OWV 冷编译按代码总量涨）
float contN1(float x, float row) {
  float i = floor(x);
  float f = x - i;
  return mix(hash12(vec2(i, row)), hash12(vec2(i + 1.0, row)), f * f * (3.0 - 2.0 * f));
}

// 瀑布格（沿周长每 uContG.z km 一格，按概率有一道瀑布）：x 瀑布中心的 u，y 顶沿缺口深（km），z 缺口半宽（km），w 有 = 1
vec4 contFallCell(float u) {
  float cw = uContG.z;
  float wi = floor(u / cw);
  float hw = hash12(vec2(wi, uContC.w * 97.0 + 23.0));
  return vec4((wi + 0.25 + 0.5 * fract(hw * 17.3)) * cw, 0.8 + 2.2 * fract(hw * 5.9), 2.0 + 3.0 * fract(hw * 9.1), step(hw, uContG.w));
}

// 顶沿（悬崖边）高度（km）：Hl 是两端顶点的线性插值；四个倍频的起伏（40 / 13 / 4.5 / 1.6 km，采样不住的淡到均值）、
// 约三成的 18 km 格里立一座孤峰（高出 1.5–6 km）、瀑布口的 V 形缺口。fu：像素足迹（沿 u，km）
float contBrink(float u, float Hl, float fu) {
  float sd = uContC.w * 97.0;
  float h = Hl + 3.2 * (contN1(u / 40.0, sd) - 0.5)
          + 1.4 * (contN1(u / 13.0, sd + 5.0) - 0.5) * (1.0 - smoothstep(2.2, 4.4, fu))
          + 0.6 * (contN1(u / 4.5, sd + 9.0) - 0.5) * (1.0 - smoothstep(0.75, 1.5, fu))
          + 0.25 * (contN1(u / 1.6, sd + 13.0) - 0.5) * (1.0 - smoothstep(0.27, 0.53, fu));
  float ci = floor(u / 18.0);
  float hs = hash12(vec2(ci, sd + 11.0));
  if (hs > 0.7) {
    float uc = (ci + 0.2 + 0.6 * fract(hs * 13.7)) * 18.0;
    float w = 1.2 + 2.0 * fract(hs * 7.1);
    h += (1.5 + 4.5 * fract(hs * 3.3)) * (1.0 - smoothstep(0.3 * w, w, abs(u - uc)));
  }
  vec4 fc = contFallCell(u);
  h -= fc.w * fc.y * max(0.0, 1.0 - abs(u - fc.x) / fc.z);
  return h;
}

// 层理：一层层厚 w 的岩层（每层按 hash 取深浅；单调扭曲让层厚不均），按竖直足迹 f 盒式积分，采样不住时淡到均值。
// 返回 (深浅 0..1, 缓坡层——会被风化成一级级台阶、朝上受光——的比例)
vec2 contLayers(float l, float f, float w, float row) {
  float lw = l + 0.3 * w * sin(l / w * 1.3 + row) + 0.25 * w * sin(l / w * 0.47 + 2.0 * row);
  float fw = max(f * 1.52, 1e-4);
  float c0 = floor((lw - 0.5 * fw) / w);
  float c1 = floor((lw + 0.5 * fw) / w);
  float v0 = hash12(vec2(c0, row));
  float v1 = hash12(vec2(c1, row));
  float fr = c1 > c0 ? clamp((lw + 0.5 * fw - c1 * w) / fw, 0.0, 1.0) : 0.0;
  vec2 r = mix(vec2(v0, step(v0, 0.28)), vec2(v1, step(v1, 0.28)), fr);
  return mix(r, vec2(0.5, 0.28), smoothstep(0.4 * w, 0.9 * w, fw));
}

// 同高度航班的航迹云（尺度参照，写法同巨柱群 pillarContrail）：局部坐标里的一条水平直线，海拔 uContK.w、顺着地球曲率下沉；
// 机头以 0.25 km/s 往前走，身后的云随「离飞机的时间」变宽、变淡。返回 (光学厚度, 深度 km)
vec2 contContrail(vec3 o, vec3 d, float pixelAngle, float T) {
  vec3 A = vec3(cos(uContK.x), 0.0, sin(uContK.x));
  vec3 P0 = vec3(uContK.y, uContK.w - dot(uContK.yz, uContK.yz) / 12740.0, uContK.z);
  float ph = fract(T / 960.0 + uContR.w);
  float sPlane = -120.0 + 240.0 * ph;
  vec3 wc = o - P0;
  float b = dot(d, A);
  float den = max(1.0 - b * b, 1e-4);
  float dw = dot(d, wc), ew = dot(A, wc);
  float tr = (b * ew - dw) / den;
  float sl = (ew - b * dw) / den;
  float age = (sPlane - sl) / 0.25;
  if (tr <= 0.0 || age < 2.0) return vec2(0.0, 1e9);
  vec3 pl = P0 + A * sl;
  pl.y = uContK.w - dot(pl.xz, pl.xz) / 12740.0;
  vec3 dv = (o + d * tr) - pl;
  float wd = 0.04 + 0.0012 * age;
  float fpx = tr * pixelAngle;
  float we2 = wd * wd + fpx * fpx;
  float patchy = 0.55 + 0.45 * sin(sl * 0.37 + uContC.w * 40.0) * sin(sl * 0.11 + 1.3);
  float tau = patchy * exp(-age / 600.0) * smoothstep(2.0, 12.0, age) * (wd / sqrt(we2)) * exp(-dot(dv, dv) / we2) / max(sqrt(den), 0.2);
  tau *= smoothstep(118.0, 95.0, abs(sl)) * smoothstep(120.0, 100.0, sPlane);
  return vec2(tau, tr);
}

// L：背景辐亮度；tLimit：这条视线打到地面 / 海面的距离（打不到传一个大数）
vec3 wonderContinent(vec3 L, vec3 rd, float tLimit) {
  if (uContOn < 0.5) return L;
  vec3 a = uWonderAxis;
  vec3 E = uContE.xyz;
  vec3 S = uContS.xyz;
  vec3 o = uContC.xyz;
  vec3 d = vec3(dot(rd, E), dot(rd, a), dot(rd, S));
  vec2 dh = d.xz;
  float dl2 = dot(dh, dh);
  if (dl2 < 1e-6) return L;
  float dl = sqrt(dl2);
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float T = uTime;
  float sd = uContC.w * 97.0;
  float front = uContA.w;
  vec2 nh2 = vec2(-dh.y, dh.x) / dl;         // 水平面里「像面横向」
  float dHz = sqrt(max(uCamR * uCamR - BOTTOM * BOTTOM, 1.0));    // 到几何地平线的距离（km）
  float dipY = -dHz / uCamR;                                         // 几何地平线处视线的 rd.y

  // ---- 航迹云（在岩壁前面 90–160 km；整体早退之外也要画：它一直延伸到大陆的轮廓以外）
  vec2 ct = contContrail(o, d, pixelAngle, T);

  // ---- 几何：每一块与视线求交，只留最近的两块（B 最近、A 次近）。
  // g1 = (周长坐标 u, 高度 y, 顶沿高 Hc, 覆盖率)，g2 = (崖面外法线的方位角, 后仰斜率, 沿 u 的足迹, 竖直足迹)，g3 = (点的 x, z, 深度 t, 左右轮廓覆盖率)
  vec4 gA1 = vec4(0.0), gA2 = vec4(0.0), gA3 = vec4(0.0);
  vec4 gB1 = vec4(0.0), gB2 = vec4(0.0), gB3 = vec4(0.0);
  float tA = 1e9, tB = 1e9;
  vec2 cc = uContA.xy;
  float tcl = max(dot(cc - o.xz, dh) / dl2, 0.0);
  vec2 qc = o.xz + dh * tcl - cc;
  if (dot(qc, qc) < uContS.w * uContS.w) {
    for (int bk = 0; bk < ${CONT_BLOCKS} + uLoopGuard; bk++) {
      if (float(bk) >= uContE.w) break;
      vec4 BI = uContB[2 * bk];
      vec4 BC = uContB[2 * bk + 1];
      float tcb = max(dot(BC.xy - o.xz, dh) / dl2, 0.0);
      vec2 qb = o.xz + dh * tcb - BC.xy;
      if (dot(qb, qb) > BI.w * BI.w) continue;
      // 往上走的视线在进入这一块的包围圆时已经高过它最高的顶沿（+ 孤峰余量）：窗里上半部分的天空都在这里早退
      if (d.y > 0.0 && o.y + d.y * max(tcb - BI.w / dl, 0.0) > BC.z + 8.0) continue;
      int i0 = int(BI.x + 0.5);
      float lean = BI.z;
      // 循环里只记下标（命中的崖面、两端的竖棱），循环后再按下标取一次顶点：少存一堆 vec4，OWV 冷编译少一截
      float tIn = -1e9, tOut = 1e9, jHit = 1.0;
      float xMin = 1e9, xMax = -1e9, wMin = 1.0, wMax = 1.0, tvMin = 0.0, tvMax = 0.0, jMin = 1.0, jMax = 1.0;
      vec2 uMin = vec2(0.0), uMax = vec2(0.0);  // 两端竖棱的周长坐标与视线在那里的高度
      vec4 P0 = uContP[i0];
      vec4 P1 = uContP[i0 + 1];
      vec2 mPrev = normalize(vec2(P1.y - P0.y, P0.x - P1.x));
      for (int j = 1; j < ${CONT_MAIN_MAX + 1} + uLoopGuard; j++) {
        if (float(j) > BI.y) break;
        vec4 Pa = uContP[i0 + j];
        vec4 Pb = uContP[i0 + j + 1];
        vec2 m = normalize(vec2(Pb.y - Pa.y, Pa.x - Pb.x));
        vec3 n = vec3(m.x, lean, m.y);
        float dn = dot(n, d);
        float num = dot(n, vec3(Pa.x, 0.0, Pa.y) - o);
        if (dn < 0.0) {
          float tk = num / dn;
          if (tk > tIn) {
            tIn = tk;
            jHit = float(j);
          }
        } else if (dn > 0.0) tOut = min(tOut, num / dn);
        else if (num < 0.0) tOut = -1.0;
        // 顶点 Pa 的竖棱（两侧崖面 mPrev、m 各往里后仰，棱沿角平分线往里退）在这条视线最近处的横向位置
        vec2 rv = Pa.xy - o.xz;
        float tv = max(dot(rv, dh) / dl2, 1.0);
        float yv = max(o.y + d.y * tv, 0.0);
        float xv = dot(rv - lean * yv * (mPrev + m) / max(1.0 + dot(mPrev, m), 0.05), nh2);
        float wv = tv * pixelAngle;
        if (xv < xMin) { xMin = xv; wMin = wv; tvMin = tv; jMin = float(j); uMin = vec2(Pa.w, yv); }
        if (xv > xMax) { xMax = xv; wMax = wv; tvMax = tv; jMax = float(j); uMax = vec2(Pa.w, yv); }
        mPrev = m;
      }
      // 两端的竖棱不是一刀切的直线：按高度抖 ±1.2 km（+ 看得清时再加 ±0.35 km 的细碎），轮廓成了风化的岩脊
      // （只给最后选出的两条端棱加：逐顶点算噪声，每个像素要多算几十次）
      for (int q = 0; q < 2 + uLoopGuard; q++) {
        if (q > 1) break;
        vec2 uv = q == 0 ? uMin : uMax;
        float jag = 2.4 * (contN1(uv.y / 4.0, uv.x * 0.37 + sd) - 0.5) + 0.7 * (contN1(uv.y / 1.2, uv.x * 0.53 + sd) - 0.5) * (1.0 - smoothstep(0.2, 0.4, q == 0 ? wMin : wMax));
        if (q == 0) xMin += jag;
        else xMax += jag;
      }
      // 左右轮廓的覆盖率：像素（三角核）落在区间 [xMin, xMax] 里的比例
      float covLat = clamp(wonderTentCdf(-xMin / wMin) + wonderTentCdf(xMax / wMax) - 1.0, 0.0, 1.0);
      bool hit = tIn > 0.0 && tIn < tOut;
      if (!hit && covLat <= 0.0) continue;
      // 中心视线从轮廓外擦过：按离它最近的那条端棱着色（深度 = 棱的距离，崖面取朝着相机的那一侧）
      bool useMin = -xMin / wMin < xMax / wMax;
      float tW = hit ? tIn : (useMin ? tvMin : tvMax);
      int kb = i0 + int((hit ? jHit : (useMin ? jMin : jMax)) + 0.5);
      vec4 Pp = uContP[kb - 1];
      vec4 pA = uContP[kb];
      vec4 pB = uContP[kb + 1];
      vec4 Pn = uContP[kb + 2];
      vec2 mA = normalize(vec2(pA.y - Pp.y, Pp.x - pA.x));   // 前一个崖面
      vec2 fm = normalize(vec2(pB.y - pA.y, pA.x - pB.x));   // 这一格
      vec2 mB = normalize(vec2(Pn.y - pB.y, pB.x - Pn.x));   // 后一个崖面
      if (!hit) {
        vec2 toCam = o.xz - pA.xy;
        fm = dot(mA, toCam) > dot(fm, toCam) ? mA : fm;
        pB = pA + vec4(-fm.y, fm.x, 0.0, 1.0);   // 退化成一个点：u、顶沿取顶点处的
      }
      // 被海面 / 地面挡住：墙脚和海面的交界、远处墙脚沉到地平线以下的那条线都是整条横贯的长边，一刀切会随飞行逐帧爬（WS09 返工 live 实测），
      // 按亚像素解析：墙在地平线以外时按视线离几何地平线的像素距离，在地平线以内时按墙脚离海面的高度；离交界两个像素以外才整像素判
      float covSea = 1.0;
      if (tW > tLimit) {
        if (tW > dHz && rd.y < dipY - 2.0 * pixelAngle) continue;
      }
      if (tW <= 0.0 || tW > tA) continue;   // 比已有的两块都远
      vec3 Pl = o + d * tW;
      vec2 eAB = pB.xy - pA.xy;
      float eL2 = max(dot(eAB, eAB), 1e-6);
      float fr = hit ? clamp(dot(Pl.xz - pA.xy, eAB) / eL2, 0.0, 1.0) : 0.0;
      float u = mix(pA.w, pB.w, fr);
      float Hl = mix(pA.z, pB.z, fr);
      float wP = tW * pixelAngle;
      vec2 tng = hit ? eAB * inversesqrt(eL2) : vec2(-fm.y, fm.x);
      float fu = wP / max(abs(dot(tng, nh2)), 0.08);   // 沿崖面的足迹（km）
      float fy = wP / dl;                                // 竖直足迹（km）
      float y = Pl.y;
      // 顶沿的覆盖率：到顶沿曲线的像素距离（按顶沿在像面上的坡度折算）；三次求值放进一个循环（一个调用点：FXC 按调用点整份内联）
      float Hc = 0.0, Hm = 0.0, Hp = 0.0;
      for (int q = 0; q < 3 + uLoopGuard; q++) {
        if (q > 2) break;
        float hq = contBrink(u + float(q - 1) * fu, Hl, fu);
        if (q == 0) Hm = hq;
        else if (q == 1) Hc = hq;
        else Hp = hq;
      }
      float slp = (Hp - Hm) / (2.0 * fy);
      covSea = tW > dHz ? wonderTentCdf((rd.y - dipY) / pixelAngle) : wonderTentCdf((y + dot(Pl.xz, Pl.xz) / 12720.0) / fy);
      if (tW > tLimit && tLimit < (tW > dHz ? dHz : tW) - 20.0) covSea = 0.0;   // 前面的真实地形（岛）挡住的，不按海面算
      float cov = covLat * covSea * wonderTentCdf((Hc - y) / fy * inversesqrt(1.0 + slp * slp));
      if (cov <= 0.0) continue;
      // 相邻崖面之间的竖棱：离棱不到一个像素时按横向距离把两侧的法线混合（棱另一侧是背面 = 轮廓，已由 covLat 管）
      vec2 mh = fm;
      if (hit) {
        vec2 rA = pA.xy - o.xz, rB = pB.xy - o.xz;
        float xA = dot(rA - lean * y * (mA + fm) / max(1.0 + dot(mA, fm), 0.05), nh2);
        float xB = dot(rB - lean * y * (fm + mB) / max(1.0 + dot(fm, mB), 0.05), nh2);
        float wA = dot(mA, -rA) > 0.0 ? 1.0 - wonderTentCdf(abs(xA) / wP) : 0.0;
        float wB = dot(mB, -rB) > 0.0 ? 1.0 - wonderTentCdf(abs(xB) / wP) : 0.0;
        mh = normalize(fm * (1.0 - wA - wB) + mA * wA + mB * wB);
      }
      vec4 g1 = vec4(u, y, Hc, cov);
      vec4 g2 = vec4(atan(mh.y, mh.x), lean, fu, fy);
      vec4 g3 = vec4(Pl.xz, tW, covLat);
      if (tW < tB) {
        gA1 = gB1; gA2 = gB2; gA3 = gB3; tA = tB;
        gB1 = g1; gB2 = g2; gB3 = g3; tB = tW;
      } else {
        gA1 = g1; gA2 = g2; gA3 = g3; tA = tW;
      }
    }
  }
  float covA = gA1.w, covB = gB1.w;
  if (covA + covB <= 0.0 && ct.x < 1e-4) return L;
  float covAll = 1.0 - (1.0 - covA) * (1.0 - covB);
  float tNear = covB > 0.0 ? tB : tA;
  // 航迹云被岩壁挡住的部分（它在岩壁后面时）
  float tauC = ct.x * (ct.y < tNear || covAll <= 0.0 ? 1.0 : 1.0 - covAll);
  if (covAll <= 0.0 && tauC < 1e-4) return L;

  // 给 outside-pass 排远云、挡点星与太阳圆盘：只按岩壁实体，乘可见前沿（浮现 / 退场时没显形的部分不挡）
  vec3 O = vec3(0.0, uCamR, 0.0);
  float visA = 1.0 - smoothstep(0.35 * front, front, length(O + rd * min(tA, 1e4)) - BOTTOM);
  float visB = 1.0 - smoothstep(0.35 * front, front, length(O + rd * min(tB, 1e4)) - BOTTOM);
  gWonderCov = 1.0 - (1.0 - covA * visA) * (1.0 - covB * visB);
  gWonderT = tNear;

  // ---- 着色（三步：远的一块 → 近的一块 → 贴壁的云与航迹云），重函数与表面花纹各一个调用点
  // 背景去掉月盘：封顶的下限、黄昏的剪影、月光内散射近似都按背景亮度算，带着月盘会让月亮透过岩壁（天环同理）
  vec3 Lbg = L - (tLimit > 1e8 ? moonDisk(rd) * sunTransmittance(uCamR, rd.y) : vec3(0.0));
  float dayF = smoothstep(-0.10, 0.02, uSunDir.y);
  float moonW = 1.0 - smoothstep(-0.21, -0.14, uSunDir.y);
  float duskW = 1.0 - smoothstep(-0.02, 0.06, uSunDir.y);
  float fwd = 1.0 + 1.5 * pow(max(dot(rd, uSunDir), 0.0), 4.0);
  vec3 skyTop = max(vec3(1.0) - transmittanceToTop(uCamR, rd.y), vec3(1e-4));
  float tauS = 0.0, hS = 0.0;                 // 贴着近块岩壁的云：光学厚度、按厚度加权的高度
  for (int k = 0; k < 3 + uLoopGuard; k++) {
    if (k > 2) break;
    bool isCloud = k == 2;
    vec4 g1 = k == 0 ? gA1 : gB1;
    vec4 g2 = k == 0 ? gA2 : gB2;
    vec4 g3 = k == 0 ? gA3 : gB3;
    float tauAll = tauS + tauC;
    float covk = isCloud ? 1.0 - exp(-tauAll) : g1.w;
    // 远的一块被近的一块整个盖住时不用算（岬角挡在主壁前面的大片像素）
    if (covk < 1e-4 || (k == 0 && covB > 0.999)) continue;
    float tk = isCloud ? max(((tB - 1.5) * tauS + ct.y * tauC) / max(tauAll, 1e-6), 1.0) : g3.z;
    vec3 Pw = O + rd * tk;
    float rr = length(Pw);
    float hq = isCloud ? (hS + uContK.w * tauC) / max(tauAll, 1e-6) : rr - BOTTOM;
    vec3 up = Pw / rr;
    float visk = 1.0 - smoothstep(0.35 * front, front, hq);
    vec3 alb = vec3(0.0);
    vec3 nW = up;
    if (!isCloud) {
      // ---- 表面：层理、冲沟、崩塌锥、瀑布、冰盖（都按足迹积分 / 淡出）
      float u = g1.x, y = g1.y, Hc = g1.z, fu = g2.z, fy = g2.w;
      vec2 mh = vec2(cos(g2.x), sin(g2.x));
      // 冲沟与山脊：间距 3–7 km、不均匀（单调扭曲），随高度略弯；山脊两侧的法线往左右摆（三角波的坡面，按足迹积分成方波的平均）
      float gP = uContG.x;
      float gx = u + gP * (contN1(u / (2.7 * gP), sd + 2.0) - 0.5) + 0.25 * gP * sin(y / 13.0 + sd * 3.0);
      float gi = floor(gx / gP);
      float gFade = 1.0 - smoothstep(gP / 6.0, gP / 3.0, fu);
      // 扶壁与冲沟：法线方位按两级值噪声摆（不规则的脊与沟，随高度汇合 / 分叉）。周期性的正弦 / 方波远看是一幕幕冰帘 / 玻璃
      // 大尺度的扶壁（15–40 km 一道、法线摆 ±0.8 rad）：顺光时也有一半的坡面转开、落进阴影，整面墙才分得出一道道山脊
      float bP = 5.3 * gP;
      float bFade = 1.0 - smoothstep(bP / 6.0, bP / 3.0, fu);
      float nb = vnoise(vec2(u / bP, y / (2.5 * bP) + sd + 4.0));
      float ng = vnoise(vec2(gx / gP, y / (3.0 * gP) + sd));
      float dAz = 2.0 * uContG.y * (ng - 0.5) * gFade + 1.6 * (nb - 0.5) * bFade;
      // 沟底（噪声的低谷）暗一些：天光被两侧的山脊挡掉一部分
      float gully = (1.0 - smoothstep(0.2, 0.45, ng)) * gFade * 0.6 + (1.0 - smoothstep(0.15, 0.4, nb)) * bFade * 0.4;
      vec2 mg = mh * cos(dAz) + vec2(-mh.y, mh.x) * sin(dAz);
      // 层理：主层 + 细层（带倾角、缓缓褶皱）；缓坡层风化成台阶，法线往上翘
      float ll = y + dot(uContT.zw, g3.xy) + 0.6 * sin(u / 47.0 + sd);
      float fl = fy + length(uContT.zw) * fu;
      vec2 L1 = contLayers(ll, fl, uContT.x, sd + 1.0);
      // 层理不是满墙一样清楚：有的段是一层层的沉积岩，有的段是整块的岩体（层理淡到几乎没有），一片几十 km
      float sc = 0.25 + 0.75 * smoothstep(0.3, 0.7, vnoise(vec2(u / 60.0, ll / 35.0 + sd + 9.0)));
      // 崩塌锥：脚下每 14 km 一格、约一半的格里有一座 2–6 km 高的碎石锥（坡缓、颜色略浅而均匀，没有层理）
      float ki = floor(u / 14.0);
      float hk = hash12(vec2(ki, sd + 19.0));
      float kc = (ki + 0.5 + 0.3 * (fract(hk * 7.7) - 0.5)) * 14.0;
      float kH = hk < 0.5 ? (2.0 + 4.0 * fract(hk * 3.1)) : 0.0;
      float kW = 4.0 + 3.0 * fract(hk * 5.3);
      float kS = kH / kW * fu / fy;
      float cone = wonderTentCdf((kH * max(0.0, 1.0 - abs(u - kc) / kW) - y) / fy * inversesqrt(1.0 + kS * kS));
      float ledge = mix(L1.y * sc, 0.0, cone);
      vec3 nl = normalize(vec3(mg.x, g2.y + 0.45 * ledge + 0.7 * cone, mg.y));
      nW = normalize(E * nl.x + a * nl.y + S * nl.z);
      // 反照率：岩性底色 × 主层 × 细层 × 冲沟底 × 从台阶上挂下来的暗色水痕（「沙漠漆」，宽 2–6 km、往下拖几十 km）
      // × 几十 km 一片的色斑（略偏铁锈色）。细的竖纹只在看得清时才有：竖纹与层理交成方格，远看就是一栋玻璃幕墙
      float varnish = smoothstep(0.55, 0.85, vnoise(vec2(u / 3.2, y / 30.0 + sd + 17.0))) * (1.0 - smoothstep(0.55, 1.1, fu));
      float blot = vnoise(vec2(u / 45.0, y / 24.0 + sd));
      vec3 rock = uContR.rgb * mix(vec3(0.94, 1.0, 1.06), vec3(1.1, 0.97, 0.86), blot) * (0.7 + 0.6 * blot);
      alb = rock * (1.0 + sc * 0.62 * (L1.x - 0.5)) * (1.0 - 0.25 * gully) * (1.0 - 0.35 * varnish);
      // 岩面的斑驳（1.5 / 4 km 两级，按足迹淡出）：没有它，远看是一整块磨砂玻璃
      float mot = (vnoise(vec2(u / 4.0, y / 3.0 + sd + 21.0)) - 0.5) * (1.0 - smoothstep(0.7, 1.4, fu))
                + 0.7 * (vnoise(vec2(u / 1.5, y / 1.1 + sd + 23.0)) - 0.5) * (1.0 - smoothstep(0.25, 0.5, max(fu, fy)));
      alb *= 1.0 + 0.55 * mot;
      alb = mix(alb, uContR.rgb * 1.05, cone);
      // 瀑布：从顶沿的缺口倾泻下来，越往下越宽、越散，落差 10–25 km 以后大半化成雾带（雾算进贴壁的云，只给近的一块）
      vec4 fc = contFallCell(u);
      if (fc.w > 0.5) {
        float drop = max(Hc - y, 0.0);
        float hw = hash12(vec2(floor(u / uContG.z), sd + 29.0));
        float Lb = 10.0 + 15.0 * hw;
        float ww = 0.25 + 0.45 * fract(hw * 7.3) + 0.035 * drop;
        float core = wonderStrip((u - fc.x) / fu, 0.5 * ww / fu) * exp(-drop / Lb) * (0.75 + 0.25 * vnoise(vec2((u - fc.x) / 0.35, (y + T * 0.03) / 0.9)));
        alb = mix(alb, vec3(0.72, 0.75, 0.78), clamp(core, 0.0, 1.0));
        float wm = 0.45 + 0.035 * drop;
        float mist = 0.9 * (1.0 - exp(-drop / Lb)) * (0.8 / wm) * exp(-(u - fc.x) * (u - fc.x) / (wm * wm)) * smoothstep(0.0, 3.0, drop)
                   * (0.6 + 0.4 * vnoise(vec2((u - fc.x) / 1.3, (y + T * 0.02) / 2.0 + sd)));
        if (k == 1) { tauS += mist; hS += mist * y; }
      }
      // 冰盖：顶沿上一道 0.35–1.45 km 厚的白边（约一半的大陆有，覆盖一部分顶沿）
      float iceM = uContW.x > 0.0 ? smoothstep(1.0 - uContW.x - 0.08, 1.0 - uContW.x + 0.08, contN1(u / 28.0, sd + 31.0)) : 0.0;
      float ti = 0.35 + 1.1 * contN1(u / 7.0, sd + 41.0);
      alb = mix(alb, vec3(0.7, 0.76, 0.84), iceM * wonderTentCdf((y - (Hc - ti)) / fy));
      if (k == 1) {
        // 脚下的云墙：岩壁挡住的湿空气堆起来（2–4.5 km，偶尔堆到 8 km），顶部是翻滚的云包
        float hcw = uContW.y * (0.55 + 0.9 * contN1(u / 22.0, sd + 51.0)) + 3.5 * smoothstep(0.72, 0.95, contN1(u / 55.0, sd + 57.0));
        float ctop = hcw + 2.4 * (contN1(u / 3.5 + T * 0.002, sd + 61.0) - 0.5) + 1.2 * (contN1(u / 9.0, sd + 63.0) - 0.5);
        float tw = 1.6 * smoothstep(ctop + 0.4, ctop - 1.2, y) * smoothstep(0.25, 0.75, contN1(u / 6.0, sd + 67.0) * 0.6 + 0.4 * vnoise(vec2(u / 1.6, y / 1.1)));
        tauS += tw;
        hS += tw * min(y, ctop);
        // 贴壁的云带：和我们一样高（8.5–12.5 km），一段段挂在岩壁上——一眼看出岩壁比云高出多少倍
        if (uContW.z > 0.0) {
          float hb = uContW.z + 1.2 * (contN1(u / 40.0, sd + 71.0) - 0.5);
          float thb = 0.5 + 0.6 * contN1(u / 15.0, sd + 73.0);
          float msk = smoothstep(0.35, 0.65, contN1(u / 18.0 + T * 0.0015, sd + 79.0));
          hb += 0.9 * (contN1(u / 5.0 - T * 0.003, sd + 75.0) - 0.5);
          float tb = 1.8 * exp(-(y - hb) * (y - hb) / (thb * thb)) * msk * smoothstep(0.25, 0.7, vnoise(vec2(u / 2.2 - T * 0.004, (y - hb) / 0.7 + 3.0)));
          tauS += tb;
          hS += tb * y;
        }
        tauS *= g3.w;
        hS *= g3.w;
      }
    }
    vec3 tSRef, tMRef;
    float visS, visM;
    vec3 eSun = uSunIlluminance * contShadowT(Pw, uSunDir, tSRef, visS);
    vec3 eMoon = uMoonIlluminance * contShadowT(Pw, uMoonDir, tMRef, visM);
    vec3 eSkyUp = skyIrradiance(min(rr, TOP), up) * (1.0 - smoothstep(40.0, 100.0, hq));
    vec3 eUp = 0.21 * (uSunIlluminance * max(dot(up, uSunDir), 0.0) + uMoonIlluminance * max(dot(up, uMoonDir), 0.0));
    // 空气透视：400 km 以内查表；更远的一段（大陆的远端在地平线外）：透射率按平均消光外推、内散射按「源函数不变」外推
    vec3 uvw = aerialPerspectiveUvw(rd, uApDir, min(tk, AERIAL_MAX_DISTANCE));
    vec3 apI = texture(uAerialInscatterS, uvw).rgb;
    vec3 apT = texture(uAerialTransmittanceS, uvw).rgb;
    if (tk > AERIAL_MAX_DISTANCE) {
      // 按 400 km 处的平均消光外推（比远塔那样查两次透射率 LUT 便宜：OWV 冷编译逐项撤回里那一段占 15%）；
      // 400 km 以外的视线在地平线以上、越走越高，平均消光只会更小，外推是偏浓的上限，远段本来就沉在霾里
      vec3 Tn = pow(max(apT, vec3(1e-4)), vec3(tk / AERIAL_MAX_DISTANCE));
      apI = apI / max(vec3(1.0) - apT, vec3(1e-3)) * (vec3(1.0) - Tn);
      apT = Tn;
    }
    vec3 apL = apI * uApIlluminance;
    // 相机到岩壁之间的内散射：月光那一路按「背景里它前面那段空气的比例」补（同巨柱群）；黄昏地影里的一段画成略暗于天空的剪影
    vec3 frontFrac = 1.0 - apT;
    if (tLimit > 1e8) frontFrac = clamp(frontFrac / skyTop, 0.0, 1.0);
    vec3 lFront = max(apL, Lbg * frontFrac * moonW);
    // 黄昏：地影里的岩壁画成比天空暗约两成的剪影（同巨柱群；查表的内散射在这里和整条视线的天空几乎一样亮，不压就看不见岩壁）
    lFront = mix(lFront, min(lFront, Lbg * 0.78), duskW);
    // 逆光（WS09 审查）：太阳在崖面背后时，相机到岩壁之间的空气落在岩壁自己的影子里——影长 (Hc − y)/tanα（太阳 4° 时 400–1300 km），
    // 占视线长度的比例 shadowF 那一段没有太阳的单次散射；查表的内散射默认整段都被照着，岩壁就和同方向的天空一样亮、整块隐形。
    // 按比例扣掉，留三成（天光与多次散射），逆光时是有空气透视层次的暗剪影，不是纯黑贴片。云那一步按近块的几何算
    vec4 gs1 = isCloud ? gB1 : g1;
    float azS = isCloud ? gB2.x : g2.x;
    vec3 nWh = E * cos(azS) + S * sin(azS);                 // 崖面水平外法线（窗外坐标）
    vec3 sH = uSunDir - up * dot(uSunDir, up);
    float sHl = max(length(sH), 1e-4);
    float behind = gs1.w > 0.0 ? smoothstep(0.0, 0.25, -dot(nWh, sH) / sHl) : 0.0;
    float shadowF = behind * clamp(max(gs1.z - gs1.y, 0.0) * sHl / max(dot(uSunDir, up), 0.02) / max(tk, 1.0), 0.0, 1.0);
    lFront *= 1.0 - 0.7 * shadowF;
    // 太阳再高一些（影长只占视线的几成）时，查表的前景空气里还有太阳附近强烈的前向散射，岩壁仍和天空几乎一样亮：
    // 背光时和黄昏一样，至少挡掉身后那段空气与天空的约两成（背景 × 0.78，同黄昏剪影），轮廓一眼可见
    lFront = mix(lFront, min(lFront, Lbg * 0.78), behind * (1.0 - duskW));
    // 贴壁的云 / 雾在顶沿以下也在岩壁的影子里（不然逆光时一圈发亮的云挂在暗墙上）
    if (isCloud) eSun *= 1.0 - behind * smoothstep(-1.0, 1.0, gs1.z - hq);
    // 背光的崖面朝着的是岩壁脚下那片被它自己挡住阳光的海面 / 云海：地球反光按背光程度扣掉大半（顺光时这一项占崖面照度的两三成，
    // 逆光时不扣，暗面就比天空还亮，岩壁又隐形了）
    eUp *= 1.0 - 0.8 * behind;
    // 亮度封顶（同巨柱群）：暮色里被照亮的顶沿不超过同方向天空的 1.3–2 倍；比例按半影的参考透射率定，「没有太阳」的一份按 visS 混
    float capLum = mix(4.0, mix(1.3, 2.0, smoothstep(10.0, 150.0, hq)), duskW) * wonderLum(Lbg);
    vec3 eRest = eMoon + eSkyUp + eUp;
    vec3 eMax = uSunIlluminance * tSRef + eRest;
    vec3 Ls, Lref, LsR, LrefR;
    if (isCloud) {
      LsR = 0.8 / M_PI * (eMoon * 0.8 + eSkyUp + 0.5 * eUp);
      LrefR = LsR;
      Ls = LsR + 0.8 / M_PI * eSun * 0.8 * fwd;
      Lref = LsR + 0.8 / M_PI * uSunIlluminance * tSRef * 0.8 * fwd;
    } else {
      Ls = alb / M_PI * wonderIrr(nW, up, eSun, eMoon, eSkyUp, eUp);
      LsR = Ls - alb / M_PI * eSun * max(dot(nW, uSunDir), 0.0);   // wonderIrr 对各路照度是线性的
      Lref = alb * 1.4 / M_PI * eMax;
      LrefR = alb * 1.4 / M_PI * eRest;
    }
    // 封顶不带 wonderCapRef 的「不暗于背景 60%」下限：那是给细线的，整块岩壁带着它就把身后的天空透出来
    vec3 Lc = mix((lFront + apT * LsR) * min(1.0, capLum / max(wonderLum(lFront + apT * LrefR), 1e-9)),
                  (lFront + apT * Ls) * min(1.0, capLum / max(wonderLum(lFront + apT * Lref), 1e-9)), visS);
    L = mix(L, Lc, covk * visk);
  }
  return L;
}
`;
