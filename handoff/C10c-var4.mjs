// C10c 第三轮：交付候选（δ = min(0.4L, 4/κ)，κ = σ·sinθ视/sinθ光）在 cu-side（看积云侧壁）0–20 km 略过亮（1.02、逐像素误差 ×2）。
// 侧壁的法线不是 up，sinθ视 ≈ 0 → κ 很小 → 一律挪满 0.4L。试：sinθ视的下限抬高（平视时少挪）、A 降到 0.3
const KV = "        float kv = dens * CLOUD_EXTINCTION * max(-dot(rd, upP), 0.05) / max(dot(uKeyDir, upP), 0.05);\n";
const SH = "        pL = p - rd * min(0.4 * stepLen, 4.0 / kv);\n";
const fl = (x) => [KV, KV.replace("max(-dot(rd, upP), 0.05)", `max(-dot(rd, upP), ${x})`)];
export const VARIANTS = {
  cur: [], cur2: [],
  c10b: [[SH, "        pL = p;\n"]],
  f15: [fl("0.15")],
  f30: [fl("0.3")],
  a3: [[SH, SH.replace("0.4 * stepLen", "0.3 * stepLen")]],
  f15a3: [fl("0.15"), [SH, SH.replace("0.4 * stepLen", "0.3 * stepLen")]],
  // 薄 / 半透明的进云步本来就是整个区间的无偏估计（受光按区间均匀平均），不该挪：挪的量再乘这一步的不透明度
  a3op: [[SH, "        pL = p - rd * (min(0.3 * stepLen, 4.0 / kv) * (1.0 - exp(-dens * CLOUD_EXTINCTION * stepLen)));\n"]],
  a3ss: [[SH, "        pL = p - rd * (min(0.3 * stepLen, 4.0 / kv) * smoothstep(1.0, 3.0, dens * CLOUD_EXTINCTION * stepLen));\n"]],
  a4ss: [[SH, "        pL = p - rd * (min(0.4 * stepLen, 4.0 / kv) * smoothstep(1.0, 3.0, dens * CLOUD_EXTINCTION * stepLen));\n"]],
};
VARIANTS.a3b = VARIANTS.a3;
