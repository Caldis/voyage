// T44 定位：远处（地平线附近）沙土色、平顶的云从哪来
const rd = `(() => { const o = {}; for (const [x, y] of [[1140, 570], [1080, 555], [700, 700]]) o[x + "," + y] = window.__t45.readCloud(x, y).map((v) => +v.toPrecision(4)); return o; })()`;
export const VARIANTS = [
  { name: "base", read: rd },
  { name: "noShadowAP", js: `window.__t45.replaceMarch([["if (nearHur && uSunDir.y > 0.02) {", "if (false) {"]])`, read: rd },
  { name: "nosun", js: `window.__t45.replaceMarch([["vec3 S = sunLight + ambient;", "vec3 S = ambient;"]])`, read: rd },
  { name: "noAP", js: `window.__t45.replaceMarch([["L = L * apT + apL * (1.0 - T);", "L = L;"]])`, read: rd },
];
