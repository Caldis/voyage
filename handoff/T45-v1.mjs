// T45 定位第一轮：日盘 = 云透射率残差？椭圆 = 海面耀斑（云影缺失）？
const readSun = `(() => { const out = {}; for (const [x, y] of [[760, 507], [700, 600], [720, 725], [780, 740], [1100, 300]]) out[x + "," + y] = window.__t45.readCloud(x, y).map((v) => +v.toPrecision(4)); return out; })()`;
export const VARIANTS = [
  { name: "base", read: readSun },
  { name: "cs0", js: `window.__t45.replaceOutside([["float cs = cloudShadow(P, uKeyDir);", "float cs = 0.0;"]])` },
  { name: "Tzero", js: `window.__t45.replaceMarch([["gl_FragColor = vec4(min(L, vec3(60000.0)), T);", "gl_FragColor = vec4(min(L, vec3(60000.0)), T < 0.006 ? 0.0 : T);"]])`, wait: 8000, read: readSun },
  { name: "nodisk", js: `window.__t45.replaceOutside([["L += disk * coverage * sunTransmittance(uCamR, rd.y);", ""]])`, wait: 8000 },
];
