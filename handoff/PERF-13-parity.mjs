// PERF-13 零回归（离线）：带 O / W 的窗外变体用 glslangValidator -E 真预处理后，与对照树的对应程序逐字比较
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

const tmp = mkdtempSync(path.join(tmpdir(), "perf13-pp-"));
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
let bad = 0;
try {
  for (const [ma, mb] of [["outside-extras", "outside-default"], ["outside-ground-detail", "outside-ground-detail"], ["outside-rail", "outside-rail"]]) {
    const pa = a.get(ma), pb = b.get(mb);
    if (!pa || !pb) {
      console.log(`${ma} ↔ ${mb}：缺程序，跳过`);
      continue;
    }
    const fa = pp(pa.fragmentShader), fb = pp(pb.fragmentShader);
    if (!fa || !fb) {
      bad++;
      console.log(`${ma} ↔ ${mb}：✗ 预处理失败`);
      continue;
    }
    if (fa === fb) console.log(`${ma} ↔ 对照 ${mb}：✓ 预处理后逐字相同（${fa.split("\n").length} 行）`);
    else {
      bad++;
      const la = fa.split("\n"), lb = fb.split("\n");
      let i = 0;
      while (i < la.length && la[i] === lb[i]) i++;
      console.log(`${ma} ↔ 对照 ${mb}：✗ 第 ${i + 1} 行起不同\n  本分支：${la[i]}\n  对照：  ${lb[i]}`);
    }
  }
  const d0 = a.get("outside-default"), d1 = b.get("outside-default");
  if (d0 && d1) console.log(`outside-default 预处理后：本分支 ${pp(d0.fragmentShader).split("\n").length} 行，对照 ${pp(d1.fragmentShader).split("\n").length} 行`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
