// TR03 自测：火车场景（scenarios.mjs 里的 rail-oito-*）加调试变体，批量交给 dev-browser.mjs shots。
// 用法：node apps/voyage/handoff/TR03-shots.mjs --port 5203 --out tmp/screenshot/TR03/xx [--debug 23,21] [--only default,curve] [--extra "<js>"] [--freeze]
//   --debug：每个场景再拍几张 uDebug = N 的图（23 水体遮罩、21 地表分类、22 像素足迹）
//   --extra：追加在场景 js 末尾、截图之前执行的一段脚本（参数 v = window.__voyage），例如改 uniform 做对照
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENES } from "../scripts/scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const port = opt("port", "5203");
const out = opt("out", "tmp/screenshot/TR03/dev");
const debug = (opt("debug", "") || "").split(",").filter(Boolean).map(Number);
const only = (opt("only", "default,curve") || "").split(",").map((s) => `rail-oito-${s}`);
const extra = opt("extra", "");
const freeze = args.includes("--freeze");

const scenes = [];
for (const sc of SCENES.filter((s) => only.includes(s.name))) {
  const base = sc.js.replace(/return [^;]*;$/, "");
  const ret = "return v.rail.describe() + ' · ' + v.groundDetail.railStatus;";
  scenes.push({ ...sc, js: `${base} v.sceneMat.uniforms.uDebug.value = 0; ${extra} ${ret}` });
  for (const d of debug) scenes.push({ ...sc, name: `${sc.name}-debug${d}`, js: `${base} v.sceneMat.uniforms.uDebug.value = ${d}; ${extra} ${ret}` });
}
const cli = [path.join(here, "..", "scripts", "dev-browser.mjs"), "shots", "--port", port, "--out", out, ...(freeze ? ["--freeze"] : [])];
for (const sc of scenes) cli.push("--scene", JSON.stringify(sc));
const r = spawnSync(process.execPath, cli, { stdio: "inherit" });
process.exit(r.status ?? 1);
