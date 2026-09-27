// T44：拱洞——光照组逐项
export const VARIANTS = [
  { name: "base" },
  { name: "noCanLight", js: `window.__t45.replaceMarch([["if (gStormSoft > 1.5) {", "if (false) {"]])` },
  { name: "oldAlb", js: `window.__t45.replaceMarch([["if (nearHur) albB = mix(", "if (false) albB = mix("]])` },
  { name: "noTremap", js: `window.__t45.replaceMarch([["T = max(T - 0.005, 0.0) / 0.995;", ""]])` },
];
