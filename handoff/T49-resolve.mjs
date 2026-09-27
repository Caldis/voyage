// T49：让 node 直接跑 src/*.ts（源码里的相对导入不带扩展名，node 的类型剥离不会自动补 .ts）。
// 用法：node --import ./handoff/T49-resolve.mjs --experimental-transform-types handoff/T49-sim.mts
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
