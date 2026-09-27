// TM02 同页 A/B 变体（给 TM01-measure.mjs 的 --vfile）。只拨曝光合成的 uniform，云不用重编，同一冻结姿态逐帧可比。
//   off    = 没有高光段（TM01 之前；215–235 段「≥ ×0.95」的分母）
//   master = TM01 定稿（全局曲线、斜率 1.3；局部关）
//   g14    = TM01 全局曲线斜率 1.4（本任务「云芯对比 ≥ 斜率 1.4 的水平」的参照）
//   final  = TM02 定稿（全部默认值）
//   其余是调参用的变体（细节斜率 sd、肩部补偿 κ、值域回落 σr）
const LOOK = (s) => [0.5, 2.5, 5.0, s];
const LOC = (sd, k, sr, on = 1) => [sd, k, sr, on];
export const VARIANTS = {
  off: { exp: { uDayHiLook: LOOK(1.0), uDayHiLocal: LOC(1.3, 0.4, 0.6, 0) } },
  master: { exp: { uDayHiLocal: LOC(1.3, 0.4, 0.6, 0) } },
  g14: { exp: { uDayHiLook: LOOK(1.4), uDayHiLocal: LOC(1.3, 0.4, 0.6, 0) } },
  final: { exp: {} },
  master2: { exp: { uDayHiLocal: LOC(1.3, 0.4, 0.6, 0) } }, // 与 master 相同：两次累积之间的噪声底
  top0: { exp: { uDayHiLocalTop: 0.001 } },
  top05: { exp: { uDayHiLocalTop: 0.5 } },
  top15: { exp: { uDayHiLocalTop: 1.5 } },
  top2: { exp: { uDayHiLocalTop: 2.0 } },
  r45: { exp: { uDayHiLocal: LOC(1.4, 0.4, 0.45) } },
  k0: { exp: { uDayHiLocal: LOC(1.3, 0.0, 0.6) } },
  k2: { exp: { uDayHiLocal: LOC(1.3, 0.2, 0.6) } },
  k6: { exp: { uDayHiLocal: LOC(1.3, 0.6, 0.6) } },
  sd14: { exp: { uDayHiLocal: LOC(1.4, 0.4, 0.6) } },
  sd14r45: { exp: { uDayHiLocal: LOC(1.4, 0.4, 0.45) } },
  sd135r5: { exp: { uDayHiLocal: LOC(1.35, 0.4, 0.5) } },
  sd15: { exp: { uDayHiLocal: LOC(1.5, 0.4, 0.6) } },
  sr03: { exp: { uDayHiLocal: LOC(1.3, 0.4, 0.3) } },
  sr10: { exp: { uDayHiLocal: LOC(1.3, 0.4, 1.0) } },
  sr100: { exp: { uDayHiLocal: LOC(1.3, 0.4, 100.0) } }, // 不做值域回落（纯低通，看光晕有多大）
  // 机翼遮挡（wave7 第 1 条）：tm01bug = 合并时的 TM01（不看机翼）；noOcc = TM02 不看机翼
  tm01bug: { exp: { uDayHiLocal: LOC(1.3, 0.4, 0.6, 0), uWingOcc: [1e9, 2e9] } },
  noOcc: { exp: { uWingOcc: [1e9, 2e9] } },
  // 台风卷云盖（wave7 第 5 条）：noAnchor = 关 C02 的 EV 锚定；offAll = 高光段与锚定都关
  noAnchor: { exp: { uDayEvAnchor: [15, 0] } },
  offAll: { exp: { uDayHiLook: LOOK(1.0), uDayHiLocal: LOC(1.3, 0.4, 0.6, 0), uDayEvAnchor: [15, 0] } },
  mask: { exp: { uDebugMask: true } }, // 窗外遮罩（TM02-halo.py 用它限定窗内）
  b14: { exp: { uDayHiLook: LOOK(1.4), uDayHiLocal: LOC(1.4, 0.4, 0.6) } },
};
