// PERF-12：舱内合成程序的消融变体（单项撤回）。同一份定义给两个工具用：
//   离线 FXC：node scripts/shader-budget.mjs --variants handoff/PERF-12-variants.mjs --only scene-default,scene-economy --rounds 3
//   GPU 计时：node scripts/passes.mjs --port <端口> --material sceneMat --target hdr --variants handoff/PERF-12-variants-gpu.mjs --only noon-cumulus,...
// 每项把一段功能换成「不做」（常量 / 空），看编译与运行时各掉多少。查找文本必须和源文件逐字一致。
const SCENE = "src/render/scene.ts";
const REFL = "src/render/cabin-reflect.glsl.ts";
const SHADE = "src/render/cabin-shading.glsl.ts";
const SEATS = "src/render/seats.glsl.ts";

const P = {
  // T41 点星
  stars: [{ file: SCENE, find: "    view += starPoints(rdW) * sunTransmittance(uCamR, rdW.y) * (PANE_TRANSMITTANCE * (outside.a - 1.0));", replace: "" }],
  // T24/T34/T42 整个窗板倒影（面状 + 光点）
  reflAll: [{ file: SCENE, find: "    vec3 surf = reflGain * reflWB * cabinReflection(pPane, rr, length(pPane - ro), rl, pts);", replace: "    pts = vec3(0.0); vec3 surf = vec3(0.0);" }],
  // T34 阅读灯光点（10 盏 + 重影）
  reflPts: [{ file: REFL, find: "  if (max(moodOn, L.lit) <= 0.0) return vec3(0.0);", replace: "  return vec3(0.0);" }],
  // T42 6 列座位循环
  reflCols: [{ file: REFL, find: "for (int k = 0; k < RF_NCOL + uLoopGuard; k++) {", replace: "for (int k = 0; k < 0; k++) {" }],
  // T42 对面舷窗遮光板随机开合
  reflOppShade: [{ file: REFL, find: "  float shadeF = st < 0.5 ? 0.0 : (st < 1.5 ? 0.3 : (st < 2.5 ? 0.7 : 1.0));", replace: "  float shadeF = 0.0;" }],
  // T35 亚麻压纹（商务舱）
  linen: [{ file: SHADE, find: "  if (fWeft + fWarp > 0.0) {", replace: "  if (false) {" }],
  // 侧壁细颗粒（T20 起的柔光压纹）
  grain: [{ file: SHADE, find: "  if (fA > 0.0) {\n    vec2 pr = mat2", replace: "  if (false) {\n    vec2 pr = mat2" }],
  // T47 1c 大尺度起伏
  undul: [{ file: SHADE, find: "    vec3 u1 = vnoiseD(mat2(0.8, 0.6, -0.6, 0.8) * p.xy * 6.7 + seed * 0.37 + 5.3);\n    slope += mat2(0.8, -0.6, 0.6, 0.8) * u1.yz * 6.7 * 0.0022;\n    albedo *= 1.0 + 0.02 * (u1.x - 0.5);", replace: "" }],
  // T35 回风格栅
  grille: [{ file: SHADE, find: "  if (grilleBox > 0.0) {", replace: "  if (false) {" }],
  // T35 侧壁金属（收边条 + 下侧壁饰条）
  wallMetal: [{ file: SHADE, find: "  if (metalCov > 0.0) {", replace: "  if (false) {" }],
  // T47 胡桃木（座椅）
  walnut: [{ file: SEATS, find: "  if (wood > 0.0) {", replace: "  if (false) {" }],
  // T35 座椅壳体（商务舱）
  shell: [
    { file: SEATS, find: "  d = min(d, min(sdSeatShell(p, 0.0), sdSeatShell(p, 1.0)));", replace: "" },
    { file: SEATS, find: "  if (seatShellBox(ro, rd, 0.0, b)) { tS = min(tS, b.x); tE = max(tE, b.y); }\n  if (seatShellBox(ro, rd, 1.0, b)) { tS = min(tS, b.x); tE = max(tE, b.y); }", replace: "" },
    { file: SEATS, find: "  if (min(dS0, dS1) < min(dB0, dB1)) {", replace: "  if (false) {" },
  ],
  // 座椅皮面缝线（T20/T35/T47）
  seams: [{ file: SEATS, find: "    vec2 sm = seatSeams(q, fr, wz, pix, coverZone, dn);", replace: "    dn = vec3(0.0); vec2 sm = vec2(0.0);" }],
  // T47 交界像素覆盖率重映射
  remap: [{ file: SCENE, find: "  if (outsideMask > 0.0 && outsideMask < 1.0) {", replace: "  if (false) {" }],
  // T29 窗上的水（参考）
  water: [{ file: SCENE, find: "  if (wat.z > 0.002) {", replace: "  if (false) {" }],
  // 整个座椅（参考）
  seatsAll: [{ file: SCENE, find: "  SeatHit seat = traceSeats(ro, rd, tWall, pixAng);", replace: "  SeatHit seat; seat.cov = 0.0; seat.t = -1.0;" }],
};

const only = (process.env.PERF12_VARIANTS || "").split(",").filter(Boolean);
const ALL = [
  ["base", []],
  ["-stars(T41)", P.stars],
  ["-reflAll", P.reflAll],
  ["-reflPts(T34)", P.reflPts],
  ["-reflCols(T42)", P.reflCols],
  ["-reflOppShade(T42)", P.reflOppShade],
  ["-linen(T35)", P.linen],
  ["-grain", P.grain],
  ["-undul(T47)", P.undul],
  ["-grille(T35)", P.grille],
  ["-wallMetal(T35)", P.wallMetal],
  ["-walnut(T47)", P.walnut],
  ["-shell(T35)", P.shell],
  ["-seams", P.seams],
  ["-remap(T47)", P.remap],
  ["-water(T29)", P.water],
  ["-seatsAll", P.seatsAll],
];
export const VARIANTS = only.length ? ALL.filter(([n]) => n === "base" || only.some((o) => n.includes(o))) : ALL;
export const PATCHES = P;
