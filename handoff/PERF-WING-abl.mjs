// PERF-WING 第一轮：消融（不等价，只为找冷编译花在哪）
// node scripts/shader-budget.mjs --variants handoff/PERF-WING-abl.mjs --only wing --rounds 3
const W = "src/render/wing.glsl.ts";
const S = "src/render/wing-shading.glsl.ts";
const part = (name) => ({ file: W, find: `? 1e3 : ${name}(P);`, replace: `? 1e3 : 1e3;` });
export const VARIANTS = [
  ["base", []],
  ["无小翼", [part("sdWingTip")]],
  ["无襟翼缝翼扰流板", [part("sdWingFlap"), part("sdWingSpoiler"), part("sdWingSlat")]],
  ["无整流罩", [part("sdWingFairing")]],
  ["无短舱", [part("sdWingNacelle")]],
  ["无 W-STAIR 下界", [{ file: W, find: "  if (uFlap > 1e-3 || uSlat > 1e-3) {\n    // 分区", replace: "  if (false) {\n    // 分区" }]],
  ["无鼓包", [{ file: W, find: "        n = normalize(n - vec3(g.y, 0.0, g.x) * flatness * sign(n.y));", replace: "" }]],
  ["无自阴影段", [{ file: W, find: "      res = min(res, 14.0 * d / ts);", replace: "      res = 0.5; break;" }]],
  ["无着色", [{ file: S, find: "      col = shadeWing(ro + rdk * w.t, rdk, w, sunC, eSky, eDown, belowAlbedo);", replace: "      col = vec3(w.t, w.nA.x, w.shadow);" }]],
];
