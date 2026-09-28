// C10：离线 FXC 逐项撤回（node scripts/shader-budget.mjs --variants handoff/C10-fxc-variants.mjs --only cloud-march --rounds 3）。
// 注意：--variants 会改磁盘上的源文件，要在没有开发服务器的对照 worktree 里跑（README「--variants 会真的改动磁盘上的源文件」）。
const F = "src/clouds/clouds.ts";
const G = "src/clouds/clouds.glsl.ts";
export const VARIANTS = [
  ["cur", []],
  ["noK", [{ file: G, find: "return min(d * mix(4.5, 1.5, cir), 1.0) * uCloudDensity;", replace: "return min(d * mix(3.5, 1.5, cir), 1.0) * uCloudDensity;" }]],
  ["noFirstK", [
    { file: F, find: "float stepLen = (wasEmpty ? 2.0 * dt : dt) * firstK;", replace: "float stepLen = wasEmpty ? 2.0 * dt : dt;" },
    { file: F, find: "wasEmpty = false; firstK = 0.5; tNoBis", replace: "wasEmpty = false; tNoBis" },
    { file: F, find: "    firstK = 1.0;\n    if (dens", replace: "    if (dens" },
  ]],
  ["noNoBis", [{ file: F, find: " && t > tNoBis && t < 60.0)", replace: " && t < 60.0)" }]],
  ["noBisTrigger", [{ file: F, find: "if (dens > 0.002 && wasEmpty && t > tNoBis && t < 60.0) { bLo = tPrevS; bHi = tS; bis = 4; continue; }", replace: "" }]],
  ["merged", [{ file: F, find: "    if (bis > 0) {\n      if (dens > 0.002) bHi = tS; else bLo = tS;\n      bis--;\n      if (bis == 0) { t = bHi; wasEmpty = false; firstK = 0.5; tNoBis = t + 3.0 * dt; }\n      continue;\n    }\n    firstK = 1.0;\n    if (dens > 0.002 && wasEmpty && t > tNoBis && t < 60.0) { bLo = tPrevS; bHi = tS; bis = 4; continue; }\n", replace: "    firstK = bis == 1 ? 0.5 : 1.0;\n    if (bis > 0 || (dens > 0.002 && wasEmpty && t > tNoBis && t < 60.0)) {\n      if (bis == 0) { bLo = tPrevS; bis = 5; }\n      if (dens > 0.002) bHi = tS; else bLo = tS;\n      bis--;\n      if (bis == 0) { t = bHi; wasEmpty = false; tNoBis = t + 3.0 * dt; }\n      continue;\n    }\n" }]],
  ["mergedNoNoBis", [{ file: F, find: "    if (bis > 0) {\n      if (dens > 0.002) bHi = tS; else bLo = tS;\n      bis--;\n      if (bis == 0) { t = bHi; wasEmpty = false; firstK = 0.5; tNoBis = t + 3.0 * dt; }\n      continue;\n    }\n    firstK = 1.0;\n    if (dens > 0.002 && wasEmpty && t > tNoBis && t < 60.0) { bLo = tPrevS; bHi = tS; bis = 4; continue; }\n", replace: "    firstK = bis == 1 ? 0.5 : 1.0;\n    if (bis > 0 || (dens > 0.002 && wasEmpty && t < 60.0)) {\n      if (bis == 0) { bLo = tPrevS; bis = 5; }\n      if (dens > 0.002) bHi = tS; else bLo = tS;\n      bis--;\n      if (bis == 0) { t = bHi; wasEmpty = false; tNoBis = t + 3.0 * dt; }\n      continue;\n    }\n" }]],
];
