// T12 按 pass 归因：生成 passes.mjs --variants 用的 JSON（页面内换云步进片段，每个变体都从原始着色器出发）。
// 用法：node handoff/T12-mkvar.mjs > tmp/perf-cloud/t12var.json
const V2 = {
  base: [],
  noSin: [["1.3 * sin(along * 0.13 + 5.0 * wx.warp.x) + ", "3.0 * wx.warp.x + "]],
  noWx: [["sampleWeather(xz - HIGH_WIND * (along0 * 0.67 * cir))", "sampleWeather(xz)"]],
  noCir: [["float cir = 1.0 - smoothstep(0.0, 0.2, uCloudType);", "float cir = 0.0;"]],
};
const V = process.argv[2] === "2" ? V2 : {
  base: [],
  noFwd: [["float sunScatter = 0.6 * hg(cosT, 0.9) * exp(-0.25 * od);", "float sunScatter = 0.0;"]],
  noCir: [["float cir = 1.0 - smoothstep(0.0, 0.2, uCloudType);", "float cir = 0.0;"]],
  noMean: [["} else d = remapc(d, 0.275 + 0.1 * cir, 1.0, 0.0, 1.0);", "}"]],
  noBase: [["float hB = h + (1.0 - cir)", "float hB = h + 0.0 * (1.0 - cir)"]],
  noBottom: [["dmod * (0.55 + 0.25 * (1.0 - smoothstep(0.0, 0.15, h)) + 0.2 * cir)", "dmod * (0.55 + 0.2 * cir)"]],
};
const out = Object.entries(V).map(([name, pairs]) => ({
  name,
  wait: 25000,
  js: `(() => { const m = window.__voyage.clouds.marchMat; window.__t12o ??= m.fragmentShader; let s = window.__t12o;
    for (const [a, b] of ${JSON.stringify(pairs)}) { if (!s.includes(a)) throw new Error("miss " + a); s = s.split(a).join(b); }
    m.fragmentShader = s; m.needsUpdate = true; })()`,
}));
console.log(JSON.stringify(out));
