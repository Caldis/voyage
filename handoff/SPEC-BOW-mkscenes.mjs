// 生成 SPEC-BOW 自测场景（--scenes-file）。每个场景的 js：按「窗中心视线（可往下 / 往上偏）与对日点（sgn=-1）或太阳（sgn=1）的夹角」
// 扫一天找时刻，再开光学开关，返回状态与对日点像素。用法：node bow-mkscenes.mjs <输出.json> [场景名,…]
import { writeFileSync } from "node:fs";

const seek = (target, altLo, altHi, extra = "", down = 0, sgn = -1) => `
const u = v.sceneMat.uniforms, st = v.state;
const fwdOf = () => { const B = u.uCamBasis.value.elements, C = u.uCabinToWorld.value.elements;
  const fc = [-B[6], -B[7], -B[8]];
  return [C[0]*fc[0]+C[3]*fc[1]+C[6]*fc[2], C[1]*fc[0]+C[4]*fc[1]+C[7]*fc[2], C[2]*fc[0]+C[5]*fc[1]+C[8]*fc[2]]; };
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const base = st.simTime; let best = null;
for (let dt = -12*60; dt <= 12*60; dt += 4) {
  st.simTime = base + dt * 60000; await frame(); await frame();
  const s = u.uSunDir.value, f = fwdOf(); const alt = Math.asin(s.y) * 180 / Math.PI;
  if (alt < ${altLo} || alt > ${altHi}) continue;
  f[1] -= ${down}; const fl = Math.hypot(f[0], f[1], f[2]);
  const ang = Math.acos(${sgn} * (f[0]*s.x + f[1]*s.y + f[2]*s.z) / fl) * 180 / Math.PI;
  const e = Math.abs(ang - ${target});
  if (!best || e < best.e) best = { e, dt, ang, alt };
}
if (best) st.simTime = base + best.dt * 60000;
${extra}
await frame(); await frame(); await new Promise(r => setTimeout(r, 400));
return JSON.stringify({ best, status: v.optics.status, anti: v.optics.pixelOf(u), fwd: fwdOf() });`;

const on = "v.optics.disabled=false; v.optics.force={bow:true}; v.optics.resetBowDemo();";
const P = { preset: "wpac", date: "2026-06-21", "wing-pos": "-4" };
const only = process.argv[3] ? process.argv[3].split(",") : null;
const scenes = [];
const add = (name, p, js) => { if (!only || only.includes(name)) scenes.push({ name, p: { ...P, ...p }, js }); };
// A. 雨虹：标准坐姿，窗中心往下约 17° 的视线离对日点 46°（主 / 副虹之间），太阳 30–80°，浓积云（阵雨）
add("bow-rain", { seat: "right", time: 720, "cloud-preset": "towering", coverage: 0.3 }, on + seek(42, 30, 80, "v.optics.resetBowDemo();", 0.2));
// B. 云虹 + 宝光同框：贴窗，窗中心离对日点 19°，太阳 8–35°，层积云海
add("bow-cloud", { seat: "right", time: 720, "cloud-preset": "stratocumulus", coverage: 0.85, "view-preset": "close" }, on + seek(19, 8, 35, "v.optics.resetBowDemo();"));
// C. 环地平弧：卷云，太阳 62–72°，窗往上偏的视线离太阳约 50°
const cirP = { seat: "right", time: 720, "cloud-preset": "cirrus", coverage: 0.6 };
add("bow-cha", cirP, on + seek(50, 62, 72, "", -0.25, 1));
// D. 日柱：卷云，太阳 1–5°，窗朝太阳
add("bow-pillar", { ...cirP, seat: "left", date: "2026-03-20" }, on + seek(4, 1, 5, "", 0, 1));
add("bow-pillar-r", { ...cirP, date: "2026-03-20" }, on + seek(4, 1, 5, "", 0, 1));
writeFileSync(process.argv[2], JSON.stringify(scenes, null, 1));
console.log("场景数", scenes.length);
