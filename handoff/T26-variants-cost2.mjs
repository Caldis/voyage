// T26 帧时间归因（typhoon-outer）：同一页面交替测，配合 --bench
export const VARIANTS = [
  ["cur", []],
  ["noCells", [["int cellHi = 1 + min(uStormCount, 0);", "int cellHi = -2 + min(uStormCount, 0);"]]],
  ["bandOnly", [["if ((band > 0.01 || cb > 0.45) && alt < topHere) {", "if (band > 0.01 && alt < topHere) {"]]],
  ["noAnvil", [["      if (Ht > 10.0) {\n        vec2 nAx", "      if (false) {\n        vec2 nAx"]]],
  ["noLightTower", [["vec3 bc = gHurCell;", "vec3 bc = vec3(0.0);"]]],
  ["cur2", []],
];
