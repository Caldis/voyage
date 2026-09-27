// T44 定位：卷云盖下方那条深色横带 + 右端斜直线是什么
export const VARIANTS = [
  { name: "base" },
  { name: "noanvil", js: `window.__t45.replaceMarch([["if (Ht > 9.5 && alt > 7.0) {", "if (false) {"]])` },
  { name: "nowall", js: `window.__t45.replaceMarch([["if (wall > d) { d = wall; wallW = 1.0; }", ""]])` },
  { name: "nocanopy", js: `window.__t45.replaceMarch([["if (canopy > d) { d = canopy;", "if (false) { d = canopy;"]])` },
];
