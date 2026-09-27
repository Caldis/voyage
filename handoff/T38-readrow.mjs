// 把 probe.mjs 打印的一行读数（窗外 pass，T38-probe-k 补丁）整理成表：x、地面距离、云深度、原透射率、处理后透射率
import fs from "node:fs";
const txt = fs.readFileSync(process.argv[2], "utf8");
const line = txt.split("\n").find((l) => l.includes("@"));
const m = line.match(/@ \((\d+),(\d+)\)/);
const x0 = Number(m[1]);
const rows = JSON.parse(line.slice(line.indexOf(": [[") + 2));
const r = rows[0];
for (let i = 0; i < r.length / 4; i++) {
  const [t, D, packed] = r.slice(i * 4, i * 4 + 3);
  const a0 = Math.floor(packed / 10) / 100;
  const a1 = packed - 10 * Math.floor(packed / 10);
  if (a0 < 0.99) console.log(x0 + i, "tG", t.toFixed(1), "D", D.toFixed(1), "D/t", (D / t).toFixed(2), "T", a0.toFixed(2), "->", a1.toFixed(2));
}
