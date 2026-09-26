/**
 * 通用的小噪声函数（GLSL）：窗外（海面、内陆水面、低空地面细节）和舱内（窗板、舱壁）都要用。
 *
 * 为什么单独一个文件（SC-5）：场景拆成「窗外」和「舱内合成」两个程序以后，浏览器的程序缓存按源码文本命中。
 * 这几个函数原来写在 cabin.glsl.ts 里，窗外程序为了用它们就得把整份 CABIN_COMMON 拼进去，
 * 改一行舱内代码就会让窗外那个大程序（冷编译十几秒）也跟着重编。拆出来以后窗外程序只拼这一小段。
 * 这里的内容两个程序都会重编，改之前想清楚。
 */
export const NOISE_COMMON = /* glsl */ `
// 恒为 0。循环上限写成「常数 + uLoopGuard」，Windows 上 ANGLE → FXC 就无法把循环展开：
// 舱内加了座椅之后，全部展开的场景着色器编译 80 多秒后直接失败（链接报错、日志为空）
uniform int uLoopGuard;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4 + uLoopGuard; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`;
