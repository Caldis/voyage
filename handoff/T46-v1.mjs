// T46：无月夜云与海面的绝对亮度（读回云缓冲 RGBA 与窗外 HDR）
const pts = [[750, 635], [800, 660], [700, 700], [950, 590], [1000, 560]];
const rd = `(() => { const v = window.__voyage; const r = v.clouds.pass.renderer; const t = v.hdrOutside; const o = {};
  for (const [x, y] of ${JSON.stringify(pts)}) {
    const b = new Float32Array(4); r.readRenderTargetPixels(t, Math.round(x / innerWidth * t.width), Math.round((1 - y / innerHeight) * t.height), 1, 1, b);
    o[x + "," + y] = { cloud: window.__t45.readCloud(x, y).map((q) => +q.toPrecision(3)), out: Array.from(b.slice(0, 3), (q) => +q.toPrecision(3)) };
  } return o; })()`;
export const VARIANTS = [
  { name: "base", read: rd },
  { name: "x10", js: `window.__t45.replaceMarch([["(1.3e-6 * 0.8 / M_PI)", "(1.3e-5 * 0.8 / M_PI)"]])`, read: rd },
];
