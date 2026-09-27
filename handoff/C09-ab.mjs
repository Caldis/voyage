// C09 交付对照：new = 本分支（不改），old = 页面内把受光段改回 master 的写法（前向峰整份 hg(0.9)·e^(−0.25·od)、相函数在循环里算）。
// 给 handoff/C09-rim.mjs --vfile（VARIANTS 对象）；passes.mjs 用 handoff/C09-cost.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/clouds/clouds.ts"), "utf-8");
const cut = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error("C09-ab：找不到 " + a);
  return src.slice(i, j + b.length);
};
const NEW_SS = cut("      float pk = 0.75 * od;", "+ phBody * pk0;");
const OLD_SS = "      float sunScatter = 0.6 * hg(cosT, 0.9) * exp(-0.25 * od) + mix(hg(cosT, -0.25), hg(cosT, 0.8), 0.7) * exp(-od);";
const NEW_MS = cut("      float msDecay2 = msDecay * msDecay;", "exp(-msDecay2 * od);");
const OLD_MS = `      float msScatter = 0.0;
      float a = msDecay, b = msDecay, c = 0.5;
      for (int k = 1; k < 3; k++) {
        float phase = mix(hg(cosT, -0.25 * c), hg(cosT, 0.8 * c), 0.7);
        msScatter += a * phase * exp(-b * od);
        a *= msDecay; b *= msDecay; c *= 0.5;
      }`;
// 只把相函数挪出循环、前向峰不展宽（看「挪出循环」本身省多少）
const HOIST_SS = "      float sunScatter = 0.6 * phPeak.x * exp(-0.25 * od) + phBody * exp(-od);";

export const VARIANTS = {
  new: { march: [] },
  old: { march: [[NEW_SS, OLD_SS], [NEW_MS, OLD_MS]] },
  hoist: { march: [[NEW_SS, HOIST_SS]] },
  // 自检用：故意加一段很贵的循环，确认 passes.mjs 的变体真的换上了（换上了云步进会明显变慢）
  slow: { march: [["float pk = 0.75 * od;", "float pk = 0.75 * od; for (int q = 0; q < 64; q++) pk = pk + 1e-9 * sin(pk * float(q));"]] },
};
