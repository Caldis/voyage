// G06：纹素 / 屏幕像素横向足迹 之比（按 ground.glsl.ts 的 groundLod / levelCovers 原式算）
const R = 6360, BASE = 8, LEVELS = 7;
const pa = (h) => (2 * Math.tan((25 * Math.PI) / 180)) / h; // 像素角
function row(altKm, depDeg, RES, H) {
  const dep = (depDeg * Math.PI) / 180;
  // 相机在 R+alt，视线俯角 dep，与 R 球求交
  const ro = R + altKm, dy = -Math.sin(dep), dx = Math.cos(dep);
  const b = ro * dy, c = ro * ro - R * R, disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  const px = dx * t, py = ro + dy * t;
  const d = R * Math.atan2(px, py); // 地面弧长 ≈ 水平距离
  const fp = t * pa(H);
  const lod = Math.min(Math.max(Math.log2(Math.max(d / (0.425 * BASE), 1)), Math.log2(Math.max((fp * RES) / (1.5 * BASE), 1))), LEVELS - 1);
  const tex = (L) => (BASE * 2 ** L) / RES;
  const contTex = (BASE * 2 ** lod) / RES;
  // 有效纹素：floor(lod) 那级盖不住就往粗走（飞机在级中心，沿轴向覆盖 0.49·S）
  let L0 = Math.floor(lod);
  while (L0 < LEVELS - 1 && d >= 0.49 * BASE * 2 ** L0) L0++;
  const f = L0 === Math.floor(lod) ? lod - L0 : 0;
  const effTex = tex(L0) * (1 - f) + tex(Math.min(L0 + 1, LEVELS - 1)) * f;
  return { d, fp: fp * 1000, lod, cont: contTex / fp, eff: effTex / fp, texM: effTex * 1000 };
}
for (const [alt, H, label] of [[10.7, 1200, "巡航 10.7 km，画布高 1200"], [10.7, 1800, "巡航 10.7 km，画布高 1800（DPR 1.5）"], [4, 1200, "低空 4 km，画布高 1200"]]) {
  console.log(`\n${label}`);
  console.log("| 俯角 | 水平距离 km | 横足迹 m | 级别 | 纹素 1024 m | 比值 1024（连续 / 有效） | 纹素 2048 m | 比值 2048（连续 / 有效） |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const dep of [3.5, 5, 8, 12, 17, 25, 35, 50]) {
    const a = row(alt, dep, 1024, H), b = row(alt, dep, 2048, H);
    if (!a) continue;
    console.log(`| ${dep}° | ${a.d.toFixed(0)} | ${a.fp.toFixed(0)} | ${a.lod.toFixed(1)} | ${a.texM.toFixed(0)} | ${a.cont.toFixed(2)} / ${a.eff.toFixed(2)} | ${b.texM.toFixed(0)} | ${b.cont.toFixed(2)} / ${b.eff.toFixed(2)} |`);
  }
}
