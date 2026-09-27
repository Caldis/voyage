// 飞机模式零回归检查（TR02；TR03 加「预处理后比对」）：离线收集两个 voyage 根目录（本分支、对照分支）的全部着色器程序文本，逐个比较。
// 程序清单与构造方式复用 scripts/lint-shaders.mjs 的 collectPrograms（vite ssrLoadModule 直接调用各材质的构造函数，
// 不开浏览器、不占 GPU）；比较的是 fragmentShader / vertexShader 的完整文本（含变体的 #define 前缀）。
//
// TR03：火车变体要在共用模块里留几处 `#ifdef RAIL` 钩子，原始文本因此不同；验收口径是「预处理后逐字相同」。
// 原始文本不同时，按每个程序开头的 `#define X 1`（three 在编译时给变体加的宏，collectPrograms 手动补在最前面）
// 用 lint-shaders.mjs 的 resolveConditionals 展开 #ifdef / #ifndef / #else / #endif 两边再比，指令行本身丢弃。
// 只在本分支里有的程序（新增的变体，例如 outside-rail）列出来，不算差异；只在对照里有的算差异（程序被删了）。
// 有差异时打印第一处不同的行（上下文几行），一眼看出是注释还是代码（TR02 审查的开发体验反馈）。
// 用法：node apps/voyage/src/rail/shader-parity.mjs <对照的 voyage 根目录>
//   例：git worktree add --detach <仓库>/tmp/<任务>-master master，node_modules 做目录联接，然后传 <临时目录>/apps/voyage
import { createHash } from "node:crypto";
import { createServer } from "vite";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mine = path.resolve(here, "..", "..");
const other = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("用法：node shader-parity.mjs <对照的 voyage 根目录>");
  process.exit(2);
}

const { resolveConditionals } = await import(pathToFileURL(path.join(mine, "scripts", "lint-shaders.mjs")).href);

async function collect(root) {
  // 各自用自己根目录下的 lint-shaders.mjs（程序清单跟着代码走）
  const { collectPrograms } = await import(pathToFileURL(path.join(root, "scripts", "lint-shaders.mjs")).href);
  const server = await createServer({ root, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true } });
  try {
    const progs = await collectPrograms(server);
    return new Map(progs.map((p) => [p.id, p]));
  } finally {
    await server.close();
  }
}

/** 程序开头连续的 `#define X …` 行 = 这个变体的宏（collectPrograms 手动补的前缀） */
function definesOf(text) {
  const set = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^#define\s+([A-Za-z_]\w*)/);
    if (!m) break;
    set.add(m[1]);
  }
  return set;
}
const preprocess = (text) => resolveConditionals(text, definesOf(text));

/** 第一处不同的行（前后各 2 行上下文） */
function firstDiff(a, b) {
  const la = a.split("\n"), lb = b.split("\n");
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  const ctx = (l) => l.slice(Math.max(0, i - 2), i + 3).map((s, k) => `      ${Math.max(0, i - 2) + k + 1}: ${s}`).join("\n");
  return `    第 ${i + 1} 行起不同\n    本分支：\n${ctx(la)}\n    对照：\n${ctx(lb)}`;
}

const sha = (s) => createHash("sha256").update(s ?? "").digest("hex").slice(0, 16);
const [a, b] = [await collect(mine), await collect(other)];
let diff = 0;
let added = 0;
console.log(`本分支：${mine}\n对照：  ${other}\n`);
console.log("程序 | 片元着色器 | 顶点着色器 | 结果");
for (const id of new Set([...a.keys(), ...b.keys()])) {
  const pa = a.get(id), pb = b.get(id);
  if (!pa) {
    diff++;
    console.log(`${id} | — | — | ✗ 只在对照里有（本分支删掉了这个程序）`);
    continue;
  }
  if (!pb) {
    added++;
    console.log(`${id} | ${sha(pa.fragmentShader)} (${pa.fragmentShader.length} 字) | ${sha(pa.vertexShader)} | 新增（只在本分支里有，不算差异）`);
    continue;
  }
  const raw = pa.fragmentShader === pb.fragmentShader && pa.vertexShader === pb.vertexShader;
  let verdict;
  let detail = "";
  if (raw) verdict = "✓ 逐字相同";
  else {
    const fa = preprocess(pa.fragmentShader), fb = preprocess(pb.fragmentShader);
    const va = preprocess(pa.vertexShader), vb = preprocess(pb.vertexShader);
    if (fa === fb && va === vb) verdict = `✓ 预处理后逐字相同（原始文本不同：只差 #ifdef 钩子；预处理后 ${sha(fa)}，${fa.length} 字）`;
    else {
      diff++;
      verdict = `✗ 预处理后仍不同（对照 ${sha(pb.fragmentShader)}）`;
      detail = fa !== fb ? firstDiff(fa, fb) : firstDiff(va, vb);
    }
  }
  console.log(`${id} | ${sha(pa.fragmentShader)} (${pa.fragmentShader.length} 字) | ${sha(pa.vertexShader)} | ${verdict}`);
  if (detail) console.log(detail);
}
const same = [...a.keys()].filter((id) => b.has(id)).length;
console.log(diff ? `\n✗ ${diff} 个程序不同` : `\n✓ 对照里的 ${same} 个程序全部相同（逐字或预处理后逐字）${added ? `；另有 ${added} 个新增程序` : ""}`);
process.exit(diff ? 1 : 0);
