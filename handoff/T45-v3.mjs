// T45 改后读数：日盘处、雨幡处的云 RGBA
const readPts = `(() => { const out = {}; for (const [x, y] of [[760, 507], [720, 725], [760, 720], [800, 715]]) out[x + "," + y] = window.__t45.readCloud(x, y).map((v) => +v.toPrecision(4)); return out; })()`;
export const VARIANTS = [{ name: "fix", read: readPts }];
