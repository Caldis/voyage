// C10c 返工（审查 P1）对照：页面跑返工版 src
//   cur / cur2 = 返工版；nowfix = 8 步受光那支不减（= 返工前交付的 55eb1f0）；c10b = 两支都不减（= master 的 C10b）
const SUBW = "        od -= min(0.5 * odNearW, odCut / CLOUD_EXTINCTION);\n";
const CUT = "        odCut = min(0.4 * stepLen * kv, 3.0) * smoothstep(1.0, 3.0, sigL);\n";
export const VARIANTS = {
  cur: [], cur2: [],
  nowfix: [[SUBW, ""]],
  c10b: [[CUT, ""]],
};
