// T44 定位：斜直线是不是占据网格（±128 km 的方盒）或步数用完的边
export const VARIANTS = [
  { name: "base" },
  { name: "noocc", js: `window.__voyage.clouds.occEnabled = false`, restore: false },
  { name: "steps", js: `window.__voyage.clouds.occEnabled = true; window.__t45.replaceMarch([["for (int i = 0; i < 448; i++) {", "for (int i = 0; i < 1400; i++) {"]])` },
  { name: "nocull", js: `window.__voyage.clouds.marchMat.uniforms.uWeatherCull.value = 0`, restore: false },
];
