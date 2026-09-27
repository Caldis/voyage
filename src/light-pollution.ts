import * as THREE from "three";
import type { GroundClipmap } from "./ground/clipmap";

/**
 * 城市光污染的天空背景（T09）：只用来压银河的可见度（stars.glsl.ts 的对比度阈值），**不画进天空**。
 *
 * 做法：从地面 clipmap 已经下好的夜光（NASA Black Marble，水体纹理的 B 通道，只读）里，
 * 在飞机周围约 150 km 内按 Walker 定律的距离衰减（∝ d^−2.5）求加权平均的「城市灯光强度」S ∈ [0, 1]，
 * 再按估算换成飞机上方天空被城市光照亮的亮度：
 *   地面上看，大城市中心的人工天光约为自然夜天光的几十倍（Falchi 2016 世界光污染图集的量级）→ 取 60 × 自然值 × S；
 *   飞机在高度 h 上只看得到 h 以上那部分空气散射的光：分子（标高 8 km）和气溶胶（标高约 1.5 km）各占一半 →
 *   × (0.5·e^(−h/8) + 0.5·e^(−h/1.5))。巡航 10.7 km 约剩 13%，4 km 约剩 34%。
 * 这些系数都是**估算**（没有实测可对），只决定「靠近城市时银河变淡多少」，改它们不影响任何别的画面。
 *
 * 没开真实地理数据（纯海面预设）时为 0。每 2 秒重算一次（只扫一级 1024² 里的 64² 个样本，约 0.2 ms）。
 */

/** 自然夜天光的亮度（kcd/m²，和 lights.glsl.ts 的 nightglow 天顶值一致） */
const NATURAL_SKY_KCD = 1.6e-7;
/** 大城市中心地面上的人工天光 ÷ 自然夜天光（估算） */
const CITY_CENTRE_RATIO = 60;
const SEARCH_RADIUS_KM = 150;
const RES = 1024; // 和 clipmap.ts 的 RES 一致（水体纹理边长）
const SAMPLES = 64;

export class LightPollution {
  readonly uniforms = {
    /** 飞机上方天空的人工天光亮度（kcd/m²），只进银河的可见度阈值 */
    uSkyGlow: { value: 0 },
  };
  private lastT = -Infinity;
  /** 最近一次算出的城市灯光强度 S（调试用） */
  strength = 0;

  update(ground: GroundClipmap, x: number, z: number, altitudeKm: number, groundOn: boolean, nowMs: number) {
    if (!groundOn) {
      this.strength = 0;
      this.uniforms.uSkyGlow.value = 0;
      return;
    }
    if (nowMs - this.lastT < 2000) return;
    this.lastT = nowMs;
    // 从粗到细找第一级能盖住搜索圆的（512 km 级优先，建好之前退到 256 km 级）
    const data = ground.water.image.data as unknown as Uint8Array;
    let s = -1;
    for (let i = ground.levelUniform.length - 1; i >= 0 && s < 0; i--) {
      const lv = ground.levelUniform[i];
      if (lv.w < 0.5 || lv.z < SEARCH_RADIUS_KM) continue;
      s = this.sampleLevel(data, i, lv, x, z, altitudeKm);
    }
    this.strength = Math.max(s, 0);
    const above = 0.5 * Math.exp(-altitudeKm / 8) + 0.5 * Math.exp(-altitudeKm / 1.5);
    this.uniforms.uSkyGlow.value = NATURAL_SKY_KCD * CITY_CENTRE_RATIO * this.strength * above;
  }

  private sampleLevel(data: Uint8Array, layer: number, lv: THREE.Vector4, x: number, z: number, altitudeKm: number) {
    const size = lv.z;
    const x0 = lv.x - size / 2;
    const z0 = lv.y - size / 2;
    const base = layer * RES * RES * 4;
    const stride = RES / SAMPLES;
    const d0 = Math.max(altitudeKm, 3); // 正下方的距离下限，免得 d^−2.5 在正下方发散
    let sum = 0;
    let wSum = 0;
    for (let j = 0; j < SAMPLES; j++) {
      const pz = z0 + ((j + 0.5) / SAMPLES) * size;
      for (let i = 0; i < SAMPLES; i++) {
        const px = x0 + ((i + 0.5) / SAMPLES) * size;
        const d2 = (px - x) ** 2 + (pz - z) ** 2;
        if (d2 > SEARCH_RADIUS_KM * SEARCH_RADIUS_KM) continue;
        const w = Math.pow(d2 + d0 * d0, -1.25);
        const k = base + ((j * stride + stride / 2) * RES + i * stride + stride / 2) * 4 + 2;
        const n = data[k] / 255;
        sum += n * n * w; // 着色器里夜光的发光量也是 night²（terrain-shading.glsl.ts）
        wSum += w;
      }
    }
    return wSum > 0 ? sum / wSum : -1;
  }
}
