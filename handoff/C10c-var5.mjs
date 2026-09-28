// C10c 第四轮：交付候选在 sea-sc-low 远处（60 km 外）的阴影缝里撒亮点（单帧截图放大可见；空白步 2dt ≈ 1 km，
// 挪 δ 上百米就跳出邻云投下的影子）。试：按距离渐隐（f）、δ 设绝对上限（m）
const SH = "        p -= rd * (min(0.3 * stepLen, 4.0 / kv) * smoothstep(1.0, 3.0, sigL));\n";
const rep = (s) => [[SH, s]];
export const VARIANTS = {
  cur: [],
  c10b: [[SH, ""]],
  f4080: rep("        p -= rd * (min(0.3 * stepLen, 4.0 / kv) * smoothstep(1.0, 3.0, sigL) * (1.0 - smoothstep(40.0, 80.0, t)));\n"),
  f6090: rep("        p -= rd * (min(0.3 * stepLen, 4.0 / kv) * smoothstep(1.0, 3.0, sigL) * (1.0 - smoothstep(60.0, 90.0, t)));\n"),
  m60: rep("        p -= rd * (min(min(0.3 * stepLen, 4.0 / kv), 0.06) * smoothstep(1.0, 3.0, sigL));\n"),
  m100: rep("        p -= rd * (min(min(0.3 * stepLen, 4.0 / kv), 0.1) * smoothstep(1.0, 3.0, sigL));\n"),
};
// p10 结论：远处渐隐不解决——撒点在 30–60 km（sea-sc-low 暗处 30% 的像素亮到真值 ×1.27–1.46、对真值的逐像素对数离散 ×2）：
// 挪过的点跳出了**邻近云块**投下的影子（阴影缝），不只是自己云顶的深度变浅。
// ocK：不挪点，改在光学厚度上减——受光步进照常从命中点走，只从「前 K+1 步（离本点最近的一段，基本是本云自己的路径）」里
// 减去深度多出来的那份 κ·δ（上限就是这一段的 od）；远处几步（邻云投下的影子）原样保留
const OLD_LOOP = `        float lsL = 0.03;
        for (int j = 0; j < 6; j++) {
          lt += lsL;
          od += layerDensity(p + uKeyDir * (lt - 0.5 * lsL), lod + 0.5, j < 3) * lsL;
          lsL *= 2.2;
        }
`;
const oc = (k) => [
  [SH, "        odCut = min(0.3 * stepLen * kv, 4.0) * smoothstep(1.0, 3.0, sigL);\n"],
  ["#ifdef CLOUD_WEATHER\n      if (stormW < 0.5 && fine", "      float odCut = 0.0;\n#ifdef CLOUD_WEATHER\n      if (stormW < 0.5 && fine"],
  [OLD_LOOP, `        float lsL = 0.03;
        float odNear = 0.0;
        for (int j = 0; j < 6; j++) {
          lt += lsL;
          od += layerDensity(p + uKeyDir * (lt - 0.5 * lsL), lod + 0.5, j < 3) * lsL;
          if (j == ${k}) odNear = od;
          lsL *= 2.2;
        }
        od -= min(odNear, odCut / CLOUD_EXTINCTION);
`],
];
VARIANTS.oc1 = oc(1);
VARIANTS.oc2 = oc(2);
VARIANTS.oc3 = oc(3);
VARIANTS.oc5 = oc(5);
// p11：阴影缝对了（暗处 / 真值 0.95–1.0、离散比 C10b 还小），但太阳低时受光面过亮（0–20 km 1.15–1.18）：od 空间里重扫 A、C（K = 2）
const ocAC = (a, c) => oc(2).map(([f, r]) => [f, r.replace("min(0.3 * stepLen * kv, 4.0)", `min(${a} * stepLen * kv, ${c})`)]);
for (const [a, c] of [["0.4", "2.0"], ["0.5", "2.0"], ["0.4", "1.5"], ["0.5", "1.5"], ["0.5", "1.0"], ["0.6", "1.5"]]) VARIANTS[`oc_${a.slice(2)}_${c.replace(".", "")}`] = ocAC(a, c);
