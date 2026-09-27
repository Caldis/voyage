// PERF-10：卷云变体（CLOUD_CIRRUS，不带天气）和 master 的卷云变体（带全部天气代码）按 pass 对照、逐项归因。
// 用法：node scripts/passes.mjs --port 5210 --only cirrus-noon --variants handoff/PERF-10-variants-cirrus.mjs --material clouds.marchCirrusMat --target clouds.raw
const HEAD = "#ifdef CLOUD_WEATHER\n#define CLOUD_OCC 1";
const BREAK_DEF = "    if (t >= seg.y || T < 0.005 || i >= 192) break;";
export const VARIANTS = [
  ["base", []],
  // 等价于 master 的卷云变体：雷暴 + 台风代码都编进来（uniform 分支平时不走）
  ["+weather", [[HEAD, "#define CLOUD_WEATHER 1\n#define CLOUD_STORM 1\n#define CLOUD_TYPHOON 1\n" + HEAD]]],
  ["+storm", [[HEAD, "#define CLOUD_WEATHER 1\n#define CLOUD_STORM 1\n" + HEAD]]],
  // 192 步上限写成「常数 + 恒为 0 的 uniform」：FXC 看不出循环次数
  ["break-guard", [[BREAK_DEF, "    if (t >= seg.y || T < 0.005 || i >= 192 + min(uStormCount, 0)) break;"]]],
];
