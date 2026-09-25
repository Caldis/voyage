/**
 * 程序生成的岛屿（GLSL）——示例，不对应真实地理。依赖 CABIN_COMMON / PANE_COMMON 里的噪声函数。
 * 海面按 30 km 的格子撒岛：每格最多一个，按概率决定有没有，类型是火山高岛或珊瑚环礁。
 */
export const ISLANDS_COMMON = /* glsl */ `
uniform float uIslandDensity;   // 每格出现岛的概率 0..1

const float ISLAND_CELL = 30.0; // km

// x = 有符号距离（< 0 在陆地上，单位是岛半径的比例），y = 类型（0 高岛，1 环礁），z = 岛半径（km），
// w = 浅水程度 0..1（1 = 海底沙子透上来的碧绿浅水，0 = 深海）
vec4 islandField(vec2 xz) {
  vec2 id = floor(xz / ISLAND_CELL);
  vec4 best = vec4(10.0, 0.0, 1.0, 0.0);
  for (int i = -1; i <= 1; i++)
  for (int j = -1; j <= 1; j++) {
    vec2 c = id + vec2(i, j);
    vec2 h = hash22(c * 1.31 + 4.7);
    if (h.x > uIslandDensity) continue;
    vec2 h2 = hash22(c * 2.77 + 1.9);
    vec2 center = (c + 0.2 + 0.6 * h2) * ISLAND_CELL;
    bool atoll = h.y > 0.55;
    float radius = atoll ? mix(2.0, 6.0, h2.x) : mix(0.6, 3.5, h2.y);
    vec2 p = xz - center;
    if (dot(p, p) > radius * radius * 4.0) continue;
    // 海岸线：用噪声扭曲圆形，得到不规则的轮廓和小半岛
    vec2 warp = vec2(fbm2(p * 0.9 / radius + h * 17.0), fbm2(p * 0.9 / radius + h * 31.0)) - 0.5;
    float r = length(p + warp * radius * 0.6) / radius;
    float d;
    float shallow;
    if (atoll) {
      // 环礁：一圈窄窄的礁岛，礁上有缺口（水道）；圈内是潟湖，整片浅水
      float gaps = fbm2(p * 5.0 / radius + h * 3.0);
      d = abs(r - 0.85) - 0.06 * smoothstep(0.35, 0.55, gaps);
      shallow = r < 0.85 ? 0.75 : 1.0 - smoothstep(0.9, 1.1, r);
    } else {
      d = r - 1.0 + 0.25 * (fbm2(p * 3.0 / radius + h * 7.0) - 0.5);
      // 岸边的浅水带，外缘是珊瑚礁（宽窄随噪声变化）
      shallow = 1.0 - smoothstep(0.0, 0.18 + 0.15 * fbm2(p * 2.0 / radius + h * 5.0), d);
    }
    if (d < best.x) best = vec4(d, atoll ? 1.0 : 0.0, radius, max(shallow, best.w));
    else best.w = max(best.w, shallow);
  }
  return best;
}

// 高岛的地形高度（km）：中间高、海岸低，带山脊
float islandHeight(vec2 xz, vec4 f) {
  if (f.y > 0.5) return 0.003 * clamp(-f.x * 20.0, 0.0, 1.0);
  float inland = clamp(-f.x, 0.0, 1.0);
  float ridges = 1.0 - abs(fbm2(xz * 2.5) * 2.0 - 1.0);
  return f.z * 0.25 * pow(inland, 0.8) * mix(0.6, 1.0, ridges);
}
`;
