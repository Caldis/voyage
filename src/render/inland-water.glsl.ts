/**
 * 湖泊、河流的水面（GLSL）。依赖 LIGHTS_COMMON（keyLight / skyIrradiance）/ CLOUD_COMMON（cloudShadow）/
 * PANE_COMMON（vnoise）/ OCEAN_COMMON（fresnelWater）。
 *
 * 为什么不直接用海面模型：海面的斜率场里有 250 m 的涌浪和几十米的风浪，按固定方向叠加。
 * 放在几十米宽的河上，低空时能看到规则的斜纹（波长与像素足迹接近，出现摩尔纹），而且河湖本来就没有涌浪。
 * 这里只有风吹出的细碎涟漪（波长 0.5–8 m），按像素足迹分成「看得清的法线扰动」和「看不清的粗糙度」两部分（LEAN 的思路，
 * 总斜率方差守恒），远处自然变成平滑的镜面 + 模糊的耀斑，不会出现摩尔纹。
 */
export const INLAND_WATER_COMMON = /* glsl */ `
#ifdef GROUND_DETAIL
// 值噪声的解析梯度（一次 4 个哈希；有限差分要 12 个，代码量大，FXC 冷编译慢）
vec2 vnoiseGrad(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return du * (vec2(b - a, c - a) + (a - b - c + d) * u.yx);
}

// 涟漪的高度梯度（单位：坡度）。两层噪声随风漂移；fp = 像素足迹（米），比像素细的层不画
vec2 rippleSlope(vec2 xzM, float fp, out float resolvedVar) {
  vec2 s = vec2(0.0);
  resolvedVar = 0.0;
  float windScale = clamp(uWind / 7.0, 0.1, 2.0);
  float lambda = 7.0;
  float amp = 0.05 * windScale;
  for (int i = 0; i < uTerrainSteps / 32; i++) {   // 3 层；上限借用 uniform，免得 FXC 展开
    float res = 1.0 - smoothstep(0.25, 0.6, fp / lambda);
    if (res > 0.0) {
      vec2 p = xzM / lambda + vec2(0.35, 0.2) * uTime / lambda * 1.5 + float(i) * 17.3;
      s += vnoiseGrad(p) * amp * res;
      resolvedVar += res * amp * amp * 1.5;
    }
    lambda *= 0.4;
    amp *= 0.85;
  }
  return s;
}
#endif

// 湖泊、河流在水面处的辐亮度（不含天空反射，天空反射由调用处按 fView 加）。
// body：水体本身的反射率（取影像的水色）；eSun / eSky：水面处主光源（已含云影）与天空光的照度，由调用处算好传进来
// （keyLight / cloudShadow 很重，在 FXC 里每调用一处就内联一份，冷编译会明显变慢）；nView 输出平均法线给天空反射用
vec3 inlandWaterRadiance(vec3 P, vec3 rd, float fp, vec3 body, vec3 eSun, vec3 eSky, out float fView, out vec3 nView) {
  vec3 n = normalize(P);
  vec3 v = -rd;
  float cosV = max(dot(n, v), 1e-3);
  float cosS = dot(n, uKeyDir);
  vec2 xzM = (P.xz + uCloudOffset) * 1000.0;
  float resVar = 0.0;
  vec2 sl = vec2(0.0);
#ifdef GROUND_DETAIL
  // 看得清的涟漪只在低空细节变体里画（高处像素足迹远大于涟漪波长，本来就全部并入粗糙度）
  sl = rippleSlope(xzM, fp, resVar);
#endif
  // 总斜率方差：内陆水面受岸和地形遮挡、风区短，按海面 Cox–Munk 的约一半风速算；看得清的部分已经画成法线，剩下的当粗糙度
  float totalVar = 0.003 + 0.00512 * 0.5 * uWind;
  float sigma2 = max(totalVar - resVar, 0.0015);
  nView = normalize(n - vec3(sl.x, 0.0, sl.y));
  float cosVn = max(dot(nView, v), 1e-3);
  float rough = sqrt(sigma2);
  fView = 0.02 + (max(1.0 - rough, 0.02) - 0.02) * pow(1.0 - cosVn, 5.0);
  vec3 L = (1.0 - fView) * body / M_PI * (eSun * max(cosS, 0.0) + eSky);
  // 太阳耀斑：与海面相同的 Cox–Munk 形式，斜率分布以涟漪法线为中心
  vec3 hv = normalize(uKeyDir + v);
  float cb = dot(hv, nView);
  if (cosS > 0.0 && cb > 0.0) {
    float cb2 = cb * cb;
    float tan2 = (1.0 - cb2) / cb2;
    float p = exp(-tan2 / sigma2) / (M_PI * sigma2);
    L += eSun * fresnelWater(dot(v, hv)) * p / (4.0 * cosV * cb2 * cb2);
  }
  return L;
}
`;
