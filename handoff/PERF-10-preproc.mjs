// PERF-10：检查各云程序「预处理后」到底含不含雷暴 / 台风代码（glslangValidator -E 真预处理，不是按文本数）。
// 用法：node apps/voyage/handoff/PERF-10-preproc.mjs [--dump 目录]
// 输出每个程序预处理后的行数、以及雷暴 / 台风标识符（stormDensity、hurricaneDensity、uStorms[ 等）出现的次数。
// 默认程序（cloud-march、cloud-shadow-map、cloud-probe）应当全为 0。
import { createServer } from "vite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectPrograms, resolveIncludes, FRAG_PREFIX } from "../scripts/lint-shaders.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (await import("glslang-validator-prebuilt-predownloaded")).default.getPath();
const dumpIdx = process.argv.indexOf("--dump");
const dump = dumpIdx > 0 ? process.argv[dumpIdx + 1] : null;
if (dump) mkdirSync(dump, { recursive: true });

const MARKERS = ["stormDensity", "towerSdf", "anvilDensity", "hurricaneDensity", "bandTowerSdf", "hurricaneSunVis", "hurricaneCasterDensity", "uStorms[", "uHurricane.", "gStormW", "cloudWeatherMaybe", "uFlash", "uOcc"];

const server = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
let programs;
try {
  programs = await collectPrograms(server, { allCloudCombos: true });
} finally {
  await server.close();
}
const tmp = mkdtempSync(path.join(tmpdir(), "perf10-pp-"));
for (const p of programs.filter((q) => q.id.startsWith("cloud-") || q.id.startsWith("outside") || q.id === "wing")) {
  const unknown = new Set();
  const src = FRAG_PREFIX + resolveIncludes(p.fragmentShader, unknown);
  const f = path.join(tmp, p.id + ".frag");
  writeFileSync(f, src);
  const res = spawnSync(bin, ["-E", "-S", "frag", f], { encoding: "utf8", maxBuffer: 64 << 20 });
  const out = res.stdout || "";
  if (dump) writeFileSync(path.join(dump, p.id + ".pp.glsl"), out);
  const lines = out.split("\n").filter((l) => l.trim()).length;
  const hits = MARKERS.map((m) => [m, out.split(m).length - 1]).filter(([, n]) => n > 0);
  console.log(`${p.id.padEnd(28)} ${String(lines).padStart(5)} 行  ${hits.length ? hits.map(([m, n]) => `${m}×${n}`).join(" ") : "（无雷暴 / 台风标识符）"}`);
}
void readFileSync;
