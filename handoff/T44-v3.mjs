// T44 定位：沙土色像素的云辐亮度（有 / 无空气透视）与透射率
const pts = [[1150, 540], [1170, 548], [1190, 540], [1120, 555], [1180, 560], [1060, 700], [600, 720]];
const rd = `(() => { const o = {}; for (const [x, y] of ${JSON.stringify(pts)}) o[x + "," + y] = window.__t45.readCloud(x, y).map((v) => +v.toPrecision(3)); return o; })()`;
export const VARIANTS = [
  { name: "base", read: rd },
  { name: "noAP", js: `window.__t45.replaceMarch([["L = L * apT + apL * (1.0 - T);", "L = L;"]])`, read: rd },
  { name: "apT", js: `window.__t45.replaceMarch([["L = L * apT + apL * (1.0 - T);", "L = apT * (1.0 - T);"]])`, read: rd },
  { name: "apL", js: `window.__t45.replaceMarch([["L = L * apT + apL * (1.0 - T);", "L = apL * (1.0 - T);"]])`, read: rd },
];
