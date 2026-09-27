// C09 变体：给 handoff/C09-rim.mjs --vfile 用（VARIANTS = { 名字: { march: [[查找, 替换], ...] } }）
// 页面上跑的是本分支（new）；old 是改回 master 的受光段（见 C09-ab.mjs），A / B 两种候选都是在 old 上改的，C 是交付的写法
import { VARIANTS as AB } from "./C09-ab.mjs";

const OLD = AB.old.march;
// old 里的单次散射一行（替换后的文本）
const OLD_SS = OLD[0][1];
const LS0 = "float lsL = 0.06;";
const GROW = "lsL *= 1.9;";
const DET = "lod + 0.5, j < 3) * lsL;";
const PEAK = "0.6 * hg(cosT, 0.9) * exp(-0.25 * od)";
const BODY = "mix(hg(cosT, -0.25), hg(cosT, 0.8), 0.7) * exp(-od)";
const onOld = (expr) => [[OLD[0][0], `      float sunScatter = ${expr};`], ...OLD.slice(1)];
const SHORT3 = [[LS0, "float lsL = 0.02;"], [GROW, "lsL *= 2.47;"]];
const SHORT30 = [[LS0, "float lsL = 0.03;"], [GROW, "lsL *= 2.2;"]];

export const VARIANTS = {
  old: { march: OLD },
  // C + B''（交付）：前向峰按路上再散射次数展宽（f = 0.75）+ 受光步进 30 m ×2.2
  new: { march: [] },
  // C 单独（受光步进改回 60 m ×1.9）
  broad: { march: AB.broadOnly.march },
  // A：前向峰旁加一个宽瓣（g 0.6；Jendersie & d'Eon 2023 对云滴 Mie 的 HG + Draine 拟合里宽的那一瓣 g ≈ 0.6、权重约一半），只按单次散射全消光
  wide5: { march: onOld(`${PEAK} + 0.5 * hg(cosT, 0.6) * exp(-od) + ${BODY}`) },
  wide10: { march: onOld(`${PEAK} + 1.0 * hg(cosT, 0.6) * exp(-od) + ${BODY}`) },
  // A'：宽瓣也按前向峰的打折消光（穿透得深，光晕更大）
  wide5q: { march: onOld(`${PEAK} + 0.5 * hg(cosT, 0.6) * exp(-0.25 * od) + ${BODY}`) },
  // A''：前向峰一半能量挪到全消光的宽瓣（总权重不变）
  split: { march: onOld(`0.3 * hg(cosT, 0.9) * exp(-0.25 * od) + 0.3 * hg(cosT, 0.6) * exp(-od) + ${BODY}`) },
  // B：受光步进第一步缩短：20 m 起步、每步 ×2.47，6 步总长与原来（60 m × 1.9^k，3.07 km）相同；细节仍只在前 3 步（0.19 km 以内）
  short3: { march: [...OLD, ...SHORT3] },
  // B'：同上，细节放到前 4 步（0.49 km，与原来前 3 步的 0.39 km 相当）
  short4: { march: [...OLD, ...SHORT3, [DET, "lod + 0.5, j < 4) * lsL;"]] },
  // B''：30 m 起步、×2.2（总长 2.9 km）
  short30: { march: [...OLD, ...SHORT30] },
  // C'：f = 0.5（「约一半是衍射峰」，余量按 e^(−0.5·od)）
  new5: { march: [...AB.broadOnly.march, ["float pk = 0.75 * od;", "float pk = 0.5 * od;"], ["max(exp(-0.25 * od) - pkSum", "max(exp(-0.5 * od) - pkSum"]] },
  // 诊断：前向峰全消光 / 去掉前向峰（在 old 上）
  dPeakFull: { march: onOld(`0.6 * hg(cosT, 0.9) * exp(-od) + ${BODY}`) },
  dNoPeak: { march: onOld(`${BODY}`) },
};
void OLD_SS;
