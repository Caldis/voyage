// C09 变体：给 handoff/C09-rim.mjs --vfile 用（VARIANTS = { 名字: { march: [[查找, 替换], ...] } }）
// 查找文本对应 src/clouds/clouds.ts 的受光段（单次散射一行、普通云受光步进的起步与步长增长）
const SS = "float sunScatter = 0.6 * hg(cosT, 0.9) * exp(-0.25 * od) + mix(hg(cosT, -0.25), hg(cosT, 0.8), 0.7) * exp(-od);";
const LS0 = "float ls = 0.06;";
const GROW = "ls *= 1.9;";
const DET = "lod + 0.5, j < 3) * ls;";
const ss = (expr) => [SS, `float sunScatter = ${expr};`];
const PEAK = "0.6 * hg(cosT, 0.9) * exp(-0.25 * od)";
const BODY = "mix(hg(cosT, -0.25), hg(cosT, 0.8), 0.7) * exp(-od)";

export const VARIANTS = {
  base: { march: [] },
  // A：前向峰旁加一个宽瓣（g 0.6，Jendersie & d'Eon 2023 对云滴 Mie 的 HG + Draine 拟合里，宽的那一瓣 g ≈ 0.6、权重约一半），只按单次散射全消光
  wide5: { march: [ss(`${PEAK} + 0.5 * hg(cosT, 0.6) * exp(-od) + ${BODY}`)] },
  wide10: { march: [ss(`${PEAK} + 1.0 * hg(cosT, 0.6) * exp(-od)+ ${BODY}`)] },
  // A'：宽瓣也按前向峰的打折消光（穿透得深，光晕更大）
  wide5q: { march: [ss(`${PEAK} + 0.5 * hg(cosT, 0.6) * exp(-0.25 * od) + ${BODY}`)] },
  // A''：把前向峰的一半能量挪到全消光的宽瓣（总权重不变，光晕变小、边更集中）
  split: { march: [ss(`0.3 * hg(cosT, 0.9) * exp(-0.25 * od) + 0.3 * hg(cosT, 0.6) * exp(-od) + ${BODY}`)] },
  // C：前向峰按「路上被峰再散射了几次」展宽（HG 卷积 HG = HG(g1·g2)）：峰的散射率 f = 0.75（与 T12 的 exp(−0.25·od) 同一个 delta 缩放），
  //    路上峰散射 k 次的概率 Poisson(k; 0.75·od)·e^(−0.25·od)，角分布 HG(0.9^(k+1))；k = 0–2 显式写，k ≥ 3 的余量给 HG(0.9^4 ≈ 0.656)。
  //    总能量与原来的 0.6·hg(0.9)·e^(−0.25·od) 相同，只是深处的那份不再按 hg(0.9) 挤在太阳几度以内
  broad: { march: [ss(`0.6 * (exp(-od) * (hg(cosT, 0.9) + 0.75 * od * hg(cosT, 0.81) + 0.28125 * od * od * hg(cosT, 0.729)) + max(exp(-0.25 * od) - exp(-od) * (1.0 + 0.75 * od + 0.28125 * od * od), 0.0) * hg(cosT, 0.6561)) + ${BODY}`)] },
  // C'：同上，峰的散射率 f = 0.5（delta 缩放取「约一半是衍射峰」，余量按 e^(−0.5·od)）
  broad5: { march: [ss(`0.6 * (exp(-od) * (hg(cosT, 0.9) + 0.5 * od * hg(cosT, 0.81) + 0.125 * od * od * hg(cosT, 0.729)) + max(exp(-0.5 * od) - exp(-od) * (1.0 + 0.5 * od + 0.125 * od * od), 0.0) * hg(cosT, 0.6561)) + ${BODY}`)] },
  // 诊断：分项置 0，看芯里（离边 0.5–1.5°）的亮度是哪一项给的
  dNoPeak: { march: [ss(`${BODY}`)] },
  dNoBody: { march: [ss(`${PEAK}`)] },
  dNoMS: { march: [["sunScatter += CLOUD_MS_ALBEDO * msScatter", "sunScatter += 0.0 * msScatter"]] },
  dNoSun: { march: [["vec3 sunLight = keyLight(r, up) * sunScatter;", "vec3 sunLight = vec3(0.0);"]] },
  dOd2: { march: [["od *= CLOUD_EXTINCTION;", "od *= CLOUD_EXTINCTION * 2.0;"]] },
  dOd4: { march: [["od *= CLOUD_EXTINCTION;", "od *= CLOUD_EXTINCTION * 4.0;"]] },
  dPeakFull: { march: [ss(`0.6 * hg(cosT, 0.9) * exp(-od) + ${BODY}`)] },
  // 可视化：云缓冲里存「按不透明度加权的受光光学厚度 / 视线消光」，减去 dZero（只剩空气透视）再除以 α
  dOdVis: { march: [["vec3 S = sunLight + ambient;", "vec3 S = vec3(od);"]] },
  dSigVis: { march: [["vec3 S = sunLight + ambient;", "vec3 S = vec3(sigma);"]] },
  dZero: { march: [["vec3 S = sunLight + ambient;", "vec3 S = vec3(0.0);"]] },
  // B：受光步进第一步缩短：20 m 起步、每步 ×2.47，6 步总长与原来（60 m × 1.9^k，3.07 km）相同；细节仍只在前 3 步（0.19 km 以内）
  short3: { march: [[LS0, "float ls = 0.02;"], [GROW, "ls *= 2.47;"]] },
  // B'：同上，细节放到前 4 步（0.49 km，与原来前 3 步的 0.39 km 相当）
  short4: { march: [[LS0, "float ls = 0.02;"], [GROW, "ls *= 2.47;"], [DET, "lod + 0.5, j < 4) * ls;"]] },
  // B''：30 m 起步、×2.2（总长 2.9 km）
  short30: { march: [[LS0, "float ls = 0.03;"], [GROW, "ls *= 2.2;"]] },
};
