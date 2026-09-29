// 汇总 parity.mjs 的日志：node parity-sum.mjs <日志>
import fs from "node:fs";
const txt = fs.readFileSync(process.argv[2], "utf8").replace(/^﻿/, "");
let n = 0;
for (const l of txt.split(/\r?\n/)) {
  const i = l.indexOf(" {");
  if (i < 0) continue;
  let r;
  try { r = JSON.parse(l.slice(i + 1)); } catch { continue; }
  n++;
  const f = (o) => Object.entries(o || {}).map(([k, v]) => `${k}:${v.diff}`).join(" ");
  console.log(l.slice(0, i).padEnd(20), `太阳 ${r.sunAlt?.toFixed(1)}° 月亮 ${r.moonAlt?.toFixed(1)}°`, r.apState?.dominant, r.apState?.second ? "两路" : "单路",
    `| cur-old ${f(r.curVsOld)} | cur2-old2 ${f(r.cur2VsOld2)} | cur-cur2 ${f(r.curVsCur2)} | old-old2 ${f(r.oldVsOld2)}`, r.error || "", `错误 ${r.errors?.length}`);
}
console.log("场景数", n);
