// T12 定位第四轮：不带细节的层状云样本按细节噪声的均值侵蚀（不取纹理），受光步进后 3 步不再偏胖
const rm = (pairs) => `window.__t45.replaceMarch(${JSON.stringify(pairs)})`;
const A = "d = remapc(d, dmod * 0.55, 1.0, 0.0, 1.0);\n  }";
export const VARIANTS = [
  { name: "base" },
  { name: "mean", js: rm([[A, "d = remapc(d, dmod * 0.55, 1.0, 0.0, 1.0);\n  } else d = remapc(d, 0.275, 1.0, 0.0, 1.0);"]]), wait: 8000 },
  { name: "mean35", js: rm([[A, "d = remapc(d, dmod * 0.55, 1.0, 0.0, 1.0);\n  } else d = remapc(d, 0.35, 1.0, 0.0, 1.0);"]]), wait: 8000 },
  { name: "detail6", js: rm([["od += layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3) * ls;", "od += layerDensity(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, true) * ls;"]]), wait: 8000 },
];
