// PERF-STORM：shader-budget --variants 的补丁，拆 cloud-march-storm 冷编译增量来自哪一处
const G = "src/clouds/clouds.glsl.ts";
const C = "src/clouds/clouds.ts";
const EARLY = { file: G, find: "    if (d2 >= 0.5625) continue;\n", replace: "" };
const PRUNE = { file: G, find: "  if (cl <= 0.0 || aBot + 0.1 - alt >= 1.26 * cl * zone) return 0.0;\n", replace: "  if (cl <= 0.0) return 0.0;\n" };
const SKIP = { file: C, find: "#if defined(CLOUD_STORM) && !defined(CLOUD_TYPHOON)\n#define CLOUD_STORM_SKIP 1\n#endif\n", replace: "" };
// 早退写成不带 continue 的 if 块（第二个哈希及以后都放进 if 里）
const EARLY_IF = [
  { file: G, find: "    if (d2 >= 0.5625) continue;\n    vec2 h2", replace: "    if (d2 < 0.5625) {\n    vec2 h2" },
  { file: G, find: "    if (s > 0.0 && h2.y > 0.25) best = max(best, (0.4 + 1.2 * h2.y * h2.y) * rad * sqrt(s));\n  }", replace: "    if (s > 0.0 && h2.y > 0.25) best = max(best, (0.4 + 1.2 * h2.y * h2.y) * rad * sqrt(s));\n    }\n  }" },
];
export const VARIANTS = [
  ["cur", []],
  ["noEarly", [EARLY]],
  ["noPrune", [PRUNE]],
  ["noSkip", [SKIP]],
  ["earlyIf", EARLY_IF],
  ["none", [EARLY, PRUNE, SKIP]],
];
