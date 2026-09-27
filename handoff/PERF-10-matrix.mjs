// PERF-10：逐场景两两求差矩阵（均值 / p99），判断「改动 vs 主分支」是否落在「同代码两次」的噪声范围内。
// 用法：node apps/voyage/handoff/PERF-10-matrix.mjs <根目录> <目录名1> <目录名2> ...（例如 base1 base2 new1 new2）
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const compare = path.join(here, "..", "scripts", "compare.mjs");
const [root, ...dirs] = process.argv.slice(2);
const scenes = readdirSync(path.join(root, dirs[0])).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4));
for (const s of scenes) {
  const cells = [];
  for (let i = 0; i < dirs.length; i++)
    for (let j = i + 1; j < dirs.length; j++) {
      const a = path.join(root, dirs[i], s + ".png");
      const b = path.join(root, dirs[j], s + ".png");
      if (!existsSync(a) || !existsSync(b)) continue;
      const out = execFileSync("node", [compare, "--diff", b, "--json", a], { encoding: "utf8" });
      const m = JSON.parse(out.slice(out.indexOf("{")));
      cells.push(`${dirs[i]}-${dirs[j]} ${m.mean.toFixed(2)}/${m.p99}`);
    }
  console.log(s.padEnd(22), cells.join("  "));
}
