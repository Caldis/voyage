#!/usr/bin/env node
// DX-11（PERF-13 反馈）：着色器零回归对照——离线枚举两棵树的全部程序（`lint-shaders.mjs` 的
// `collectPrograms`，vite ssrLoadModule 直接调用各材质构造函数，不开浏览器、不占 GPU），逐个 id 比较：
//   1. 原始文本逐字相同 -> 通过；
//   2. 不同 -> 用 glslangValidator 的 `-E` 做**真预处理**（宏展开 + 条件编译 + 去掉注释/多余空白），
//      再比一次 -> 预处理后相同也算通过（常见于只是 `#ifdef` 钩子本身文本不同，两边编译到的代码其实一样，
//      例如火车模式在共用模块里留的 `#ifdef RAIL`）；
//   3. 预处理后仍不同 -> 报差异，打印第一处不同的行（含上下文）。
// 只在本分支存在的程序（新增变体）不算差异；只在对照存在的（程序被删了）算差异。
//
// 收编自两份各写一半的一次性脚本，取代它们：
//   - `handoff/PERF-13-parity.mjs`：已经在用 glslangValidator 真预处理，但只写死比较 3 对程序；
//   - `src/rail/shader-parity.mjs`（TR02/TR03）：比全部程序、打印首处不同行，但用 `resolveConditionals`
//     的文本展开近似（简化的 `#ifdef` 匹配，不是真正的宏展开）代替真预处理，遇到嵌套宏 / 函数式宏时不准。
// 这里是两者的合并版：全部程序 + 真预处理 + 首处不同行。**`src/rail/shader-parity.mjs` 不在 scripts/
// 归属范围内（本任务约定只改 scripts/ 与 README），原样保留没有删除或改成转发，但往后新任务请改用这里**。
//
// 用法：
//   node scripts/shader-parity.mjs --base <目录|提交> [--only id1,id2] [--workdir tmp/shader-parity-base]
//   node scripts/shader-parity.mjs --base .claude/worktrees/agent-xxxx/apps/voyage
//   node scripts/shader-parity.mjs --base 1de0481          # 提交：在 --workdir（默认 tmp/shader-parity-base）
//                                                            建一次性对照 worktree，和 shader-budget.mjs
//                                                            --chain 同一套约定，跨次调用复用（省重装依赖）
import { createServer } from "vite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import glslangPkg from "glslang-validator-prebuilt-predownloaded";
import { resolveExistingDirRoot, resolveCommitRoot } from "./lib/baseline-root.mjs";
import { resolveRepoPath } from "./lib/chrome.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOYAGE_ROOT = path.join(HERE, "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      out[key] = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
    } else out._.push(a);
  }
  return out;
}

/** 各自用自己根目录下的 lint-shaders.mjs（程序清单跟着代码走：老树没有的变体自然不会出现） */
async function collect(root) {
  const { collectPrograms } = await import(pathToFileURL(path.join(root, "scripts", "lint-shaders.mjs")).href);
  const server = await createServer({ root, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true } });
  try {
    const progs = await collectPrograms(server, { lenient: true });
    return new Map(progs.map((p) => [p.id, p]));
  } finally {
    await server.close();
  }
}

/** 第一处不同的行（前后各 2 行上下文），和 src/rail/shader-parity.mjs 的 firstDiff 同一个输出格式 */
function firstDiff(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  const ctx = (l) =>
    l
      .slice(Math.max(0, i - 2), i + 3)
      .map((s, k) => `      ${Math.max(0, i - 2) + k + 1}: ${s}`)
      .join("\n");
  return `    第 ${i + 1} 行起不同\n    本分支：\n${ctx(la)}\n    对照：\n${ctx(lb)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base) {
    console.error("用法：node scripts/shader-parity.mjs --base <目录|提交> [--only id1,id2] [--workdir tmp/shader-parity-base]");
    process.exit(2);
  }
  let otherRoot = resolveExistingDirRoot(REPO_ROOT, String(args.base));
  if (!otherRoot) {
    const workdir = resolveRepoPath(REPO_ROOT, args.workdir || "tmp/shader-parity-base");
    otherRoot = resolveCommitRoot(REPO_ROOT, String(args.base), workdir, { log: console.log });
  }
  const only = args.only ? new Set(String(args.only).split(",")) : null;

  const { FRAG_PREFIX, resolveIncludes } = await import(pathToFileURL(path.join(VOYAGE_ROOT, "scripts", "lint-shaders.mjs")).href);

  console.log(`本分支：${VOYAGE_ROOT}`);
  console.log(`对照：  ${otherRoot}\n`);
  const [a, b] = await Promise.all([collect(VOYAGE_ROOT), collect(otherRoot)]);

  const tmpDir = mkdtempSync(path.join(tmpdir(), "voyage-shader-parity-"));
  let n = 0;
  const pp = (src) => {
    const file = path.join(tmpDir, `p${n++}.frag`);
    writeFileSync(file, FRAG_PREFIX + resolveIncludes(src, new Set()));
    const r = spawnSync(glslangPkg.getPath(), ["-E", "-S", "frag", file], { encoding: "utf8", maxBuffer: 64 << 20 });
    return (r.stdout || "")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#line") && !l.startsWith("#extension") && !/^#(version|pragma)/.test(l))
      .map((l) => l.replace(/\s+/g, " ").trim())
      .join("\n");
  };

  let diff = 0;
  let added = 0;
  try {
    const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
    for (const id of ids) {
      if (only && !only.has(id)) continue;
      const pa = a.get(id);
      const pb = b.get(id);
      if (!pa) {
        diff++;
        console.log(`${id}：✗ 只在对照里有（本分支删掉了这个程序）`);
        continue;
      }
      if (!pb) {
        added++;
        console.log(`${id}：新增（只在本分支里有，不算差异，${pa.fragmentShader.length} 字）`);
        continue;
      }
      if (pa.fragmentShader === pb.fragmentShader) {
        console.log(`${id}：✓ 逐字相同`);
        continue;
      }
      const fa = pp(pa.fragmentShader);
      const fb = pp(pb.fragmentShader);
      if (!fa || !fb) {
        diff++;
        console.log(`${id}：✗ glslangValidator 预处理失败（原始文本本身不同）`);
        continue;
      }
      if (fa === fb) {
        console.log(`${id}：✓ 预处理后逐字相同（原始文本不同，只是 #define/#ifdef 钩子；预处理后 ${fa.split("\n").length} 行）`);
        continue;
      }
      diff++;
      console.log(`${id}：✗ 预处理后仍不同\n${firstDiff(fa, fb)}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  const same = [...a.keys()].filter((id) => b.has(id)).length;
  console.log(diff ? `\n✗ ${diff} 个程序不同` : `\n✓ 对照里的 ${same} 个程序全部相同（逐字或预处理后逐字）${added ? `；另有 ${added} 个新增程序` : ""}`);
  process.exit(diff ? 1 : 0);
}

main().catch((err) => {
  console.error(`[shader-parity] 失败：${err.message}`);
  process.exit(1);
});
