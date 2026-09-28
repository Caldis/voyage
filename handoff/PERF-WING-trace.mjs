// PERF-WING：wingTrace 求交循环的等价写法逐项对照（在「灯位置每像素一次」之后的新基线上）
// node scripts/shader-budget.mjs --variants handoff/PERF-WING-trace.mjs --only wing --rounds 3
const W = "src/render/wing.glsl.ts";
const sel = (k, name) => ({ file: W, find: `gWingSkip == ${k} ? 1e3 : ${name}(P);`, replace: `${name}(P); if (gWingSkip == ${k}) x = 1e3;` });
export const VARIANTS = [
  ["base", []],
  // ① 循环上界：现在是 min(uWingSteps, 0) 起步 + uniform 推出的 total。改回常数起点，看 FXC 会不会展开（反例，不采用）
  ["常数起点 i=0", [{ file: W, find: "  for (int i = min(uWingSteps, 0); i < total; i++) {", replace: "  for (int i = 0; i < total; i++) {" }]],
  // ② W-STAIR 下界的外层 uniform 分支去掉（内层两个 if 保留）：看是否「两份」
  ["W-STAIR 去外层 if", [{ file: W, find: "  if (uFlap > 1e-3 || uSlat > 1e-3) {\n    // 分区", replace: "  {\n    // 分区" }]],
  // ③ sdWing 里「跳过部件」的三目改成先算再覆盖（分支移出、无条件求值）
  ["跳过部件改成先算后选", [
    { file: W, find: "  float x = gWingSkip == 0 ? 1e3 : sdWingTip(P);", replace: "  float x = sdWingTip(P); if (gWingSkip == 0) x = 1e3;" },
    { file: W, find: "  x = gWingSkip == 2 ? 1e3 : sdWingFlap(P);", replace: "  x = sdWingFlap(P); if (gWingSkip == 2) x = 1e3;" },
    { file: W, find: "  x = gWingSkip == 3 ? 1e3 : sdWingSpoiler(P);", replace: "  x = sdWingSpoiler(P); if (gWingSkip == 3) x = 1e3;" },
    { file: W, find: "  x = gWingSkip == 4 ? 1e3 : sdWingSlat(P);", replace: "  x = sdWingSlat(P); if (gWingSkip == 4) x = 1e3;" },
    { file: W, find: "  x = gWingSkip == 5 ? 1e3 : sdWingFairing(P);", replace: "  x = sdWingFairing(P); if (gWingSkip == 5) x = 1e3;" },
    { file: W, find: "  x = gWingSkip == 6 ? 1e3 : sdWingNacelle(P);", replace: "  x = sdWingNacelle(P); if (gWingSkip == 6) x = 1e3;" },
  ]],
  // ④ 小翼的包围早退改成单出口 if/else
  ["小翼包围单出口", [{ file: W, find: "  if (outside > 0.0) return outside + 0.5;\n  WingTipCoord q = wingTipCoord(P);\n  float dn = abs(q.n - q.cam) - q.halfT;\n  float dx = max(-q.xi, q.xi - 1.0) * q.c * 0.8;\n  float ds = max(-q.sig - 0.02, q.sig - (q.arcLen + q.wlLen));\n  return max(max(dn, dx), ds);", replace: "  float r = outside + 0.5;\n  if (outside <= 0.0) {\n    WingTipCoord q = wingTipCoord(P);\n    float dn = abs(q.n - q.cam) - q.halfT;\n    float dx = max(-q.xi, q.xi - 1.0) * q.c * 0.8;\n    float ds = max(-q.sig - 0.02, q.sig - (q.arcLen + q.wlLen));\n    r = max(max(dn, dx), ds);\n  }\n  return r;" }]],
  // ⑤ 取样点三目：求交放最后一个分支（W-EDGE v5 的写法）
  ["q 三目换序", [{ file: W, find: "    vec3 q = phase == 0 ? oA + dA * t : (phase == 1 ? P + wingTetraDir(j) * 0.0023 : P + w.nA * 0.01 + lA * ts);", replace: "    vec3 q = phase == 1 ? P + wingTetraDir(j) * 0.0023 : (phase == 2 ? P + w.nA * 0.01 + lA * ts : oA + dA * t);" }]],
];
