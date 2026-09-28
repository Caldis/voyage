// SPEC-RAYS：云隙光三个 pass 的 GPU 计时（shots --pair 的 js，参数 v = window.__voyage；结果进截图 JSON 的 jsOut）。
// 每个部分 9 轮 × 20 次，取中位与最小值（ms / 次）
for (let i = 0; i < 300 && v.rays.state !== "ready"; i++) await new Promise((r) => setTimeout(r, 100));
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const out = { res: [v.hdrOutside.width, v.hdrOutside.height], active: v.rays.wanted };
for (const part of ["all", "march", "blur", "composite"]) {
  const xs = [];
  for (let k = 0; k < 9; k++) xs.push(await v.rays.bench(v.hdrOutside, 20, part));
  out[part] = { med: +med(xs).toFixed(4), min: +Math.min(...xs).toFixed(4) };
}
return JSON.stringify(out);
