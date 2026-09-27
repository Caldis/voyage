// PERF-10：把 passes.mjs 的日志按「场景 × 端口 × pass」汇总成各轮中位数的最小值 / 中位数（均值受个别长帧影响太大）。
// 用法：node apps/voyage/handoff/PERF-10-passes-sum.mjs <passes 日志> [pass 名,…]
import { readFileSync } from "node:fs";
const [file, want = "云步进,云步进(卷云变体),云步进(奇观变体),云resolve,窗外,舱内合成"] = process.argv.slice(2);
const passes = want.split(",");
const acc = new Map();
for (const line of readFileSync(file, "utf8").split("\n")) {
  const m = line.match(/^\s+(\S+) \[端口 (\d+)\]: (.*)$/);
  if (!m) continue;
  const [, scene, port, rest] = m;
  for (const it of rest.matchAll(/(\S+?)=([\d.]+)ms\(中位([\d.]+),n\d+\)/g)) {
    const key = `${scene}|${port}|${it[1]}`;
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key).push(Number(it[3]));
  }
}
const scenes = [...new Set([...acc.keys()].map((k) => k.split("|")[0]))];
const ports = [...new Set([...acc.keys()].map((k) => k.split("|")[1]))];
const fmt = (a) => {
  if (!a) return "—";
  const s = [...a].sort((x, y) => x - y);
  return `${s[0].toFixed(3)}/${s[Math.floor(s.length / 2)].toFixed(3)}`;
};
console.log(`场景 | pass | ${ports.map((p) => `${p} 最小/中位`).join(" | ")}`);
for (const sc of scenes)
  for (const p of passes) {
    const cells = ports.map((port) => acc.get(`${sc}|${port}|${p}`));
    if (cells.every((c) => !c)) continue;
    console.log(`${sc} | ${p} | ${cells.map(fmt).join(" | ")}`);
  }
