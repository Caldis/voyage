// T45 定位第二轮：椭圆是雨幡（云底以下）被低太阳从侧面照亮 + 前向散射；受光步进的精简密度里没有雨幡（不自遮挡）？
const readPts = `(() => { const out = {}; for (const [x, y] of [[760, 507], [720, 725], [760, 720], [800, 715]]) out[x + "," + y] = window.__t45.readCloud(x, y).map((v) => +v.toPrecision(4)); return out; })()`;
const RAIN_LITE = [
  [
    "float R = c.z;\n  if (alt < STORM_BASE - 0.1 || alt > top + STORM_OVERSHOOT + 0.7) return 0.0;",
    "float R = c.z;\n  if (alt > top + STORM_OVERSHOOT + 0.7) return 0.0;\n  float rainL = alt < STORM_BASE + 0.1 ? rainDensity(xz, alt, c.xy, R, lod) : 0.0;\n  if (alt < STORM_BASE - 0.1) return rainL;",
  ],
  ["return max(smoothstep(0.0, 0.25, -sdf), anvilDensity(xz, alt, c.xy, R, top, lod, ao, geo));", "return max(max(smoothstep(0.0, 0.25, -sdf), anvilDensity(xz, alt, c.xy, R, top, lod, ao, geo)), rainL);"],
];
export const VARIANTS = [
  { name: "base", read: readPts, restore: false },
  { name: "norain", js: `window.__t45.replaceMarch([["float sigma = 1.8 * core", "float sigma = 0.0 * core"]])`, wait: 8000, read: readPts },
  { name: "rainlite", js: `window.__t45.replaceMarch(${JSON.stringify(RAIN_LITE)})`, wait: 8000, read: readPts },
];
