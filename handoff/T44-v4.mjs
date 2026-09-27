// T44：云的原始辐亮度与窗外适应亮度（判断「沙土色」是不是曝光把暖色的受光面压到了中间调）
const rd = (pts) => `(() => { const v = window.__voyage; const o = {}; for (const [x, y] of ${JSON.stringify(pts)}) o[x + "," + y] = window.__t45.readCloud(x, y).map((q) => +q.toPrecision(3));
  const t = v.exposure.adapted[0]; const b = new Float32Array(4 * t.width); v.clouds.pass.renderer.readRenderTargetPixels(t, 0, 0, t.width, 1, b); o.adaptedLog2 = Array.from(b.slice(0, 4), (q) => +q.toFixed(3)); return o; })()`;
export const FAIR = [{ name: "read", read: rd([[1060, 815], [900, 715], [1110, 780]]) }];
export const OUTER = [{ name: "read", read: rd([[1060, 700], [600, 720], [800, 300]]) }];
export const VARIANTS = process.env.T44_SET === "fair" ? FAIR : OUTER;
