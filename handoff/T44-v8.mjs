// T44：近处塔底的深色「拱洞」来自哪一项（第二轮）
export const VARIANTS = [
  { name: "base" },
  { name: "oldCaster", js: `window.__t45.replaceMarch([["* mix(1.0, 0.06, smoothstep(Re * 3.5, Re * 7.0, r));", ";"]])` },
  { name: "oldFloor", js: `window.__t45.replaceMarch([["mix(mix(0.12, 0.5, eyeK), 1.0, vis)", "mix(0.12, 1.0, vis)"]])` },
  { name: "noCanLight", js: `window.__t45.replaceMarch([["if (gStormSoft > 1.5) {", "if (false) {"]])` },
  { name: "noTremap", js: `window.__t45.replaceMarch([["T = max(T - 0.005, 0.0) / 0.995;", ""]])` },
];
