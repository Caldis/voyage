// G06：同机位冻结截图。用法：node g06-shots.mjs <voyage 根目录> <端口> <输出目录(相对仓库根)> [场景名,…] [额外参数…]
// 每个场景的 js：把飞机挪回场景起点、冻结、关翼尖频闪，再等地面瓦片 / Worker / 上传全部就位
import { spawnSync } from "node:child_process";
import path from "node:path";

const [root, port, out, only, ...extra] = process.argv.slice(2);
const att = `v.state.heading = v.state.preset.heading; v.state.bankDeg = 0; v.state.rollDeg = 0; v.state.pitchDeg = 2.5; v.state.turbulence = 0;`;
const pin = (ox, oz) =>
  `v.wingDebug && (v.wingDebug.strobe = 0); v.freeze(true); v.cloudUniforms.uCloudOffset.value.set(${ox}, ${oz}); ${att}` +
  `let calm = 0; for (let i = 0; i < 240 && calm < 6; i++) { await new Promise((r) => setTimeout(r, 500)); calm = v.ground.pending === 0 ? calm + 1 : 0; }` +
  `v.cloudUniforms.uCloudOffset.value.set(${ox}, ${oz}); ${att} return 'pending ' + v.ground.pending + ' hdg ' + v.state.heading.toFixed(2);`;
const S = [
  { name: "fuji-day", p: { preset: "fuji", time: 930, altitude: 6, coverage: 0.1, "wing-pos": "-4" }, offset: [-20, 0.2], ground: true },
  { name: "route-hnd-cts", p: { preset: "hnd-cts", time: 990, coverage: 0.25, "wing-pos": "8" }, ground: true },
  { name: "yangtze", p: { preset: "yangtze", time: 630, coverage: 0.1, "wing-pos": "8" }, ground: true },
  { name: "wpac-isl", p: { preset: "wpac", time: 720, coverage: 0.1, seat: "left", "wing-pos": "8" }, offset: [-60, -344], ground: true },
  { name: "night-city", p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false }, offset: [0, -25], ground: true, head: -0.25 },
  { name: "route-hnd-cts-night", p: { preset: "hnd-cts", date: "2026-01-16", time: 1290, coverage: 0.1, seat: "left", "cabin-light": false, "wing-pos": "8" }, ground: true },
].map((s) => ({ ...s, p: process.env.G06_COV ? { ...s.p, coverage: Number(process.env.G06_COV) } : s.p, wait: 1500, js: pin(...(s.offset ?? [0, 0])) }));
const pick = only && only !== "all" ? S.filter((s) => only.split(",").includes(s.name)) : S;
const args = [path.join(root, "scripts/dev-browser.mjs"), "shots", "--port", port, "--out", out, "--freeze", "--settle", "--respect-lock", ...extra];
for (const s of pick) args.push("--scene", JSON.stringify(s));
const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
