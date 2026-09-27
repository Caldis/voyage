// T12 按 pass 归因第四轮：在当前代码上逐项去掉一处改动（其余保留），找是哪一处把云步进推到慢的一档。
// 用法：node handoff/T12-mkvar4.mjs > tmp/perf-cloud/t12var5.json
const V = {
  base: [],
  noFwd: [["float sunScatter = 0.6 * hg(cosT, 0.9) * exp(-0.25 * od);", "float sunScatter = 0.0;"]],
  noPowder: [["mix(1.0, powder, 0.5 * (1.0 - smoothstep(0.3, 0.9, cosT)))", "mix(1.0, powder, 0.5)"]],
  noAmb: [["mix(ambFloor, 1.0, pow(h01, 0.7))", "mix(0.12, 1.0, pow(h01, 0.7))"]],
  noMean: [["} else d = remapc(d, 0.275 + 0.1 * cir, 1.0, 0.0, 1.0);", "}"]],
  noHB: [["base *= heightProfile(hB, uCloudType);", "base *= heightProfile(h, uCloudType);"]],
  noBottom: [["dmod * (0.55 + 0.25 * (1.0 - smoothstep(0.0, 0.15, h)) + 0.2 * cir)", "dmod * (0.55 + 0.2 * cir)"]],
  noCirBr: [["if (uCloudType < 0.2) {", "if (false) {"]],
};
const out = Object.entries(V).map(([name, pairs]) => ({
  name,
  wait: 25000,
  js: `(() => { const m = window.__voyage.clouds.marchMat; window.__t12o ??= m.fragmentShader; let s = window.__t12o;
    for (const [a, b] of ${JSON.stringify(pairs)}) { if (!s.includes(a)) throw new Error("miss " + a.slice(0, 60)); s = s.split(a).join(b); }
    m.fragmentShader = s; m.needsUpdate = true; })()`,
}));
console.log(JSON.stringify(out));
