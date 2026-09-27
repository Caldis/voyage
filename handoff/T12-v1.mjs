// T12 定位第一轮：逆光积云（sunset-wing）为什么没有银边。用法见 T45-probe.mjs
const rm = (pairs) => `window.__t45.replaceMarch(${JSON.stringify(pairs)})`;
export const VARIANTS = [
  { name: "base" },
  // 去掉 Beer-Powder（逆光时它把薄边压到 0.7 倍）
  { name: "nopowder", js: rm([["mix(1.0, powder, 0.5)", "1.0"]]), wait: 8000 },
  // 受光步进的光学厚度置 0：上限（薄边能亮到多少）
  { name: "od0", js: rm([["od *= CLOUD_EXTINCTION;", "od *= 0.0;"]]), wait: 8000 },
  // 前向峰更尖：加一个 g = 0.9 的波瓣
  { name: "sharp", js: rm([["float phase = mix(hg(cosT, -0.25 * c), hg(cosT, 0.8 * c), 0.7);", "float phase = mix(hg(cosT, -0.25 * c), mix(hg(cosT, 0.8 * c), hg(cosT, 0.93 * c), 0.35), 0.7);"]]), wait: 8000 },
];
