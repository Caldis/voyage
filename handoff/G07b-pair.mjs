// G07b：同页 A/B（shots --pair）：默认 a = G07 做法（mip 浮点临时缓冲每级新分配），b = G07b（复用）；环境变量 G07B_FLAG 换成别的 ground 开关（a = false、b = true）。
// 两张都在冻结的同一机位、切换后原地重建全部级别（rebuildAll）并等到全部传完再拍；期望逐像素 0 差（离线已验证 mip 字节相同：G07b-mipscratch.mts）。
// 用法（apps/voyage 下）：node handoff/G07b-pair.mjs <端口> <输出目录（相对仓库根）> [场景名,…|all] [额外 shots 参数…]
// 再 node handoff/G07-diffs.mjs <目录> .a <目录> .b 求差。场景表沿用 G07-scenes.json。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [port, out, only, ...extra] = process.argv.slice(2);
const FLAG = process.env.G07B_FLAG ?? "mipScratchReuse"; // 同页切换的开关名（a = false、b = true），如 G07B_FLAG=waterCanvasCpu
const mode = (reuse) =>
  `const g = v.ground; for (let i = 0; i < 240 && g.imageryStats.warmup.fine < 0; i++) await new Promise((r) => setTimeout(r, 250));` +
  `const w0 = g.imageryStats.worker.count; g[${JSON.stringify(FLAG)}] = ${reuse}; g.rebuildAll();` +
  `await new Promise((r) => setTimeout(r, 500));` +
  `for (let i = 0; i < 240; i++) { await new Promise((r) => setTimeout(r, 250)); if (g.pending === 0 && !g.levels.some((l) => l.building || l.stale) && g.uploadQueue.length === 0) break; }` +
  `await new Promise((r) => setTimeout(r, 500)); return ${JSON.stringify(FLAG + "=")} + g[${JSON.stringify(FLAG)}] + ' 重建级数=' + (g.imageryStats.worker.count - w0) + ' 地面=' + g.imageryStats.res + ' pending=' + g.pending + ' 失败=' + JSON.stringify(Object.fromEntries(Object.entries(g.imageryStats.hosts).map(([k, h]) => [k, h.failed ?? h.errors ?? null])));`;
const scenes = JSON.parse(fs.readFileSync(path.join(here, "G07-scenes.json"), "utf8"));
const pick = only && only !== "all" ? scenes.filter((s) => only.split(",").includes(s.name)) : scenes;
const args = [path.join(here, "../scripts/dev-browser.mjs"), "shots", "--port", port, "--out", out, "--settle", "--pair", mode(false), "--pair", mode(true), ...extra];
for (const s of pick) args.push("--scene", JSON.stringify(s));
const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: path.join(here, "..") });
process.exit(r.status ?? 1);
