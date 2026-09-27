// T12 定位第三轮：逆光积云的受光光学厚度是哪一段贡献的
const rm = (pairs) => `window.__t45.replaceMarch(${JSON.stringify(pairs)})`;
const LOOP = "od += layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3) * ls;";
export const VARIANTS = [
  { name: "base" },
  // 受光步进全程带细节侵蚀（后 3 步不再是偏胖的大形）
  { name: "detail6", js: rm([[LOOP, "od += layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, true) * ls;"]]), wait: 8000 },
  // 只算前 3 步（约 0.4 km）：远处邻居的遮挡去掉
  { name: "near3", js: rm([[LOOP, "od += (j < 3 ? layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, true) : 0.0) * ls;"]]), wait: 8000 },
  // 只算后 3 步：只有远处
  { name: "far3", js: rm([[LOOP, "od += (j >= 3 ? layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, false) : 0.0) * ls;"]]), wait: 8000 },
];
