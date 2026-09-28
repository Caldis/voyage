// C10c 第五轮：od 版在 sunset-wing（太阳很低、积云）0–20 km 过亮（1.11，C10b 0.92）。试几种收敛办法
const CUT = "        odCut = min(0.4 * stepLen * kv, 2.0) * smoothstep(1.0, 3.0, sigL);\n";
const SUB = "        od -= min(odNear, odCut / CLOUD_EXTINCTION);\n";
const cut = (s) => [[CUT, s]];
export const VARIANTS = {
  cur: [],
  c10b: [[CUT, ""]],
  // 最多减掉近处一段的一半
  half: [[SUB, "        od -= min(0.5 * odNear, odCut / CLOUD_EXTINCTION);\n"]],
  // 逆光（看向太阳）时不减：前向峰对 od 极敏感
  back: cut("        odCut = min(0.4 * stepLen * kv, 2.0) * smoothstep(1.0, 3.0, sigL) * (1.0 - smoothstep(0.0, 0.6, cosT));\n"),
  // 太阳贴地平线时不减（sinθ光 < 0.1 起渐隐）
  lowsun: cut("        odCut = min(0.4 * stepLen * kv, 2.0) * smoothstep(1.0, 3.0, sigL) * smoothstep(0.08, 0.25, dot(uKeyDir, upP));\n"),
  c15: cut("        odCut = min(0.4 * stepLen * kv, 1.5) * smoothstep(1.0, 3.0, sigL);\n"),
  f35: [[SUB, "        od -= min(0.35 * odNear, odCut / CLOUD_EXTINCTION);\n"]],
  f65: [[SUB, "        od -= min(0.65 * odNear, odCut / CLOUD_EXTINCTION);\n"]],
  f5c3: [[SUB, "        od -= min(0.5 * odNear, odCut / CLOUD_EXTINCTION);\n"], [CUT, CUT.replace("2.0)", "3.0)")]],
  c1: cut("        odCut = min(0.4 * stepLen * kv, 1.0) * smoothstep(1.0, 3.0, sigL);\n"),
};
