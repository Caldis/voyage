// C03 诊断用变体（给 C01-measure.mjs 的 --vfile；页面内替换默认云步进片段）
//   base  = 不改
//   half  = 研究报告的 halfStepKeepLod：步长减半、mip 不变（上限估计）；步数上限跟着加倍，免得远处用完
//   cap   = 只把步数上限 192 → 384（看横纹 / 缺云是不是步数用完）
//   noE2  = 空白处不走 2 倍步长
//   proxN = 靠近表面（形状包络里、还没被细节侵蚀到的地方）时空白步长从 2dt 渐变到 N·dt
const LOOP_OLD = "if (t >= seg.y || T < 0.005 || i >= 192) break;";
const STEP_OLD = "float stepLen = wasEmpty ? 2.0 * dt : dt;";
const DT_OLD = "float dtBase = clamp(t * 0.008, 0.06, 2.0);";
const LOD_OLD = "float lod = clamp(log2(dtBase / 0.055), 0.0, 5.0);";
const DENS_OLD = "float dens = cloudDensity(p, lod, t < 150.0);";
const WAS_OLD = "bool wasEmpty = true;";
const LD_DECL = "float layerDensity(vec3 p, float lod, bool detail) {";
const LD_HEAD = "  float r = length(p);\n  float alt = r - BOTTOM;\n  float thick = uCloudTop - uCloudBottom;";
const LD_DET = "d = remapc(d, dmod * (0.55 + 0.25 * (1.0 - smoothstep(0.0, 0.15, h)) + 0.2 * cir), 1.0, 0.0, 1.0);\n  } else d = remapc(d, 0.275 + 0.1 * cir, 1.0, 0.0, 1.0);";
const LD_DET_NEW = "float thrC = dmod * (0.55 + 0.25 * (1.0 - smoothstep(0.0, 0.15, h)) + 0.2 * cir); gLayerNear = d / max(thrC, 1e-3);\n    d = remapc(d, thrC, 1.0, 0.0, 1.0);\n  } else { gLayerNear = d / (0.275 + 0.1 * cir); d = remapc(d, 0.275 + 0.1 * cir, 1.0, 0.0, 1.0); }";

function prox(fine, a, budget = 0, tGate = 0) {
  const lim = (budget > 0 ? ` && nFine < ${budget}` : "") + (tGate > 0 ? ` && T > ${tGate.toFixed(3)}` : "");
  return [
    [LD_DECL, "float gLayerNear = 0.0;\n" + LD_DECL],
    [LD_HEAD, "  gLayerNear = 0.0;\n" + LD_HEAD],
    [LD_DET, LD_DET_NEW],
    [WAS_OLD, WAS_OLD + " float nearPrev = 0.0; int nFine = 0;"],
    [STEP_OLD, `float stepLen = wasEmpty${lim} ? mix(2.0, ${fine.toFixed(3)}, nearPrev) * dt : (wasEmpty ? 2.0 * dt : dt); if (stepLen < 0.999 * dt) nFine++;`],
    [LOOP_OLD, "if (t >= seg.y || T < 0.005 || i - nFine >= 192) break;"],
    [DENS_OLD, DENS_OLD + ` nearPrev = smoothstep(${a.toFixed(3)}, 1.0, gLayerNear);`],
  ];
}

// 步进网格随机平移：第一步只走随机的一截，之后整条网格跟着平移（每帧换）
const GRID_J = "float gridJ = max(fract(ign(gl_FragCoord.yx + 41.0) + uFrame * 0.75487767), 0.02);";
const JIT_OLD = "float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803);";
function rnd() {
  return [
    [JIT_OLD, JIT_OLD + " " + GRID_J],
    [STEP_OLD, "float stepLen = (wasEmpty ? 2.0 * dt : dt) * (i == 0 ? gridJ : 1.0);"],
  ];
}
function rndProx(fine, a) {
  return [
    [JIT_OLD, JIT_OLD + " " + GRID_J],
    ...prox(fine, a).map(([f, r]) => (f === STEP_OLD ? [f, r.replace(" * dt : dt;", " * dt : dt; if (i == 0) stepLen *= gridJ;")] : [f, r])),
  ];
}
// 层状云进云细化（照搬雷暴的做法）：从空白进云时退回最近的空白采样点，8 小步重走
function refine(n) {
  return [
    [WAS_OLD, WAS_OLD + " int fineN = 0; float fineDtL = 0.03; float lastEmptyL = seg.x; int nFine = 0;"],
    [DT_OLD + "\n", DT_OLD + "\n"],
    ["float dt = dtBase;\n    " + STEP_OLD, "float dt = fineN > 0 ? fineDtL : dtBase;\n    float stepLen = fineN > 0 ? dt : (wasEmpty ? 2.0 * dt : dt); if (fineN > 0) nFine++;"],
    [LOOP_OLD, "if (t >= seg.y || T < 0.005 || i - nFine >= 192) break;"],
    [DENS_OLD, DENS_OLD + `\n    if (dens > 0.002 && wasEmpty && fineN == 0 && t > seg.x) { float tHit = t + stepLen * jitter; t = max(lastEmptyL, seg.x); fineDtL = max((tHit - t) / ${n.toFixed(1)}, 0.005); fineN = ${n}; wasEmpty = false; continue; }\n    if (fineN > 0) fineN--;`],
    ["      wasEmpty = true;\n#ifdef CLOUD_WEATHER\n      wasThin = false;\n      lastEmpty = t + stepLen * jitter;\n#endif", "      wasEmpty = true; lastEmptyL = t + stepLen * jitter;\n#ifdef CLOUD_WEATHER\n      wasThin = false;\n      lastEmpty = t + stepLen * jitter;\n#endif"],
  ];
}

// 进云锚定：从空白进云时，用「形状包络 / 侵蚀阈值」这个连续量（gLayerNear，= 1 处就是云的表面）在
// [上一个空白采样点, 这个有云的采样点] 之间做割线法定位表面（K 次额外探测，复用同一个密度调用点），
// 然后从表面重新开始按 dt 走：第一个云里采样点的深度在 [0, dt) 均匀，与表面落在步进网格的哪个相位无关
const P_OLD = "vec3 p = ro + rd * (t + stepLen * jitter);";
const EMPTY_OLD = "      wasEmpty = true;\n#ifdef CLOUD_WEATHER\n      wasThin = false;";
function anchor(K) {
  return [
    [LD_DECL, "float gLayerNear = 0.0;\n" + LD_DECL],
    [LD_HEAD, "  gLayerNear = 0.0;\n" + LD_HEAD],
    [LD_DET, LD_DET_NEW],
    [WAS_OLD, WAS_OLD + " int nFine = 0; int probe = 0; float sProbe = 0.0, bE = 0.0, bX = 0.0, nE = 0.0, nX = 0.0, lastEmptyL = seg.x, nearEL = 0.0;"],
    [LOOP_OLD, "if (t >= seg.y || T < 0.005 || i - nFine >= 192) break;"],
    [P_OLD, "vec3 p = ro + rd * (probe > 0 ? sProbe : t + stepLen * jitter);"],
    [DENS_OLD, DENS_OLD + `
    float nearX = gLayerNear;
    if (probe > 0) {
      if (dens > 0.002) { bX = sProbe; nX = nearX; } else { bE = sProbe; nE = nearX; }
      probe--;
      sProbe = mix(bE, bX, clamp((1.0 - nE) / max(nX - nE, 1e-3), probe > 0 ? 0.1 : 0.0, probe > 0 ? 0.9 : 1.0));
      if (probe == 0) { t = sProbe; wasEmpty = false; }
      nFine++;
      continue;
    }
    if (dens > 0.002 && wasEmpty) {
      bE = max(lastEmptyL, seg.x); nE = nearEL; bX = t + stepLen * jitter; nX = nearX;
      probe = ${K};
      sProbe = mix(bE, bX, clamp((1.0 - nE) / max(nX - nE, 1e-3), probe > 0 ? 0.1 : 0.0, probe > 0 ? 0.9 : 1.0));
      if (probe == 0) { t = sProbe; wasEmpty = false; }
      nFine++;
      continue;
    }`],
    [EMPTY_OLD, "      wasEmpty = true; lastEmptyL = t + stepLen * jitter; nearEL = nearX;\n#ifdef CLOUD_WEATHER\n      wasThin = false;"],
  ];
}

const RND_OLD = "gDetailRnd = fract(jitter + float(i) * 0.6180339);";
const RND_NEW = "gDetailRnd = fract(ign(gl_FragCoord.yx * 1.37 + vec2(float(i) * 5.3, 11.0)) + uFrame * 0.75487767);";
const RND_D = "gDetailRnd = fract(ign(gl_FragCoord.xy) * 13.0 + uFrame * 0.75487767 + float(i) * 0.6180339);";
const RND_A ="gDetailRnd = fract(ign(gl_FragCoord.xy + vec2(19.0, 47.0)) + uFrame * 0.75487767 + float(i) * 0.6180339);";
const RND_C ="gDetailRnd = fract(jitter * 13.0 + float(i) * 0.6180339);";
const S_OLD = "vec3 S = sunLight + ambient;";
const S_FLAT = "vec3 S = vec3(0.02 * uSunIlluminance);";
const OD_OLD = "od *= CLOUD_EXTINCTION;";
// 表皮受光：进云那个样本的受光步进起点挪回到「估计的表面下 1/σ」处（割线法估计表面，不多求密度），
// 受光不再取决于进云样本随机落在表面下多深（那一层被照亮的表皮只有几十米，比步长薄得多）
function skin(withProx) {
  const base = withProx ? prox(0.5, 0.5, 0, 0.9) : [
    [LD_DECL, "float gLayerNear = 0.0;\n" + LD_DECL],
    [LD_HEAD, "  gLayerNear = 0.0;\n" + LD_HEAD],
    [LD_DET, LD_DET_NEW],
    [WAS_OLD, WAS_OLD + " float nearPrev = 0.0;"],
    [DENS_OLD, DENS_OLD + " nearPrev = 0.0;"],
  ];
  return [
    [RND_OLD, RND_C],
    ...base.map(([f, r]) => {
      if (f === WAS_OLD) return [f, r + " float lastEmptyL = seg.x, nearEL = 0.0, skinZ = 0.0;"];
      if (f === DENS_OLD) return [f, r + "\n    float nearX = gLayerNear;\n    skinZ = (wasEmpty && dens > 0.002) ? (t + stepLen * jitter - max(lastEmptyL, seg.x)) * clamp((nearX - 1.0) / max(nearX - nearEL, 1e-3), 0.0, 1.0) : 0.0;"];
      return [f, r];
    }),
    [EMPTY_OLD, "      wasEmpty = true; lastEmptyL = t + stepLen * jitter; nearEL = nearX;\n#ifdef CLOUD_WEATHER\n      wasThin = false;"],
    ["      float od = 0.0;\n      float ls = 0.06;", "      float od = 0.0;\n      float ls = 0.06;\n      vec3 pL = p - rd * max(skinZ - 1.0 / sigma, 0.0);"],
    ["od += layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3) * ls;", "od += layerDensity(pL + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3) * ls;"],
  ];
}

// 细步进云时受光按「原来的 2dt 区间」取深度：不透明度用细步的结果，受光的深度统计与原来一致（表皮受光的偏差处处相同）
function baseLight(fine, a, tGate) {
  return [
    [RND_OLD, RND_C],
    ...prox(fine, a, 0, tGate).map(([f, r]) => (f === WAS_OLD ? [f, r + " float lightShift = 0.0;"] : f === DENS_OLD ? [f, r + "\n    lightShift = (wasEmpty && dens > 0.002) ? max(2.0 * dt - stepLen, 0.0) * jitter : 0.0;"] : [f, r])),
    ["      float od = 0.0;\n      float ls = 0.06;", "      float od = 0.0;\n      float ls = 0.06;\n      vec3 pL = p + rd * lightShift;"],
    ["od += layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3) * ls;", "od += layerDensity(pL + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3) * ls;"],
  ];
}

// 细步区间里的采样位置换一个与「细不细」这个决定去相关的随机数（决定由上一个样本的位置 = jitter 决定）
function blDec(fine, a, tGate, k) {
  const v = baseLight(fine, a, tGate);
  return [
    ...v.map(([f, r]) => (f === DENS_OLD ? [f, r.replace("max(2.0 * dt - stepLen, 0.0) * jitter", "(2.0 * dt * jitter - stepLen * jSub)")] : [f, r])),
    [P_OLD, `float jSub = stepLen < 1.99 * dt ? fract(jitter * ${k.toFixed(1)} + 0.31) : jitter;\n    vec3 p = ro + rd * (t + stepLen * jSub);`],
  ];
}

export const VARIANTS = {
  // 源码改好以后（src 里已是 rndD）：old = 页面内改回原来的 fract(jitter + i·φ)
  new: {},
  old: { march: [[RND_D, RND_OLD]] },
  rndD: { march: [[RND_OLD, "gDetailRnd = fract(ign(gl_FragCoord.xy) * 13.0 + uFrame * 0.75487767 + float(i) * 0.6180339);"]] },
  bd50a3g9: { march: blDec(0.5, 0.3, 0.9, 7) },
  bd50a5g9: { march: blDec(0.5, 0.5, 0.9, 7) },
  bl50a5g9: { march: baseLight(0.5, 0.5, 0.9) },
  bl50a3g9: { march: baseLight(0.5, 0.3, 0.9) },
  bl100a0: { march: baseLight(1.0, 0.0, 0) },
  skin: { march: skin(false) },
  skinP: { march: skin(true) },
  flatS: { march: [[S_OLD, S_FLAT]] },
  flatSq: { march: [[S_OLD, S_FLAT], ["for (int i = 0; i < 448; i++) {", "for (int i = 0; i < 900; i++) {"], [DT_OLD, "float dtBase = clamp(t * 0.002, 0.015, 0.5);"], [LOD_OLD, "float lod = clamp(log2(dtBase * 4.0 / 0.055), 0.0, 5.0);"], [LOOP_OLD, "if (t >= seg.y || T < 0.005 || i >= 800) break;"]] },
  noOd: { march: [[OD_OLD, "od = 0.0;"]] },
  anchor0: { march: anchor(0) },
  anchor1: { march: anchor(1) },
  anchor2: { march: anchor(2) },
  anchor5: { march: anchor(5) },
  // 受光步进挑格点的随机数和采样深度去相关（原来都是同一个 jitter + i·φ）
  rndDet: { march: [[RND_OLD, RND_NEW]] },
  rndDetQ: { march: [[RND_OLD, RND_NEW], ["for (int i = 0; i < 448; i++) {", "for (int i = 0; i < 900; i++) {"], [DT_OLD, "float dtBase = clamp(t * 0.002, 0.015, 0.5);"], [LOD_OLD, "float lod = clamp(log2(dtBase * 4.0 / 0.055), 0.0, 5.0);"], [LOOP_OLD, "if (t >= seg.y || T < 0.005 || i >= 800) break;"]] },
  rndA: { march: [[RND_OLD, "gDetailRnd = fract(ign(gl_FragCoord.xy + vec2(19.0, 47.0)) + uFrame * 0.75487767 + float(i) * 0.6180339);"]] },
  rndC: { march: [[RND_OLD, "gDetailRnd = fract(jitter * 13.0 + float(i) * 0.6180339);"]] },
  cP100a0: { march: [[RND_OLD, RND_C], ...prox(1.0, 0.0)] },
  cP75a0: { march: [[RND_OLD, RND_C], ...prox(0.75, 0.0)] },
  cP50a3: { march: [[RND_OLD, RND_C], ...prox(0.5, 0.3)] },
  cP50a7: { march: [[RND_OLD, RND_C], ...prox(0.5, 0.7)] },
  cP50a5g9: { march: [[RND_OLD, RND_C], ...prox(0.5, 0.5, 0, 0.9)] },
  cP50a3g9: { march: [[RND_OLD, RND_C], ...prox(0.5, 0.3, 0, 0.9)] },
  cP35a3g9: { march: [[RND_OLD, RND_C], ...prox(0.35, 0.3, 0, 0.9)] },
  cP35a5g9: { march: [[RND_OLD, RND_C], ...prox(0.35, 0.5, 0, 0.9)] },
  cP50a4g9: { march: [[RND_OLD, RND_C], ...prox(0.5, 0.4, 0, 0.9)] },
  aP50a5g9: { march: [[RND_OLD, RND_A], ...prox(0.5, 0.5, 0, 0.9)] },
  fP50a5g9: { march: [[RND_OLD, "gDetailRnd = 0.5;"], ...prox(0.5, 0.5, 0, 0.9)] },
  cP50a5: { march: [[RND_OLD, RND_C], ...prox(0.5, 0.5)] },
  base0c: { march: [[RND_OLD, RND_C + " // c03"]] },
  detFix: { march: [[RND_OLD, "gDetailRnd = 0.5;"]] },
  // 与 base 相同，只多一行注释：passes.mjs 的空补丁不会换回原程序，计时对照用它
  base0: { march: [[LOOP_OLD, LOOP_OLD + " // c03"]] },
  p50a5: { march: prox(0.5, 0.5) },
  p25a6: { march: prox(0.25, 0.6) },
  p35a5: { march: prox(0.35, 0.5) },
  p50a3: { march: prox(0.5, 0.3) },
  proxNoop: { march: prox(2.0, 0.5) },
  p100a0: { march: prox(1.0, 0.0) },
  p50a7: { march: prox(0.5, 0.7) },
  e15: { march: [[STEP_OLD, "float stepLen = wasEmpty ? 1.5 * dt : dt;"]] },
  p35a5b8: { march: prox(0.35, 0.5, 8) },
  p35a5b16: { march: prox(0.35, 0.5, 16) },
  p25a5b12: { march: prox(0.25, 0.5, 12) },
  p25a3b12: { march: prox(0.25, 0.3, 12) },
  rnd: { march: rnd() },
  rndProx25: { march: rndProx(0.25, 0.3) },
  refine8: { march: refine(8) },
  refine4: { march: refine(4) },
  base: {},
  half: { march: [[DT_OLD, "float dtBase = clamp(t * 0.004, 0.03, 1.0);"], [LOD_OLD, "float lod = clamp(log2(dtBase * 2.0 / 0.055), 0.0, 5.0);"], [LOOP_OLD, "if (t >= seg.y || T < 0.005 || i >= 384) break;"]] },
  quarter: { march: [["for (int i = 0; i < 448; i++) {", "for (int i = 0; i < 900; i++) {"], [DT_OLD, "float dtBase = clamp(t * 0.002, 0.015, 0.5);"], [LOD_OLD, "float lod = clamp(log2(dtBase * 4.0 / 0.055), 0.0, 5.0);"], [LOOP_OLD, "if (t >= seg.y || T < 0.005 || i >= 800) break;"]] },
  lodm2: { march: [[LOD_OLD, "float lod = clamp(log2(dtBase / 0.055) - 2.0, 0.0, 5.0);"]] },
  quarterLod: { march: [["for (int i = 0; i < 448; i++) {", "for (int i = 0; i < 900; i++) {"], [DT_OLD, "float dtBase = clamp(t * 0.002, 0.015, 0.5);"], [LOOP_OLD, "if (t >= seg.y || T < 0.005 || i >= 800) break;"]] },
  cap: { march: [[LOOP_OLD, "if (t >= seg.y || T < 0.005 || i >= 384) break;"]] },
  noE2: { march: [[STEP_OLD, "float stepLen = dt;"]] },
  prox25: { march: prox(0.25, 0.3) },
  prox50: { march: prox(0.5, 0.3) },
};
