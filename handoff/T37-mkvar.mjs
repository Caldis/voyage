// 由 v-*.mjs 的 VARIANTS 生成 passes.mjs 用的 JSON（页面内替换云步进着色器片段）
import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
const [src, out] = process.argv.slice(2);
const { VARIANTS } = await import(pathToFileURL(path.resolve(src)).href);
const js = (R) => `(()=>{const m=window.__voyage.clouds.marchMat; window.__o ||= m.fragmentShader; let s=window.__o; for (const [a,b] of ${JSON.stringify(R)}) { if(!s.includes(a)) throw new Error('miss '+a); s=s.split(a).join(b);} m.fragmentShader=s; m.needsUpdate=true;})()`;
fs.writeFileSync(out, JSON.stringify(VARIANTS.map(([name, R]) => ({ name, js: js(R), wait: 12000 }))));
