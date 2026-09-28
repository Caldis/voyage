// C10b 原型：对「当前实际画的云步进」原文（C10 交付版：二分 + 倍率 4.5）做文本替换（给 handoff/C10-ab.mjs --vfile）
const NOBIS = ["(bis > 0 || (dens > 0.002 && wasEmpty && t < 60.0))", "(bis > 0)"];
const STEP = "    float stepLen = (wasEmpty ? 2.0 * dt : dt) * firstK;\n";
const CAP = (n) => ["|| i >= 192) break;", `|| i >= ${n}) break;`];
// 近处系数：R 以内 k，R → 1.5R 平滑过渡到 1
const nk = (k, R) => `mix(${k.toFixed(3)}, 1.0, smoothstep(${R.toFixed(1)}, ${(1.5 * R).toFixed(1)}, t))`;
// 只减有云的步（空白步维持 2dt）
const cloudOnly = (k, R, cap = 384) => [NOBIS, CAP(cap), [STEP, `    float stepLen = wasEmpty ? 2.0 * dt : dt * ${nk(k, R)};\n`]];
// 有云 / 空白都减（= 审查原型 near2xold 限在 R 以内）
const both = (k, R, cap = 384) => [NOBIS, CAP(cap), [STEP, `    float stepLen = (wasEmpty ? 2.0 * dt : dt) * ${nk(k, R)};\n`]];
// 空白步按 ke、有云步按 kc
const split = (ke, kc, R, cap = 384) => [NOBIS, CAP(cap), [STEP, `    float stepLen = wasEmpty ? 2.0 * dt * ${nk(ke, R)} : dt * ${nk(kc, R)};\n`]];

// 细步真值：不二分、步长 1/4、步数上限 3000，lod 仍按原步长（同一个密度场）
const REF = [
  NOBIS,
  ["for (int i = 0; i < 448; i++) {", "for (int i = 0; i < 3000; i++) {"],
  CAP(3000),
  ["float lod = clamp(log2(dtBase / 0.055), 0.0, 5.0);", "float lod = clamp(log2(clamp(t * 0.008, 0.06, 2.0) / 0.055), 0.0, 5.0);"],
  ["float dtBase = clamp(t * 0.008, 0.06, 2.0);", "float dtBase = clamp(t * 0.002, 0.015, 0.5);"],
];

export const VARIANTS = {
  cur: [], cur2: [],
  nb: [NOBIS],
  c20: cloudOnly(0.5, 20),
  c20b: cloudOnly(0.5, 20),
  e20: both(0.5, 20),
  s20: split(0.75, 0.5, 20),
  c40: cloudOnly(0.5, 40),
  ref: REF,
  dist: [["  L = L * apT + apL * (1.0 - T);", "  L = vec3(depth) * (1.0 - T);"]],
  e40: both(0.5, 40),
  e60: both(0.5, 60),
  u40: split(0.5, 1.0, 40),
  u60: split(0.5, 1.0, 60),
  u80: split(0.5, 1.0, 80),
  u20: split(0.5, 1.0, 20),
  e80: both(0.5, 80),
  eall: [NOBIS, CAP(384), [STEP, `    float stepLen = (wasEmpty ? 2.0 * dt : dt) * 0.5;
`]],
};

// 步数诊断：输出 α = 1、Y = 这条视线用掉的步数（看有没有用完上限）
const STEPS = [
  ["  for (int i = 0; i < 448; i++) {\n", "  float iUsed = 0.0;\n  for (int i = 0; i < 448; i++) {\n    iUsed = float(i);\n"],
  ["  gl_FragColor = vec4(min(L, vec3(60000.0)), T);\n  gl_FragDepth", "  gl_FragColor = vec4(vec3(iUsed), 0.0);\n  gl_FragDepth"],
  ["#else\n  if (wSum <= 0.0) return;\n#endif", "#else\n  if (wSum <= 0.0) { depthSum = 1.0; wSum = 1.0; }\n#endif"],
];
for (const k of ["cur", "u40", "u60", "e40"]) VARIANTS["st_" + k] = [...VARIANTS[k], ...STEPS];
