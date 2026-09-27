// T38 定位：云步进输出 (深度, 深度, 深度, T)，窗外 pass 输出 (地面求交距离 km, 云透射率, 云深度 km（云步进补丁把深度写进 rgb）)。
// 用法：node scripts/probe.mjs --port 5238 --scene '<fuji-dawn>' --patch handoff/T38-probe-depth.mjs \
//   --read '{"target":"clouds.raw","x":..,"y":..}' --read '{"target":"outside","x":..,"y":..}'
export const PATCHES = [
  {
    mat: "clouds.marchMat",
    target: "clouds.raw",
    replace: [["gl_FragColor = vec4(min(L, vec3(60000.0)), T);", "gl_FragColor = vec4(vec3(depth), T);"]],
  },
  {
    mat: "outsideMat",
    target: "hdrOutside",
    replace: [["return opticsComposite(L, cloud, rd);", "return vec3(hitGround ? tGround : -1.0, cloud.a, cloud.r);"],
              ["view = (view * tr.a + tr.rgb + boltRadiance(rdW)) * PANE_TRANSMITTANCE;", "view = view;"]],
  },
];
