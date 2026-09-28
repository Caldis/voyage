// SPEC-RAYS：飞行中 ΔL 本身的时间稳定性（shots --pair 的 js，v = window.__voyage）。
// 解冻、每个 rAF 后读回模糊后的 ΔL（rays.blurred）中间一块，算时间二阶差分 |x_t − (x_{t−1}+x_{t+1})/2| 相对均值的大小。
// 只看 ΔL 自己（不含海浪、耀斑这些本来就在变的背景），回答「光条本身闪不闪」
for (let i = 0; i < 300 && v.rays.state !== "ready"; i++) await new Promise((r) => setTimeout(r, 100));
v.freeze(false);
const t = v.rays.blurred, R = v.clouds.pass.renderer;
const w = Math.min(160, t.width), h = Math.min(120, t.height);
const x0 = ((t.width - w) / 2) | 0, y0 = ((t.height - h) / 2) | 0;
const buf = new Uint16Array(w * h * 4);
const h2f = (u) => { const e = (u >> 10) & 31, m = u & 1023, s = u >> 15 ? -1 : 1; return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15); };
const frames = [];
for (let f = 0; f < 150; f++) {
  await new Promise((r) => requestAnimationFrame(r));
  R.readRenderTargetPixels(t, x0, y0, w, h, buf);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = h2f(buf[i * 4]) * 0.2126 + h2f(buf[i * 4 + 1]) * 0.7152 + h2f(buf[i * 4 + 2]) * 0.0722;
  frames.push(lum);
}
let sum = 0, d2 = 0, n = 0, over = 0, drift = 0;
for (let f = 1; f < frames.length - 1; f++) for (let i = 0; i < w * h; i++) {
  const a = frames[f - 1][i], b = frames[f][i], c = frames[f + 1][i];
  const d = Math.abs(b - (a + c) / 2);
  sum += b; d2 += d; n++; drift += Math.abs(c - a) / 2;
  if (b > 0 && d / b > 0.02) over++;
}
const mean = sum / n;
return JSON.stringify({ active: v.rays.active, meanDL: mean, rel2nd: d2 / n / mean, relDrift: drift / n / mean, over2pct: over / n });
