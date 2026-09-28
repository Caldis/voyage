import * as THREE from "three";
import { FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import { FullscreenPass } from "../render/pass";
import { BUTTERFLY_FRAG, EVOLVE_FRAG, FINALIZE_FRAG } from "./fft.glsl";
import { buildSpectrum, type CascadeBand, coxMunkVariance, normalTailInverse, type SpectrumResult, whitecapCoverage } from "./spectrum";

/**
 * FFT 海浪（Tessendorf 2001），三个级联：
 * - 平铺尺寸约 1531 m / 211 m / 29 m，互不成整数比；每级在着色器里再按世界坐标做随机六边形平铺（T21，见 ocean.glsl.ts），
 *   单级内部也没有周期（只互不成比例还不够：俯视时 211 m 那一级会铺成约 17 像素的规则格子）；
 * - 每级只保留自己的波数段（上一级到 L/6 的波长为止），不重叠、不重复计数；
 * - 每帧：相位推进 1 次 + 逆 FFT 16 次（每次三级一起）+ 写入纹理数组 3 次 + 生成 mip，全部是 256² 量级的小 pass。
 *
 * 接入：`new OceanWaves(renderer)`，把 `uniforms` 合并进场景材质，每帧 `update(秒, 风速 m/s, 飞机累计位移 km)`。
 *
 * 风速（WX11g）：频谱只在少数几个风速档（WIND_LEVELS）上算，风速落在两档之间时，相位推进 pass 按比例混合两档的 h0
 * （同一组高斯随机数，只是振幅不同），所以风速可以每帧连续变化而不重算频谱；重算只发生在跨进新的一对档位时，
 * 而且在 Worker 里做（CPU 约 20–40 ms，放主线程必掉帧），算好之前海面停在上一个风速上（最多几十毫秒）。
 */

/**
 * 海面 10 m 风速的档位（m/s），大致一档一个蒲福风级（WMO 蒲福风级表的风速区间与海况描述）：
 * 0 无风（只有涌浪，镜面）· 1.5 软风（1 级上沿：鱼鳞状涟漪）· 3 轻风（2 级：小波，波峰光滑不破碎）·
 * 5 微风（3 级：波峰开始破碎，零星白浪）· 7 和风（4 级：白浪较多）· 10 劲风（5 级：中浪，白浪很多）·
 * 13.5 强风（6 级：大浪，白沫成片）· 17.5 疾风（7–8 级之交：浪堆起，白沫顺风成条）· 22 大风（9 级）。
 * 7 m/s 必须是一档：它是面板默认值，默认场景的频谱与改前逐位相同
 */
export const WIND_LEVELS = [0, 1.5, 3, 5, 7, 10, 13.5, 17.5, 22];
/** 缓存里最多留几档的 h0（每档 3 MB）：超过它才逐出 [i−2, i+2] 以外的档 */
const CACHE_LEVELS = 6;

const N = 256;
/** 波场的时间周期（s）：ω 按 2π/T 量化后波场严格以 T 为周期（相对误差 < 1%，看不出来） */
const PERIOD = 512;

const SIZES = [1531.1, 211.37, 29.17];
/** 随机平铺的格子密度：每个平铺尺寸内的格点数（与 ocean.glsl.ts 的 OCEAN_HEX_SCALE 一致） */
const HEX_SCALE = 2;
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

/** 一个 h0 槽位（图集：宽 N·级联数、高 N，RGBA32F，按下标 texelFetch） */
function h0Texture() {
  const t = new THREE.DataTexture(new Float32Array(N * SIZES.length * N * 4), N * SIZES.length, N, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

export class OceanWaves {
  /** 合并进场景材质的 uniform */
  readonly uniforms: {
    uOceanWaves: THREE.IUniform<THREE.Texture>;
    uOceanTile: THREE.IUniform<THREE.Vector3>;
    uOceanHex: THREE.IUniform<THREE.Vector4[]>;
    uOceanCam: THREE.IUniform<THREE.Vector4>;
    uOceanVar: THREE.IUniform<THREE.Vector3>;
    uOceanFoam: THREE.IUniform<THREE.Vector4>;
  };
  /**
   * 调试：当前海况。wind = 频谱实际用到的风速（算好之前可能落后于输入）；level = [下档, 上档, 混合比]；
   * hs / slopeVar / foamTau 按混合后的 h0 估算；coverage = Monahan 白浪覆盖率；
   * buildMs = 最近一次频谱计算（Worker 里的为 Worker 耗时），syncBuildMs = 最近一次主线程同步计算（只有启动那一次，或 Worker 不可用），
   * uploadMs = 最近一次把 h0 交给 three（真正的上传在下一次 render 里，见 README 坑点）；builds / holds = 累计计算档数 / 等频谱的帧数
   */
  stats = {
    wind: -1,
    level: [0, 0, 0] as [number, number, number],
    hs: 0,
    slopeVar: [0, 0, 0],
    coxMunk: 0,
    coverage: 0,
    foamTau: 0,
    buildMs: 0,
    syncBuildMs: 0,
    uploadMs: 0,
    builds: 0,
    holds: 0,
    pending: 0,
    gustDriftKm: 0,
  };

  private readonly pass: FullscreenPass;
  /** 两个 h0 槽位：A = 下档、B = 上档（uMix = 在两档之间的比例） */
  private h0A: THREE.DataTexture;
  private h0B: THREE.DataTexture;
  private slotLevel: [number, number] = [-1, -1];
  private readonly cache = new Map<number, SpectrumResult>();
  private readonly pendingLevels = new Set<number>();
  private worker: Worker | null | undefined = undefined;
  private readonly workerJobs = new Map<number, number>();
  private jobId = 0;
  private readonly ping = atlasTarget();
  private readonly pong = atlasTarget();
  private readonly waves: THREE.WebGLArrayRenderTarget;
  private readonly evolve: THREE.ShaderMaterial;
  private readonly butterfly: THREE.ShaderMaterial;
  private readonly finalize: THREE.ShaderMaterial;
  /** 频谱实际显示的风速（−1 = 还没有） */
  private wind = -1;
  /** 阵风斑的漂移（km）：D0 + 风速 ×（t − t0），风速变了就把已走的距离并进 D0（风速恒定时与改前着色器里的 uWind·uTime 至多差 1 ulp） */
  private drift0 = 0;
  private driftT0 = 0;
  private driftWind = Number.NaN;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.pass = new FullscreenPass(renderer);
    this.h0A = h0Texture();
    this.h0B = h0Texture();

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
      uH0: { value: this.h0A },
      uH0b: { value: this.h0B },
      uMix: { value: 0 },
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
      uOceanHex: { value: SIZES.map(() => new THREE.Vector4()) },
      uOceanCam: { value: new THREE.Vector4() },
      uOceanVar: { value: new THREE.Vector3() },
      uOceanFoam: { value: new THREE.Vector4(1e3, 0, 0, 0) },
    };
  }

  // ---------- 风速 → 频谱（WX11g） ----------

  /** 频谱 Worker（第一次用时创建；创建失败或出错后为 null，改为主线程同步算） */
  private getWorker(): Worker | null {
    if (this.worker !== undefined) return this.worker;
    if (typeof Worker === "undefined") return (this.worker = null);
    try {
      const wk = new Worker(new URL("./spectrum.worker.ts", import.meta.url), { type: "module" });
      wk.onmessage = (e: MessageEvent<{ id: number; data?: Float32Array; slopeVar?: number[]; heightVar?: number[]; ms?: number; error?: string }>) => {
        const d = e.data;
        const lvl = this.workerJobs.get(d.id);
        this.workerJobs.delete(d.id);
        if (lvl === undefined) return;
        this.pendingLevels.delete(lvl);
        if (d.error || !d.data) {
          console.warn("海浪频谱 Worker 出错，改为主线程同步计算", d.error);
          this.disableWorker();
          return;
        }
        this.cache.set(lvl, { data: d.data, slopeVar: d.slopeVar!, heightVar: d.heightVar! });
        this.stats.buildMs = Math.round(d.ms ?? 0);
        this.stats.builds++;
      };
      wk.onerror = (e) => {
        console.warn("海浪频谱 Worker 不可用，改为主线程同步计算", e.message);
        this.disableWorker();
      };
      this.worker = wk;
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private disableWorker() {
    this.worker?.terminate();
    this.worker = null;
    this.pendingLevels.clear();
    this.workerJobs.clear();
  }

  /** 在后台算某一档（已有 / 在算就跳过） */
  private prefetch(lvl: number) {
    if (lvl < 0 || lvl >= WIND_LEVELS.length || this.cache.has(lvl) || this.pendingLevels.has(lvl)) return;
    const wk = this.getWorker();
    if (!wk) return;
    const id = ++this.jobId;
    this.pendingLevels.add(lvl);
    this.workerJobs.set(id, lvl);
    wk.postMessage({ id, n: N, bands: BANDS, wind: WIND_LEVELS[lvl] });
  }

  /** 主线程同步算一档（只在启动的第一帧、或 Worker 不可用时；CPU 约 20–40 ms） */
  private buildSync(lvl: number) {
    const t0 = performance.now();
    this.cache.set(lvl, buildSpectrum(N, BANDS, WIND_LEVELS[lvl]));
    this.stats.syncBuildMs = this.stats.buildMs = Math.round(performance.now() - t0);
    this.stats.builds++;
  }

  /** 把某一档的 h0 放进槽位 slot（直接引用缓存里的数组，不拷贝），并立刻交给 GPU（计时的是主线程这一侧） */
  private upload(slot: 0 | 1, lvl: number) {
    const t0 = performance.now();
    const tex = slot === 0 ? this.h0A : this.h0B;
    tex.image.data = this.cache.get(lvl)!.data;
    tex.needsUpdate = true;
    this.renderer.initTexture(tex);
    this.slotLevel[slot] = lvl;
    this.stats.uploadMs = +(performance.now() - t0).toFixed(2);
  }

  /**
   * 把海况对到风速 input（m/s）。风速落在 WIND_LEVELS[i] 与 [i+1] 之间：两档都在缓存里就按比例混合（纯 uniform，零 CPU），
   * 缺哪档就交给 Worker 去算、这一帧保持原样（holds 计数）；两侧各预取一档，风速继续往同一方向走时通常已经算好。
   * 第一次调用（启动）同步算，海面不会先空一下
   */
  private setWind(input: number) {
    const L = WIND_LEVELS;
    const w = Math.min(Math.max(Number.isFinite(input) ? input : 0, 0), L[L.length - 1]);
    if (w === this.wind) return;
    let i = 0;
    while (i + 2 < L.length && L[i + 1] <= w) i++;
    const a = Math.min(Math.max((w - L[i]) / (L[i + 1] - L[i]), 0), 1);
    const need = a > 0 ? [i, i + 1] : [i];
    // 启动第一帧（或 Worker 不可用）先同步算需要的档，再预取：顺序反过来 Worker 会把同一档再算一遍（审查 L1）
    for (const l of need) if (!this.cache.has(l) && (this.wind < 0 || !this.getWorker())) this.buildSync(l);
    // 预取：当前一对（风速正好落在档上时上档也要备好）+ 两侧各一档
    for (const l of [i, i + 1, i - 1, i + 2]) this.prefetch(l);
    this.stats.pending = this.pendingLevels.size;
    if (need.some((l) => !this.cache.has(l))) {
      this.stats.holds++;
      return;
    }
    // 槽位：已经装着的档不重传；A 放下档、B 放上档
    const find = (l: number) => (this.slotLevel[0] === l ? 0 : this.slotLevel[1] === l ? 1 : -1);
    let sa = find(i);
    let sb = a > 0 ? find(i + 1) : -1;
    if (sa < 0) {
      sa = sb >= 0 ? 1 - sb : Math.abs(this.slotLevel[0] - i) >= Math.abs(this.slotLevel[1] - i) ? 0 : 1;
      this.upload(sa as 0 | 1, i);
    }
    if (a > 0 && sb < 0) {
      sb = 1 - sa;
      this.upload(sb as 0 | 1, i + 1);
    }
    const texA = sa === 0 ? this.h0A : this.h0B;
    this.evolve.uniforms.uH0.value = texA;
    this.evolve.uniforms.uH0b.value = texA === this.h0A ? this.h0B : this.h0A;
    this.evolve.uniforms.uMix.value = a;
    // 缓存只留 [i−2, i+2]（对称）：风速在档边界来回时 i 在相邻两值间跳，不对称的范围会把刚逐出的档又算一遍（审查 M1）
    for (const l of [...this.cache.keys()]) if ((l < i - 2 || l > i + 2) && this.cache.size > CACHE_LEVELS) this.cache.delete(l);

    // 混合后的方差：两档是同一组随机数、振幅线性混合，所以按「标准差线性混合」估算（两档谱形相近时几乎精确；a = 0 时逐位等于该档）
    const A = this.cache.get(i)!;
    const B = a > 0 ? this.cache.get(i + 1)! : null;
    const mixVar = (va: number, vb: number | undefined) => (B && vb !== undefined ? ((1 - a) * Math.sqrt(va) + a * Math.sqrt(vb)) ** 2 : va);
    const slopeVar = A.slopeVar.map((v, c) => mixVar(v, B?.slopeVar[c]));
    const heightVar = A.heightVar.map((v, c) => mixVar(v, B?.heightVar[c]));
    // 白浪：只看前两级（决定破碎的是谱峰附近的主波，不是厘米级的短波）。Σ|k|·h 是高斯场，方差等于这两级的斜率方差；
    // 取阈值 τ 使超过它的面积比例正好是 Monahan 覆盖率（按实际风速连续算，跨档时白浪也是连续变化的）
    const foamVar = slopeVar[0] + slopeVar[1];
    const cov = whitecapCoverage(w);
    const tau = cov > 1e-6 && foamVar > 1e-8 ? Math.sqrt(foamVar) * normalTailInverse(cov) : 1e3;
    this.uniforms.uOceanVar.value.set(slopeVar[0], slopeVar[1], slopeVar[2]);
    this.uniforms.uOceanFoam.value.x = tau;
    this.uniforms.uOceanFoam.value.y = 1;
    this.wind = w;
    Object.assign(this.stats, {
      wind: w,
      level: [L[i], L[i + 1], +a.toFixed(3)],
      hs: 4 * Math.sqrt(heightVar.reduce((x, y) => x + y, 0)),
      slopeVar,
      coxMunk: coxMunkVariance(w),
      coverage: cov,
      foamTau: tau,
    });
  }

  /**
   * 阵风斑（ocean.glsl.ts 的 gustFactor）随风漂移的距离（km），放在 uOceanFoam.z。
   * 改前着色器里直接写 uWind·uTime：风速一变，整片阵风斑瞬间挪 Δ风速 × 已运行秒数（运行 10 分钟后差 1 m/s 就跳 0.6 km）。
   * 现在逐段积分：风速恒定时 = 风速 × t（与改前至多差 1 ulp），风速变化时位置连续
   */
  private updateDrift(timeSec: number, wind: number) {
    if (Number.isNaN(this.driftWind)) this.driftWind = wind;
    else if (wind !== this.driftWind) {
      this.drift0 += this.driftWind * (timeSec - this.driftT0) * 1e-3;
      this.driftT0 = timeSec;
      this.driftWind = wind;
    }
    const d = this.drift0 + wind * (timeSec - this.driftT0) * 1e-3;
    this.uniforms.uOceanFoam.value.z = d;
    this.stats.gustDriftKm = d;
  }

  /**
   * 每帧调用。timeSec：秒（与场景 uTime 同源即可）；wind：海面风速 m/s（可以连续变化，见 setWind）；offsetKm：飞机累计位移（km，即 uCloudOffset）。
   * 位移在 CPU 上用双精度换算成各级随机平铺格子的斜格坐标（整数 + 小数），着色器里只加相对相机的小量，飞得再远也不丢精度。
   */
  update(timeSec: number, wind: number, offsetKm?: THREE.Vector2) {
    this.setWind(wind);
    this.updateDrift(timeSec, wind);
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
      const xM = offsetKm.x * 1000;
      const zM = offsetKm.y * 1000;
      SIZES.forEach((L, c) => {
        // 相机在随机平铺格子里的斜格坐标（与 ocean.glsl.ts 的 TriangleGrid 一致），双精度拆成整数 + 小数：
        // 着色器里只加相对相机的小量，格点编号是精确整数
        const sx = (xM / L) * HEX_SCALE;
        const sz = (zM / L) * HEX_SCALE;
        const a = sx - sz / Math.sqrt(3);
        const b = (sz * 2) / Math.sqrt(3);
        this.uniforms.uOceanHex.value[c].set(Math.floor(a), Math.floor(b), a - Math.floor(a), b - Math.floor(b));
      });
      const mod = (v: number) => v - 4096 * Math.floor(v / 4096);
      this.uniforms.uOceanCam.value.set(mod(xM), mod(zM), 0, 0);
    }
  }

  dispose() {
    this.h0A.dispose();
    this.h0B.dispose();
    this.worker?.terminate();
    this.ping.dispose();
    this.pong.dispose();
    this.waves.dispose();
    this.evolve.dispose();
    this.butterfly.dispose();
    this.finalize.dispose();
  }
}
