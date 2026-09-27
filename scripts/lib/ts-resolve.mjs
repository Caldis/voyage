// DX-11：node 直接跑 apps/voyage 下 .ts/.mts 离线单测的标准入口（收编自 handoff/T49-resolve.mjs，T49
// 起就在用；这里固定成正式路径，往后新的离线单测都 --import 这一份，不用各任务各自在 handoff/ 下复制一份）。
//
// 解决的问题：src/ 下的相对导入按仓库约定不带扩展名（`import { foo } from "./bar"`），但 node 原生的
// 类型剥离（`--experimental-strip-types` / `--experimental-transform-types`）不会像 vite/tsc 那样自动
// 补全 .ts 后缀，直接跑会报 `ERR_MODULE_NOT_FOUND`。这里注册一个模块解析 hook：相对导入解析失败时补一个
// .ts 后缀再试一次，其余情况（已经带扩展名、绝对路径导入、node_modules 里的包）原样交给下一个 resolver。
//
// 用法（在 apps/voyage 目录下）：
//   node --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings <文件>.mts
// `--experimental-transform-types` 是 node 原生类型剥离的开关（把 TS 特有语法直接擦除，不做类型检查，
// 不需要装 ts-node / tsx）；`--no-warnings` 压掉这个特性目前还带的实验性警告。已知在用的例子：
//   scripts/weather-stats.mts（不需要这个 hook：它的导入本来就写了 .ts 扩展名，直接 --experimental-transform-types 即可）
//   handoff/T49-sim.mts / handoff/T49-test.mts（T49 的航向 / 坡度曲线离线复现，导入 src/*.ts 不带扩展名，需要这个 hook）
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith("./") || spec.startsWith("../")) && !/\\.[cm]?[jt]s$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`),
  import.meta.url,
);
