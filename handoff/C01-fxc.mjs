// shader-budget --variants：扩散尾巴（C01 返工）的离线 FXC 增量。prev = 去掉尾巴那一行（= 第一次交付的受光段）
const F = "src/clouds/clouds.ts";
export const VARIANTS = [
  ["cur", []],
  ["prev", [{ file: F, find: "      sunScatter += (tailK / (4.0 * M_PI)) * (1.0 / (1.0 + 0.1125 * od) - exp(-od));\n", replace: "" }]],
];
