/**
 * 海浪 FFT 的 GPU 着色器（全屏 pass）。三个级联并排放在一张图集里（宽 N·3、高 N），每个 pass 一次画完三级。
 * 全部用 texelFetch 按整数下标读，不经过过滤。
 */

const COMMON = /* glsl */ `
#define M_PI 3.14159265358979
uniform float uN;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

/**
 * 相位推进：h(k,t) = h0(k)·e^{−iωt} + conj(h0(−k))·e^{iωt}，再做成两组要逆变换的复数场：
 * A = i·kx·h + i·(i·kz·h)  → 逆 FFT 后实部 = ∂h/∂x，虚部 = ∂h/∂z（两个实场塞进一个复数场）
 * B = |k|·h + i·h          → 逆 FFT 后实部 = Σ|k|·h（水平位移散度的负值，算雅可比 / 泡沫），虚部 = 波高 h
 * ω 按 ω0 = 2π/T 量化（Tessendorf 2001 的做法），波场以 T 为周期，相位可以用 fract 精确算，时间再长也不丢精度。
 */
export const EVOLVE_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uH0;
uniform vec3 uSize;     // 各级平铺尺寸（m）
uniform float uTau;     // (t mod T) / T
uniform float uOmega0;  // 2π / T
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = int(uN);
  int c = p.x / n;
  int x = p.x - c * n;
  float L = c == 0 ? uSize.x : (c == 1 ? uSize.y : uSize.z);
  float mx = float(x < n / 2 ? x : x - n);
  float mz = float(p.y < n / 2 ? p.y : p.y - n);
  vec2 kv = vec2(mx, mz) * (2.0 * M_PI / L);
  float k = length(kv);
  vec4 h0 = texelFetch(uH0, p, 0);
  // 深水色散关系，带表面张力修正（k_m = 370 rad/m，只影响厘米级的波）
  float w = sqrt(9.81 * k * (1.0 + k * k / (370.0 * 370.0)));
  float nw = floor(w / uOmega0);
  float ph = 2.0 * M_PI * fract(nw * uTau);
  vec2 e = vec2(cos(ph), sin(ph));
  vec2 h = cmul(h0.xy, vec2(e.x, -e.y)) + cmul(h0.zw, e);
  vec2 A = vec2(-kv.x * h.y - kv.y * h.x, kv.x * h.x - kv.y * h.y);
  vec2 B = vec2(k * h.x - h.y, k * h.y + h.x);
  gl_FragColor = vec4(A, B);
}
`;

/**
 * Stockham 基 2 逆 FFT 的一级（自然顺序进、自然顺序出，不需要位反转）。
 * uSub = 本级子变换长度 2^(s+1)；uHoriz = 1 沿 x（每个级联各自在自己的 N 列内变换），0 沿 y。
 */
export const BUTTERFLY_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uSrc;
uniform float uSub;
uniform int uHoriz;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = int(uN);
  int sub = int(uSub);
  int halfSub = sub / 2;
  int idx = uHoriz == 1 ? p.x - (p.x / n) * n : p.y;
  int even = (idx / sub) * halfSub + (idx - (idx / halfSub) * halfSub);
  int odd = even + n / 2;
  ivec2 pe = uHoriz == 1 ? ivec2(p.x - idx + even, p.y) : ivec2(p.x, even);
  ivec2 po = uHoriz == 1 ? ivec2(p.x - idx + odd, p.y) : ivec2(p.x, odd);
  vec4 E = texelFetch(uSrc, pe, 0);
  vec4 O = texelFetch(uSrc, po, 0);
  float q = float(idx - (idx / sub) * sub);
  float ang = 2.0 * M_PI * q / uSub; // 逆变换取 +
  vec2 tw = vec2(cos(ang), sin(ang));
  gl_FragColor = vec4(E.xy + cmul(tw, O.xy), E.zw + cmul(tw, O.zw));
}
`;

/**
 * 写进纹理数组的一层（一个级联）：R = ∂h/∂x，G = ∂h/∂z，B = (∂h/∂x)² + (∂h/∂z)²，A = Σ|k|·h。
 * B 存二阶矩，mip 过滤以后 B − R² − G² 就是这个像素内看不清的斜率方差（LEAN mapping，Olano & Baker 2010）。
 */
export const FINALIZE_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uSrc;
uniform float uLayer;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 f = texelFetch(uSrc, ivec2(int(uLayer) * int(uN) + p.x, p.y), 0);
  gl_FragColor = vec4(f.x, f.y, f.x * f.x + f.y * f.y, f.z);
}
`;
