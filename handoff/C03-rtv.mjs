// C03 返工：给 C03-rt.mjs（审查的实时路径脚本，blend 0.12 + 邻域夹取，预热 96 帧后逐帧读云缓冲 128 帧）的 --vfile。源码已是 final
const FINAL = "gDetailRnd = fract(ign(gl_FragCoord.yx + vec2(19.0, 47.0)) + uFrame * 0.41421356 + float(i) * 0.6180339);";
export const VARIANTS = {
  final: {},
  old: { march: [[FINAL, "gDetailRnd = fract(jitter + float(i) * 0.6180339);"]] },
  // 第一次交付的写法
  new: { march: [[FINAL, "gDetailRnd = fract(ign(gl_FragCoord.xy) * 13.0 + uFrame * 0.75487767 + float(i) * 0.6180339);"]] },
};
