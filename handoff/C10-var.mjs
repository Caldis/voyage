// C10 的云步进变体（给 handoff/C10-ab.mjs --vfile）。每个变体 = 若干 [查找, 替换]，对云步进原文逐个全部替换。
const DENS = "    float dens = cloudDensity(p, lod, t < 150.0);\n";
const RET = "return min(d * mix(3.5, 1.5, cir), 1.0) * uCloudDensity;";

// 表皮剖面诊断：沿视线第一次碰到云的地方，从上一个区间起点起按 4 m 细步走 800 m（与渲染同一 lod、带细节），
// 输出 R = 视线光学厚度到 1 的深度（m，从 σ 首次 > 0.5 /km 算起）、G = 到 3 的深度、B = 进云 100 m 处的 σ（/km）、A = 800 m 内 σmax + 1。
// 只看 40 km 以内的云
const diag = (ret) => [
  ...(ret ? [[RET, ret]] : []),
  [DENS, DENS + `    if (dens > 0.002 && t < 40.0) {
      float s0 = -1.0, dOd1 = 999.0, dOd3 = 999.0, s100 = 0.0, smax = 0.0, odA = 0.0;
      float t0 = max(t - stepLen, seg.x);
      for (int k = 0; k < 200 + min(uStormCount, 0); k++) {
        float tt = t0 + float(k) * 0.004;
        float sg = cloudDensity(ro + rd * tt, lod, true) * CLOUD_EXTINCTION;
        if (s0 < 0.0) { if (sg > 0.5) s0 = tt; else continue; }
        float dd = tt - s0;
        odA += sg * 0.004;
        if (dOd1 > 998.0 && odA >= 1.0) dOd1 = dd * 1000.0;
        if (dOd3 > 998.0 && odA >= 3.0) dOd3 = dd * 1000.0;
        if (dd >= 0.098 && dd < 0.102) s100 = sg;
        smax = max(smax, sg);
      }
      gl_FragColor = vec4(dOd1, dOd3, s100, s0 < 0.0 ? 0.0 : -(smax + 1.0));
      return;
    }
`],
];

const K = (k) => [[RET, `return min(d * mix(${k.toFixed(1)}, 1.5, cir), 1.0) * uCloudDensity;`]];

// 进云二分定位（只在默认 / 非天气路径）：空白 → 有云时，在「上一个空白样本」与「这个样本」之间二分 nb 次（只求密度、不受光），
// 然后从定位到的表面起按 firstK·dt 走第一步（之后照常 dt）：进云样本的深度从 [0, 2dt] 收到 [0, firstK·dt]，且步进网格锚在表面上。
const bis = (nb, firstK, tmax = 60) => [
  ["  bool wasEmpty = true;\n", "  bool wasEmpty = true;\n  int bis = 0; float bLo = seg.x, bHi = seg.x, tPrevS = seg.x, tNoBis = -1.0, firstK = 1.0;\n"],
  ["    float dt = dtBase;\n    float stepLen = wasEmpty ? 2.0 * dt : dt;\n#endif\n    vec3 p = ro + rd * (t + stepLen * jitter);\n",
   "    float dt = dtBase;\n    float stepLen = (wasEmpty ? 2.0 * dt : dt) * firstK;\n#endif\n    float tS = bis > 0 ? 0.5 * (bLo + bHi) : t + stepLen * jitter;\n    vec3 p = ro + rd * tS;\n"],
  [DENS, DENS + `#ifndef CLOUD_WEATHER
    if (bis > 0) {
      if (dens > 0.002) bHi = tS; else bLo = tS;
      bis--;
      if (bis == 0) { t = bHi; wasEmpty = false; firstK = ${firstK.toFixed(3)}; tNoBis = t + 3.0 * dt; }
      continue;
    }
    firstK = 1.0;
    if (dens > 0.002 && wasEmpty && t > tNoBis && t < ${tmax.toFixed(1)}) { bLo = tPrevS; bHi = tS; bis = ${nb}; continue; }
#endif
`],
  ["      wasEmpty = true;\n", "      wasEmpty = true;\n      tPrevS = tS;\n"],
];

export const VARIANTS = {
  base: [],
  base2: [],
  diag: diag(null),
  // 饱和倍率（边缘消光爬升的斜率）
  k7: K(7), k12: K(12), k20: K(20),
  diagk7: diag(`return min(d * mix(7.0, 1.5, cir), 1.0) * uCloudDensity;`),
  diagk12: diag(`return min(d * mix(12.0, 1.5, cir), 1.0) * uCloudDensity;`),
  diagk20: diag(`return min(d * mix(20.0, 1.5, cir), 1.0) * uCloudDensity;`),
  // 低密度段开方（边上陡、芯不变）
  pow5: [[RET, "return pow(min(d * mix(3.5, 1.5, cir), 1.0), mix(0.5, 1.0, cir)) * uCloudDensity;"]],
  diagpow5: diag("return pow(min(d * mix(3.5, 1.5, cir), 1.0), mix(0.5, 1.0, cir)) * uCloudDensity;"),
  // 消光整体翻倍
  bis3: bis(3, 1.0), bis3h: bis(3, 0.5), bis3q: bis(3, 0.25),
  k7bis3h: [...K(7), ...bis(3, 0.5)], k12bis3h: [...K(12), ...bis(3, 0.5)],
  bis4h: bis(4, 0.5), bis3t: bis(3, 0.35), bis2h: bis(2, 0.5),
  k4bis4h: [...K(4), ...bis(4, 0.5)], k6bis4h: [...K(6), ...bis(4, 0.5)],
  bis4hcap: [...bis(4, 0.5), ["i >= 192) break;", "i >= 384) break;"]], basecap: [["i >= 192) break;", "i >= 384) break;"]],
  k5bis3h: [...K(5), ...bis(3, 0.5)], k5bis4h: [...K(5), ...bis(4, 0.5)], k5: K(5),
  ext2: [["const float CLOUD_EXTINCTION = 60.0;", "const float CLOUD_EXTINCTION = 120.0;"]],
};
