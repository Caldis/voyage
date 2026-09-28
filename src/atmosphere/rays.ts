import * as THREE from "three";
import { ATMOSPHERE_COMMON, FULLSCREEN_VERT } from "./common.glsl";
import { CLOUD_COMMON } from "../clouds/clouds.glsl";
import { VIEW_COMMON } from "../render/view.glsl";
import type { FullscreenPass } from "../render/pass";

/**
 * 云隙光 / 曙暮光条（SPEC-RAYS）：云挡住阳光的那几段空气不散射阳光。
 *
 * 大气 LUT（天空视图 / 空气透视）按「整条视线都受光」算内散射，云影只落在海面 / 地面上，空气里没有影子：
 * 低太阳从积云后面照过来时，真实照片里云缝之间明暗相间的光条（曙暮光条）、从高空俯看时云影投进下方霾层的暗柱都画不出来。
 * 这里沿每条视线在云层以下（及云层之间）的空气里步进，查云影图（T27，clouds.ts 建、窗外程序本来就在查）得到每一点的
 * 阳光可见度 V，累计「本该有、却被云挡掉」的那部分单次散射 ΔL = ∫ T(相机→p) · σs(p)·P(θ) · E☉ · T☉(p) · (1 − V(p)) dt，
 * 再从窗外 HDR 里减掉。多次散射（天光）不减：影子里的空气照样被天空照亮，所以暗条是灰蓝的，不是黑的。
 * 反曙暮光（对日点方向收敛的光条）是同一批影子从另一头看，自动就有（前向散射弱，所以淡）。
 *
 * 三个小 pass，都不碰窗外主程序（冷启动关键路径，DEV_SOP 第 5 节）：
 * 1. 步进（1/4 分辨率）：每像素 RAYS_STEPS 步，起点按 4×4 Bayer 矩阵错开（固定在屏幕上、不随时间变，不闪）；
 *    输出 RGB = ΔL（以「太阳照度 = 1」为单位），A = 其中「在云壳入口之后」那一份占的比例（被云挡住时要乘云的透射率）。
 * 2. 4×4 盒式模糊（1/4 分辨率）：任何 4×4 窗口里 16 个错开相位正好各出现一次，模糊后等效 16 × RAYS_STEPS 个分层样本，
 *    没有步进条带、也没有固定噪点。
 * 3. 合成（全分辨率）：读窗外 HDR、双线性上采样 ΔL、按云缓冲的透射率拆近 / 远两份，写一张新的窗外 HDR，
 *    舱内合成改读它（main.ts：`sceneMat.uniforms.uOutside.value = rays.render(...)`）。
 *    不用 GL 混合直接在 hdrOutside 上减：减法没法夹到 ≥ 0（步进与 LUT 的积分误差、近 / 远拆分的近似都可能让个别像素减过头）。
 *
 * 不该出现时整段不画、舱内合成读原来的 hdrOutside（逐位不变）：主光源不是太阳（夜里换成月亮）、太阳低于 −4°、
 * 没有云（覆盖率 0 且没有雷暴 / 台风）、云影图还没建好、程序还在后台编译。
 *
 * 云影图只存「从 0 / 1 / 2 / 3 km 高度出发朝太阳的透射率」：3 km 以上的点按 3 km 的值取，
 * 在云底（至少 3 km）以上到云顶之间渐变回 1（云层之间的空气多半受光；层积云、积云云底都低于 3 km，误差只在云层内部）。
 */

/** 每条视线的步数（1/4 分辨率上；错开 16 个相位后等效 16 倍） */
export const RAYS_STEPS = 32;
/** 步进目标相对全分辨率的缩小倍数 */
export const RAYS_DOWNSCALE = 4;
/** 步进只算到这么远（km）：云影图最外一级半边长 400 km，再远的空气里不算影子 */
const RAYS_MAX_KM = 400;

const MARCH_FRAG = /* glsl */ `
${ATMOSPHERE_COMMON}
${VIEW_COMMON}
${CLOUD_COMMON}
uniform vec3 uSunDir;
uniform vec3 uKeyDir;
uniform float uCamR;
uniform vec2 uRaysRes;          // 步进目标的像素尺寸
uniform int uLoopGuard;         // 恒为 0（循环上限写成「常数 + uLoopGuard」，FXC 不展开，见 README 着色器编译坑点）
varying vec2 vUv;

const float OUTSIDE_WINDOW_PITCH = 0.533; // 和 outside-pass.ts 一致，只用来判定本窗

// 4×4 Bayer 矩阵：步进起点的错开量（0..15）/ 16。周期 4：任何 4×4 窗口里 16 个值各出现一次
float raysBayer(ivec2 q) {
  int x = q.x & 3, y = q.y & 3;
  int b = ((x ^ y) & 1) * 8 + (y & 1) * 4 + (((x ^ y) >> 1) & 1) * 2 + ((y >> 1) & 1);
  return (float(b) + 0.5) / 16.0;
}

// 云影图给的阳光可见度（见文件头：3 km 以上在云底—云顶之间渐变回 1）
float raysVisibility(vec3 p, float h) {
  float v = cloudShadow(p, uKeyDir);
  float lo = max(3.0, uShellBottom);
  return mix(v, 1.0, smoothstep(lo, max(uShellTop, lo + 0.1), h));
}

void main() {
  // 这个步进像素对应的全分辨率坐标（像素中心）
  vec2 fc = gl_FragCoord.xy * (uResolution / uRaysRes);
  vec3 rd = cabinRay(fc);
  vec3 ro = uHead;
  // 本窗窗板判定（同 outside-pass.ts），放宽到模糊半径以外：窗边的 ΔL 不被窗外的 0 拉低
  float rdz = max(rd.z, 1e-4);
  vec3 pWall = ro + rd * ((0.0 - ro.z) / rdz);
  vec3 pPane = ro + rd * ((PANE_DEPTH - ro.z) / rdz);
  float dPane = sdRoundRect(pPane.xy, PANE_HALF, PANE_RADIUS);
  float wP = fwidth(dPane);
  bool isMain = abs(floor(pWall.x / OUTSIDE_WINDOW_PITCH + 0.5)) < 0.5;
  if (rd.z < 1e-4 || !isMain || dPane > 4.0 * wP + 1e-4) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 rdW = uCabinToWorld * rd;
  vec3 o = vec3(0.0, uCamR, 0.0);
  // 只有云顶以下的空气可能在云影里：求视线在 [海面, 云顶] 之间的那一段
  float rTop = BOTTOM + uShellTop;
  vec2 top = raySphere2(o, rdW, rTop);
  float tGround = raySphere(o, rdW, BOTTOM);
  float tA, tB;
  if (uCamR > rTop) {
    if (top.x < 0.0) { gl_FragColor = vec4(0.0); return; }   // 视线不进云顶以下
    tA = top.x;
    tB = tGround > 0.0 ? tGround : top.y;
  } else {
    tA = 0.0;
    tB = tGround > 0.0 ? tGround : top.y;
  }
  tB = min(tB, ${RAYS_MAX_KM.toFixed(1)});
  if (tB <= tA) { gl_FragColor = vec4(0.0); return; }
  // 云壳入口：之后的空气在云背后，被云挡住时要乘云的透射率（合成 pass 按云缓冲算）
  vec2 shell = cloudShellInterval(o, rdW);
  float tSplit = shell.y > shell.x ? shell.x : 1e9;

  float cosTheta = dot(rdW, uSunDir);
  float pR = rayleighPhase(cosTheta);
  float pM = miePhase(cosTheta);
  float pH = csPhase(cosTheta, HAZE_G);
  vec3 hazeSpec = hazeSpectral(uHazeShape.z);
  vec3 ssa = clamp(uHazeShape.y + uHazeShape.w * vec3(1.0, 0.0, -1.0), 0.0, 1.0);

  // 相机到起点的透射率：起点在相机下方（从云顶以上往下看）时，两段都朝上看到大气层顶再相除
  vec3 T = vec3(1.0);
  if (tA > 0.0) {
    vec3 pA = o + rdW * tA;
    float rA = length(pA);
    T = min(transmittanceToTop(rA, dot(pA, -rdW) / rA) / max(transmittanceToTop(uCamR, -rdW.y), vec3(1e-6)), vec3(1.0));
  }
  float dt = (tB - tA) / float(${RAYS_STEPS});
  float j = raysBayer(ivec2(gl_FragCoord.xy));
  vec3 Lnear = vec3(0.0), Lfar = vec3(0.0);
  for (int i = 0; i < ${RAYS_STEPS} + uLoopGuard; i++) {
    float t = tA + (float(i) + j) * dt;
    vec3 p = o + rdW * t;
    float r = length(p);
    float h = r - BOTTOM;
    float dR = exp(-h / RAYLEIGH_SCALE_HEIGHT);
    float dM = exp(-h / MIE_SCALE_HEIGHT);
    vec3 haze = hazeExtinction(h) * hazeSpec;
    vec3 ext = RAYLEIGH_SCATTERING * dR + vec3((MIE_SCATTERING + MIE_ABSORPTION) * dM) + haze;
    vec3 stepT = exp(-ext * dt);
    float shadow = 1.0 - raysVisibility(p, h);
    if (shadow > 0.0) {
      vec3 S = (RAYLEIGH_SCATTERING * dR * pR + MIE_SCATTERING * dM * pM + haze * ssa * pH) * sunTransmittance(r, dot(p, uSunDir) / r);
      vec3 dL = T * S * shadow * (1.0 - stepT) / max(ext, vec3(1e-7));
      if (t < tSplit) Lnear += dL;
      else Lfar += dL;
    }
    T *= stepT;
  }
  vec3 L = Lnear + Lfar;
  float lum = dot(L, vec3(0.2126, 0.7152, 0.0722));
  float farFrac = lum > 0.0 ? dot(Lfar, vec3(0.2126, 0.7152, 0.0722)) / lum : 0.0;
  gl_FragColor = vec4(L, farFrac);
}
`;

// 4×4 盒式模糊：4 次双线性取样，每次落在 2×2 纹素的公共角上（各 1/4 权重）。
// 覆盖的是 [i−1, i+2] 这 4 个纹素，中心偏了半个纹素，合成 pass 上采样时反向挪回
const BLUR_FRAG = /* glsl */ `
uniform sampler2D uRaysRaw;
uniform vec2 uRaysRes;
varying vec2 vUv;
void main() {
  vec2 c = gl_FragCoord.xy;
  vec2 px = 1.0 / uRaysRes;
  // A（远段比例）按 ΔL 的亮度加权平均，避免没有 ΔL 的纹素把比例拉向 0
  vec4 a = texture(uRaysRaw, (c + vec2(-0.5, -0.5)) * px);
  vec4 b = texture(uRaysRaw, (c + vec2( 1.5, -0.5)) * px);
  vec4 d = texture(uRaysRaw, (c + vec2(-0.5,  1.5)) * px);
  vec4 e = texture(uRaysRaw, (c + vec2( 1.5,  1.5)) * px);
  vec4 w = vec4(dot(a.rgb, vec3(1.0)), dot(b.rgb, vec3(1.0)), dot(d.rgb, vec3(1.0)), dot(e.rgb, vec3(1.0)));
  float ws = w.x + w.y + w.z + w.w;
  float far = ws > 0.0 ? dot(w, vec4(a.a, b.a, d.a, e.a)) / ws : 0.0;
  gl_FragColor = vec4((a.rgb + b.rgb + d.rgb + e.rgb) * 0.25, far);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${CLOUD_BUFFER_ONLY()}
uniform sampler2D uOutsideSrc;   // 窗外 HDR（hdrOutside，最近邻）
uniform sampler2D uRaysBlur;     // 模糊后的 ΔL（1/4 分辨率，线性过滤）
uniform sampler2D uClouds;       // 云缓冲（两倍宽，左半 A = 云的透射率）
uniform vec2 uResolution;
uniform vec2 uRaysRes;
uniform vec3 uSunIlluminance;
uniform float uRaysGain;         // 1 = 物理量；调试 / 对照用
varying vec2 vUv;
const float PANE_TRANSMITTANCE = 0.85; // 和 outside-pass.ts 一致：窗外 HDR 已乘窗板透射率
const float RAYS_MAX_CUT = 0.9;
void main() {
  vec4 src = texelFetch(uOutsideSrc, ivec2(gl_FragCoord.xy), 0);
  // 窗外 pass 没算的像素（alpha 0）原样照抄；alpha 的「1 + 点星可见度」（T41）不动
  if (src.a < 0.5) { gl_FragColor = src; return; }
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 r = texture(uRaysBlur, uv - 0.5 / uRaysRes);
  float cloudT = cloudBufferColor(uClouds, uv).a;
  vec3 d = r.rgb * (1.0 - r.a * (1.0 - cloudT)) * uSunIlluminance * (PANE_TRANSMITTANCE * uRaysGain);
  // 最多减掉原值的 RAYS_MAX_CUT：步进与 LUT 的积分误差、近 / 远拆分的近似不许把像素减成负数或死黑。
  // 三个通道共用一个缩放 k（不逐通道夹）：逐通道夹时红通道先触底、蓝通道照减，海浪的暗像素被染成一粒粒紫色（第一版踩过）
  vec3 room = src.rgb * RAYS_MAX_CUT;
  vec3 kc = room / max(d, vec3(1e-12));
  float k = min(1.0, min(kc.r, min(kc.g, kc.b)));
  gl_FragColor = vec4(src.rgb - d * k, src.a);
}
`;

/** 合成 pass 只需要云缓冲的取色函数（CLOUD_COMMON 太大，这里单独抄这一小段，与 clouds.glsl.ts 的 cloudBufferColor 同公式） */
function CLOUD_BUFFER_ONLY() {
  return /* glsl */ `
vec4 cloudBufferColor(sampler2D buf, vec2 uv) {
  float w = float(textureSize(buf, 0).x) * 0.5;
  return texture(buf, vec2(min(uv.x * w, w - 0.5) / (2.0 * w), uv.y));
}
`;
}

function lowTarget() {
  return new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

function mat(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, name: string) {
  const m = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
  m.name = name;
  return m;
}

/**
 * 三个材质（离线检查 lint-shaders.mjs 也用这一份）。shared：舱内材质的 uniforms（相机、太阳、云、云影图、大气 LUT 都在里面）；
 * haze：大气的霾 uniform（atmosphere.hazeUniforms，只有 LUT 程序和这里用）
 */
export function createRaysMaterials(shared: Record<string, THREE.IUniform>, haze: Record<string, THREE.IUniform>) {
  const uRaysRes = { value: new THREE.Vector2(1, 1) };
  const march = mat(MARCH_FRAG, { ...shared, ...haze, uRaysRes }, "云隙光步进");
  const blur = mat(BLUR_FRAG, { uRaysRaw: { value: null }, uRaysRes }, "云隙光模糊");
  const composite = mat(
    COMPOSITE_FRAG,
    {
      uOutsideSrc: { value: null },
      uRaysBlur: { value: null },
      uClouds: shared.uClouds ?? { value: null },
      uResolution: shared.uResolution ?? { value: new THREE.Vector2(1, 1) },
      uRaysRes,
      uSunIlluminance: shared.uSunIlluminance ?? { value: new THREE.Vector3(120, 120, 120) },
      uRaysGain: { value: 1 },
    },
    "云隙光合成",
  );
  return { march, blur, composite };
}

type State = "idle" | "compiling" | "ready" | "failed";

export class CloudRays {
  readonly march: THREE.ShaderMaterial;
  readonly blur: THREE.ShaderMaterial;
  readonly composite: THREE.ShaderMaterial;
  private readonly raw = lowTarget();
  private readonly blurred = lowTarget();
  /** 合成后的窗外 HDR（格式与 hdrOutside 相同） */
  readonly target: THREE.WebGLRenderTarget;
  /** 总开关（调试 / A-B：`__voyage.rays.enabled = false`；URL `?rays=0`） */
  enabled = typeof location === "undefined" || new URLSearchParams(location.search).get("rays") !== "0";
  /** 这一帧画了没有（调试 / 回归看） */
  active = false;
  state: State = "idle";
  compileMs = 0;
  private frames = 0;
  /** 首帧后多少帧才开始后台编译（让启动批次先走，不上冷启动关键路径） */
  static readonly PREWARM_AFTER_FRAMES = 60;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly pass: FullscreenPass,
    private readonly shared: Record<string, THREE.IUniform>,
    haze: Record<string, THREE.IUniform>,
    outside: THREE.WebGLRenderTarget,
  ) {
    const m = createRaysMaterials(shared, haze);
    this.march = m.march;
    this.blur = m.blur;
    this.composite = m.composite;
    this.blur.uniforms.uRaysRaw.value = this.raw.texture;
    this.composite.uniforms.uRaysBlur.value = this.blurred.texture;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: outside.texture.type,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
  }

  setSize(w: number, h: number) {
    const lw = Math.max(1, Math.ceil(w / RAYS_DOWNSCALE));
    const lh = Math.max(1, Math.ceil(h / RAYS_DOWNSCALE));
    this.raw.setSize(lw, lh);
    this.blurred.setSize(lw, lh);
    this.target.setSize(w, h);
    (this.march.uniforms.uRaysRes.value as THREE.Vector2).set(lw, lh);
  }

  /** 这一帧该不该画（物理上有没有可见的云隙光）：主光源是太阳、太阳不低于 −4°、有云、云影图已建好 */
  get wanted(): boolean {
    const u = this.shared;
    const sun = u.uSunDir.value as THREE.Vector3;
    const key = u.uKeyDir.value as THREE.Vector3;
    if (sun.y < -0.07 || sun.dot(key) < 0.99999) return false;
    if ((u.uCloudShadowCenter.value as THREE.Vector3).z < 0.5) return false;
    const clouds = (u.uCoverage.value as number) > 0 || (u.uStormCount.value as number) > 0 || (u.uHurricane.value as THREE.Vector4).w > 0.5;
    return clouds;
  }

  private prepare() {
    if (this.state !== "idle") return;
    this.state = "compiling";
    const t0 = performance.now();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const prev = this.renderer.getRenderTarget();
    // 编译时绑定真正要画进去的目标（ANGLE 的 D3D 后端按链接时的帧缓冲生成输出布局，见 outside-pass.ts LazyVariant）
    const jobs = ([[this.march, this.raw], [this.blur, this.blurred], [this.composite, this.target]] as const).map(([m, t]) => {
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(geometry, m);
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.renderer.setRenderTarget(t);
      return this.renderer.compileAsync(scene, cam);
    });
    this.renderer.setRenderTarget(prev);
    Promise.all(jobs)
      .then(() => {
        for (const m of [this.march, this.blur, this.composite]) {
          const program = (this.renderer.properties.get(m) as { currentProgram?: { getUniforms(): unknown; diagnostics?: { runnable: boolean } } }).currentProgram;
          program?.getUniforms();
          if (!program || program.diagnostics?.runnable === false) {
            this.state = "failed";
            return;
          }
        }
        this.state = "ready";
      })
      .catch(() => (this.state = "failed"))
      .then(() => {
        if (this.state === "failed") console.warn("云隙光程序编译失败，不画云隙光");
      })
      .finally(() => {
        this.compileMs = performance.now() - t0;
        geometry.dispose();
      });
  }

  /**
   * 调试 / 测量：GPU 计时（EXT_disjoint_timer_query_webgl2）连画 n 次云隙光的三个 pass，返回每次的毫秒数
   * （只计这三个 pass；不可用或被打断时返回 NaN）。`await __voyage.rays.bench(outside, 20)`，outside 传 `__voyage.hdrOutside`
   */
  async bench(outside: THREE.WebGLRenderTarget, n = 20, part: "all" | "march" | "blur" | "composite" = "all"): Promise<number> {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (!ext || this.state !== "ready") return NaN;
    this.composite.uniforms.uOutsideSrc.value = outside.texture;
    const once = () => {
      if (part === "all" || part === "march") this.pass.render(this.march, this.raw);
      if (part === "all" || part === "blur") this.pass.render(this.blur, this.blurred);
      if (part === "all" || part === "composite") this.pass.render(this.composite, this.target);
    };
    once();
    const q = gl.createQuery()!;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < n; i++) once();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    }
    const ok = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT);
    const ns = ok ? (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) : NaN;
    gl.deleteQuery(q);
    return ns / 1e6 / n;
  }

  /**
   * 每帧在窗外 pass 之后调用：返回舱内合成该读的窗外纹理——画了云隙光就是合成后的 target，否则原样是 outside（逐位不变）
   */
  render(outside: THREE.WebGLRenderTarget): THREE.Texture {
    this.active = false;
    if (!this.enabled) return outside.texture;
    const want = this.wanted;
    if (++this.frames > CloudRays.PREWARM_AFTER_FRAMES || (want && this.frames > 2)) this.prepare();
    if (!want || this.state !== "ready") return outside.texture;
    this.composite.uniforms.uOutsideSrc.value = outside.texture;
    this.pass.render(this.march, this.raw);
    this.pass.render(this.blur, this.blurred);
    this.pass.render(this.composite, this.target);
    this.active = true;
    return this.target.texture;
  }
}
