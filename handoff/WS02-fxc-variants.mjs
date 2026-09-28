// WS02：离线 FXC 逐项撤回（node scripts/shader-budget.mjs --variants handoff/WS02-fxc-variants.mjs --only wonder-layer --rounds 3）。
// 注意：--variants 会改磁盘上的源文件（测完自动恢复），最好在没有开发服务器的 worktree 里跑；锚点只用单行（多行锚点实测匹配不上）。
// 撤回要写成编译期常量（if (false)），写成 uniform 比较 FXC 照样编那一支，量不出差别。
const F = "src/wonders/city.glsl.ts";
export const VARIANTS = [
  ["cur", []],
  ["noShadeExtra", [
    { file: F, find: "  if (mat < 0.5) {", replace: "  if (false) {" },
    { file: F, find: "  } else if (mat > 1.5) {", replace: "  } else if (false) {" },
  ]],
  ["noDome", [{ file: F, find: "  vec2 hs = fcSlab(co.y, cd.y, 0.4, 16.0);", replace: "  vec2 hs = vec2(1.0, 0.0);" }]],
  ["noPoints", [{ file: F, find: "for (int i = 0; i < 9 + FC_TOWERS + min(uStormCount, 0); i++) {", replace: "for (int i = 0; i < 0; i++) {" }]],
  ["noTowersSdf", [{ file: F, find: "  if (dt < 1.0) {", replace: "  if (false) {" }]],
  ["noSpireSdf", [{ file: F, find: "    ds = min(ds, fcSpire(c - vec3(sd.x, 0.0, sd.y), sd.z, sd.w));", replace: "    ds = min(ds, length(c - vec3(sd.x, 0.0, sd.y)) - sd.z);" }]],
  ["noZig", [{ file: F, find: "    dp = min(dp, fcZiggurat(c - vec3(P.x, 0.0, P.y), P.z, fcZigDef(i)));", replace: "    dp = min(dp, length(c - vec3(P.x, 0.0, P.y)) - P.z);" }]],
];
