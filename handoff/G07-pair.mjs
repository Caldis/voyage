// G07：同页 A/B（shots --pair）：a = G06 做法（整组 generateMipmap + 每帧直传一张），b = G07 做法（Worker 按层 mip + 暂存原子换上）。
// 两张都在冻结的同一机位、切换后原地重建全部级别（rebuildAll）并等到全部传完再拍；差异只来自 mip 的算法与 A 通道的 mip 编码。
// 用法（apps/voyage 下）：node handoff/G07-pair.mjs <端口> <输出目录（相对仓库根）> [场景名,…] [额外 shots 参数…]
// 噪声底：G07_SELF=1 时 a、b 都用 G07 做法（同一做法重建两次，应逐像素为 0）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [port, out, only, ...extra] = process.argv.slice(2);
const mode = (g06) =>
  `const g = v.ground; for (let i = 0; i < 240 && g.imageryStats.warmup.fine < 0; i++) await new Promise((r) => setTimeout(r, 250));` +
  `const w0 = g.imageryStats.worker.count; g.gpuMips = ${g06}; g.stagedUpload = ${!g06}; g.rebuildAll();` +
  `await new Promise((r) => setTimeout(r, 500));` +
  `for (let i = 0; i < 240; i++) { await new Promise((r) => setTimeout(r, 250)); if (g.pending === 0 && !g.levels.some((l) => l.building || l.stale) && g.uploadQueue.length === 0) break; }` +
  `await new Promise((r) => setTimeout(r, 500)); return 'gpuMips=' + g.gpuMips + ' staged=' + g.stagedUpload + ' 重建级数=' + (g.imageryStats.worker.count - w0);`;
const scenes = JSON.parse(fs.readFileSync(path.join(here, "G07-scenes.json"), "utf8"));
const pick = only && only !== "all" ? scenes.filter((s) => only.split(",").includes(s.name)) : scenes;
const args = [path.join(here, "../scripts/dev-browser.mjs"), "shots", "--port", port, "--out", out, "--settle", "--pair", mode(!process.env.G07_SELF), "--pair", mode(false), ...extra];
for (const s of pick) args.push("--scene", JSON.stringify(s));
const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: path.join(here, "..") });
process.exit(r.status ?? 1);
