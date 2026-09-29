// PERF-TW04 ③ 冷编译试法：精简密度里伴生塔的写法（shader-budget --variants，先停开发服务器）
const G = "src/clouds/clouds.glsl.ts";
const PICK_LOOP = `    float best = 1e9;
    vec4 sb = vec4(0.0, 0.0, 0.0, 1.0);
    vec2 hb = vec2(0.0);
    for (int k = 0; k < 4 + min(uStormCount, 0); k++) {
      if (k >= nSat) break;
      vec4 sa = uSatA[si * 4 + k];
      vec2 dd = xz - sa.xy;
      float d2 = dot(dd, dd) / (sa.w * sa.w);
      if (alt <= sa.z + 0.8 && d2 < best) { best = d2; sb = sa; hb = uSatB[si * 4 + k].xy; }
    }
    if (best < 1e9) sdf =`;
const PICK_ANG = `    vec2 dc = xz - c.xy;
    float an = atan(dc.y, dc.x) - sd.y * 6.2831853;
    an -= 6.2831853 * floor(an / 6.2831853 + 0.5);
    int kb = clamp(int(floor(an / 1.1 + 0.5 * float(nSat - 1) + 0.5)), 0, nSat - 1);
    vec4 sb = uSatA[si * 4 + kb];
    vec2 hb = uSatB[si * 4 + kb].xy;
    if (alt <= sb.z + 0.8) sdf =`;
export const VARIANTS = [
  ["pickLoop", []],
  ["pickAng", [{ file: G, find: PICK_LOOP, replace: PICK_ANG }]],
  ["liteMainOnly", [{ file: G, find: "  float sdf = stormTowersSdf(si, c, xz, alt, lod, true, ao);\n  float pilL = gPileusD;", replace: "  float sdf = towerSdf(xz, alt, c.xy, c.z, c.w + 0.7 + 0.6 * uStormSd[si].y, 0.72, lod, uStormSd[si].xy, 0.35, ao);\n  float pilL = 0.0;" }]],
  ["pickLoop2", []],
];
