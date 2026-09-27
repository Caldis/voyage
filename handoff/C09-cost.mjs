// C09：scripts/passes.mjs --variants 用（同页换云步进片段，按 pass 计 GPU 时间）。变体见 C09-ab.mjs；
// 只测环境变量 C09_COST 列出的变体（逗号分隔，缺省 new,old,new,old——同页交替两轮）
import { VARIANTS as V } from "./C09-ab.mjs";
const names = (process.env.C09_COST || "new,old,new,old").split(",");
export const VARIANTS = names.map((n) => [n, V[n].march]);
