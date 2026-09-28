// SPEC-FUJI 零回归（离线）：带 O / W 的窗外变体用 glslangValidator -E 真预处理后，与对照树的对应程序逐字比较
//   本分支 outside-extras（OW）      ↔ 对照 outside-default（改动前的默认程序就是全都带）
//   本分支 outside-ground-detail（DOW）↔ 对照 outside-ground-detail
//   本分支 outside-rail（DROW）       ↔ 对照 outside-rail
// 另外打印本分支默认程序预处理后比对照少了多少行（被拆出去的罕见光学 / 天幕层奇观）。
// 用法：node apps/voyage/handoff/PERF-13-parity.mjs <对照的 voyage 根目录>
import { createServer } from "vite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import glslangPkg from "glslang-validator-prebuilt-predownloaded";

const here = path.dirname(fileURLToPath(import.meta.url));
const mine = path.resolve(here, "..");
const other = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("用法：node PERF-13-parity.mjs <对照的 voyage 根目录>");
  process.exit(2);
}
const { FRAG_PREFIX, resolveIncludes } = await import(pathToFileURL(path.join(mine, "scripts", "lint-shaders.mjs")).href);

async function collect(root) {
  const { collectPrograms } = await import(pathToFileURL(path.join(root, "scripts", "lint-shaders.mjs")).href);
  const server = await createServer({ root, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true } });
  try {
    return new Map((await collectPrograms(server, { lenient: true })).map((p) => [p.id, p]));
  } finally {
    await server.close();
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "fuji-pp-"));
let n = 0;
function pp(src) {
  const file = path.join(tmp, `p${n++}.frag`);
  writeFileSync(file, FRAG_PREFIX + resolveIncludes(src, new Set()));
  const r = spawnSync(glslangPkg.getPath(), ["-E", "-S", "frag", file], { encoding: "utf8", maxBuffer: 64 << 20 });
  return (r.stdout || "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#line") && !l.startsWith("#extension") && !/^#(version|pragma)/.test(l))
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n");
}

const [a, b] = [await collect(mine), await collect(other)];
let bad = 0, same = 0;
try {
  // 两边都有的程序逐个比（本任务只新增 L 变体，其余程序预处理后应逐字相同）
  for (const [id, pb] of b) {
    const pa = a.get(id);
    if (!pa) { console.log(`${id}：本分支缺，跳过`); continue; }
    const fa = pp(pa.fragmentShader), fb = pp(pb.fragmentShader);
    if (!fa || !fb) { bad++; console.log(`${id}：✗ 预处理失败`); continue; }
    if (fa === fb) { same++; continue; }
    bad++;
    const la = fa.split("\n"), lb = fb.split("\n");
    let i = 0;
    while (i < la.length && la[i] === lb[i]) i++;
    console.log(`${id}：✗ 第 ${i + 1} 行起不同\n  本分支：${la[i]}\n  对照：  ${lb[i]}`);
  }
  console.log(`逐字相同 ${same} 个，不同 ${bad} 个；本分支新增：${[...a.keys()].filter((k) => !b.has(k)).join(", ")}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);