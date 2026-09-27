// G07：跨版本同机位冻结截图（G07-scenes.json 的场景），等地面全部就位（G07 分支还要等首载升级完）再拍。
// 用法（apps/voyage 下）：node handoff/G07-shots.mjs <端口> <输出目录（绝对或相对仓库根）> [场景名,…] [额外 shots 参数…]
// 两个端口各拍一次，再用 G07-diffs.mjs 求差；同一端口拍两次得噪声底
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [port, out, only, ...extra] = process.argv.slice(2);
// 和 G06-shots 一样：先冻结、把飞机钉回场景起点与姿态，再等地面
const pin = (s) =>
  `v.wingDebug && (v.wingDebug.strobe = 0); v.freeze(true); v.cloudUniforms.uCloudOffset.value.set(${(s.offset ?? [0, 0]).join(",")});` +
  `v.state.heading = v.state.preset.heading; v.state.bankDeg = 0; v.state.rollDeg = 0; v.state.pitchDeg = 2.5; v.state.turbulence = 0;`;
const wait =
  `const g = v.ground; for (let i = 0; i < 480; i++) { const w = g.imageryStats.warmup; if (g.pending === 0 && (!w || w.fine >= 0) && !(g.uploadQueue && g.uploadQueue.length)) break; await new Promise((r) => setTimeout(r, 250)); }` +
  `await new Promise((r) => setTimeout(r, 1500)); return 'pending ' + g.pending + ' res ' + (g.imageryStats.res ?? 2048);`;
const scenes = JSON.parse(fs.readFileSync(path.join(here, "G07-scenes.json"), "utf8"));
const pick = only && only !== "all" ? scenes.filter((s) => only.split(",").includes(s.name)) : scenes;
const args = [path.join(here, "../scripts/dev-browser.mjs"), "shots", "--port", port, "--out", out, "--freeze", "--settle", ...extra];
for (const s of pick) args.push("--scene", JSON.stringify({ ...s, js: pin(s) + wait }));
const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: path.join(here, "..") });
process.exit(r.status ?? 1);
