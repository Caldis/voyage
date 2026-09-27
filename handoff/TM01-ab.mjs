// TM01 同页 A/B 变体（给 TM01-measure.mjs 的 --vfile）
//   old  = C01 之前的云受光段 + 关 C02 锚定（C01 报告里 int_c 倍数的分母，只在 avg 模式可用）
//   base = master（TM01 全关：高光段强度 0、锚定硬 max）
//   其余 = 各方案；参数就是曝光合成的 uniform（见 src/render/exposure.ts）
import { OLD_MS, NEW_MS } from "./C01-ab.mjs";
const OFF = { uDayHiLook: [1.25, 3.5, 1.4, 0], uTmMode: 0, uTmAux: 0, uTmRoll: 0, uTmRollEnd: 6.5, uTmRollMax: 0, uTmSat: [0.2, 0.5, 0], uDayEvSoft: [0.001, 0] };
const hi = (k, t, s) => ({ ...OFF, uDayHiLook: [k, t, s, 1] });
export const VARIANTS = {
  old: { march: [[NEW_MS, OLD_MS]], exp: { ...OFF, uDayEvAnchor: [15, 0] } },
  base: { exp: OFF },
  // ① AgX + Punchy（Blender：power 1.35、sat 1.4）；_eq：加预增益，让云的亮度与 base 相当再比对比
  punchy: { exp: { ...OFF, uTmMode: 1, uDayHiLook: [0, 0, 1, 1] } },
  punchyEq: { exp: { ...OFF, uTmMode: 1, uTmAux: 0.6, uDayHiLook: [0, 0, 1, 1] } },
  punchyS1: { exp: { ...OFF, uTmMode: 1, uTmAux: 0.6, uTmPunchy: [1.35, 1.0], uDayHiLook: [0, 0, 1, 1] } },
  // ② Khronos PBR Neutral；_eq：预增益压回 AgX 的亮度水平
  neutral: { exp: { ...OFF, uTmMode: 2, uDayHiLook: [0, 0, 1, 1] } },
  neutralEq: { exp: { ...OFF, uTmMode: 2, uTmAux: -0.5, uDayHiLook: [0, 0, 1, 1] } },
  // ③ AgX 之前的高光段斜率
  hi14: { exp: hi(1.25, 3.5, 1.4) },
  hi13: { exp: hi(1.25, 3.5, 1.3) },
  hi15: { exp: hi(1.5, 3.5, 1.5) },
  hi14k1: { exp: hi(1.0, 3.25, 1.4) },
  // 第 2 轮：膝点压低到云芯（clouds-variety 云芯显示 168 ≈ 中灰 +1.25 档），配锚定的有限自适应
  hiA: { exp: hi(0.5, 3.25, 1.4) },
  hiB: { exp: hi(0.75, 3.5, 1.4) },
  hiC: { exp: hi(0.5, 3.25, 1.3) },
  soft: { exp: { ...OFF, uDayEvSoft: [0.5, 0.3] } },
  hiD: { exp: { ...hi(0.5, 3.25, 1.4), uDayEvSoft: [0.5, 0.3] } },
  hiE: { exp: { ...hi(0.25, 3.0, 1.5), uDayEvSoft: [0.5, 0.3] } },
  // 第 3 轮：顶点以上收回到 AgX 白点（不让太阳 / 耀斑附近整体抬 1 档），锚定软过渡（宽 0.5 档、不留自适应，舱内不变）
  softOnly: { exp: { ...OFF, uDayEvSoft: [0.5, 0] } },
  cand: { exp: { ...hi(0.5, 3.25, 1.4), uTmRoll: 1, uDayEvSoft: [0.5, 0] } },
  candC: { exp: { ...hi(0.5, 3.25, 1.3), uTmRoll: 1, uDayEvSoft: [0.5, 0] } },
  // 第 4 轮：sunset-wing 的橙色受光云边被推过 250（1.1% → 4.3%）→ 收回段提前结束、按最大通道定位
  r5: { exp: { ...hi(0.5, 3.0, 1.4), uTmRoll: 1, uTmRollEnd: 5.0, uDayEvSoft: [0.5, 0] } },
  r5m: { exp: { ...hi(0.5, 3.0, 1.4), uTmRoll: 1, uTmRollEnd: 5.0, uTmRollMax: 1, uDayEvSoft: [0.5, 0] } },
  r45m: { exp: { ...hi(0.5, 2.75, 1.4), uTmRoll: 1, uTmRollEnd: 4.5, uTmRollMax: 1, uDayEvSoft: [0.5, 0] } },
  r5m15: { exp: { ...hi(0.5, 3.0, 1.5), uTmRoll: 1, uTmRollEnd: 5.0, uTmRollMax: 1, uDayEvSoft: [0.5, 0] } },
  // 第 5 轮：r45m 仍让 sunset-wing 611 个 249 的橙色像素变成 250 → 收回再提前 / 按饱和度淡出（白云饱和度低，夕照云边高）
  r425m: { exp: { ...hi(0.5, 2.75, 1.4), uTmRoll: 1, uTmRollEnd: 4.25, uTmRollMax: 1, uDayEvSoft: [0.5, 0] } },
  r4m: { exp: { ...hi(0.5, 2.5, 1.4), uTmRoll: 1, uTmRollEnd: 4.0, uTmRollMax: 1, uDayEvSoft: [0.5, 0] } },
  r45ms: { exp: { ...hi(0.5, 2.75, 1.4), uTmRoll: 1, uTmRollEnd: 4.5, uTmRollMax: 1, uTmSat: [0.2, 0.45, 1], uDayEvSoft: [0.5, 0] } },
  r5ms: { exp: { ...hi(0.5, 3.0, 1.4), uTmRoll: 1, uTmRollEnd: 5.0, uTmRollMax: 1, uTmSat: [0.15, 0.35, 1], uDayEvSoft: [0.5, 0] } },
};
