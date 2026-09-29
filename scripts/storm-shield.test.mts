// 砧盾外接椭圆的单测（PERF-TW04）：随机单体，足迹内随机点必须都在椭圆里；报告椭圆 / 旧外接圆面积比。
// 运行：node --experimental-transform-types --no-warnings scripts/storm-shield.test.mts
// 改了 anvilShield 的足迹（shieldAxes、wh、中线弯曲）必须同步改 storm-shield.ts 并跑这个测试，否则视线包围判断会漏掉砧盾
import { fitShieldEllipse, shieldInsideAL, shieldShape } from "../src/clouds/storm-shield.ts";

let fail = 0;
let ratioSum = 0;
let n = 0;
let worst = 0;
for (let it = 0; it < 400; it++) {
  const R = 3.5 + Math.random() * 3.5;
  const s = shieldShape(R, [Math.random(), Math.random()]);
  // 故意扰动一点形状参数：±0.2%
  const e = fitShieldEllipse(R, s);
  const sp = { Lx: s.Lx * (1 + (Math.random() - 0.5) * 0.004), Ly: s.Ly * (1 + (Math.random() - 0.5) * 0.004), k: s.k + (Math.random() - 0.5) * 0.001 };
  for (let j = 0; j < 20000; j++) {
    const a = -sp.Ly + Math.random() * (sp.Lx + sp.Ly);
    const l = (Math.random() - 0.5) * 2 * (R * 1.9 + 0.36 * sp.Lx + 0.25 * sp.Lx);
    if (!shieldInsideAL(a, l, R, sp)) continue;
    const q = ((a - e.a0) / e.A) ** 2 + ((l - e.l0) / e.B) ** 2;
    worst = Math.max(worst, q);
    if (q >= 1) fail++;
  }
  const rc = (s.Lx + s.Ly) * 0.5 + R * 2.5 + 8;
  ratioSum += (e.A * e.B) / (rc * rc);
  n++;
}
console.log(`fail=${fail} worst q=${worst.toFixed(4)} 椭圆/外接圆 面积比 平均 ${(ratioSum / n).toFixed(3)}`);
process.exit(fail ? 1 : 0);
