/**
 * 远处路过的飞机与航迹云（GLSL）。依赖 ATMOSPHERE_COMMON / LIGHTS_COMMON / VIEW_COMMON。
 * 坐标：窗外坐标（km），相机在原点附近（只关心相对位置，几十公里内忽略地球曲率）。
 *
 * 航迹云是一条从飞机往后延伸的直线：第 s 公里处的尾迹年龄 a = s / 航速。
 * 截面按高斯分布，宽度随年龄变宽（w = 20 m + 4 m/s · a），总冰量守恒，所以越老越淡；
 * 发动机后约 100 m 才开始凝结。冰晶前向散射很强（HG g ≈ 0.75），逆着太阳看最亮。
 */
export const TRAFFIC_COMMON = /* glsl */ `
uniform vec3 uTrafficPos[2];    // 那架飞机相对我们的位置（km，窗外坐标）
uniform vec3 uTrafficDir[2];    // 航向单位向量（相对空气）
uniform float uTrafficSpeed[2]; // 地速（km/s）
uniform float uTrafficActive[2];
uniform sampler3D uAerialInscatterS;
uniform sampler3D uAerialTransmittanceS;

float hgPhase(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * M_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// 返回 rgb = 航迹云和飞机的辐亮度（已加空气透视），a = 透射率
vec4 trafficRadiance(vec3 rd) {
  vec3 L = vec3(0.0);
  float T = 1.0;
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  for (int i = 0; i < 2; i++) {
    if (uTrafficActive[i] < 0.5) continue;
    vec3 A = uTrafficPos[i];
    vec3 D = -uTrafficDir[i];                 // 尾迹从飞机往后延伸
    float speed = uTrafficSpeed[i];
    const float MAX_AGE = 900.0;              // 秒：老于 15 分钟的尾迹已经散成卷云
    float lMax = speed * MAX_AGE;
    // 视线 t·rd 与尾迹 A + s·D 的最近点
    float b = dot(rd, D);
    float denom = 1.0 - b * b;
    if (denom < 1e-6) continue;
    float dA = dot(rd, A);
    float eA = dot(D, A);
    float s = clamp((b * dA - eA) / denom, 0.0, lMax);
    float t = dot(rd, A + D * s);
    if (t <= 0.0) continue;
    vec3 closest = A + D * s - rd * t;
    float dist = length(closest);
    float age = s / max(speed, 1e-3);
    float w = 0.02 + 0.004 * age;             // 截面宽度（km，1σ）
    float onset = smoothstep(0.08, 0.3, s);   // 发动机后约 100 m 才凝结
    float fade = 1.0 - smoothstep(MAX_AGE * 0.6, MAX_AGE, age);
    // 光学厚度：高斯截面，积分冰量守恒（∝ 1/w），视线斜穿时路径更长
    float sinT = sqrt(denom);
    float tau = 0.6 * (0.02 / w) * exp(-0.5 * dist * dist / (w * w)) / max(sinT, 0.15) * onset * fade;
    // 远处的尾迹细于像素时，按覆盖比例摊薄，免得闪烁
    float wPix = t * pixelAngle;
    tau *= w / max(w, wPix);
    if (tau > 1e-4) {
      vec3 up = vec3(0.0, 1.0, 0.0);
      vec3 eKey = keyLight(uCamR + A.y, up);
      float ph = mix(hgPhase(dot(rd, uKeyDir), 0.75), hgPhase(dot(rd, uKeyDir), -0.2), 0.25);
      vec3 amb = skyIrradiance(uCamR + A.y, up) / (2.0 * M_PI);
      vec3 Lc = (1.0 - exp(-tau)) * (eKey * ph + amb);
      // 空气透视
      vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, t);
      vec3 apT = texture(uAerialTransmittanceS, uvw).rgb;
      L += T * Lc * apT;
      T *= exp(-tau);
    }
    // 飞机本身：远处只有几个像素，白色机身被阳光照亮，偶尔把太阳反射过来一闪
    vec3 toA = A;
    float tA = dot(rd, toA);
    if (tA > 0.0) {
      float angDist = length(toA - rd * tA) / tA;
      float size = 0.02 / length(toA);        // 约 40 m 长的飞机，角半径
      float cover = clamp((size - angDist) / pixelAngle + 0.5, 0.0, 1.0) * clamp(size / pixelAngle, 0.0, 1.0);
      vec3 eKey = keyLight(uCamR + A.y, vec3(0.0, 1.0, 0.0));
      vec3 body = 0.6 / M_PI * eKey * (0.4 + 0.6 * max(uKeyDir.y, 0.0));
      // 机身或舷窗恰好把太阳反射过来时的一闪：随姿态轻微变化，这里用缓慢的时间调制近似
      float glint = pow(max(sin(uTime * 0.45 + float(i) * 2.1), 0.0), 60.0) * 8.0 * step(0.0, uKeyDir.y);
      vec3 uvw = aerialPerspectiveUvw(rd, uSunDir, tA);
      L = mix(L, (body * (1.0 + glint)) * texture(uAerialTransmittanceS, uvw).rgb, cover);
      T *= 1.0 - cover;
    }
  }
  return vec4(L, T);
}
`;
