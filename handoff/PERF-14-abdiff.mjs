// PERF-14：对 shots --base-shader 的输出目录逐场景求 a−b（改动 vs 基线着色器）与 a−a2（噪声底），汇总成表
// 用法：node perf14-abdiff.mjs <worktree 根> <输出目录（相对仓库根）> [a 与 b 的后缀，默认 a,b]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [root, dirRel, pair = "a,b"] = process.argv.slice(2);
const [sa, sb] = pair.split(",");
const dir = path.resolve(root, dirRel);
const compare = path.join(root, "apps/voyage/scripts/compare.mjs");
const names = [...new Set(fs.readdirSync(dir).filter((f) => f.endsWith(`.${sa}.png`)).map((f) => f.slice(0, -`.${sa}.png`.length)))].sort();
const diff = (x, y, heat) => {
  const args = [compare, "--diff", path.join(dir, y), "--threshold", "8", "--json", path.join(dir, x)];
  if (heat) args.splice(1, 0, "--heatmap", path.join(dir, heat));
  const out = execFileSync(process.execPath, args, { encoding: "utf8", cwd: root });
  const j = JSON.parse(out.slice(out.indexOf("{")));
  const d = j.diff ?? j;
  return d;
};
const rows = [];
for (const n of names) {
  const b = `${n}.${sb}.png`;
  if (!fs.existsSync(path.join(dir, b))) continue;
  const ab = diff(`${n}.${sa}.png`, b, `${n}.heat.png`);
  const hasA2 = fs.existsSync(path.join(dir, `${n}.a2.png`));
  const aa = hasA2 ? diff(`${n}.${sa}.png`, `${n}.a2.png`) : null;
  rows.push({ n, ab, aa });
  console.log(`${n}\t a-${sb}: ${JSON.stringify(ab)}\t a-a2: ${aa ? JSON.stringify(aa) : "—"}`);
}
fs.writeFileSync(path.join(dir, "abdiff.json"), JSON.stringify(rows, null, 1));
