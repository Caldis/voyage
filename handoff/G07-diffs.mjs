// G07：两组截图逐场景求差（compare.mjs --diff），一行一个场景：平均差 / p99 / 最大差 / 超阈值 8 占比。
// 用法（apps/voyage 下）：node handoff/G07-diffs.mjs <目录A> <后缀A> <目录B> <后缀B> [场景名,…]
// 例：同页 A/B  node handoff/G07-diffs.mjs X .a X .b ；跨版本  node handoff/G07-diffs.mjs X "" Y ""
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [dirA, sufA, dirB, sufB, only] = process.argv.slice(2);
const names = only
  ? only.split(",")
  : fs.readdirSync(dirA).filter((f) => f.endsWith(`${sufA}.png`)).map((f) => f.slice(0, -(sufA.length + 4))).filter((n) => !n.includes("."));
for (const n of names) {
  const a = path.join(dirA, `${n}${sufA}.png`), b = path.join(dirB, `${n}${sufB}.png`);
  if (!fs.existsSync(a) || !fs.existsSync(b)) { console.log(n, "缺图"); continue; }
  const r = spawnSync(process.execPath, [path.join(here, "../scripts/compare.mjs"), "--diff", b, "--json", a], { encoding: "utf8" });
  try {
    const d = JSON.parse(r.stdout);
    console.log(`${n.padEnd(22)} 平均 ${d.mean.toFixed(3)}  p99 ${d.p99}  最大 ${d.max}  >8 ${d.overThresholdPct}%`);
  } catch {
    console.log(n, r.stdout.slice(-300), r.stderr.slice(-300));
  }
}
