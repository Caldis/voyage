// T12 定位第二轮：银边——前向衍射峰（g≈0.9）的光按 delta 缩放只受约 1/4 的消光（Joseph 1976），只在朝太阳看时起作用
const rm = (pairs) => `window.__t45.replaceMarch(${JSON.stringify(pairs)})`;
const ss = "float sunScatter = 0.0;";
export const VARIANTS = [
  { name: "base" },
  { name: "fwdA", js: rm([[ss, "float sunScatter = 0.5 * hg(cosT, 0.9) * exp(-0.25 * od);"]]), wait: 8000 },
  { name: "fwdB", js: rm([[ss, "float sunScatter = 1.0 * hg(cosT, 0.85) * exp(-0.15 * od);"]]), wait: 8000 },
  { name: "fwdC", js: rm([[ss, "float sunScatter = 0.6 * hg(cosT, 0.9) * exp(-0.25 * od);"], ["mix(1.0, powder, 0.5)", "mix(1.0, powder, 0.5 * (1.0 - smoothstep(0.3, 0.9, cosT)))"]]), wait: 8000 },
];
