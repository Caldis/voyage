// C10c 原型变体（给 handoff/C10-ab.mjs / C10b-time.mjs 的 --vfile）：页面跑的是 master（C10b），各变体对云步进片段做文本替换。
//   cur / cur2 = master（C10b）；old = C10（进云二分 + 空白 2dt + 上限 192，取自 C10b-var2）；ref = 细步真值（步长 1/4、上限 3000）；dist = 深度图
//   sK（K = 35 / 50 / 65 / 100）：从空白进云的那一步，受光步进的起点沿视线往回挪 K% 个步长（零额外密度调用）。
//     道理：进云样本在表面以下的深度 D 在 [0, L] 里均匀（L = 这一步的区间长），而浓云的像素亮度几乎只由表面以下 1/σ（十几米）
//     的那层决定；受光随深度是凸的下降（Jensen），D 均匀时期望偏暗。往回挪 δ = K·L，受光按 max(D − δ, 0) 的深度估计。
//   opK：挪的比例再乘这一步的不透明度 1 − e^(−σL)（薄 / 软的步本来就该按整个区间平均，不挪）。
import { VARIANTS as V } from "./C10b-var2.mjs";

const HIT = "    if (dens > 0.002) {\n      wasEmpty = false;\n";
const LIGHT = [
  ["od += layerDensity(p + uKeyDir * (lt - 0.5 * lsL)", "od += layerDensity(pL + uKeyDir * (lt - 0.5 * lsL)"],
  ["od += cloudDensityLite(p + uKeyDir * (lt - 0.5 * ls)", "od += cloudDensityLite(pL + uKeyDir * (lt - 0.5 * ls)", true],
];
const shift = (expr) => [[HIT, `    if (dens > 0.002) {\n      vec3 pL = (wasEmpty && i > 0) ? p - rd * ((${expr}) * stepLen) : p;\n      wasEmpty = false;\n`], ...LIGHT];

export const VARIANTS = {
  cur: [], cur2: [],
  old: V.old, ref: V.ref, dist: V.dist,
  s35: shift("0.35"), s50: shift("0.5"), s65: shift("0.65"), s100: shift("1.0"),
  op50: shift("0.5 * (1.0 - exp(-dens * CLOUD_EXTINCTION * stepLen))"),
  op75: shift("0.75 * (1.0 - exp(-dens * CLOUD_EXTINCTION * stepLen))"),
};
VARIANTS.s50b = VARIANTS.s50;
// aK：除受光步进外，天空光的高度归一（h01）与 keyLight 的高度也按挪过的点算（整份受光 S 在 pL 处求值）
const ALL = ["      float r = length(p);\n      vec3 up = p / r;\n", "      float r = length(pL);\n      vec3 up = pL / r;\n"];
for (const k of ["35", "50", "65"]) VARIANTS["a" + k] = [...shift("0." + k), ALL];
VARIANTS.aop75 = [...VARIANTS.op75, ALL];
// phK：一阶模型定挪多少。浓云里真实的受光深度按 σ·e^(−σx) 加权，期望约 1/σ；估计量的受光深度是 max(D − δ, 0)、D ~ U[0, L]，
// 期望 (L − δ)² / (2L)。两者相等 → δ/L = 1 − √(2 / (σL))（σL ≤ 2 时 0：薄 / 软的步不挪，C10b 的云边与薄丝原样保留）。上限 K
const ph = (cap) => shift(`clamp(1.0 - sqrt(2.0 / max(dens * CLOUD_EXTINCTION * stepLen, 1e-3)), 0.0, ${cap})`);
VARIANTS.ph = ph("1.0");
VARIANTS.ph65 = ph("0.65");
VARIANTS.ph50 = ph("0.5");
VARIANTS.aph = [...VARIANTS.ph, ALL];
// p1 结论（sea-sc-low）：往回挪会把受光起点挪到云外，太阳低时那里的受光路径贴着云顶平着走、几乎不被挡 → 亮一倍多。
// 挪受光点必须保证还在云里，只能靠密度判断 → prN：进云（且这一步光学厚度 > PROBE_OD）时先不累积，
// 在「上一个空白样本 ≈ tS − L」与 tS 之间二分 N 次（同一个 cloudDensity 调用点，循环多走 N 步），受光点取最浅的有云点；
// σ、区间、不透明度仍按命中样本（C10b 的云边 / 薄丝不动，也没有 C10 二分「丢掉粗样本权重」的偏差）
const probe = (n, odMin) => [
  ["  bool wasEmpty = true;\n#ifdef CLOUD_WEATHER\n  bool refineOn", "  bool wasEmpty = true;\n  int probe = 0; float bLo = 0.0; float bHi = 0.0; float hitDens = 0.0;\n#ifdef CLOUD_WEATHER\n  bool refineOn"],
  ["    float tS = t + stepLen * jitter;\n", "    float tS = probe > 0 ? 0.5 * (bLo + bHi) : t + stepLen * jitter;\n"],
  [HIT, `#ifndef CLOUD_WEATHER
    if (probe == 0 && dens > 0.002 && wasEmpty && i > 0 && dens * CLOUD_EXTINCTION * stepLen > ${odMin}) {
      probe = ${n}; bHi = tS; bLo = tS - stepLen; hitDens = dens;
      continue;
    }
    if (probe > 0) {
      if (dens > 0.002) bHi = tS; else bLo = tS;
      probe--;
      if (probe > 0) continue;
      p = ro + rd * bHi;
      dens = hitDens;
    }
#endif
` + HIT],
];
VARIANTS.pr1 = probe(1, "1.0");
VARIANTS.pr2 = probe(2, "1.0");
VARIANTS.pr3 = probe(3, "1.0");
VARIANTS.pr2t0 = probe(2, "0.0");
// p2 结论（sea-sc-low）：「有云」按 dens > 0.002 判，二分找到的常是表皮最外面那层极稀的絮（σ 不到 1 /km），
// 在那里算受光等于没进云，太阳低时又亮一倍。改成按命中样本密度的一个比例判「够浓」：dens > F·hitDens
const probeF = (n, f) => VARIANTS[`pr${n}`].map(([a, b, o]) => [a, b.replace("if (dens > 0.002) bHi = tS; else bLo = tS;", `if (dens > ${f} * hitDens) bHi = tS; else bLo = tS;`), o]);
for (const n of [1, 2]) for (const f of ["0.3", "0.6", "0.9"]) VARIANTS[`pr${n}f${f.slice(2)}`] = probeF(n, f);
VARIANTS.prnever = probe(1, "1e9"); // 探测代码在、但永不触发：量结构本身的开销
// gpu1 结论：pr1f3 画质好（低太阳也不过亮）但 GPU +10–13%（多出的那一步让同一 warp 里受光块分散到更多迭代）。
// lfK_F（零额外密度调用）：受光起点先挪 K·L（同 sK），但用受光步进自己的第一个样本（起点朝太阳 15 m，带细节）验一下：
// 那里的密度 < F·命中密度 → 起点落在表皮外 / 最外层稀絮 → 退回命中点（这一段的 od 用命中点密度补上，等于原做法）
const LF_OLD = `        float lsL = 0.03;
        for (int j = 0; j < 6; j++) {
          lt += lsL;
          od += layerDensity(p + uKeyDir * (lt - 0.5 * lsL), lod + 0.5, j < 3) * lsL;
          lsL *= 2.2;
        }
`;
const lf = (k, f) => [
  [HIT, `    if (dens > 0.002) {\n      bool shifted = wasEmpty && i > 0;\n      vec3 pL = shifted ? p - rd * (${k} * stepLen) : p;\n      wasEmpty = false;\n`],
  [LF_OLD, `        float lsL = 0.03;
        for (int j = 0; j < 6; j++) {
          lt += lsL;
          float dl = layerDensity(pL + uKeyDir * (lt - 0.5 * lsL), lod + 0.5, j < 3);
          if (j == 0 && shifted && dl < ${f} * dens) { pL = p; dl = dens; }
          od += dl * lsL;
          lsL *= 2.2;
        }
`],
];
for (const k of ["0.5", "0.65"]) for (const f of ["0.3", "0.6"]) VARIANTS[`lf${k.slice(2)}_${f.slice(2)}`] = lf(k, f);
// p4 结论：lf 的「朝太阳 15 m 处」验得太严（浅处本来就在密度爬升段），正午也大半退回，收益只剩一小半。
// pvF：同 pr1fF 的探测位置与判据（tS − L/2 处密度 > F·命中密度 → 受光点挪到那里），但探测放在受光那一步里做
// （受光步进之前多一次 layerDensity，同一次迭代，不多走一步、不打乱 warp 里受光块的迭代分布）。代价：多一个 layerDensity 调用点
const pv = (f, k = "0.5") => [
  [HIT, `    if (dens > 0.002) {\n      vec3 pL = p;\n      if (wasEmpty && i > 0 && dens * CLOUD_EXTINCTION * stepLen > 1.0) {\n        vec3 q = p - rd * (${k} * stepLen);\n        if (layerDensity(q, lod, t < 150.0) > ${f} * dens) pL = q;\n      }\n      wasEmpty = false;\n`],
  ...LIGHT,
];
VARIANTS.pv3 = pv("0.3");
VARIANTS.pv2 = pv("0.2");
VARIANTS.pv4 = pv("0.4");
// gpu2 结论：pv3 +2.6~10%（sea-sc 每个像素都进一次浓云，最贵），pr1f3 +10~14%，prnever（pr 的代码在但不触发）就 +4~9%。
// 压探测本身的价钱：n = 探测不取细节（均值侵蚀）；l = 探测的 mip 按受光步进（lod + 0.5）；g = 60–90 km 渐隐、90 km 外不探
const pvx = (f, { detail = "t < 150.0", lodE = "lod", gate = false } = {}) => [
  [HIT, `    if (dens > 0.002) {\n      vec3 pL = p;\n      if (wasEmpty && i > 0 && dens * CLOUD_EXTINCTION * stepLen > 1.0${gate ? " && t < 90.0" : ""}) {\n        vec3 q = p - rd * (0.5 * stepLen${gate ? " * (1.0 - smoothstep(60.0, 90.0, t))" : ""});\n        if (layerDensity(q, ${lodE}, ${detail}) > ${f} * dens) pL = q;\n      }\n      wasEmpty = false;\n`],
  ...LIGHT,
];
VARIANTS.pv3n = pvx("0.3", { detail: "false" });
VARIANTS.pv3l = pvx("0.3", { lodE: "lod + 0.5" });
VARIANTS.pv3g = pvx("0.3", { gate: true });
