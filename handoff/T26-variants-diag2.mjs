// T26 诊断二：读原始输出，分开云自身辐亮度（过透射后）与空气透视内散射
export const VARIANTS = [
  ["base", []],
  ["cloudOnly", [["L = L * apT + apL * (1.0 - T);", "L = L * apT;"]]],
  ["apOnly", [["L = L * apT + apL * (1.0 - T);", "L = apL * (1.0 - T);"]]],
  ["depth", [["L = L * apT + apL * (1.0 - T);", "L = vec3(depth, h01dbg, 0.0);"], ["float depthSum = 0.0;", "float depthSum = 0.0; float h01dbg = 0.0;"]]],
];
