// W00：生成 passes.mjs 的 --variants JSON——召唤测试体后，在页面里替换「奇观变体」步进着色器的片段，按 pass 计 GPU 时间。
// 用法：node apps/voyage/handoff/W00-mkvar.mjs <输出.json> [on|off-screen]
//   on：测试体放在窗口正前方 60 km；off-screen：放在身后（视线穿不过包围盒，只剩「用了变体」的结构开销）
// passes.mjs 要带 ?w00probe 打开页面（复制一份把 URL 改成 `/?perf=…&w00probe`）
import fs from "node:fs";
import { VARIANTS } from "./W00-variants-cost.mjs";
const [out, where = "on"] = process.argv.slice(2);
const fwd = where === "on" ? 0 : 180;
const js = (R) => `(()=>{const v=window.__voyage; const w=v.wonders; w.enabled=true; w.clear(); w.trigger('w00-probe',{forwardOffsetDeg:${fwd},distKm:60,reveal:1,baseKm:0});
const m=v.clouds.marchWonderMat; window.__ow ||= m.fragmentShader; let s=window.__ow; for (const [a,b] of ${JSON.stringify(R)}) { if(!s.includes(a)) throw new Error('miss '+a); s=s.split(a).join(b);} m.fragmentShader=s; m.needsUpdate=true;})()`;
fs.writeFileSync(out, JSON.stringify(VARIANTS.map(([name, R]) => ({ name, js: js(R), wait: 25000 }))));
