// FOCUS-ZOOM：头部左右限位表（离线，几秒跑完）。
// node --experimental-transform-types --no-warnings apps/voyage/handoff/FOCUS-ZOOM-limits.mts [宽高比] [默认半视场°] [头高 y]
// 输出：各舱等 / 座位、各前伸量（z）× 各聚焦倍率下头部 x 的左右上限，以及对应的视线偏航角（相机中心视线与舷窗法线的夹角）；
// 并核对现有视角预设在默认视场下是否都在限位以内（不在的话预设会被拉回，画面就变了）。
import { headOk as frustumOk, headXLimit, type LimitQuery } from "../src/head-limits.ts";

const aspect = Number(process.argv[2] || 1600 / 1200);
const half = Number(process.argv[3] || 25);
const tan0 = Math.tan((half * Math.PI) / 180);
const headY = Number(process.argv[4] ?? 0.02);
const TARGET_Z = 0.075;
const yawDeg = (x: number, z: number) => (Math.atan2(Math.abs(x), TARGET_Z - z) * 180) / Math.PI;

const zs = [-0.75, -0.6, -0.5, -0.42, -0.35, -0.3, -0.25, -0.2, -0.15, -0.1, -0.06, -0.03];
const mags = [1, 1.5, 2.5, 4, 8];
for (const economy of [false, true]) {
  for (const seatSign of [1, -1]) {
    console.log(`\n== ${economy ? "经济舱" : "商务舱"} · ${seatSign > 0 ? "右座" : "左座"}（宽高比 ${aspect.toFixed(3)}，默认垂直半视场 ${half}°，头高 y = ${headY}）`);
    console.log("  z（前伸）  " + mags.map((m) => `${m}×：机尾侧 / 机头侧 x（偏航°）`.padEnd(34)).join(""));
    for (const z of zs) {
      const cells = mags.map((m) => {
        const q: LimitQuery = { y: headY, z, tanHalfFov: tan0 / m, aspect, seatSign, economy };
        // 座舱系 x 的正方向：右座朝机头、左座朝机尾
        const aft = headXLimit(seatSign > 0 ? -1 : 1, q), fwd = headXLimit(seatSign > 0 ? 1 : -1, q);
        return `${aft.toFixed(3)} / ${fwd.toFixed(3)}（${yawDeg(aft, z).toFixed(0)}° / ${yawDeg(fwd, z).toFixed(0)}°）`.padEnd(34);
      });
      console.log(`  ${z.toFixed(2).padStart(6)}    ${cells.join("")}`);
    }
  }
}

// 现有视角预设（view-presets.ts）：fwd 换成 x 乘座位方向；towardWing 按机翼在后方（默认 wingRootLE = 8 > 0 → 机翼在前方，头往机尾挪）
const presets = [
  { id: "seated", fwd: 0, y: 0.02, z: -0.42 },
  { id: "close", fwd: 0, y: 0.0, z: -0.03 },
  { id: "wing（机翼在前）", fwd: -0.2, y: 0.14, z: -0.26 },
  { id: "wing（机翼在后）", fwd: 0.2, y: 0.14, z: -0.26 },
  { id: "ahead", fwd: -0.42, y: 0.1, z: -0.5 },
  { id: "behind", fwd: 0.42, y: 0.1, z: -0.5 },
  { id: "场景默认", fwd: 0, y: 0.02, z: -0.3 },
  { id: "night-city", fwd: 0, y: 0.02, z: -0.25 },
];
console.log("\n== 现有视角预设在默认视场下是否在限位以内");
for (const economy of [false, true])
  for (const seatSign of [1, -1])
    for (const p of presets) {
      const x = p.fwd * seatSign;
      const q: LimitQuery = { y: p.y, z: p.z, tanHalfFov: tan0, aspect, seatSign, economy };
      const ok = frustumOk(x, q);
      const lim = headXLimit(x >= 0 ? 1 : -1, q);
      console.log(`  ${economy ? "经济舱" : "商务舱"} ${seatSign > 0 ? "右座" : "左座"} ${p.id.padEnd(14)} x=${x.toFixed(2)} ${ok ? "在限位内" : "超出！"}（这一侧上限 ${lim.toFixed(3)}）`);
    }
