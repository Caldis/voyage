// C10b 交付后的对照变体（给 handoff/C10-ab.mjs 或 C10b-time.mjs --vfile）：页面跑的是交付版（撤二分 + 60 km 内空白步不加倍 + 上限 384）
//   old  = 改回 master（C10：非天气程序二分 + 空白 2dt + 上限 192；天气程序：空白 2dt + 上限 192），与 master 逐位等价
//   new  = 交付版；ref = 细步真值（步长 1/4、上限 3000、lod 按原步长、同一密度场）；dist = 输出深度（Y/α = km）
const DENS = "    float dens = cloudDensity(p, lod, t < 150.0);\n";
const OLD = [
  ["  bool wasEmpty = true;\n#ifdef CLOUD_WEATHER\n  bool refineOn",
   "  bool wasEmpty = true;\n#ifndef CLOUD_WEATHER\n  int bis = 0; float bLo = seg.x; float bHi = seg.x; float tPrevS = seg.x; float firstK = 1.0;\n#endif\n#ifdef CLOUD_WEATHER\n  bool refineOn"],
  ["(!refineOn && i >= 384)) break;", "(!refineOn && i >= 192)) break;"],
  ["|| i >= 384) break;", "|| i >= 192) break;"],
  ["    float emptyK = 1.0 + smoothstep(60.0, 90.0, t);\n", "    float emptyK = 2.0;\n"],
  ["    float stepLen = wasEmpty ? emptyK * dt : dt;\n#endif\n    float tS = t + stepLen * jitter;\n",
   "    float stepLen = (wasEmpty ? 2.0 * dt : dt) * firstK;\n    float tS = bis > 0 ? 0.5 * (bLo + bHi) : t + stepLen * jitter;\n#endif\n#ifdef CLOUD_WEATHER\n    float tS = t + stepLen * jitter;\n#endif\n"],
  [DENS, DENS + `#ifndef CLOUD_WEATHER
    firstK = bis == 1 ? 0.5 : 1.0;
    if (bis > 0 || (dens > 0.002 && wasEmpty && t < 60.0)) {
      if (bis == 0) { bLo = tPrevS; bis = 5; }
      if (dens > 0.002) bHi = tS; else bLo = tS;
      bis--;
      if (bis == 0) { t = bHi; wasEmpty = false; }
      continue;
    }
#endif
`],
  ["      wasEmpty = true;\n#ifdef CLOUD_WEATHER\n      wasThin = false;", "      wasEmpty = true;\n#ifndef CLOUD_WEATHER\n      tPrevS = tS;\n#endif\n#ifdef CLOUD_WEATHER\n      wasThin = false;"],
];
// 细步真值：交付版的估计器（近处空白 dt）步长再 ×1/4，上限 3000
const REF = [
  ["for (int i = 0; i < 448; i++) {", "for (int i = 0; i < 3000; i++) {"],
  ["(!refineOn && i >= 384)) break;", "(!refineOn && i >= 3000)) break;"],
  ["|| i >= 384) break;", "|| i >= 3000) break;"],
  ["float lod = clamp(log2(dtBase / 0.055), 0.0, 5.0);", "float lod = clamp(log2(clamp(t * 0.008, 0.06, 2.0) / 0.055), 0.0, 5.0);"],
  ["float dtBase = clamp(t * 0.008, 0.06, 2.0);", "float dtBase = clamp(t * 0.002, 0.015, 0.5);"],
];
const STEPS = [
  ["  for (int i = 0; i < 448; i++) {\n", "  float iUsed = 0.0;\n  for (int i = 0; i < 448; i++) {\n    iUsed = float(i);\n"],
  ["  gl_FragColor = vec4(min(L, vec3(60000.0)), T);\n  gl_FragDepth", "  gl_FragColor = vec4(vec3(iUsed), 0.0);\n  gl_FragDepth"],
  ["#else\n  if (wSum <= 0.0) return;\n#endif", "#else\n  if (wSum <= 0.0) { depthSum = 1.0; wSum = 1.0; }\n#endif"],
];
export const VARIANTS = {
  old: OLD, old2: OLD, new: [], new2: [],
  ref: REF,
  dist: [["  L = L * apT + apL * (1.0 - T);", "  L = vec3(depth) * (1.0 - T);"]],
  st_old: [...OLD, ...STEPS], st_new: STEPS,
  // 天气程序的代价对照：thin2 = 软边稀薄样本（台风卷云盖）仍走 2dt；noref = 够得着雷暴 / 台风的视线整条不走细步
  thin2: [["(fine > 0 || (!wasEmpty && !wasThin)) ? dt : emptyK * dt;", "(fine > 0 || (!wasEmpty && !wasThin)) ? dt : (wasThin ? 2.0 : emptyK) * dt;"]],
  noref: [["    if (refineOn) {\n      float hT", "    if (refineOn) { emptyK = 2.0;\n      float hT"]],
};
VARIANTS.r30 = [["    if (refineOn) {\n      float hT", "    if (refineOn) { emptyK = 1.0 + smoothstep(30.0, 45.0, t);\n      float hT"]];
VARIANTS.st_thin2 = [...VARIANTS.thin2, ...STEPS];
