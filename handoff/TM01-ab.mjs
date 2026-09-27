// TM01 同页 A/B 变体（给 TM01-measure.mjs 的 --vfile），对应定稿代码的 uniform
//   old   = C01 之前的云受光段 + 关 C02 锚定（C01 报告里 int_c 倍数的分母，只在 avg 模式可用）
//   base  = 改前（master）：高光段关（uDayHiLook.w = 1）、锚定硬 max（uDayEvSoft = 0）
//   soft  = 只有锚定软拐角；hi = 只有高光段；final = 定稿（全部默认值）
// 三种方案（Punchy / PBR Neutral / 高光段各参数）的实验变体在检查点提交 2f6d09a 的本文件与 exposure.ts 里（uTmMode 切换），
// 定稿删掉了实验 uniform，那些变体不能对定稿代码跑
import { OLD_MS, NEW_MS } from "./C01-ab.mjs";
const HI = [0.5, 2.5, 4.0, 1.4];
const OFF = { uDayHiLook: [0.5, 2.5, 4.0, 1.0], uDayEvSoft: 0 };
export const VARIANTS = {
  old: { march: [[NEW_MS, OLD_MS]], exp: { ...OFF, uDayEvAnchor: [15, 0] } },
  base: { exp: OFF },
  soft: { exp: { ...OFF, uDayEvSoft: 1 } },
  hi: { exp: { ...OFF, uDayHiLook: HI } },
  final: { exp: {} },
};
