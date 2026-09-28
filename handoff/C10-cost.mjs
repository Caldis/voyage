// C10：scripts/passes.mjs --variants 用（同页换云步进片段，按 pass 计 GPU 时间）。
// nobis = 二分永不触发且饱和倍率回 3.5（运行时工作量等于改动前；分支本身的代价看离线 FXC 与 master 页面对照）
const NOBIS = [["(bis > 0 || (dens > 0.002 && wasEmpty && t < 60.0))", "(bis > 0)"], ["mix(4.5, 1.5, cir)", "mix(3.5, 1.5, cir)"]];
const V = { cur: [], nobis: NOBIS };
const names = (process.env.C10_COST || "cur,nobis,cur,nobis").split(",");
export const VARIANTS = names.map((n) => [n, V[n]]);
