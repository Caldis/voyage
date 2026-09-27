// 把 probe.mjs 打印的一列读数（T38-probe-tower 补丁）按缓冲行号（左上原点，云缓冲按画质档可能小于屏幕）列成表：每 step 行一条
import fs from "node:fs";
const [file, stepArg] = process.argv.slice(2);
const step = Number(stepArg || 10);
for (const line of fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes(" @ ("))) {
  const m = line.match(/@ \((\d+),(\d+)\) (\d+)x(\d+)（目标 (\d+)x(\d+)/);
  const [x, y, , , , H] = m.slice(1).map(Number);
  const rows = JSON.parse(line.slice(line.indexOf(": [[") + 2));
  console.log(`x=${x}`);
  for (let j = rows.length - 1; j >= 0; j -= step) {
    const v = rows[j].slice(0, 4).map((a) => (Math.abs(a) < 0.01 && a !== 0 ? a.toExponential(2) : a.toFixed(3)));
    console.log(`  缓冲 y=${H - 1 - (y + j)}`, v.join("  "));
  }
}
