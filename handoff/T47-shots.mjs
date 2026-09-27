#!/usr/bin/env node
// T47：舱内与机翼次要项的对照截图。包一层 dev-browser.mjs shots，场景日期都写死（夜景不随「今天」漂）。
// 用法：node apps/voyage/handoff/T47-shots.mjs --port 5251 --out tmp/screenshot/T47/x [--only a,b] [--angle vulkan]
//   --out 相对仓库根（与 dev-browser.mjs 一致）。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const HEADS = { ahead: [-0.42, 0.1, -0.5], behind: [0.42, 0.1, -0.5], seated: [0, 0.02, -0.42] };
const DAY = { preset: "wpac", date: "2026-09-27", time: 720, "wing-pos": "8" };
const NIGHT = { preset: "wpac", date: "2026-01-16", time: 1260, "wing-pos": "8", "cabin-light": true };
const SCENES = {
  "sea-night-on": { p: { preset: "scs", seat: "left", date: "2026-05-15", time: 1350, coverage: 0.15, "cabin-light": true, "wing-pos": "-4" } },
  "night-city-on": { p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": true }, offset: [0, -25], head: -0.25 },
  "sunset-wing": { p: { preset: "wpac", date: "2026-09-27", time: 1040, "wing-pos": "8" } },
  "route-hnd-cts": { p: { preset: "hnd-cts", date: "2026-09-27", time: 990, coverage: 0.25, "wing-pos": "8" } },
  "noon-cumulus": { p: { preset: "wpac", date: "2026-09-27", time: 720, "wing-pos": "8" } },
};
for (const cls of ["biz", "econ"]) {
  for (const view of ["ahead", "behind", "seated"]) {
    const c = { "cabin-class": cls === "econ" ? "economy" : "business" };
    SCENES[`${cls}-${view}`] = { p: { ...DAY, ...c }, head: HEADS[view] };
    SCENES[`${cls}-${view}-night`] = { p: { ...NIGHT, ...c }, head: HEADS[view] };
  }
}
const only = (get("--only") ?? "sea-night-on,biz-ahead,biz-behind,biz-seated,econ-behind,biz-ahead-night,sunset-wing").split(",");
const pass = ["shots", "--port", get("--port") ?? "5251", "--out", get("--out") ?? "tmp/screenshot/T47/x"];
if (get("--angle")) pass.push("--angle", get("--angle"));
for (const n of only) {
  if (!SCENES[n]) { console.error(`未知场景 ${n}`); process.exit(1); }
  pass.push("--scene", JSON.stringify({ name: n, ...SCENES[n] }));
}
const r = spawnSync(process.execPath, [path.join(HERE, "..", "scripts", "dev-browser.mjs"), ...pass], { stdio: "inherit" });
process.exit(r.status ?? 1);
