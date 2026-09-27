// TM01 同页 A/B 变体（给 TM01-measure.mjs 的 --vfile），对应定稿代码的 uniform
//   old   = C01 之前的云受光段 + 关 C02 锚定（C01 报告里 int_c 倍数的分母，只在 avg 模式可用）
//   base  = 改前（master）：高光段关（uDayHiLook.w = 1）、锚定硬 max（uDayEvSoft = 0）
//   soft  = 只有锚定软拐角；hi = 只有高光段；final = 定稿（全部默认值）
// 三种方案（Punchy / PBR Neutral / 高光段各参数）的实验变体在检查点提交 2f6d09a 的本文件与 exposure.ts 里（uTmMode 切换），
// 定稿删掉了实验 uniform，那些变体不能对定稿代码跑
import { OLD_MS, NEW_MS } from "./C01-ab.mjs";
const HI = [0.5, 2.5, 5.0, 1.4];
const OFF = { uDayHiLook: [0.5, 2.5, 5.0, 1.0], uDayEvSoft: 0 };
export const VARIANTS = {
  old: { march: [[NEW_MS, OLD_MS]], exp: { ...OFF, uDayEvAnchor: [15, 0] } },
  base: { exp: OFF },
  soft: { exp: { ...OFF, uDayEvSoft: 1 } },
  hi: { exp: { ...OFF, uDayHiLook: HI } },
  final: { exp: {} },
  // 返工对照：prev = 第一次交付（收回到 +4.0、整窗都给）；noCloud = 收回到 +5.0 但不看云
  prev: { exp: { uDayHiLook: [0.5, 2.5, 4.0, 1.4], uDayHiCloud: [0.05, 0.35, 0], uDayHiSatRoll: 0 } },
  // 斜率取舍：拉开云体与压扁最亮一段是同一件事的两面（见 handoff/TM01.md「返工」）
  s13: { exp: { uDayHiLook: [0.5, 2.5, 5.0, 1.3] } },
  s12: { exp: { uDayHiLook: [0.5, 2.5, 5.0, 1.2] } },
  noCloud: { exp: { uDayHiCloud: [0.05, 0.35, 0] } },
  // 顶点前移（离线模型：顶点越低，215–235 段被压得越少，云体拉开得也越少）
  t225: { exp: { uDayHiLook: [0.5, 2.25, 5.0, 1.4] } },
  t20: { exp: { uDayHiLook: [0.5, 2.0, 5.0, 1.4] } },
  t20s15: { exp: { uDayHiLook: [0.5, 2.0, 5.0, 1.5] } },
  // 收回终点再往后（太阳 / 天空已由云门控排除，只剩夕照云边的截白风险）
  r55: { exp: { uDayHiLook: [0.5, 2.5, 5.5, 1.4] } },
  r60: { exp: { uDayHiLook: [0.5, 2.5, 6.0, 1.4] } },
  r65: { exp: { uDayHiLook: [0.5, 2.5, 6.5, 1.4] } },
  // 收回段按饱和度前移（橙色云边提前收回）
  r5s1: { exp: { uDayHiLook: [0.5, 2.5, 5.0, 1.4], uDayHiSatRoll: 1.0 } },
  r5s2: { exp: { uDayHiLook: [0.5, 2.5, 5.0, 1.4], uDayHiSatRoll: 2.0 } },
  r55s2: { exp: { uDayHiLook: [0.5, 2.5, 5.5, 1.4], uDayHiSatRoll: 2.0 } },
  r5s03: { exp: { uDayHiLook: [0.5, 2.5, 5.0, 1.4], uDayHiSatRoll: 0.3 } },
  r5s05: { exp: { uDayHiLook: [0.5, 2.5, 5.0, 1.4], uDayHiSatRoll: 0.5 } },
  r6s3: { exp: { uDayHiLook: [0.5, 2.5, 6.0, 1.4], uDayHiSatRoll: 3.0 } },
};
