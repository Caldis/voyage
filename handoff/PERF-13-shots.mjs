// PERF-13 零回归截图：简报点名的场景 + 强制光学（等价 ?optics=all），冻结 + 等瓦片。
// 每个场景的 js 末尾都等窗外变体编好（groundDetail.pending；master 上没有这个字段就不等），再把云的世界偏移和模拟时刻
// 重新设回场景值：等待时长两边不同，飞机和太阳在等待期间走的距离不同，不设回来两次截图的云 / 奇观就错开了（PERF-10 坑点）。
// 用法：node apps/voyage/handoff/PERF-13-shots.mjs <端口> <输出目录（相对仓库根或绝对路径）> [--only a,b]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENES } from "../scripts/scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [port, out, ...rest] = process.argv.slice(2);
const onlyIdx = rest.indexOf("--only");
const only = onlyIdx >= 0 ? new Set(rest[onlyIdx + 1].split(",")) : null;

const NAMED = ["noon-cumulus", "sunset-wing", "fuji-day", "night-city", "night-sea-milkyway", "route-hnd-cts-night", "wonder-tether-dusk", "wonder-jianmu-day", "wonder-fogcity-night", "wonder-floatcity-day", "rail-oito-default"];
const FORCE = "v.optics.disabled = false; v.optics.pinGreenFlash(null); v.optics.force = { glory: true, halo: true, flash: true };";
// 强制光学（= URL ?optics=all）：T17 自测的三个几何（宝光在左窗、低空本机影子、右窗卷云幻日 / 晕）
const OPTICS = [
  { name: "optics-all-glory", p: { preset: "wpac", date: "2026-09-27", "wing-pos": "-4", seat: "left", time: 990, "cloud-preset": "stratocumulus", coverage: 0.85 }, js: FORCE },
  { name: "optics-all-lowshadow", p: { preset: "wpac", date: "2026-09-27", "wing-pos": "-4", seat: "left", time: 990, "cloud-preset": "stratocumulus", coverage: 0.9, altitude: 2.6 }, js: FORCE },
  { name: "optics-all-halo", p: { preset: "wpac", date: "2026-09-27", "wing-pos": "-4", seat: "right", time: 990, "cloud-preset": "cirrus", coverage: 0.5 }, js: FORCE },
];

const scenes = [...NAMED.map((n) => SCENES.find((s) => s.name === n)), ...OPTICS].filter((s) => s && (!only || only.has(s.name)));
const args = [path.join(here, "..", "scripts", "dev-browser.mjs"), "shots", "--port", port, "--out", out, "--freeze", "--settle"];
for (const s of scenes) {
  const sc = { ...s, p: { ...s.p } };
  // 其他场景的光学开关不带过来：非强制场景一律回到默认（按条件 + 随机，种子每次打开页面不同，所以非强制场景里光学要么没有、要么只有影子）
  // 种子写死（optics.ts 的 seed 默认是每次打开页面随机的）：两边掷出同样的宝光 / 幻日段落
  // 翼尖频闪钉成灭（wingDebug.strobe = 0）：冻结时刻落在频闪相位的哪一点两边不同，夜景第一轮有一张正好拍到闪光（整窗发白，与窗外 pass 无关）
  const reset = "v.optics.seed = 12345; v.wingDebug.strobe = 0;" + (s.js && s.js.includes("v.optics.force") ? "" : "v.optics.disabled = false; v.optics.pinGreenFlash(null); v.optics.force = {};");
  const [ox, oy] = s.offset ?? [0, 0];
  const time = s.p.time;
  const settle =
    "for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));" +
    "for (let i = 0; i < 480 && v.groundDetail && v.groundDetail.pending; i++) await new Promise((r) => setTimeout(r, 250));" +
    (s.name.startsWith("rail-") ? "" : `v.cloudUniforms.uCloudOffset.value.set(${ox}, ${oy});`) +
    (time !== undefined ? `{ const el = document.getElementById("time"); el.value = "${time}"; el.dispatchEvent(new Event("input")); }` : "") +
    "return (v.groundDetail && v.groundDetail.variantStatus ? JSON.stringify({ w: v.groundDetail.variantStatus.wanted, s: v.groundDetail.variantStatus.shown }) : 'master') + ' ' + JSON.stringify(v.optics.status);";
  // 原 js 可能以 return 结尾：包进一个 async 函数里跑完，再做上面的收尾
  sc.js = reset + (s.js ? `await (async () => { ${s.js} })();` : "") + settle;
  sc.offset = s.offset ?? [0, 0];
  args.push("--scene", JSON.stringify(sc));
}
const r = spawnSync("node", args, { stdio: "inherit" });
process.exit(r.status ?? 1);
