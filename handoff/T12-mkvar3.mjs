// T12 按 pass 归因第三轮：把本任务的改动分块撤回，看云步进落在哪一档。
// 用法：node handoff/T12-mkvar3.mjs <master 的 clouds.glsl.ts 路径> > tmp/perf-cloud/t12var3.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cur = fs.readFileSync(path.join(HERE, "..", "src", "clouds", "clouds.glsl.ts"), "utf8");
const old = fs.readFileSync(process.argv[2], "utf8");
const cut = (s) => s.slice(s.indexOf("float layerDensity("), s.indexOf("// ---- 雷暴（积雨云）----"));
const LAYER = [[cut(cur), cut(old)]];
const MAIN = [
  ["float sunScatter = 0.6 * hg(cosT, 0.9) * exp(-0.25 * od);", "float sunScatter = 0.0;"],
  ["mix(1.0, powder, 0.5 * (1.0 - smoothstep(0.3, 0.9, cosT)))", "mix(1.0, powder, 0.5)"],
  ["mix(ambFloor, 1.0, pow(h01, 0.7))", "mix(0.12, 1.0, pow(h01, 0.7))"],
];
const V = { base: [], revLayer: LAYER, revMain: MAIN, revAll: [...LAYER, ...MAIN] };
const out = Object.entries(V).map(([name, pairs]) => ({
  name,
  wait: 25000,
  js: `(() => { const m = window.__voyage.clouds.marchMat; window.__t12o ??= m.fragmentShader; let s = window.__t12o;
    for (const [a, b] of ${JSON.stringify(pairs)}) { if (!s.includes(a)) throw new Error("miss " + a.slice(0, 60)); s = s.split(a).join(b); }
    m.fragmentShader = s; m.needsUpdate = true; })()`,
}));
console.log(JSON.stringify(out));
