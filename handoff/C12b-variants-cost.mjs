// C12b：给 scripts/passes.mjs --variants 用（--material clouds.resolveMat --target clouds.history.0 之类）。
// 每个变体整段替换 resolve 原文（master 原文取自 C12b-ab.mjs 输出目录里的 master-resolve.glsl，环境变量 C12B_MASTER 指定）。
import fs from "node:fs";
import { resolveVariant } from "./C12b-variants.mjs";
const master = fs.readFileSync(process.env.C12B_MASTER, "utf-8");
const defs = { cr12_d3_ad: "CR_MODE 2;DEPTH3;ADAPT", cr16_d3_ad: "CR_MODE 1;DEPTH3;ADAPT", cr5_d3_ad: "CR_MODE 3;DEPTH3;ADAPT", bl_d3_ad: "DEPTH3;ADAPT" };
// master 原文末尾加一个空行，逼它重编一次（和其他变体同样经历「换程序」的路径）
export const VARIANTS = [["master", [[master, master + "\n"]]], ...Object.entries(defs).map(([n, d]) => [n, [[master, resolveVariant(master, d)]]])];
