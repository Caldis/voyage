// C10c：把 C10c-var.mjs 里的文本补丁变体转成 `dev-browser.mjs ab` / `gpu-ab` 的 job 文件（patch 作用在 clouds.marchMat = 当前实际画的步进变体）
// 用法：node handoff/C10c-mkjobs.mjs <输出 json> <场景[:crop x,y,w,h],...> <变体,...> [--dump] [--ref]
//   变体名 cur / cur2 = 不打补丁；--ref 追加 builtin cloud-ref / cloud-dist；--dump 给 job 加 cloudDump
import fs from "node:fs";
import { VARIANTS } from "./C10c-var.mjs";

const [out, scenesArg, varsArg, ...flags] = process.argv.slice(2);
const variants = varsArg.split(",").map((vn) => {
  const p = VARIANTS[vn];
  if (p === undefined) throw new Error("没有变体 " + vn);
  return p.length ? { name: vn, patch: { "clouds.marchMat": p.map(([a, b, o]) => (o ? [a, b, true] : [a, b])) } } : { name: vn };
});
if (flags.includes("--ref")) variants.push({ name: "ref", builtin: "cloud-ref" }, { name: "dist", builtin: "cloud-dist" });
// 场景表里没有的（cu-side、graze-sc 等 C10 系列的临时场景）从 C10c-scenes.json 取对象
const extra = JSON.parse(fs.readFileSync(new URL("./C10c-scenes.json", import.meta.url), "utf-8"));
const { SCENES } = await import("../scripts/scenarios.mjs");
const jobs = scenesArg.split(",").map((s) => {
  const [scene, crop] = s.split(":");
  const obj = SCENES.some((x) => x.name === scene) ? scene : extra.find((x) => x.name === scene);
  if (!obj) throw new Error("没有场景 " + scene);
  const j = { name: scene, scene: obj, variants };
  if (crop) j.crop = crop.split(/[ ;]/).length > 1 ? crop.split(/[ ;]/).map(Number) : crop.split("/").map(Number);
  if (flags.includes("--dump")) j.cloudDump = { warm: 96, frames: 16 };
  return j;
});
fs.writeFileSync(out, JSON.stringify(jobs, null, 1));
console.log(`写了 ${jobs.length} 个 job × ${variants.length} 个变体 → ${out}`);
