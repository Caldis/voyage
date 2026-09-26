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
 * 合成：场景输出的 alpha 是「这个像素有多少是窗外」（本窗、窗板以内、没被遮光板和座椅挡住），记作 m。
 *   结果 = mix(场景, 机翼 × 窗板透射率 × 油污衰减, 机翼覆盖率 × m)，再加上翼尖灯本身（亮点 + 云雾里的光晕）× m。
 * 窗板上附加的亮度（划痕、擦痕、窗板反射舱内）在机翼像素上按场景里窗外那一路的值被替换掉了，这是和旧做法（在场景里合成）的唯一差别；
 * 窗板油污的乘性衰减这里照做。
 */
const WING_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${CLOUD_COMMON}
${CABIN_COMMON}
${PANE_COMMON}
${WING_COMMON}
${LIGHTS_COMMON}
uniform sampler2D uScene;        // 场景 pass 的 HDR 结果（alpha = 窗外遮罩）
uniform sampler2D uClouds;       // 半分辨率云层（雾色用）
uniform float uCameraFog;
uniform float uHdrMax;
varying vec2 vUv;
const float WING_PANE_T = 0.85;  // 窗板透射率，和 scene.ts 的 PANE_TRANSMITTANCE 一致
${WING_SHADING_COMMON}

void main() {
  vec4 sc = texelFetch(uScene, ivec2(gl_FragCoord.xy), 0);
  vec4 cloud = texture(uClouds, gl_FragCoord.xy / uResolution);   // 隐式求导的采样放在分支之前
  gl_FragColor = sc;
  float m = sc.a;
  vec3 rd = cabinRay(gl_FragCoord.xy);
  vec3 ro = uHead;
  if (m <= 0.0 || rd.z < 1e-4) return;

  // 窗外来的光（和 scene.ts 里的算法一致）
  vec3 sunC = transpose(uCabinToWorld) * uKeyDir;
  vec3 upW = vec3(0.0, 1.0, 0.0);
  vec3 eSkyH = skyIrradiance(uCamR, upW);
  vec3 eDown = eSkyH + keyLight(uCamR, upW) * max(uKeyDir.y, 0.0);
  float belowAlbedo = mix(0.06, 0.7, clamp(uCoverage * 0.9, 0.0, 1.0));

  float refL = dot(sc.rgb, vec3(0.2126, 0.7152, 0.0722)) / WING_PANE_T;
  vec4 wing = wingView(ro, rd, (PANE_DEPTH - ro.z) / rd.z, sunC, eSkyH, eDown, belowAlbedo, cloud, refL);
  vec3 col = sc.rgb;
  if (wing.a > 0.0) {
    vec3 pPane = ro + rd * ((PANE_DEPTH - ro.z) / rd.z);
    vec3 w = wing.rgb * WING_PANE_T * (1.0 - 0.1 * smudges(pPane.xy));
    col = mix(col, w, wing.a * m);
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
