// T44：近处塔底的深色「拱洞」来自哪一项（第三轮）
const THICK = [
  "max(min(0.9 * exp(-(r - Re * 3.5) / (Re * 1.3)), 0.9) * mix(1.0, 0.4 + 0.9 * fibS, thin),\n                                       mix(0.0, 0.012 + 0.04 * fibS * fibS, thin))",
  "mix(0.9, 0.3 * fibS, thin)",
];
export const VARIANTS = [
  { name: "base" },
  { name: "thick", js: `window.__t45.replaceMarch(${JSON.stringify([THICK])})` },
  { name: "oldAnvil", js: `window.__t45.replaceMarch([["/ mix(0.45, 0.8, smoothstep(-0.3 * La, La, al)));", "/ 0.7);"], ["al / (al > 0.0 ? 1.0 : 0.4)", "al / (al > 0.0 ? 1.0 : 0.55)"]])` },
  { name: "noCB", js: `window.__t45.replaceMarch([["canopyBase += 1.2 * (nCb.r - 0.5) + 0.8 * hurCap(nCb.g) * smoothstep(Re * 3.5, Re * 6.0, r);", ""]])` },
];
