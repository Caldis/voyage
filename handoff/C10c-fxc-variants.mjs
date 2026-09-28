// C10c：shader-budget --variants 的补丁（在磁盘上的 src 做替换、计时、立刻改回）。拆交付版冷编译增量来自哪一处
// （原型阶段拆「探测调用点 +46% / 单格点 +23% / 两次循环 +25%」用的补丁已随原型撤掉，结果见 handoff/C10c.md）
const F = "src/clouds/clouds.ts";
export const VARIANTS = [
  ["cur", []],
  ["nocut", [{ file: F, find: "        od -= min(0.5 * odNear, odCut / CLOUD_EXTINCTION);\n", replace: "" }]],
  ["noguard", [{ file: F, find: "for (int i = 0; i < 448 + uLoopGuard; i++) {", replace: "for (int i = 0; i < 448; i++) {" }]],
];
