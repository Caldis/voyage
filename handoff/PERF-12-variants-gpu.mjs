// PERF-12：把 PERF-12-variants.mjs 的「文件 + 查找 / 替换」转成 passes.mjs --variants 要的 [查找, 替换] 对
// （passes.mjs 在拼好的整段 fragmentShader 上替换，所有 *.glsl.ts 都逐字拼在里面）。
import { VARIANTS as FX } from "./PERF-12-variants.mjs";
export const VARIANTS = FX.map(([name, list]) => [name, list.map((x) => [x.find, x.replace])]);
