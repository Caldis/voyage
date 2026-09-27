// T44 定位：雨带云为什么是沙土色（15:00，太阳约 52°）
export const VARIANTS = [
  { name: "base" },
  // 去掉台风的体积阴影空气透视（被当成在卷云盖影子里的空气不再散射阳光）
  { name: "noShadowAP", js: `window.__t45.replaceMarch([["if (nearHur && uSunDir.y > 0.02) {", "if (false) {"]])` },
  // 去掉卷云盖（完整密度）
  { name: "nocanopy", js: `window.__t45.replaceMarch([["if (canopy > d) { d = canopy;", "if (false) { d = canopy;"]])` },
];
