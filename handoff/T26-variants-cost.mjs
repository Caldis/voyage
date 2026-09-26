// T26 帧时间归因：逐项关掉新加的东西（同一页面交替测，配合 --bench）
export const VARIANTS = [
  ["cur", []],
  ["noLong", [["if (abs(t - hurVisT) > 2.0) {", "if (false) {"]]],
  ["noCells", [["int cellHi = 1 + min(uStormCount, 0);", "int cellHi = -2 + min(uStormCount, 0);"]]],
  ["noLightTower", [["vec3 bc = gHurCell;", "vec3 bc = vec3(0.0);"]]],
  ["noOpp", [["float opp = smoothstep(-0.2, 0.6, away)", "float opp = 0.0 * smoothstep(-0.2, 0.6, away)"]]],
  ["noSkirtCells", [["if ((band > 0.01 || cb > 0.3) && alt < topHere) {", "if (false) {"]]],
  ["cur2", []],
];
