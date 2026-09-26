import * as THREE from "three";
import { AERIAL_MAX_DISTANCE_KM, ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { Atmosphere } from "../atmosphere/luts";
import type { FullscreenPass } from "../render/pass";
import { LIGHTS_COMMON } from "../render/lights.glsl";
import { VIEW_COMMON } from "../render/view.glsl";
import { CLOUD_COMMON, OCC_LAYERS, OCC_N, OCC_SPACING } from "./clouds.glsl";
import type { CloudNoise } from "./noise";

/**
 * 体积云：半分辨率光线步进 + 时间累积。
 * 输出纹理 RGB = 已经加上空气透视的云辐亮度（预乘），A = 云的透射率（背景还剩多少）。
 *
 * 步进程序只有一个颜色输出，云的深度写进 gl_FragDepth（深度纹理，按 AERIAL_MAX_DISTANCE 归一化）（PERF-1）。
 * 以前是 MRT（颜色 + 深度两个颜色输出）：ANGLE/D3D11 链接时只按第一个输出生成像素着色器，
 * 并行编译完成后第一次 draw 到双附件帧缓冲时，还要在 GPU 线程上同步把整个步进像素着色器重编一遍（冷启动冻结约 4.7 s）。
 */

const MARCH_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
#define CLOUD_OCC 1
${CLOUD_COMMON}
${LIGHTS_COMMON}
uniform sampler3D uAerialInscatter;
uniform sampler3D uAerialTransmittance;
uniform float uFrame;
uniform vec2 uCloudResolution;
varying vec2 vUv;

// 交错梯度噪声：每个像素的步进起点错开，时间累积后抹平成平滑结果
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// 眼里逆光看眼壁时额外压掉的空气透视内散射比例（美术取向，见 main 里的说明）
const float HUR_BACKLIT_AP_CUT = 0.5;

// 投影用的台风大形（只在云步进里用）：眼壁（含台阶平台、各扇区顶高、外卷）和卷云盖。
// 比 hurricaneShadowDensity 多了台阶与顶高起伏；眼壁内缘整体往外让 1.5 km，凹进去的表面点不会被自己的大形误判成在影子里
float hurricaneCasterDensity(vec2 xz, float alt) {
  if (alt > HUR_TOP + 1.8 || alt < 0.3) return 0.0;
  vec2 d2 = xz - uHurricane.xy;
  float r = length(d2);
  float Re = uHurricane.z;
  if (r > Re * 9.0) return 0.0;
  // 方位角的正余弦直接由方向向量得到，倍角公式展开 sin(nθ + φ)：这个函数每像素要求值几十次，省掉 atan 和一串 sin（帧时间）
  vec2 cs = d2 / max(r, 1e-3);                  // (cos θ, sin θ)
  vec2 cs2 = vec2(cs.x * cs.x - cs.y * cs.y, 2.0 * cs.x * cs.y);
  vec2 cs3 = vec2(cs2.x * cs.x - cs2.y * cs.y, cs2.x * cs.y + cs2.y * cs.x);
  vec2 cs4 = vec2(cs2.x * cs2.x - cs2.y * cs2.y, 2.0 * cs2.x * cs2.y);
  // sin(nθ + φ) = sin nθ cos φ + cos nθ sin φ
  #define HSIN(c, ph) ((c).y * cos(ph) + (c).x * sin(ph))
  float slopeK = 0.95 + 0.35 * HSIN(cs, 1.3) + 0.12 * HSIN(cs4, 0.5);
  float l1 = 4.5 + 1.3 * HSIN(cs2, 0.4);
  float l2 = 8.5 + 1.6 * HSIN(cs3, 1.9);
  float fl = smoothstep(HUR_FLARE_START, HUR_TOP, alt);
  float rIn = Re * (1.0 + 0.10 * HSIN(cs2, 0.6)) + slopeK * (0.55 * alt + 0.045 * alt * alt)
            + 1.6 * smoothstep(l1 - 0.35, l1 + 0.35, alt) * smoothstep(-0.3, 0.5, HSIN(cs3, 0.8))
            + 2.0 * smoothstep(l2 - 0.4, l2 + 0.4, alt) * smoothstep(-0.4, 0.4, HSIN(cs2, 2.6))
            + HUR_FLARE * fl * fl + 1.5;
  float top = HUR_TOP - 0.5 + 1.2 * HSIN(cs, 0.4) + 0.45 * HSIN(cs3, 1.7) + 0.5;   // = hurricaneRimTop(θ) + 0.5
  #undef HSIN
  float wall = smoothstep(rIn, rIn + 2.0, r) * (1.0 - smoothstep(top - 0.6, top, alt));
  float canopy = smoothstep(Re * 2.5, Re * 3.0, r) * smoothstep(12.0, 12.8, alt) * (1.0 - smoothstep(HUR_TOP - 1.0, HUR_TOP, alt));
  return max(wall, canopy);
}

// 台风里某点沿 dir 方向的阳光可见度（0..1）：用解析大形估计光学厚度（便宜，不采样纹理）。
// start：从离开该点多远处开始算（km）。云里的点只算远处的遮挡（对面的眼壁），近处 15 km 由受光步进负责，
// 而且解析大形没有隆起，凹进去的表面点会被误判在大形里面
float hurricaneSunVis(vec3 p, vec3 dir, float start) {
  float alt = length(p) - BOTTOM;
  float len = clamp((HUR_TOP + 1.8 - alt) / max(dir.y, 0.05), 0.0, 70.0) - start;
  if (len <= 0.0 || dir.y < 0.0) return 1.0;
  float dt = len / 5.0;
  float od = 0.0;
  // 上界依赖 uniform，FXC 不展开
  for (int i = 0; i < 5 + min(uStormCount, 0); i++) {
    vec3 q = p + dir * (start + (float(i) + 0.5) * dt);
    od += hurricaneCasterDensity(q.xz + uCloudOffset, length(q) - BOTTOM);
  }
  // 光学厚度按「穿过遮挡物的公里数」算、系数取得很小：解析大形和真实表面差几公里，影子边缘要留出几公里的半影，
  // 否则影子是一刀切的，落在眼壁上像一个个破洞
  return exp(-od * dt * 0.6);
}

// 带体积阴影的空气透视内散射（未乘太阳照度）。full：不考虑阴影时整段的值（LUT 直接查出来的）
vec3 hurricaneShadowedInscatter(vec3 ro, vec3 rd, float depth, vec3 full) {
  vec3 acc = vec3(0.0);
  vec3 prev = vec3(0.0);
  const float N = 6.0;
  for (int k = 1; k < 7 + min(uStormCount, 0); k++) {
    float fk = float(k);
    vec3 Lk = fk >= N ? full : textureLod(uAerialInscatter, aerialPerspectiveUvw(rd, uSunDir, depth * fk / N), 0.0).rgb;
    float vis = hurricaneSunVis(ro + rd * (depth * (fk - 0.5) / N), uSunDir, 0.0);
    // 影子里的空气仍被天空光照着（多次散射）；眼里低处四周是眼壁，看得到的天空只有头顶一块，取约 12%
    acc += max(Lk - prev, vec3(0.0)) * mix(0.12, 1.0, vis);
    prev = Lk;
  }
  return acc;
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * M_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

void main() {
  // 深度写进深度附件（单输出，见文件头）。写了 gl_FragDepth 的程序每条路径都要写，否则深度未定义
  gl_FragDepth = 1.0;
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  vec2 fc = gl_FragCoord.xy * (uResolution / uCloudResolution);
  vec3 rdC = cabinRay(fc);
  // 只算能穿出窗外的像素（留一点余量，避免上采样时窗边出现一圈空白）
  bool anyWeather = uCoverage > 0.0 || uStormCount > 0 || uHurricane.w > 0.5;
  if (!anyWeather || paneDistance(uHead, rdC) > 0.02) return;
  vec3 rd = uCabinToWorld * rdC;
  vec3 ro = vec3(0.0, uCamR, 0.0);
  vec2 seg = cloudShellInterval(ro, rd);
  seg.y = min(seg.y, AERIAL_MAX_DISTANCE);
  if (seg.y <= seg.x) return;

  // 直射主光源：白天是太阳，夜里是月亮（月光照亮云海）
  float cosT = dot(rd, uKeyDir);
  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803);
  vec3 L = vec3(0.0);
  float T = 1.0;
  float depthSum = 0.0;
  float wSum = 0.0;
  float t = seg.x;
  // 有雷暴时：从空白进入云的那一步改用 1/4 的小步重新走一遍，采样点才能落在云的表面附近。
  // 否则远处步长几百米、云的消光又高（60 /km），第一个采样点可能已经在云里几百米深处，
  // 被阳光照亮的那层表面被跳过，受光面发灰、菜花状的隆起也看不出来
  // 台风的眼壁同理（远处的眼壁表面同样会被大步长跳过）
  bool refineOn = uStormCount > 0 || uHurricane.w > 0.5;
  int fine = 0;
  float fineDt = 0.03;
  bool wasEmpty = true;
  float hurVis = 1.0;         // 台风长影的缓存（见下）
  float hurVisT = -1e9;
  float lastEmpty = seg.x;   // 最近一个空白采样点的位置：表面一定在它和第一个有云的采样点之间
  // 闪电放电通道（线段）：两端换到相机坐标
  vec3 fA = vec3(uFlash.x - uCloudOffset.x, BOTTOM + uFlash.y, uFlash.z - uCloudOffset.y);
  vec3 fAB = vec3(uFlashB.x - uCloudOffset.x, BOTTOM + uFlashB.y, uFlashB.z - uCloudOffset.y) - fA;
  float flashI = uFlash.w / (1.0 + 0.25 * length(fAB)); // 总能量摊到整条通道上
  // 下方（海面 / 低云）反射上来的光的反照率：有低云时明显更亮
  // 台风眼里脚下是眼底的云，不是海面（晴天取 0.35），再按眼底受光的比例打折（见下）
  float albedoBelow = 0.06 + 0.5 * uCoverage;
  if (uHurricane.w > 0.5) {
    // 反射光来自眼底和对面的眼壁，随受光几何变：太阳低的时候眼底大半在向阳一侧眼壁的影子里（「井底」），
    // 反射光跟着变弱，背光的眼壁不再被统一提亮到天空的亮度（T26）。取眼底中心和沿太阳方位前后各一点的平均
    vec2 hc = uHurricane.xy - uCloudOffset;
    vec2 sh = normalize(uKeyDir.xz + vec2(1e-5)) * uHurricane.z * 0.6;
    float fv = 0.0;
    for (int k = -1; k < 2 + min(uStormCount, 0); k++) {
      vec2 f = hc + sh * float(k);
      fv += hurricaneSunVis(vec3(f.x, BOTTOM + 1.6, f.y), uKeyDir, 0.0);
    }
    albedoBelow = 0.35 * mix(0.25, 1.0, fv / 3.0);
  }
  // 次数上限：从相机空步走到 60 km 外本身就要约 190 步，细化还要额外的步数（每进一次云 9 步）
  for (int i = 0; i < 256; i++) {
    // 没有雷暴时仍是原来的 192 步（多出的步数只给雷暴的表面细化用，普通云不必多走）
    if (t >= seg.y || T < 0.005 || (!refineOn && i >= 192)) break;
    // 步长随距离变长：近处 60 m，远处 2 km
    float dtBase = clamp(t * 0.008, 0.06, 2.0);
    float dt = fine > 0 ? fineDt : dtBase;
    // 这一步代表的区间长度：空白处走 2 倍步长。抖动必须覆盖整个区间——旧版只抖动 dt、却走 2dt，
    // 每个区间的后一半永远采不到，远处的薄云被「同心球壳」切成一条条水平细纹（T13）
    float stepLen = (fine > 0 || !wasEmpty) ? dt : 2.0 * dt;
    vec3 p = ro + rd * (t + stepLen * jitter);
    float lod = clamp(log2(dtBase / 0.055), 0.0, 5.0);
    float dens = cloudDensity(p, lod, t < 150.0);
    float stormW = gStormW;
    float stormAO = gStormAO;
    // 只在进入雷暴 / 台风时细化（层状云不必，保持原样）；这段会被小步重新采样，进云那一步的密度并没有丢
    if (dens > 0.002 && stormW > 0.5 && wasEmpty && fine == 0 && dtBase > 0.1 && t > seg.x) {
      // 表面夹在「上一个空白采样点」和「这个有云的采样点」之间：退回到上一个空白采样点，8 小步走完这段。
      // 旧版一：固定退回一个区间 [t − 2dt, t]，那里是空的，8 小步白走后又回到空白状态，下一步再次撞上同一处表面、
      //   再退回……反复直到用完步数上限，远处的云出现一圈圈等高线似的条纹。
      // 旧版二：不退回、从 t 开始细化——带抖动的粗采样可能落在表面之前而漏检，下一个区间才检出时 t 已经在云里，
      //   进云深度随「表面落在步进网格的哪个位置」周期变化，台风眼壁上一道道平行的明暗条纹（T04）
      float tHit = t + stepLen * jitter;
      t = max(lastEmpty, seg.x);
      fineDt = max((tHit - t) * 0.125, 0.02);
      fine = 8;
      wasEmpty = false;
      continue;
    }
    if (fine > 0) fine--;
    if (dens > 0.002) {
      wasEmpty = false;
      float sigma = dens * CLOUD_EXTINCTION;
      float r = length(p);
      vec3 up = p / r;
      // 朝太阳方向做短距步进，估计阳光在云里走过的光学厚度。
      // 有雷暴、台风时走得更远（约 15 km），否则几公里厚的积雨云底部照样被照亮
      float od = 0.0;
      float ls = 0.06;
      float lt = 0.0;
      int lightSteps = (uStormCount > 0 || uHurricane.w > 0.5) ? 8 : 6;
      if (lightSteps == 6) {
        // 普通云（没有雷暴、台风）：只有层状云，常量上界，编译器展开后最快（和改动前一致）。
        // 这里只能调用层状云密度：展开的每一份都带上雷暴密度的话，冷编译会从 55 s 涨到 90 s
        for (int j = 0; j < 6; j++) {
          lt += ls;
          od += layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3) * ls;
          ls *= 1.9;
        }
      } else {
        // 雷暴 / 台风：上界依赖 uniform，FXC 不展开（展开成 8 份雷暴密度时冷编译很慢）
        for (int j = 0; j < lightSteps; j++) {
          lt += ls;
          od += cloudDensityLite(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3, true) * ls;
          ls *= 2.0;
        }
      }
      od *= CLOUD_EXTINCTION;
      // 多次散射近似（Wrenninge 2013）：每一阶散射更弱、衰减更慢、相函数更平。
      // 原来只取 4 阶、权重每阶折半，顺光（背散射）时厚云的有效反照率只有 ~0.3，真实厚云是 0.7–0.8，
      // 所以顺光的云普遍偏灰。改成 6 阶、权重衰减放慢，补回高阶散射的能量
      float sunScatter = 0.0;
      float a = 1.0, b = 1.0, c = 1.0;
      // 雷暴的光学厚度大得多（几百），高阶散射占比更高、整体反照率更接近 1：高阶权重衰减得更慢
      float aDecay = stormW > 0.5 ? 0.7 : 0.62;
      for (int k = 0; k < 6; k++) {
        float phase = mix(hg(cosT, -0.25 * c), hg(cosT, 0.8 * c), 0.7);
        sunScatter += a * phase * exp(-b * od);
        a *= aDecay; b *= 0.35; c *= 0.5;
      }
      // Beer-Powder：云团边缘朝向太阳的地方偏暗，看起来更有体积（Schneider 2015）
      float powder = 1.0 - exp(-2.0 * od - 0.5);
      vec3 sunLight = keyLight(r, up) * sunScatter * mix(1.0, powder, 0.5);
      // 台风：对面眼壁投下的长影（几十公里，受光步进只走 15 km 够不着）。太阳不高时眼壁下半截和眼底都在影子里，
      // 上亮下暗，「体育场」的碗形靠这个读出来
      // 只在眼和眼壁附近算（外围雨带头顶的卷云盖由受光步进负责，这里再算一遍会重复压暗）
      // 长影在空间上变化很慢（半影几公里）：同一条视线上离上次求值不到 2 km 就沿用，省掉大部分求值（帧时间）
      if (uHurricane.w > 0.5 && stormW > 0.5 && length(p.xz + uCloudOffset - uHurricane.xy) < uHurricane.z * 3.5) {
        if (abs(t - hurVisT) > 2.0) { hurVis = hurricaneSunVis(p, uKeyDir, 3.0); hurVisT = t; }
        sunLight *= hurVis;
      }
      // 环境光：上半球的天空光，云顶亮、云底暗
      float h01 = clamp((r - BOTTOM - uShellBottom) / (uShellTop - uShellBottom), 0.0, 1.0);
      vec3 eSky = skyIrradiance(r, up);
      vec3 ambient = eSky / (2.0 * M_PI) * mix(0.12, 1.0, pow(h01, 0.7));
      if (stormW > 0.5) {
        // 雷暴：隆起之间的凹处、砧底、雨幡里看到的天空少（菜花状的明暗）；
        // 塔身下半截还被下方的海面 / 低云反射的光照着（中性的灰白，冲淡天空光的蓝）
        ambient *= mix(0.3, 1.0, stormAO);
        vec3 eBelow = albedoBelow * keyLight(BOTTOM + 1.0, up) * max(dot(up, uKeyDir), 0.0);
        // 台风眼里，背光的眼壁对面就是被太阳直射的眼壁和眼底：反射光在各个高度都很强，不只是下半截
        float hBelow = uHurricane.w > 0.5 ? 1.0 - 0.4 * h01 : 1.0 - h01;
        ambient += eBelow / (2.0 * M_PI) * 0.5 * hBelow * stormAO;
        if (uHurricane.w > 0.5) {
          // 眼里的互相照亮：向阳一侧的眼壁（内表面背着太阳）对面就是被太阳直射的眼壁，占了它小半个视野，
          // 补光是中性的灰白。只按「内表面朝向」算：朝太阳的受光面对面是背光的暗壁，几乎没有补光。
          // 量级：对面受光壁辐亮度约 0.25 E，占视野约 1/3，反照率 0.8，取一半（对面下半截在影子里）≈ 0.035 E
          vec2 toC = (uHurricane.xy - uCloudOffset) - p.xz;
          float rc = length(toC);
          float away = -dot(toC / max(rc, 1e-3), normalize(uKeyDir.xz + vec2(1e-6)));
          float opp = smoothstep(-0.2, 0.6, away) * (1.0 - smoothstep(uHurricane.z * 2.2, uHurricane.z * 3.0, rc));
          ambient += keyLight(r, uKeyDir) * 0.035 * opp * mix(0.15, 1.0, stormAO) * smoothstep(0.02, 0.2, uKeyDir.y);
        }
      }
      vec3 S = sunLight + ambient;
      // 闪电：云里一段几公里长的放电通道，光在云里多次散射后向外扩散（扩散长度约 2 km），
      // 整团云从内部亮起来，离通道越远越暗。凹处（ao 小）被周围的云挡住，也暗一些
      if (uFlash.w > 0.0) {
        vec3 pw = vec3(p.x, length(p), p.z);
        float u = clamp(dot(pw - fA, fAB) / max(dot(fAB, fAB), 1e-6), 0.0, 1.0);
        float fd = length(pw - fA - fAB * u);
        // 强度按观感标定：白天只在通道附近隐约可见，夜里通道周围几公里亮起来、十公里外的云只被照亮一点
        S += vec3(0.8, 0.85, 1.0) * flashI * 0.005 * exp(-fd / 1.5) / (1.0 + fd * fd) * mix(1.0, stormAO, 0.5);
      }
      float stepT = exp(-sigma * stepLen);
      // 云的反照率接近 1：散射系数 ≈ 消光系数，积分式里 σ 被约掉
      L += T * S * (1.0 - stepT);
      depthSum += T * (1.0 - stepT) * t;
      wSum += T * (1.0 - stepT);
      T *= stepT;
      t += stepLen;
    } else {
      // 空白区域大步走（细化时仍用小步）
      wasEmpty = true;
      lastEmpty = t + stepLen * jitter;
      t += stepLen;
    }
  }
  if (wSum <= 0.0) return;
  float depth = depthSum / wSum;
  // 相机到云之间的空气透视：远处的云被大气染蓝、变淡，融进地平线
  vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, depth);
  vec3 apL = texture(uAerialInscatter, uvw).rgb;
  vec3 apT = texture(uAerialTransmittance, uvw).rgb;
  // 台风：视线上被眼壁 / 卷云盖挡住阳光的那几段空气不散射阳光（体积阴影）。
  // 下午逆光看远处眼壁时，40 km 的空气透视内散射是眼壁自身亮度的约 10 倍（T26 实测：0.9/1.9/4.5 对 0.2/0.2/0.24），
  // 背光的眼壁整面被刷成天空蓝；而真实的眼里，靠近向阳一侧眼壁的空气正处在它的影子里。
  // 分段累加：L(0, b) − L(0, a) ≈ 段 [a, b] 的内散射（已含到相机的透射），乘这一段中点的受光比例
  if (uHurricane.w > 0.5 && uSunDir.y > 0.02) {
    apL = hurricaneShadowedInscatter(ro, rd, depth, apL);
    // 美术取向（有意偏离物理，T26 协调者 / 美术总监的要求）：物理上从 10.7 km 隔 40 km 看逆光的眼壁，空气透视
    // 和眼壁顶上方 8° 的天空几乎一样亮（两条视线穿过的空气柱相当），背光的眼壁整面融进天空；
    // 外卷的「看台」又让低太阳照进眼里，体积阴影只减掉约 5–20%。这里在眼里朝太阳方向看时再压掉一部分内散射，
    // 让背光面读成深灰蓝。只作用于台风眼附近、朝太阳、太阳不高的时候；要回到纯物理把 HUR_BACKLIT_AP_CUT 设 0
    vec2 hcC = uHurricane.xy - uCloudOffset;
    float inEye = 1.0 - smoothstep(uHurricane.z * 2.0, uHurricane.z * 3.0, length(hcC));
    float toward = max(dot(normalize(rd.xz + vec2(1e-6)), normalize(uSunDir.xz + vec2(1e-6))), 0.0);
    apL *= 1.0 - HUR_BACKLIT_AP_CUT * inEye * toward * toward * (1.0 - smoothstep(0.35, 0.8, uSunDir.y));
  }
  apL *= uSunIlluminance;
  L = L * apT + apL * (1.0 - T);
  gl_FragColor = vec4(min(L, vec3(60000.0)), T);
  gl_FragDepth = clamp(depth / AERIAL_MAX_DISTANCE, 0.0, 1.0);
}
`;

// 时间累积：把上一帧的结果按云的运动重投影过来，再和这一帧混合；用邻域夹取防止拖影
const RESOLVE_FRAG = /* glsl */ `
${VIEW_COMMON}
const float CLOUD_DEPTH_SCALE = ${AERIAL_MAX_DISTANCE_KM.toFixed(1)};  // 深度纹理里存的是 depth / 这个值（与步进程序的 AERIAL_MAX_DISTANCE 一致）
uniform sampler2D uCurrent;
uniform sampler2D uCurrentDepth;   // 步进程序的深度附件（gl_FragDepth）
uniform sampler2D uHistory;
uniform mat3 uPrevCamBasis;
uniform mat3 uPrevCabinToWorld;
uniform vec3 uMotion;
uniform bool uReset;
uniform vec2 uCloudResolution;
varying vec2 vUv;
void main() {
  vec2 texel = 1.0 / uCloudResolution;
  vec2 uv = gl_FragCoord.xy * texel;
  vec4 cur = texture(uCurrent, uv);
  if (uReset) { gl_FragColor = cur; return; }

  vec4 mn = cur, mx = cur;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++) {
    vec4 s = texture(uCurrent, uv + vec2(x, y) * texel);
    mn = min(mn, s);
    mx = max(mx, s);
  }

  float depth = texture(uCurrentDepth, uv).r * CLOUD_DEPTH_SCALE;
  vec3 rd = uCabinToWorld * cabinRay(gl_FragCoord.xy * (uResolution / uCloudResolution));
  vec3 prevDir = normalize(rd * depth + uMotion);
  vec3 v = transpose(uPrevCamBasis) * (transpose(uPrevCabinToWorld) * prevDir);
  float blend = 0.12;
  vec2 puv = vec2(-1.0);
  if (v.z < 0.0) {
    vec2 ndc = v.xy / (-v.z) / uTanHalfFov;
    ndc.x /= uResolution.x / uResolution.y;
    puv = ndc * 0.5 + 0.5;
  }
  if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) blend = 1.0;
  vec4 hist = clamp(texture(uHistory, puv), mn, mx);
  gl_FragColor = mix(hist, cur, blend);
}
`;

// 探针：算飞机位置和前方几百米的云密度，异步读回给 CPU（判断是否在云里：窗上起水痕、颠簸）
const PROBE_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${CLOUD_COMMON}
uniform float uCamR;
uniform vec3 uProbeDir;   // 航向（窗外坐标）
varying vec2 vUv;
void main() {
  vec3 p0 = vec3(0.0, uCamR, 0.0);
  float d = 0.0;
  for (int k = 0; k < 4; k++) d += cloudDensityLite(p0 + uProbeDir * (float(k) * 0.12), 1.0, false, false);
  gl_FragColor = vec4(d * 0.25, 0.0, 0.0, 1.0);
}
`;

// 占据网格（PERF-2）：每个格点求一次雷暴 / 台风密度，有云写 1。只要大形，不做细节侵蚀（侵蚀只会让密度变小）。
// 云步进远处用粗 mip 的噪声（lod 最大约 5）、近处用细的，两者的表面能差出一两公里：这里 lod 0 和 3.5 各求一次取并集，
// 再靠查询时的 mip 膨胀兜住其余差异（见 clouds.glsl.ts 的 OCC_*）
const OCC_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${CLOUD_COMMON}
uniform vec2 uOccOrigin;
uniform vec2 uOccAlt;
uniform float uOccLayer;
varying vec2 vUv;
void main() {
  vec2 xz = uOccOrigin + floor(gl_FragCoord.xy) * ${OCC_SPACING.toFixed(3)};
  float alt = uOccAlt.x + uOccLayer * uOccAlt.y;
  float d = 0.0;
  float ao;
  // 两个 lod 放进同一个循环（上界依赖 uniform，FXC 不展开）：雷暴 / 台风密度各只内联一份
  for (int k = 0; k < 2 + min(uStormCount, 0); k++) {
    float lod = float(k) * 3.5;
    for (int i = 0; i < uStormCount; i++) {
      vec4 c = uStorms[i];
      vec2 dd = xz - c.xy;
      if (dot(dd, dd) > c.z * c.z * 56.0) continue;
      d = max(d, stormDensity(c, xz, alt, lod, false, ao));
    }
    if (uHurricane.w > 0.5) d = max(d, hurricaneDensity(xz, alt, lod, false, ao));
  }
  gl_FragColor = vec4(d > 0.0 ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
`;

export interface CloudPreset {
  id: string;
  name: string;
  bottom: number;
  top: number;
  coverage: number;
  type: number;
  density: number;
}

export const CLOUD_PRESETS: CloudPreset[] = [
  { id: "cumulus", name: "晴天积云", bottom: 1.2, top: 3.4, coverage: 0.42, type: 1, density: 1 },
  { id: "stratocumulus", name: "层积云云海", bottom: 1.0, top: 2.2, coverage: 0.78, type: 0.2, density: 0.8 },
  { id: "towering", name: "浓积云（午后对流）", bottom: 1.4, top: 6.5, coverage: 0.35, type: 1, density: 1.2 },
  { id: "altocumulus", name: "高积云（中层，4.5–6 km）", bottom: 4.5, top: 6.0, coverage: 0.6, type: 0.45, density: 0.7 },
  { id: "deck-below", name: "云海贴着航路（云顶 9.8 km）", bottom: 8.0, top: 9.8, coverage: 0.85, type: 0.25, density: 0.8 },
  { id: "cirrus", name: "卷云（航路上方 11.5–12.5 km）", bottom: 11.5, top: 12.5, coverage: 0.4, type: 0.0, density: 0.12 },
  { id: "clear", name: "无云", bottom: 1.2, top: 3.4, coverage: 0, type: 1, density: 1 },
];

/** 云场参数。场景着色器（海面云影）和云着色器共用同一组 uniform 对象 */
export function createCloudUniforms(noise: CloudNoise) {
  return {
    uShapeNoise: { value: noise.shape },
    uDetailNoise: { value: noise.detail },
    uWeather: { value: noise.weather },
    uCloudOffset: { value: new THREE.Vector2() },
    uCloudBottom: { value: 1.2 },
    uCloudTop: { value: 3.4 },
    uCoverage: { value: 0.42 },
    uCloudType: { value: 1 },
    uCloudDensity: { value: 1 },
    uShellBottom: { value: 1.2 },
    uShellTop: { value: 3.4 },
    uStormCount: { value: 0 },
    uStorms: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
    uUpperWind: { value: new THREE.Vector2(0.8, 0.6) },
    uHurricane: { value: new THREE.Vector4(0, 0, 20, 0) },
    uFlash: { value: new THREE.Vector4() },
    uFlashB: { value: new THREE.Vector3() },
  };
}
export type CloudUniforms = ReturnType<typeof createCloudUniforms>;

function target(w: number, h: number) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
}

/** 步进的输出：颜色（RGB 辐亮度 + A 透射率）+ 深度附件（云的深度，gl_FragDepth） */
function rawTarget(w: number, h: number) {
  const depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
  depthTexture.format = THREE.DepthFormat;
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    depthTexture,
  });
}

/** 占据网格：水平 OCC_N × OCC_N、竖直 OCC_LAYERS 层的 R8 3D 纹理，带 mipmap（查询时用 mip 做膨胀） */
function occTarget() {
  const t = new THREE.WebGL3DRenderTarget(OCC_N, OCC_N, OCC_LAYERS, {
    type: THREE.UnsignedByteType,
    format: THREE.RedFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  t.texture.wrapS = t.texture.wrapT = t.texture.wrapR = THREE.ClampToEdgeWrapping;
  // 只在画最后一层时生成 mipmap（three 每画一层都会按这个开关重新生成一遍，84 层就是 84 遍）
  t.texture.generateMipmaps = false;
  return t;
}

/** 飞机离网格中心超过这么远就重建（网格覆盖 ±128 km，步进最远约 170 km，网格外照旧逐点求值） */
const OCC_RECENTER_KM = 24;

export class Clouds {
  private raw = rawTarget(1, 1);
  private history = [target(1, 1), target(1, 1)];
  private frame = 0;
  /** 云的渲染分辨率相对全屏的比例 */
  resolutionScale = 1;
  private reset = true;
  private readonly prevCamBasis = new THREE.Matrix3();
  private readonly prevCabinToWorld = new THREE.Matrix3();

  private readonly marchMat: THREE.ShaderMaterial;
  private readonly probeMat: THREE.ShaderMaterial;
  private readonly probeTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
  private readonly probePixel = new Float32Array(4);
  private probeBusy = false;
  /** 飞机所在位置的云密度（0..1，几帧前的值） */
  cameraDensity = 0;
  private readonly resolveMat: THREE.ShaderMaterial;
  // ---- 雷暴 / 台风的占据网格（PERF-2）----
  private readonly occMat: THREE.ShaderMaterial;
  private readonly occ = occTarget();
  /** 上一次建网格时的天气签名（雷暴、台风、高空风、云壳高度）；变了就重建 */
  private occKey = "";
  private readonly occCenter = new THREE.Vector2(1e9, 1e9);
  /** 网格程序是否已编译好（后台编译，没好之前步进照旧逐点求值，不卡主线程） */
  private occState: "idle" | "compiling" | "ready" = "idle";
  /** 调试 / 对照：false 时步进不查占据网格（逐点求完整密度，等于改动前的行为） */
  occEnabled = true;

  constructor(
    private readonly pass: FullscreenPass,
    atmosphere: Atmosphere,
    readonly uniforms: CloudUniforms,
    /** 场景着色器的 uniform（视角、太阳等），直接共享同一批对象 */
    viewUniforms: Record<string, THREE.IUniform>,
  ) {
    const common = { depthTest: false, depthWrite: false, toneMapped: false, vertexShader: FULLSCREEN_VERT };
    this.marchMat = new THREE.ShaderMaterial({
      ...common,
      // 深度测试恒通过、写深度：云深度经 gl_FragDepth 写进 raw 的深度纹理（关掉深度测试时 GL 不写深度）
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
      fragmentShader: MARCH_FRAG,
      uniforms: {
        ...atmosphere.sharedUniforms,
        ...viewUniforms,
        ...this.uniforms,
        uAerialInscatter: { value: atmosphere.aerialInscatter.texture },
        uAerialTransmittance: { value: atmosphere.aerialTransmittance.texture },
        uFrame: { value: 0 },
        uCloudResolution: { value: new THREE.Vector2(1, 1) },
        uOcc: { value: this.occ.texture },
        uOccOrigin: { value: new THREE.Vector2() },
        uOccAlt: { value: new THREE.Vector2(0, 1) },
        uOccValid: { value: 0 },
      },
    });
    this.occMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: OCC_FRAG,
      uniforms: {
        ...atmosphere.sharedUniforms,
        ...this.uniforms,
        // 网格的原点、层高和步进程序共用同一组对象：建网格与步进在同一帧里先后进行，值总是一致
        uOccOrigin: this.marchMat.uniforms.uOccOrigin,
        uOccAlt: this.marchMat.uniforms.uOccAlt,
        uOccLayer: { value: 0 },
      },
    });
    this.probeMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: PROBE_FRAG,
      uniforms: { ...viewUniforms, ...this.uniforms, uProbeDir: { value: new THREE.Vector3(1, 0, 0) } },
    });
    this.resolveMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: RESOLVE_FRAG,
      uniforms: {
        ...viewUniforms,
        uCurrent: { value: this.raw.texture },
        uCurrentDepth: { value: this.raw.depthTexture },
        uHistory: { value: null },
        uPrevCamBasis: { value: this.prevCamBasis },
        uPrevCabinToWorld: { value: this.prevCabinToWorld },
        uMotion: { value: new THREE.Vector3() },
        uReset: { value: true },
        uCloudResolution: this.marchMat.uniforms.uCloudResolution,
      },
    });
  }

  /**
   * 需要和其他着色器一起后台并行编译的材质与它们真正画进去的目标（启动时 main.ts 的 compileAsync 批次用）。
   * 占据网格程序不在这批里也行：第一次需要时 ensureOccCompiled 会自己在后台编译，编好之前步进照旧逐点求值
   */
  compileTargets(): Array<readonly [THREE.ShaderMaterial, THREE.WebGLRenderTarget]> {
    return [
      [this.marchMat, this.raw],
      [this.resolveMat, this.history[0]],
      [this.occMat, this.occ],
    ];
  }

  /** 占据网格程序后台编译（KHR_parallel_shader_compile），不阻塞主线程 */
  private ensureOccCompiled(renderer: THREE.WebGLRenderer) {
    if (this.occState !== "idle") return;
    this.occState = "compiling";
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geo, this.occMat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.occ);
    const job = renderer.compileAsync(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    renderer.setRenderTarget(prev);
    job
      .then(() => (this.occState = "ready"))
      .catch(() => (this.occState = "ready"))
      .finally(() => geo.dispose());
  }

  /**
   * 雷暴 / 台风的占据网格：天气变了、或飞机离网格中心太远时重建（整张网格在一帧里画完：84 层，每层 512² 个格点）。
   * 没有雷暴 / 台风时什么都不做（步进里也不查网格）
   */
  private updateOccupancy() {
    const u = this.uniforms;
    const mu = this.marchMat.uniforms;
    const hasWeather = u.uStormCount.value > 0 || u.uHurricane.value.w > 0.5;
    if (!hasWeather || this.occState !== "ready" || !this.occEnabled) {
      mu.uOccValid.value = 0;
      return;
    }
    const storms = u.uStorms.value.slice(0, u.uStormCount.value).map((v) => v.toArray().join(","));
    const key = [storms.join(";"), u.uHurricane.value.toArray().join(","), u.uUpperWind.value.toArray().join(","), u.uShellBottom.value, u.uShellTop.value].join("|");
    const off = u.uCloudOffset.value;
    mu.uOccValid.value = 1;
    if (key === this.occKey && off.distanceTo(this.occCenter) < OCC_RECENTER_KM) return;
    this.occKey = key;
    // 网格中心对齐到格点上，前后两次重建的格点位置一致
    this.occCenter.set(Math.round(off.x / OCC_SPACING) * OCC_SPACING, Math.round(off.y / OCC_SPACING) * OCC_SPACING);
    const half = ((OCC_N - 1) / 2) * OCC_SPACING;
    mu.uOccOrigin.value.set(this.occCenter.x - half, this.occCenter.y - half);
    const bottom = u.uShellBottom.value;
    mu.uOccAlt.value.set(bottom, (u.uShellTop.value - bottom) / (OCC_LAYERS - 1));
    const tex = this.occ.texture;
    for (let k = 0; k < OCC_LAYERS; k++) {
      this.occMat.uniforms.uOccLayer.value = k;
      tex.generateMipmaps = k === OCC_LAYERS - 1;
      this.pass.render(this.occMat, this.occ, k);
    }
    tex.generateMipmaps = false;
  }

  /** 每几帧调用一次：在 GPU 上算飞机位置的云密度，异步读回（不阻塞渲染） */
  probe(renderer: THREE.WebGLRenderer, heading: THREE.Vector3) {
    this.ensureOccCompiled(renderer);
    if (this.probeBusy) return;
    this.probeMat.uniforms.uProbeDir.value.copy(heading);
    this.pass.render(this.probeMat, this.probeTarget);
    this.probeBusy = true;
    renderer
      .readRenderTargetPixelsAsync(this.probeTarget, 0, 0, 1, 1, this.probePixel)
      .then(() => (this.cameraDensity = this.probePixel[0]))
      .finally(() => (this.probeBusy = false));
  }

  get texture() {
    return this.history[0].texture;
  }

  applyPreset(p: CloudPreset) {
    const u = this.uniforms;
    u.uCloudBottom.value = p.bottom;
    u.uCloudTop.value = p.top;
    u.uCoverage.value = p.coverage;
    u.uCloudType.value = p.type;
    u.uCloudDensity.value = p.density;
    this.snap();
  }

  snap() {
    this.reset = true;
  }

  setSize(fullWidth: number, fullHeight: number) {
    // 降分辨率步进，时间累积补回细节
    const w = Math.max(1, Math.round(fullWidth * this.resolutionScale));
    const h = Math.max(1, Math.round(fullHeight * this.resolutionScale));
    this.raw.setSize(w, h);
    for (const t of this.history) t.setSize(w, h);
    this.marchMat.uniforms.uCloudResolution.value.set(w, h);
    this.reset = true;
  }

  /**
   * motion：上一帧到这一帧，云相对相机的位移反过来（km，窗外坐标）。飞机向前飞，云向后退，
   * 所以同一朵云上一帧在「现在的位置 + 飞机位移」。
   */
  render(motion: THREE.Vector3, camBasis: THREE.Matrix3, cabinToWorld: THREE.Matrix3) {
    this.updateOccupancy();
    this.marchMat.uniforms.uFrame.value = this.frame++ % 64;
    this.pass.render(this.marchMat, this.raw);

    const [prev, next] = this.history;
    const r = this.resolveMat.uniforms;
    r.uCurrent.value = this.raw.texture;
    r.uCurrentDepth.value = this.raw.depthTexture;
    r.uHistory.value = prev.texture;
    r.uMotion.value.copy(motion);
    r.uReset.value = this.reset;
    this.pass.render(this.resolveMat, next);
    this.history = [next, prev];
    this.reset = false;
    this.prevCamBasis.copy(camBasis);
    this.prevCabinToWorld.copy(cabinToWorld);
  }
}
