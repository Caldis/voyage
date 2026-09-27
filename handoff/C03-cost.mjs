// C03：passes.mjs --variants 用（同页换云步进片段，按 pass 计 GPU 时间）。变体定义见 C03-diag.mjs；
// 只测环境变量 C03_COST 列出的变体（逗号分隔，缺省 base,prox25,quarter）
import { VARIANTS as V } from "./C03-diag.mjs";
const names = (process.env.C03_COST || "base,prox25,quarter").split(",");
export const VARIANTS = names.map((n) => [n, V[n].march || []]);
