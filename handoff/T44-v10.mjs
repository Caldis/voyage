// T44：拱洞 / 塔身变光滑——成组回退
const BANDS = [
  ["float rb = Rt * mix(0.88 + 0.15 * h3.x, 1.0, smoothstep(0.05, 0.7, hh));", "float rb = Rt * mix(0.7 + 0.25 * h3.x, 1.0, smoothstep(0.05, 0.7, hh));"],
  ["/ mix(0.45, 0.8, smoothstep(-0.3 * La, La, al)));", "/ 0.7);"],
  ["al / (al > 0.0 ? 1.0 : 0.4)", "al / (al > 0.0 ? 1.0 : 0.55)"],
  ["bool isSkirt = !isAnvil && skirt > towerD;", "bool isSkirt = false;"],
];
const MAIN = [
  ["vec4 nO = textureLod(uShapeNoise, vec3(u * 11.0, alt / 18.0, 0.53), 3.0);", "vec4 nO = vec4(0.5, 0.2, 0.5, 0.5);"],
  ["* (1.0 - smoothstep(Re * 3.3, Re * 4.1, r + Re * 0.35 * (nT.a - 0.5)));", ";"],
  ["canopyBase += 1.2 * (nCb.r - 0.5) + 0.8 * hurCap(nCb.g) * smoothstep(Re * 3.5, Re * 6.0, r);", ""],
];
const LIGHT = [
  ["if (gStormSoft > 1.5) {", "if (false) {"],
  ["if (nearHur) albB = mix(", "if (false) albB = mix("],
  ["T = max(T - 0.005, 0.0) / 0.995;", ""],
];
export const VARIANTS = [
  { name: "base" },
  { name: "bands", js: `window.__t45.replaceMarch(${JSON.stringify(BANDS)})` },
  { name: "main", js: `window.__t45.replaceMarch(${JSON.stringify(MAIN)})` },
  { name: "light", js: `window.__t45.replaceMarch(${JSON.stringify(LIGHT)})` },
];
