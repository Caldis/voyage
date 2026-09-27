import * as THREE from "three";
import { FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import { CABIN_SHADING_COMMON } from "./cabin-shading.glsl";
import { LEATHER_COMMON } from "./cabin-leather.glsl";
import { FABRIC_COMMON } from "./fabric.glsl";
import { SEATS_COMMON } from "./seats.glsl";
import { CABIN_FRAG_HEAD, CABIN_LIGHTS_SETUP } from "./scene";

/**
 * 座椅 pass（PERF-14）：窗外 pass 之后、舱内合成之前，单独画座椅（本排头枕侧翼 / 壳体、前排靠背），
 * 写到 hdrSeat（rgb = 座椅颜色，kcd/m²；a = 座椅覆盖率，没打到座椅的像素是 0）。舱内合成按像素读回，
 * 和原来在同一个程序里算的 seatCol / seat.cov 用法完全一样（先算合成权重，座椅完全挡住时跳过侧壁 / 内衬 / 窗板）。
 *
 * 为什么拆出来：舱内程序的离线 FXC 时间主要是座椅着色（shadeSeat）和主函数其余部分「叠在一起」（PERF-12：整块换常数 −42%，
 * 里面任何一块单独去掉都在噪声里，零碎的循环化只拿回 5%）。PERF-13 之后真冷启动的关键路径就是舱内程序。
 * 拆成两个程序后两边靠 KHR_parallel_shader_compile 并行编译，各自规模都小（同机翼 pass 的拆法，见 wing-pass.ts）。
 * 光照走同一个 cabinLightsSetup（scene.ts 的 CABIN_LIGHTS_SETUP），同一组 uniform（直接复用场景材质的 uniform 对象），结果逐位相同。
 *
 * 舱等：同一份源码，经济舱加 #define CABIN_CLASS_ECONOMY（CabinClassVariant 和舱内合成的经济舱变体一起后台编译、一起切换）。
 * 单输出（不用 MRT，见 README 着色器编译坑点）。目标用 32 位浮点（有 EXT_color_buffer_float 时）：夜里全关灯时座椅的亮度
 * 只有 1e-5 kcd/m² 量级，半精度落进非规格数，曝光一拉高会显出台阶。
 */
const SEAT_FRAG = /* glsl */ `
${CABIN_FRAG_HEAD}
${CABIN_SHADING_COMMON}
${LEATHER_COMMON}
${FABRIC_COMMON}
${SEATS_COMMON}
${CABIN_LIGHTS_SETUP}

void main() {
  vec3 rd = cabinRay(gl_FragCoord.xy);
  vec3 ro = uHead;
  float pixAng = 2.0 * uTanHalfFov / uResolution.y; // 一个像素的张角（和舱内合成同一公式）
  float tWall = rd.z > 1e-4 ? traceWall(ro, rd) : 1e3;
  SeatHit seat = traceSeats(ro, rd, tWall, pixAng);
  gl_FragColor = vec4(0.0);
  if (seat.cov <= 0.0) return;
  vec3 eCabinRefl, mainTint;
  CabinLights cl = cabinLightsSetup(eCabinRefl, mainTint);
  gl_FragColor = vec4(shadeSeat(ro, rd, seat, pixAng, cl, uShadeBottom), seat.cov);
}
`;

/** uniforms 直接复用场景材质的 uniform 对象（同一个引用），和机翼 pass 一样 */
export function createSeatMaterial(sceneUniforms: Record<string, THREE.IUniform>) {
  const m = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: SEAT_FRAG,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: sceneUniforms,
  });
  m.name = "座椅";
  return m;
}

/** 座椅 pass 的目标：全分辨率、单输出、最近邻（舱内合成按 texelFetch 逐像素读） */
export function createSeatTarget(renderer: THREE.WebGLRenderer) {
  const float = renderer.extensions.has("EXT_color_buffer_float");
  return new THREE.WebGLRenderTarget(1, 1, {
    type: float ? THREE.FloatType : THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
}
