import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { Atmosphere } from "../atmosphere/luts";
import { CLOUD_COMMON } from "../clouds/clouds.glsl";
import { CABIN_COMMON, PANE_COMMON } from "./cabin.glsl";
import { VIEW_COMMON } from "./view.glsl";
import type { GroundClipmap } from "../ground/clipmap";
import { GROUND_COMMON } from "./ground.glsl";
import { ISLANDS_COMMON } from "./islands.glsl";
import { LIGHTNING_COMMON } from "./lightning.glsl";
import { LIGHTS_COMMON } from "./lights.glsl";
import { OCEAN_COMMON } from "./ocean.glsl";
import { STARS_COMMON } from "./stars.glsl";
import { TERRAIN_SHADING_COMMON } from "./terrain-shading.glsl";
import { TRAFFIC_COMMON } from "./traffic.glsl";
import { WING_COMMON } from "./wing.glsl";
import { WING_SHADING_COMMON } from "./wing-shading.glsl";

/**
 * 场景着色器：从头部位置向屏幕每个像素发射线，先穿过按真实尺寸建模的舷窗，
 * 能穿出去的射线再算窗外的天空、太阳和海面。输出 HDR 亮度（单位 kcd/m²）。
 *
 * 座舱坐标（米）：原点在舱壁内饰面上的窗洞中心，x 沿舱壁（右侧座位时朝机头），y 向上，z 朝窗外。
 * 窗外坐标（km）：地心为原点，飞机正下方为 +y，x 朝东，z 朝南。
 */
const SCENE_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${CLOUD_COMMON}
${CABIN_COMMON}
${PANE_COMMON}
${WING_COMMON}
${LIGHTS_COMMON}
${STARS_COMMON}
${ISLANDS_COMMON}
${GROUND_COMMON}
uniform sampler2D uClouds;       // 半分辨率云层：RGB 预乘辐亮度，A 透射率
uniform float uShadeBottom;
uniform float uWind;
uniform float uCabinLight;      // 舱内灯光照度，klux
uniform float uTime;            // 秒，给波浪和闪烁用
uniform float uWetness;         // 窗板外侧的湿度 0..1
uniform float uCameraFog;       // 飞机所在位置云的消光系数（1/km），机翼要隔着这层雾看
uniform float uHdrMax;          // HDR 目标能存的最大值（半精度时是 6e4）
// 调试可视化：0 关，1 内衬命中深度，2 亮度（伪彩），3 内衬受到的窗光，4 内衬法线，
// 5 海面本身，6 海面天空反射，7 海面的内散射，8 海面粗糙度 / 像素覆盖，9 海面直射照度，10 闪烁格子
uniform int uDebug;
varying vec2 vUv;
${TRAFFIC_COMMON}

const float PANE_TRANSMITTANCE = 0.85;      // 两层亚克力 + 内层防刮板
const vec3 PLASTIC_ALBEDO = vec3(0.78, 0.76, 0.72);

${OCEAN_COMMON}
${LIGHTNING_COMMON}
${TERRAIN_SHADING_COMMON}

vec3 outsideRadiance(vec3 rd, vec4 cloud) {
  vec3 ro = vec3(0.0, uCamR, 0.0);
  if (uGroundOn > 0.5) {
    vec4 gr = groundRadiance(ro, rd);
    if (gr.w > 0.0) return gr.rgb * cloud.a + cloud.rgb;
  }
  float tGround = raySphere(ro, rd, BOTTOM);
  bool hitGround = tGround > 0.0;
  // 天空视图 LUT 已经包含到地面为止的内散射（空气透视）
  vec3 L = skyRadiance(rd, hitGround);
  if (hitGround) {
    vec3 P = ro + rd * tGround;
    // 相机到海面的透射率 = T(海面→层顶) / T(相机→层顶)，两段都是朝上的射线
    vec3 tSurface = transmittanceToTop(BOTTOM, dot(normalize(P), -rd));
    vec3 tCamera = transmittanceToTop(uCamR, -rd.y);
    vec3 tView = min(tSurface / max(tCamera, vec3(1e-6)), vec3(1.0));
    float fView;
    vec3 nView;
    vec3 inscatter = L;
    vec3 sea = tView * (oceanRadiance(P, rd, tGround, vec3(-1.0), 1.0, fView, nView) + vec3(0.02, 0.04, 0.05) / M_PI * flashIlluminance(P));
    L += sea;
    // 天空反射：天空视图 LUT 是从相机算的，L相机(反射方向) ≈ 内散射(相机→海面) + 透射率 × L海面(反射方向)。
    // 所以反射的贡献是 F·(L相机 − 内散射)，不能再乘一次透射率，否则地平线处会被衰减两次，出现一条暗线
    vec3 skyCam = skyRadiance(reflect(rd, nView), false);
    vec3 refl = fView * max(skyCam - inscatter, vec3(0.0));
    L += refl;
    if (uDebug == 5 || uDebug >= 8) L = sea;
    if (uDebug == 6) L = refl;
    if (uDebug == 7) L = inscatter;
  } else {
    // 太阳圆盘：辐亮度 = 照度 / 立体角，带临边昏暗
    float c = dot(rd, uSunDir);
    if (c > 0.0) {
      float ang = asin(min(length(cross(rd, uSunDir)), 1.0));
      float x = ang / SUN_ANGULAR_RADIUS;
      if (x < 1.2) {
        float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
        float coverage = clamp((SUN_ANGULAR_RADIUS - ang) / pixelAngle + 0.5, 0.0, 1.0);
        float mu = sqrt(max(0.0, 1.0 - x * x));
        float limb = (1.0 - 0.6 * (1.0 - mu)) / (1.0 - 0.6 / 3.0);
        vec3 disk = uSunIlluminance / (M_PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS) * limb;
        L += disk * coverage * sunTransmittance(uCamR, rd.y);
      }
    }
    // 月亮圆盘（白天也在，只是很淡）和星星；都要穿过相机上方的大气
    vec3 tUp = sunTransmittance(uCamR, rd.y);
    L += (moonDisk(rd) + starRadiance(rd)) * tUp;
  }
  // 云挡在前面：背景剩下云的透射率那么多，再加上云自身的光
  return L * cloud.a + cloud.rgb;
}

${WING_SHADING_COMMON}

void main() {
  vec3 rd = cabinRay(gl_FragCoord.xy);
  vec3 ro = uHead;

  // ---- 所有屏幕导数都在任何循环和分支之前算好（分支里的导数没有定义） ----
  float rdz = max(rd.z, 1e-4);
  vec3 pWall = ro + rd * ((0.0 - ro.z) / rdz);
  vec3 pShade = ro + rd * ((SHADE_DEPTH - ro.z) / rdz);
  vec3 pPane = ro + rd * ((PANE_DEPTH - ro.z) / rdz);
  float dBezel = sdRoundRect(pWall.xy, BEZEL_HALF, BEZEL_RADIUS);
  float dPane = sdRoundRect(pPane.xy, PANE_HALF, PANE_RADIUS);
  // 抗锯齿宽度设上限：视线几乎贴着舱壁时交点飞到很远，导数会大到把几层颜色混在一起
  float wB = min(fwidth(dBezel), 0.005);
  float wP = min(fwidth(dPane), 0.005);
  float wS = min(fwidth(pShade.y), 0.005);
  float px = length(fwidth(pWall.xy));
  float pixPane = max(length(fwidth(pPane.xy)), 1e-5);

  // ---- 窗外来的光（舱内所有表面共用） ----
  // 「sun」系列变量指直射主光源：白天是太阳，夜里是月亮
  vec3 sunC = transpose(uCabinToWorld) * uKeyDir;   // 座舱系里的主光源方向
  vec3 upW = vec3(0.0, 1.0, 0.0);
  vec3 eSunNormal = keyLight(uCamR, upW) * PANE_TRANSMITTANCE;
  vec3 eSkyH = skyIrradiance(uCamR, upW);
  // 下半球：海面或云海把天空光和阳光反射上来。云海的反照率远高于海面
  vec3 eDown = eSkyH + keyLight(uCamR, upW) * max(uKeyDir.y, 0.0);
  float belowAlbedo = mix(0.06, 0.7, clamp(uCoverage * 0.9, 0.0, 1.0));
  // 窗板当作面光源时的平均辐亮度：一半看天，一半看下面
  vec3 lWin = 0.5 * (eSkyH / M_PI + belowAlbedo * eDown / M_PI) * PANE_TRANSMITTANCE;
  // 舱内环境光：灯光 + 满舱窗户进来的光被来回反射后的均匀部分（经验系数，待换成辐射度近似）
  vec3 eCabin = uCabinLight * CABIN_LIGHT_COLOR + 0.06 * M_PI * lWin + 0.004 * eSunNormal * max(sunC.z, 0.0);

  // ---- 舱壁 ----
  // 塑料面板：毫米级的橘皮纹理 + 厘米级的轻微斑驳。远处纹理细于像素时淡出，免得闪烁
  float grain = vnoise(pWall.xy * 900.0) - 0.5;
  float mottle = vnoise(pWall.xy * 30.0) - 0.5;
  float grainFade = 1.0 - smoothstep(0.0004, 0.0012, px);
  vec3 wallAlbedo = PLASTIC_ALBEDO * (1.0 + 0.06 * grain * grainFade + 0.04 * mottle);
  // 上亮下暗：顶灯和行李架下的灯带从上方照下来
  float wallGrad = 1.0 + 0.35 * clamp(pWall.y / 0.4, -1.0, 1.0);
  vec3 wall = wallAlbedo / M_PI * eCabin * wallGrad;
  if (rd.z < 1e-4) {
    gl_FragColor = vec4(wall, 0.0);
    return;
  }

  // ---- 窗洞内衬（漏斗曲面） ----
  vec3 hit;
  vec3 reveal = wall;
  float hitZ = 1.0; // 打到内衬的深度，没打到就是 1（比窗板还深）
  if (dBezel < 0.01 && marchFunnel(ro, rd, hit)) {
    hitZ = hit.z;
    vec3 n = funnelNormal(hit);
    float depth01 = clamp(hit.z / PANE_DEPTH, 0.0, 1.0);
    float ao = mix(1.0, 0.45, sqrt(depth01)); // 越深，看到的舱内越少
    vec3 e = eCabin * ao + windowIrradiance(hit, n, lWin)
           + eSunNormal * max(dot(n, sunC), 0.0) * sunThroughWindow(hit, sunC, uShadeBottom);
    float g = vnoise(hit.xy * 900.0 + hit.z * 500.0) - 0.5;
    // 窗板四周一圈深灰色的橡胶密封条
    float gasket = (1.0 - smoothstep(0.004, 0.006, sdRoundRect(hit.xy, PANE_HALF, PANE_RADIUS))) * step(PANE_DEPTH - 0.012, hit.z);
    vec3 albedo = mix(PLASTIC_ALBEDO * (1.0 + 0.05 * g * grainFade), vec3(0.06), gasket);
    reveal = albedo / M_PI * e;
    if (uDebug == 3) reveal = windowIrradiance(hit, n, lWin);
    if (uDebug == 4) reveal = n * 0.5 + 0.5;
  }

  // ---- 遮光板：半透的白色塑料，舱内一侧能看到透过来的光 ----
  vec3 eShadeOuter = M_PI * lWin + eSunNormal * max(sunC.z, 0.0);
  vec3 shade = PLASTIC_ALBEDO / M_PI * (0.8 * eCabin + 0.08 * eShadeOuter);
  // 遮光板下沿有一道凸起的把手，被顶上来的光照亮
  float lip = smoothstep(0.012, 0.0, pShade.y - uShadeBottom);
  shade *= 1.0 + 0.25 * lip;

  // ---- 合成 ----
  float inBezel = 1.0 - smoothstep(-wB, wB, dBezel);
  float inPane = 1.0 - smoothstep(-wP, wP, dPane);
  // 视线在遮光板所在深度之前就打到内衬的话，遮光板被内衬挡住
  float shaded = smoothstep(-wS, wS, pShade.y - uShadeBottom) * step(SHADE_DEPTH, hitZ);

  vec4 cloud = texture(uClouds, gl_FragCoord.xy / uResolution);
  vec3 view;
  float tWing = inBezel > 0.0 ? wingHit(ro, rd, (PANE_DEPTH - ro.z) / rd.z) : -1.0;
  if (tWing > 0.0) {
    view = shadeWing(ro + rd * tWing, rd, sunC, eSkyH, eDown, belowAlbedo);
    // 在云里：机翼隔着几米到十几米的雾。消光系数取探针测到的云密度，雾色取这条视线上云的亮度
    if (uCameraFog > 0.0) {
      float tFog = exp(-uCameraFog * tWing * 0.001);
      vec3 fogColor = cloud.rgb / max(1.0 - cloud.a, 0.05);
      view = mix(fogColor, view, tFog);
    }
    view *= PANE_TRANSMITTANCE;
  } else {
    vec3 rdW = uCabinToWorld * rd;
    view = outsideRadiance(rdW, cloud);
    // 远处的飞机和航迹云在云层之上，挡在海面和云前面
    vec4 tr = trafficRadiance(rdW);
    view = (view * tr.a + tr.rgb + boltRadiance(rdW)) * PANE_TRANSMITTANCE;
  }
  view += wingLights(ro, rd) * PANE_TRANSMITTANCE;

  // ---- 窗板上的细节 ----
  vec2 q = pPane.xy;
  float sunLit = step(0.0, sunC.z); // 阳光照得到窗板
  vec2 sc = scratches(q, rd, sunC, pixPane);
  float sm = smudges(q);
  // 油污的前向散射：视线离太阳越近越亮，散射角大约 10–20°
  float fwdLobe = exp(-(1.0 - dot(rd, sunC)) / 0.03);
  view *= 1.0 - 0.1 * sm;
  view += sunLit * eSunNormal * (0.015 * sc.x + 0.004 * sm * fwdLobe);
  view += M_PI * lWin * (0.01 * sc.y + 0.006 * sm);
  // 窗板外侧的水：水线和水珠像小透镜，把周围一大片的光折射进来——亮度被「平均」成窗外的平均亮度，
  // 边缘因为全反射偏暗；迎着阳光时会闪亮
  vec2 wetCov = waterOnPane(q, pixPane, -uSeatSign, uTime, uWetness);
  float wc = clamp(wetCov.x + wetCov.y, 0.0, 1.0);
  // 均匀的雾里水珠几乎看不见，主要靠边缘的全反射暗边；外面有明暗对比时才折射出亮光
  vec3 lensed = M_PI * lWin * 0.9 + eSunNormal * 0.004 * sunLit * fwdLobe;
  float edge = clamp(4.0 * wc * (1.0 - wc) + 0.6 * wetCov.x, 0.0, 1.0);
  view *= 1.0 - 0.3 * edge;
  view += wc * 0.12 * max(lensed - view, vec3(0.0));
  // 内层窗板底部的透气孔（直径约 3 mm），孔边一圈暗环
  float dHole = length(q - vec2(0.0, -0.145));
  view *= 1.0 - 0.6 * smoothstep(0.0011, 0.0014, dHole) * (1.0 - smoothstep(0.0016, 0.0021, dHole));
  // 窗板反射舱内：正对时约 4%，斜看时更多（菲涅尔）
  float fr = 0.04 + 0.96 * pow(1.0 - clamp(rd.z, 0.0, 1.0), 5.0);
  view += fr * wall * 1.5;
  vec3 col = mix(wall, mix(mix(reveal, view, inPane), shade, shaded), inBezel);
  if (uDebug == 3 || uDebug == 4) col = mix(vec3(0.0), reveal, inBezel * (1.0 - inPane));
  if (uDebug == 1) col = vec3(hitZ / PANE_DEPTH, inBezel, shaded) * 10.0;
  if (uDebug == 2) col = vec3(log2(max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1e-6)) * 0.1 + 1.0) * 10.0;
  // HDR 目标是 32 位浮点时可以原样存下太阳的辐亮度（约 1.8e6 kcd/m²），眩光的能量才对。
  // alpha 存「这个像素有多少是窗外」，曝光时窗外和舱内分开适应
  float outsideMask = inBezel * inPane * (1.0 - shaded);
  gl_FragColor = vec4(min(col, vec3(uHdrMax)), outsideMask);
}
`;

export function createSceneMaterial(atmosphere: Atmosphere, cloudUniforms: Record<string, THREE.IUniform>, ground: GroundClipmap) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: SCENE_FRAG,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      ...atmosphere.sharedUniforms,
      ...cloudUniforms,
      uClouds: { value: null },
      uSkyViewLut: { value: atmosphere.skyView.texture },
      uSkyViewMoonLut: { value: atmosphere.skyViewMoon.texture },
      uIrradianceLut: { value: atmosphere.irradiance.texture },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunIlluminance: { value: new THREE.Vector3(120, 120, 120) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonIlluminance: { value: new THREE.Vector3() },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      uKeyIlluminance: { value: new THREE.Vector3(120, 120, 120) },
      uSunFromMoon: { value: new THREE.Vector3(0, 1, 0) },
      uMoonAngularRadius: { value: 0.0045 },
      uMoonPhaseFraction: { value: 1 },
      uMoonTexture: { value: null },
      uStarMap: { value: null },
      uLocalToEquatorial: { value: new THREE.Matrix3() },
      uCamR: { value: 6370 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uHead: { value: new THREE.Vector3(0, 0, -0.45) },
      uCamBasis: { value: new THREE.Matrix3() },
      uTanHalfFov: { value: Math.tan((25 * Math.PI) / 180) },
      uCabinToWorld: { value: new THREE.Matrix3() },
      uShadeBottom: { value: 1 },
      uWind: { value: 7 },
      uCabinLight: { value: 0.2 },
      uTime: { value: 0 },
      uWetness: { value: 0 },
      uCameraFog: { value: 0 },
      uSeatSign: { value: 1 },
      uWingRootLE: { value: 8 },
      uWingFlex: { value: 0.5 },
      uStrobe: { value: 0 },
      uIslandDensity: { value: 0.15 },
      uGroundAlbedo: { value: ground.albedo },
      uGroundWater: { value: ground.water },
      uGroundHeight: { value: ground.height },
      uGroundLevel: { value: ground.levelUniform },
      uGroundOn: { value: 1 },
      uTerrainMax: { value: 0 },
      uBolt: { value: Array.from({ length: 16 }, () => new THREE.Vector3()) },
      uBoltIntensity: { value: 0 },
      uTrafficPos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uTrafficDir: { value: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)] },
      uTrafficSpeed: { value: [0.23, 0.23] },
      uTrafficActive: { value: [0, 0] },
      uAerialInscatterS: { value: atmosphere.aerialInscatter.texture },
      uAerialTransmittanceS: { value: atmosphere.aerialTransmittance.texture },
      uHdrMax: { value: 6e4 },
      uDebug: { value: 0 },
    },
  });
}
