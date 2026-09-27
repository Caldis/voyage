// C12b：resolve 的候选变体（对 master 的 RESOLVE_FRAG 原文做文本替换，按 #define 切换各开关）。
// 开关：CR_MODE 0 双线性（master）/ 1 Catmull-Rom 16 次 texelFetch / 2 Catmull-Rom 12 次（去四角）/ 3 Catmull-Rom 5 次双线性；
//      B_CONST 常数 blend；ADAPT 按重投影位置的小数部分自适应（B_MIN、B_MAX、K_SUB）；ADAPT_CLAMP 夹取改动量大时回到 B_MAX；
//      VCLIP 方差裁剪（γ = VCLIP，与 min/max 取交集）。只作用于云外左半（!depthHalf && wImm <= 0），云里 / 右半逐字等于 master。
const HELPERS = /* glsl */ `
// ---- C12b 候选 ----
vec4 c12bFetch(ivec2 t) { return texelFetch(uHistory, clamp(t, ivec2(0), ivec2(uCloudResolution) - 1), 0); }
vec4 c12bRow(ivec2 b, int y, vec4 wx) {
  return c12bFetch(b + ivec2(-1, y)) * wx.x + c12bFetch(b + ivec2(0, y)) * wx.y + c12bFetch(b + ivec2(1, y)) * wx.z + c12bFetch(b + ivec2(2, y)) * wx.w;
}
vec4 c12bRow2(ivec2 b, int y, vec2 wx) { return c12bFetch(b + ivec2(0, y)) * wx.x + c12bFetch(b + ivec2(1, y)) * wx.y; }
vec4 c12bCatmullRom(vec2 p) {
  vec2 q = p - 0.5;
  vec2 i0 = floor(q);
  vec2 f = q - i0;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  ivec2 b = ivec2(i0);
#if CR_MODE == 1
  vec4 wx = vec4(w0.x, w1.x, w2.x, w3.x);
  return c12bRow(b, -1, wx) * w0.y + c12bRow(b, 0, wx) * w1.y + c12bRow(b, 1, wx) * w2.y + c12bRow(b, 2, wx) * w3.y;
#elif CR_MODE == 2
  vec4 wx = vec4(w0.x, w1.x, w2.x, w3.x);
  vec4 s = c12bRow2(b, -1, vec2(w1.x, w2.x)) * w0.y + c12bRow(b, 0, wx) * w1.y + c12bRow(b, 1, wx) * w2.y + c12bRow2(b, 2, vec2(w1.x, w2.x)) * w3.y;
  float ws = (w1.x + w2.x) * (w0.y + w3.y) + (w1.y + w2.y);
  return s / ws;
#else
  vec2 w12 = w1 + w2;
  vec2 c = i0 + 0.5;
  vec2 t0 = c - 1.0, t3 = c + 2.0, t12 = c + w2 / w12;
  vec2 lo = vec2(0.5), hi = uCloudResolution - 0.5;
  t0 = clamp(t0, lo, hi); t3 = clamp(t3, lo, hi); t12 = clamp(t12, lo, hi);
  vec2 inv = 1.0 / vec2(2.0 * uCloudResolution.x, uCloudResolution.y);
  vec4 s = texture(uHistory, vec2(t12.x, t0.y) * inv) * (w12.x * w0.y)
         + texture(uHistory, vec2(t0.x, t12.y) * inv) * (w0.x * w12.y)
         + texture(uHistory, t12 * inv) * (w12.x * w12.y)
         + texture(uHistory, vec2(t3.x, t12.y) * inv) * (w3.x * w12.y)
         + texture(uHistory, vec2(t12.x, t3.y) * inv) * (w12.x * w3.y);
  return s / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y);
#endif
}
`;

const TAIL_OLD = "  vec4 hist = clamp(texture(uHistory, vec2(hx / (2.0 * uCloudResolution.x), puv.y)), mn, mx);\n  gl_FragColor = mix(hist, cur, blend);";
const TAIL_NEW = /* glsl */ `
  bool c12b = !depthHalf && wImm <= 0.0;
  vec2 hp = puv * uCloudResolution;
  vec4 histRaw;
#if CR_MODE > 0
  if (c12b) histRaw = c12bCatmullRom(hp); else
#endif
  histRaw = texture(uHistory, vec2(hx / (2.0 * uCloudResolution.x), puv.y));
  vec4 lo = mn, hi4 = mx;
#ifdef VCLIP
  if (c12b) {
    vec4 mu = nsum * (1.0 / 9.0);
    vec4 sg = sqrt(max(nsq * (1.0 / 9.0) - mu * mu, 0.0));
    lo = max(mn, mu - VCLIP * sg);
    hi4 = min(mx, mu + VCLIP * sg);
  }
#endif
  vec4 hist = clamp(histRaw, lo, hi4);
#if defined(ADAPT) || defined(MAG)
  if (c12b && blend < 1.0) {
    float bMove = B_MAX;
  #ifdef ADAPT
    vec2 fr = fract(hp - 0.5);
    float sub = fr.x * (1.0 - fr.x) + fr.y * (1.0 - fr.y);
    bMove = mix(B_MIN, B_MAX, clamp(K_SUB * sub, 0.0, 1.0));
  #endif
  #ifdef MAG
    blend = mix(B_MIN, bMove, smoothstep(MAG_LO, MAG_HI, length(hp - fc)));
  #else
    blend = bMove;
  #endif
  #ifdef ADAPT_CLAMP
    vec3 dd = abs(histRaw.rgb - hist.rgb);
    float rel = dot(dd, vec3(0.2126, 0.7152, 0.0722)) / (dot(hi4.rgb - lo.rgb, vec3(0.2126, 0.7152, 0.0722)) + 1e-12);
    blend = max(blend, mix(B_MIN, B_MAX, clamp(rel * ADAPT_CLAMP, 0.0, 1.0)));
  #endif
  }
#elif defined(B_CONST)
  if (c12b && blend < 1.0) blend = B_CONST;
#endif
  gl_FragColor = mix(hist, cur, blend);`;

const TAIL_TRUTH = /* glsl */ `
  // 真值：静止、不夹取、逐帧等权平均（第 k 帧 blend = 1/(k+1)）
  gl_FragColor = mix(texelFetch(uHistory, ip + ivec2(depthHalf ? int(uCloudResolution.x) : 0, 0), 0), cur, 1.0 / (uTruthK + 1.0));`;

function must(s, a) { if (!s.includes(a)) throw new Error("resolve 原文里找不到：" + a.slice(0, 60)); }

/** defines：字符串，如 "CR_MODE 1;ADAPT;B_MIN 0.04"；"master" 返回原文；"truth" 返回真值累积版 */
export function resolveVariant(master, defines) {
  if (defines === "master") return master;
  let s = master;
  must(s, TAIL_OLD);
  must(s, "void main() {");
  if (defines === "truth") {
    s = s.replace("void main() {", "uniform float uTruthK;\nvoid main() {");
    return s.replace(TAIL_OLD, TAIL_TRUTH);
  }
  must(s, "vec4 nsum = vec4(0.0);");
  must(s, "    nsum += s;");
  const defs = { CR_MODE: "0", B_MIN: "0.04", B_MAX: "0.12", K_SUB: "4.0", MAG_LO: "0.02", MAG_HI: "0.1" };
  const flags = [];
  for (const part of defines.split(";").map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split(/\s+/);
    if (v === undefined) flags.push(k); else defs[k] = v;
  }
  const head = Object.entries(defs).map(([k, v]) => `#define ${k} ${v}`).concat(flags.map((k) => `#define ${k}`)).join("\n") + "\n";
  s = s.replace("void main() {", HELPERS + "void main() {");
  s = s.replace("vec4 nsum = vec4(0.0);", "vec4 nsum = vec4(0.0), nsq = vec4(0.0);");
  s = s.replace("    nsum += s;", "    nsum += s;\n    nsq += s * s;\n#ifdef DEPTH3\n    if (!depthHalf) { float ow = 1.0 - s.a; dsum += texelFetch(uCurrentDepth, q, 0).r * CLOUD_DEPTH_SCALE * ow; wsum += ow; }\n#endif");
  s = s.replace("vec4 nsum = vec4(0.0), nsq = vec4(0.0);", "vec4 nsum = vec4(0.0), nsq = vec4(0.0);\n  float dsum = 0.0, wsum = 0.0;");
  must(s, "  vec3 prevDir = normalize(rd * dCur + uMotion);");
  s = s.replace("  vec3 prevDir = normalize(rd * dCur + uMotion);", "  float dRep = dCur;\n#ifdef DEPTH3\n  if (!depthHalf && wImm <= 0.0 && wsum > 1e-3) dRep = dsum / wsum;\n#endif\n  vec3 prevDir = normalize(rd * dRep + uMotion);");
  s = s.replace(TAIL_OLD, TAIL_NEW);
  return head + s;
}
