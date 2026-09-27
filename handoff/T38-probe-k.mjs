// T38 定位：窗外 pass 输出 (地面距离 km, 云缓冲里的平均深度 km, 去掉山后云之后的透射率)，用来查 cloudBeforeGround 逐像素判断
export const PATCHES = [
  {
    mat: "outsideMat",
    target: "hdrOutside",
    replace: [
      [
        "  if (onGround) cloud = cloudBeforeGround(cloud, cloudBufferDepth(uClouds, gl_FragCoord.xy / uResolution), tGround);",
        "  float dbgD = cloudBufferDepth(uClouds, gl_FragCoord.xy / uResolution); float dbgA = cloud.a;\n  if (onGround) cloud = cloudBeforeGround(cloud, dbgD, tGround);\n  return vec3(onGround ? tGround : -1.0, dbgD, cloud.a + 10.0 * floor(dbgA * 100.0));",
      ],
      ["view = (view * tr.a + tr.rgb + boltRadiance(rdW)) * PANE_TRANSMITTANCE;", "view = view;"],
    ],
  },
];
