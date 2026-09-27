import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import { CLOUD_COMMON } from "../clouds/clouds.glsl";
import { CABIN_COMMON, PANE_COMMON } from "./cabin.glsl";
import { LIGHTS_COMMON } from "./lights.glsl";
import { VIEW_COMMON } from "./view.glsl";
import { WING_COMMON } from "./wing.glsl";
import { WING_SHADING_COMMON } from "./wing-shading.glsl";

/**
 * 机翼 pass：场景 pass 之后单独画机翼，读场景的 HDR 结果、把机翼按覆盖率合成上去，写到另一张 HDR 目标。
 *
 * 为什么拆出来：机翼的距离场、材质和边缘超采样放在场景着色器里时，Windows 上 ANGLE → FXC 的冷编译从约 57 秒涨到 104 秒
 * （FXC 编译时间随单个着色器的规模超线性增长）。拆成独立的程序后，两个程序靠 KHR_parallel_shader_compile 并行编译，各自规模也小一半。
 *
 * 合成：场景输出的 alpha 是「这个像素有多少是窗外」（本窗、窗板以内、没被遮光板和座椅挡住），记作 m；
 * 场景输出的 alpha 里还打包了「与窗外颜色无关的部分」A = 场景 − m·k·O（见 scene.ts 的 packWingRef），窗板乘性系数 k 在这里重算。
 *   结果 = (1 − a)·场景 + a·(A + m·k·机翼 × 窗板透射率)，a 是机翼覆盖率；再加上翼尖灯本身（亮点 + 云雾里的光晕）× m。
 * 窗板的附加亮度（划痕、擦痕、水珠、舱内反射）与窗外无关，增量合成时原样保留在机翼上。
 */
const WING_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${CLOUD_COMMON}
${CABIN_COMMON}
${PANE_COMMON}
${WING_COMMON}
${LIGHTS_COMMON}
uniform sampler2D uScene;        // 场景 pass 的 HDR 结果（alpha 里打包了窗外遮罩和窗外原色，见 scene.ts 的 packWingRef）
uniform float uTime;
uniform float uWetness;
uniform sampler2D uClouds;       // 云缓冲（雾色用；两倍宽，用 cloudBufferColor 取左半，T38）
uniform float uCameraFog;
uniform vec3 uKeyCloud;          // 飞机周围云对光照的影响（T31，见 scene.ts）
uniform float uHdrMax;
varying vec2 vUv;
const float WING_PANE_T = 0.85;  // 窗板透射率，和 scene.ts 的 PANE_TRANSMITTANCE 一致
${WING_SHADING_COMMON}

// 解包 scene.ts 的 packWingRef：返回窗外遮罩 m，o 是场景结果里「与窗外颜色无关的部分」A
float unpackWingRef(float a, out vec3 o) {
  o = vec3(0.0);
  if (uHdrMax < 1e10) return a;
  uint bits = floatBitsToUint(a);
  float m = float(bits & 31u) / 31.0;
  float e = float(int((bits >> 24) & 31u) - 20);
  o = vec3(float((bits >> 5) & 63u), float((bits >> 11) & 63u), float((bits >> 17) & 63u)) / 63.0 * exp2(e);
  return m;
}

void main() {
  vec4 sc = texelFetch(uScene, ivec2(gl_FragCoord.xy), 0);
  vec3 o;
  float m = unpackWingRef(sc.a, o);
  sc.a = m;                        // 写回真正的窗外遮罩，曝光要用
  // 窗板平面上的像素足迹（屏幕导数要在分支之前取）
  vec3 rd0 = cabinRay(gl_FragCoord.xy);
  vec3 pPane0 = uHead + rd0 * ((PANE_DEPTH - uHead.z) / max(rd0.z, 1e-4));
  float pixPane = max(length(fwidth(pPane0.xy)), 1e-5);
  vec4 cloud = cloudBufferColor(uClouds, gl_FragCoord.xy / uResolution);   // 隐式求导的采样放在分支之前
  gl_FragColor = sc;
  vec3 rd = rd0;
  vec3 ro = uHead;
  if (m <= 0.0 || rd.z < 1e-4) return;

  // 窗外来的光（和 scene.ts 里的算法一致）
  vec3 sunC = transpose(uCabinToWorld) * uKeyDir;
  vec3 upW = vec3(0.0, 1.0, 0.0);
  vec3 eKey0 = keyLight(uCamR, upW);
  vec3 eSkyH = skyIrradiance(uCamR, upW) * uKeyCloud.z + eKey0 * max(uKeyDir.y, 0.0) * uKeyCloud.y;
  vec3 eDown = eSkyH + eKey0 * uKeyCloud.x * max(uKeyDir.y, 0.0);
  float belowAlbedo = mix(0.06, 0.7, clamp(uCoverage * 0.9, 0.0, 1.0));

  float refL = dot(sc.rgb, vec3(0.2126, 0.7152, 0.0722)) / WING_PANE_T;
  vec4 wing = wingView(ro, rd, (PANE_DEPTH - ro.z) / rd.z, sunC, eSkyH, eDown, belowAlbedo, cloud, refL);
  vec3 col = sc.rgb;
  if (wing.a > 0.0) {
    // 增量合成：只把「窗外 → 机翼」的差换进去，窗板上的划痕、水痕、舱内反射都留着；
    // 窗框 / 座椅部分覆盖的像素按 m 加权，交界处不再漏出一条天空色细线。
    // 窗板效果里和窗外亮度成正比的部分（油污、水珠暗边与透镜化、透气孔）按 scene.ts 的公式重算
    vec2 q = pPane0.xy;
    // 水的折射在这里不重做（机翼上的水珠只保留暗边），偏折留给 scene.ts 里的窗外部分
    float wetRim = waterOnPane(q, pixPane, -uSeatSign, uTime, uWetness).w;
    float dHole = length(q - vec2(0.0, -0.145));
    float k = (1.0 - 0.1 * smudges(q)) * (1.0 - WATER_RIM * wetRim)
      * (1.0 - 0.6 * smoothstep(0.0011, 0.0014, dHole) * (1.0 - smoothstep(0.0016, 0.0021, dHole)));
    vec3 w = wing.rgb * WING_PANE_T;
    col = uHdrMax < 1e10 ? mix(col, w * k, wing.a * m) : (1.0 - wing.a) * col + wing.a * (o + m * k * w);
  }
  col += wingLights(ro, rd) * WING_PANE_T * m;
  gl_FragColor = vec4(min(col, vec3(uHdrMax)), sc.a);
}
`;

/** uniforms 直接复用场景材质的 uniform 对象（同一个引用），主循环里更新场景的 uniform 就同时更新了这里；另加 uScene */
export function createWingMaterial(sceneUniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: WING_FRAG,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: { ...sceneUniforms, uScene: { value: null } },
  });
}
