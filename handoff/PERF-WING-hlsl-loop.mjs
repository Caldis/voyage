// PERF-WING：在 ANGLE 翻出的 HLSL 上直接试 [loop] / [fastopt] 等属性对 fxc /O1 时间的影响（ANGLE 下 GLSL 写不出这些属性，
// 只作「值不值得去找 ANGLE 开关」的参考）。
// 用法：node handoff/PERF-WING-hlsl-loop.mjs <wing.hlsl（shader-budget --keep-hlsl 留下的）> [轮数]
// 需要外层持测量锁：node scripts/measure-lock.mjs run -- node handoff/PERF-WING-hlsl-loop.mjs …
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [src, roundsArg] = process.argv.slice(2);
const rounds = +(roundsArg || 3);
const kits = "C:/Program Files (x86)/Windows Kits/10/bin";
const ver = fs.readdirSync(kits).filter((v) => fs.existsSync(path.join(kits, v, "x64", "fxc.exe"))).sort().pop();
const fxc = path.join(kits, ver, "x64", "fxc.exe");
const text = fs.readFileSync(src, "utf8");
const TRACE = /\{ for\(int (_i\d+) = min\(_uWingSteps, 0\); \(\1 < _total\d+\);/;
const KLOOP = /\{LOOP for\(int (_k\d+) = min\(_uWingSteps, 0\); \(\1 < 5\);/;
const must = (s, re, rep) => { if (!re.test(s)) throw new Error("找不到 " + re); return s.replace(re, rep); };
const variants = [
  ["原样", text, []],
  ["定义 ANGLE_ENABLE_LOOP_FLATTEN（LOOP = [loop]）", text, ["/D", "ANGLE_ENABLE_LOOP_FLATTEN=1"]],
  ["求交循环加 [loop]", must(text, TRACE, (m) => m.replace("{ for", "{ [loop] for")), []],
  ["求交循环加 [fastopt]", must(text, TRACE, (m) => m.replace("{ for", "{ [fastopt] for")), []],
  ["子射线循环去掉 LOOP", must(text, KLOOP, (m) => m.replace("{LOOP for", "{ for")), []],
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perfwing-hlsl-"));
const res = variants.map(() => []);
for (let r = 0; r < rounds; r++) {
  variants.forEach(([name, s, extra], i) => {
    const f = path.join(dir, `v${i}.hlsl`);
    fs.writeFileSync(f, s);
    const t0 = Date.now();
    let ok = true;
    try {
      execFileSync(fxc, ["/nologo", "/T", "ps_5_0", "/E", "main", "/O1", ...extra, "/Fo", "NUL", "/Fc", f + ".asm", f], { stdio: ["ignore", "pipe", "pipe"] });
    } catch { ok = false; }
    const ms = Date.now() - t0;
    const asm = ok ? fs.readFileSync(f + ".asm", "utf8") : "";
    const slots = (asm.match(/Approximately (\d+) instruction slots/) || [])[1];
    res[i].push({ ms, ok, slots });
    console.log(`第 ${r + 1} 轮 ${name}：${ok ? ms + " ms，slots=" + slots : "编译失败"}`);
  });
}
console.log("\n== 最小值 ==");
const base = Math.min(...res[0].map((x) => x.ms));
variants.forEach(([name], i) => {
  const m = Math.min(...res[i].map((x) => x.ms));
  console.log(`${name}: ${m} ms（${(((m / base) - 1) * 100).toFixed(1)}%）slots=${res[i][0].slots}`);
});
fs.rmSync(dir, { recursive: true, force: true });
