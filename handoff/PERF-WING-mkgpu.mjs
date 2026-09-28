// 生成 PERF-WING 的 gpu-ab / ab jobs：old（master）/ A（当前提交）/ V（PERF-WING-lamps2 的就地写法，页内补丁）/ A2（A/A 噪声底）
// 用法（在 apps/voyage 下）：node handoff/PERF-WING-mkgpu.mjs <输出.json>
import fs from "node:fs";
import { V_LOCAL } from "./PERF-WING-lamps2.mjs";
const [out] = process.argv.slice(2);
const pairs = V_LOCAL.map((p) => [p.find, p.replace]);
const scenes = [
  ["sun", "sunset-wing", {}, "wingMat"],
  ["biz", { name: "biz-seated-noon", p: { preset: "wpac", time: 720, "wing-pos": "8", "cabin-class": "business" }, head: [0, 0.02, -0.42] }, {}, "wingMat"],
  ["ic", "in-cloud", { offset: [-10, -5] }, "wingMat.wet"],
  ["night", { name: "night-city-low", p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 1, coverage: 0.15, "cabin-light": "off" }, offset: [0, -25], ground: true, head: -0.25 }, {}, "wingMat"],
];
const jobs = scenes.map(([name, scene, extra, mat]) => ({
  name, scene, ...extra,
  variants: [
    { name: "old", materials: { [mat]: mat === "wingMat" ? "base" : "base:wingMat" } },
    { name: "A" },
    { name: "V", patch: { [mat]: pairs } },
    { name: "A2" },
  ],
}));
fs.writeFileSync(out, JSON.stringify(jobs, null, 1));
