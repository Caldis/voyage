// T26 诊断：视线上各段的阳光可见度（R = 前半段平均，G = 后半段平均），B = 太阳高度 sin
export const VARIANTS = [
  ["vis", [["if (uHurricane.w > 0.5 && uSunDir.y > 0.02) apL = hurricaneShadowedInscatter(ro, rd, depth, apL);",
    "float va = 0.0, vb = 0.0; for (int k = 0; k < 4; k++) { va += hurricaneSunVis(ro + rd * depth * (float(k) + 0.5) / 8.0); vb += hurricaneSunVis(ro + rd * depth * (float(k) + 4.5) / 8.0); } gl_FragColor = vec4(va * 0.25, vb * 0.25, uSunDir.y, T); outDepth = vec4(depth); return;"]]],
];
