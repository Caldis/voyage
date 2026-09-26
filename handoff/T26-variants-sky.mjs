// T26 诊断：同一像素方向上的天空辐亮度（到地面为止），和云的空气透视对比
export const VARIANTS = [
  ["sky", [["if (wSum <= 0.0) return;", "gl_FragColor = vec4(skyRadiance(rd, false), 1.0); return;"]]],
  ["skyG", [["if (wSum <= 0.0) return;", "gl_FragColor = vec4(skyRadiance(rd, true), 1.0); return;"]]],
];
