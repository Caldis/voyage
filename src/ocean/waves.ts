import * as THREE from "three";
import { FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import { FullscreenPass } from "../render/pass";
import { BUTTERFLY_FRAG, EVOLVE_FRAG, FINALIZE_FRAG } from "./fft.glsl";
import { buildSpectrum, type CascadeBand, coxMunkVariance, normalTailInverse, whitecapCoverage } from "./spectrum";

/**
 * FFT 海浪（Tessendorf 2001），三个级联：
 * - 平铺尺寸约 1531 m / 211 m / 29 m，互不成整数比，叠在一起看不出平铺周期；
 * - 每级只保留自己的波数段（上一级到 L/6 的波长为止），不重叠、不重复计数；
 * - 每帧：相位推进 1 次 + 逆 FFT 16 次（每次三级一起）+ 写入纹理数组 3 次 + 生成 mip，全部是 256² 量级的小 pass。
 *
 * 接入：`new OceanWaves(renderer)`，把 `uniforms` 合并进场景材质，每帧 `update(秒, 风速 m/s, 飞机累计位移 km)`。
 */

const N = 256;
/** 波场的时间周期（s）：ω 按 2π/T 量化后波场严格以 T 为周期（相对误差 < 1%，看不出来） */
const PERIOD = 512;

const SIZES = [1531.1, 211.37, 29.17];
const BANDS: CascadeBand[] = SIZES.map((size, i) => ({
  size,
  kLo: i === 0 ? 0 : (6 * 2 * Math.PI) / size,
  kHi: i + 1 < SIZES.length ? (6 * 2 * Math.PI) / SIZES[i + 1] : (Math.PI * N) / size,
}));

function passMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function atlasTarget() {
  return new THREE.WebGLRenderTarget(N * SIZES.length, N, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

export class OceanWaves {
  /** 合并进场景材质的 uniform */
  readonly uniforms: {
    uOceanWaves: THREE.IUniform<THREE.Texture>;
    uOceanTile: THREE.IUniform<THREE.Vector3>;
    uOceanOrigin: THREE.IUniform<THREE.Vector2[]>;
    uOceanVar: THREE.IUniform<THREE.Vector3>;
    uOceanFoam: THREE.IUniform<THREE.Vector4>;
  };
  /** 调试：各级的波高方差、斜率方差、白浪阈值 */
  stats = { wind: -1, hs: 0, slopeVar: [0, 0, 0], coxMunk: 0, foamTau: 0, buildMs: 0 };

  private readonly pass: FullscreenPass;
  private readonly h0: THREE.DataTexture;
  private readonly ping = atlasTarget();
  private readonly pong = atlasTarget();
  private readonly waves: THREE.WebGLArrayRenderTarget;
  private readonly evolve: THREE.ShaderMaterial;
  private readonly butterfly: THREE.ShaderMaterial;
  private readonly finalize: THREE.ShaderMaterial;
  private wind = -1;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.pass = new FullscreenPass(renderer);
    this.h0 = new THREE.DataTexture(new Float32Array(N * SIZES.length * N * 4), N * SIZES.length, N, THREE.RGBAFormat, THREE.FloatType);
    this.h0.minFilter = this.h0.magFilter = THREE.NearestFilter;
    this.h0.generateMipmaps = false;

    this.waves = new THREE.WebGLArrayRenderTarget(N, N, SIZES.length, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      generateMipmaps: true,
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
    });
    // 先按「带 mip」分配存储；之后每帧只在最后一层画完时生成 mip（见 update）
    renderer.initRenderTarget(this.waves);

    const size = new THREE.Vector3(...SIZES);
    this.evolve = passMaterial(EVOLVE_FRAG, {
      uN: { value: N },
      uH0: { value: this.h0 },
      uSize: { value: size },
      uTau: { value: 0 },
      uOmega0: { value: (2 * Math.PI) / PERIOD },
    });
    this.butterfly = passMaterial(BUTTERFLY_FRAG, {
      uN: { value: N },
      uSrc: { value: null },
      uSub: { value: 2 },
      uHoriz: { value: 1 },
    });
    this.finalize = passMaterial(FINALIZE_FRAG, {
      uN: { value: N },
      uSrc: { value: null },
      uLayer: { value: 0 },
    });

    this.uniforms = {
      uOceanWaves: { value: this.waves.texture },
      uOceanTile: { value: size.clone() },
      uOceanOrigin: { value: SIZES.map(() => new THREE.Vector2()) },
      uOceanVar: { value: new THREE.Vector3() },
      uOceanFoam: { value: new THREE.Vector4(1e3, 0, 0, 0) },
    };
  }

  /** 风速变了才重算频谱（CPU，十几毫秒） */
  private rebuild(wind: number) {
    const t0 = performance.now();
    const spec = buildSpectrum(N, BANDS, wind);
    (this.h0.image.data as Float32Array).set(spec.data);
    this.h0.needsUpdate = true;
    // 白浪：只看前两级（决定破碎的是谱峰附近的主波，不是厘米级的短波）。Σ|k|·h 是高斯场，方差等于这两级的斜率方差；
    // 取阈值 τ 使超过它的面积比例正好是 Monahan 覆盖率
    const foamVar = spec.slopeVar[0] + spec.slopeVar[1];
    const cov = whitecapCoverage(wind);
    const tau = cov > 1e-6 && foamVar > 1e-8 ? Math.sqrt(foamVar) * normalTailInverse(cov) : 1e3;
    this.uniforms.uOceanVar.value.set(spec.slopeVar[0], spec.slopeVar[1], spec.slopeVar[2]);
    this.uniforms.uOceanFoam.value.set(tau, 1, 0, 0);
    this.wind = wind;
    this.stats = {
      wind,
      hs: 4 * Math.sqrt(spec.heightVar.reduce((a, b) => a + b, 0)),
      slopeVar: spec.slopeVar,
      coxMunk: coxMunkVariance(wind),
      foamTau: tau,
      buildMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * 每帧调用。timeSec：秒（与场景 uTime 同源即可）；wind：海面风速 m/s；offsetKm：飞机累计位移（km，即 uCloudOffset）。
   * 位移在 CPU 上用双精度对各级平铺尺寸取余，着色器里只剩小数，飞得再远纹理坐标也不丢精度。
   */
  update(timeSec: number, wind: number, offsetKm?: THREE.Vector2) {
    if (Math.abs(wind - this.wind) > 1e-3) this.rebuild(wind);
    const prevTarget = this.renderer.getRenderTarget();
    const tMod = ((timeSec % PERIOD) + PERIOD) % PERIOD;
    this.evolve.uniforms.uTau.value = tMod / PERIOD;
    this.pass.render(this.evolve, this.ping);
    let src = this.ping;
    let dst = this.pong;
    const stages = Math.log2(N);
    for (const horiz of [1, 0]) {
      for (let s = 0; s < stages; s++) {
        this.butterfly.uniforms.uSrc.value = src.texture;
        this.butterfly.uniforms.uSub.value = 2 << s;
        this.butterfly.uniforms.uHoriz.value = horiz;
        this.pass.render(this.butterfly, dst);
        [src, dst] = [dst, src];
      }
    }
    this.finalize.uniforms.uSrc.value = src.texture;
    // three 在每次画完带 mip 的目标后都会生成 mip：只在最后一层画完时生成一次
    for (let c = 0; c < SIZES.length; c++) {
      this.waves.texture.generateMipmaps = c === SIZES.length - 1;
      this.finalize.uniforms.uLayer.value = c;
      this.pass.render(this.finalize, this.waves, c);
    }
    this.renderer.setRenderTarget(prevTarget);

    if (offsetKm) {
      SIZES.forEach((L, c) => {
        const fx = (offsetKm.x * 1000) / L;
        const fz = (offsetKm.y * 1000) / L;
        this.uniforms.uOceanOrigin.value[c].set(fx - Math.floor(fx), fz - Math.floor(fz));
      });
    }
  }

  dispose() {
    this.h0.dispose();
    this.ping.dispose();
    this.pong.dispose();
    this.waves.dispose();
    this.evolve.dispose();
    this.butterfly.dispose();
    this.finalize.dispose();
  }
}
