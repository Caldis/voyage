// TW01 改坏矩阵：每条规则只改一处（复制到 src/tw01-sab/，不动正式文件），跑 weather-stats --only towering，列出失败的断言
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
// 用法（在 apps/voyage 下）：node handoff/TW01-sabotage.mjs [段=towering] [规则序号,逗号分隔] [传给 weather-stats 的其他参数，如 --multi]
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const dir = `${root}/src/tw01-sab`;
const only = process.argv[2] ?? "towering";
const RULES = [
  ["去掉海上季风槽 / 暖洋面对流项", "weather.ts", "base += (0.42 * mon + 0.3 * warm)", "base += 0 * (0.42 * mon + 0.3 * warm)"],
  ["去掉暖洋面的浓积云加分", "weather.ts", "(isLand ? 0 : 0.4 * this.warmOcean(lat, lon, t) * conv)", "0"],
  ["季风槽不压信风积云", "weather.ts", "* (1 - 0.75 * this.monsoonTrough(lat, lon, t));", ";"],
  ["砧顶改回改前公式", "weather.ts", "top: anvilBase + 1.8 * hash(i, j, k, s + 80 + c),", "top: 11.2 + 1.6 * trop + 1.6 * hash(i, j, k, s + 80 + c),"],
  ["暖洋面项不随季节（全年）", "weather.ts", "return smooth(0.7, 0.95, this.summer(t, lat)) * smooth(33, 26, lat)", "return smooth(33, 26, lat)"],
  ["季风槽不随季节（全年）", "weather.ts", "const s = smooth(0.6, 0.9, this.summer(t, lat));", "const s = 1;"],
  ["飑线间距改回固定 16 km", "weather.ts", "const sqGap = 10 + 12 * hash(i, j, k, s + 13);", "const sqGap = 16;"],
  ["飑线单体数改回固定 4 个", "weather.ts", "n - (hash(i, j, k, s + 12) < 0.4 ? 1 : 0)", "n"],
  ["名额挑选：另一侧也挑", "weather-director.ts", "    if (cross * side <= 0) continue;\n", ""],
  ["名额挑选：飞过去的也挑", "weather-director.ts", "    if (along < -PASSED_KM) continue;\n", ""],
];
const pick = process.argv[3] ? process.argv[3].split(",").map(Number) : RULES.map((_, i) => i);
const rows = [];
for (const i of pick) {
  const [name, file, a, b] = RULES[i];
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of ["weather.ts", "weather-director.ts"]) {
    let s = readFileSync(`${root}/src/${f}`, "utf8");
    if (f === "weather-director.ts") s = s.replace('from "./flight"', 'from "../flight"').replace('from "./clouds/clouds"', 'from "../clouds/clouds"').replace('from "./director"', 'from "../director"');
    if (f === file) {
      const n = s.split(a).length - 1;
      if (n !== 1) throw new Error(`${name}: 匹配 ${n} 处`);
      s = s.replace(a, b);
    }
    writeFileSync(`${dir}/${f}`, s);
  }
  let out = "";
  try {
    out = execFileSync("node", ["--import", "./scripts/lib/ts-resolve.mjs", "--experimental-transform-types", "--no-warnings", "scripts/weather-stats.mts", "--only", only, ...(process.env.TW_FULL ? [] : ["--quiet"]), "--src", "src/tw01-sab", ...process.argv.slice(4)], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  } catch (e) {
    out = e.stdout;
  }
  if (process.env.TW_FULL) console.log(`### ${name}
` + out.split("## 断言")[0]);
  const failed = out.split("\n").filter((l) => l.includes("**失败**") || / \*\*.*失败\*\* /.test(l)).map((l) => l.split("|").slice(1, 3).map((x) => x.trim()).join(" = "));
  rows.push(`| ${name} | ${failed.length ? failed.join("；") : "（无失败）"} |`);
  console.error(`${name}: ${failed.length} 条失败`);
}
rmSync(dir, { recursive: true, force: true });
console.log("| 改坏什么 | 失败的断言（值） |\n| --- | --- |\n" + rows.join("\n"));
