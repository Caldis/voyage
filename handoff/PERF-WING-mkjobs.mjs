// 生成 PERF-WING 的 ab jobs（同页冻结 A/B + hdrWing 读回）：
//   old     对照端口（master）的机翼着色器（主 + 湿窗）
//   new     本分支
//   noLamp  old + uWingDebug=2（关掉翼尖灯照翼面）：与 old 不同的像素 = 被灯照到的翼面
//   cov     new，但把机翼覆盖率 wing.a 写进 r（覆盖率 > 0 的算机翼）
//   oldNG / newNG  去掉翼尖灯本身的亮点与云雾光晕（wingLights），看非机翼像素的差是不是只来自光晕
//   stats   页内统计（jsOut）：按覆盖率分「机翼 / 非机翼」、按 noLamp 分「灯照 / 其余」，报不同像素数、最大绝对 / 相对差
// 用法：node perfwing-mkjobs.mjs <输出 jobs.json>
import fs from "node:fs";
const [out] = process.argv.slice(2);
const OLD = { wingMat: "base", "wingMat.wet": "base:wingMat" };
const MATS = "wingMat,wingMat.wet";
const COV = { [MATS]: [["gl_FragColor = sc;\n", "gl_FragColor = vec4(0.0);\n"], ["gl_FragColor = vec4(min(col, vec3(uHdrMax)), sc.a);", "gl_FragColor = vec4(wing.a, 0.0, m, 1.0);"]] };
const NG = { [MATS]: [["  col += wingLights(ro, rd) * WING_PANE_T * m;", ""]] };
const STATS = `const H = window.__dxHdr; const out = {}; const C = H.cov, M = H.noLamp;
const cmp = (A, B) => { const r = { wing: 0, nonWing: 0, lampLit: 0, other: 0, maxRelWing: 0, maxAbsWing: 0, maxRelNonWing: 0, maxAbsNonWing: 0, alphaDiff: 0, wingPx: 0 };
  for (let p = 0; p < A.length; p += 4) { const isWing = C[p] > 0; if (isWing) r.wingPx++; if (A[p + 3] !== B[p + 3]) r.alphaDiff++;
    let d = 0, q = 0, lamp = false;
    for (let c = 0; c < 3; c++) { const e = Math.abs(A[p + c] - B[p + c]); d = Math.max(d, e); q = Math.max(q, e / Math.max(Math.abs(B[p + c]), 1e-9)); if (M[p + c] !== H.old[p + c]) lamp = true; }
    if (d > 0) { if (lamp) r.lampLit++; else r.other++;
      if (isWing) { r.wing++; r.maxRelWing = Math.max(r.maxRelWing, q); r.maxAbsWing = Math.max(r.maxAbsWing, d); }
      else { r.nonWing++; r.maxRelNonWing = Math.max(r.maxRelNonWing, q); r.maxAbsNonWing = Math.max(r.maxAbsNonWing, d); } } }
  return r; };
out.new_vs_old = cmp(H.new, H.old);
if (H.newGlowOld) out.newGlowOld_vs_old = cmp(H.newGlowOld, H.old);
{ const A = H.new, B = H.old, W = window.__voyage.hdrWing.width; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, best = 0, at = -1;
  for (let p = 0; p < A.length; p += 4) { let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A[p + c] - B[p + c]));
    if (d > 0) { const i = p / 4, x = i % W, y = (i / W) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); if (d > best) { best = d; at = i; } } }
  out.diffBox = [x0, y0, x1, y1]; out.maxAt = at >= 0 ? { x: at % W, y: (at / W) | 0, old: Array.from(B.subarray(at * 4, at * 4 + 4)), new: Array.from(A.subarray(at * 4, at * 4 + 4)), oldNG: Array.from(H.oldNG.subarray(at * 4, at * 4 + 4)), cov: C[at * 4] } : null; }
out.newNG_vs_oldNG = cmp(H.newNG, H.oldNG);
return out;`;
const scenes = [
  ["sun", "sunset-wing", {}],
  ["biz", { name: "biz-seated-noon", p: { preset: "wpac", time: 720, "wing-pos": "8", "cabin-class": "business" }, head: [0, 0.02, -0.42] }, {}],
  ["ic", "in-cloud", { offset: [-10, -5] }],
  ["night", { name: "night-city-low", p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 1, coverage: 0.15, "cabin-light": "off" }, offset: [0, -25], ground: true, head: -0.25 }, {}],
];
const jobs = scenes.map(([name, scene, extra]) => ({
  name, scene, ...extra, hdr: "hdrWing",
  variants: [
    { name: "old", materials: OLD },
    { name: "new" },
    { name: "noLamp", materials: OLD, uniforms: { "sceneMat.uniforms.uWingDebug.value": 2 } },
    { name: "cov", patch: COV },
    { name: "oldNG", materials: OLD, patch: NG },
    { name: "newNG", patch: NG },
    ...(process.argv.includes("--diag") ? [{ name: "newGlowOld", patch: { [MATS]: [["    vec3 a = wingLampAt(i);", "    vec3 a = wingLampPos(i);"]] } }] : []),
    { name: "stats", js: STATS },
  ],
}));
fs.writeFileSync(out, JSON.stringify(jobs, null, 1));
