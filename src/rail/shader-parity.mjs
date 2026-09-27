// 飞机模式零回归检查（TR02）：离线收集两个 voyage 根目录（本分支、对照分支）的全部着色器程序文本，逐个比较。
// 程序清单与构造方式复用 scripts/lint-shaders.mjs 的 collectPrograms（vite ssrLoadModule 直接调用各材质的构造函数，
// 不开浏览器、不占 GPU）；比较的是 fragmentShader / vertexShader 的完整文本（含变体的 #define 前缀）。
// 用法：node apps/voyage/src/rail/shader-parity.mjs <对照的 voyage 根目录>
//   例：git worktree add --detach <临时目录> master，然后传 <临时目录>/apps/voyage
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

const sha = (s) => createHash("sha256").update(s ?? "").digest("hex").slice(0, 16);
const [a, b] = [await collect(mine), await collect(other)];
let diff = 0;
console.log(`本分支：${mine}\n对照：  ${other}\n`);
console.log("程序 | 片元着色器 | 顶点着色器 | 结果");
for (const id of new Set([...a.keys(), ...b.keys()])) {
  const pa = a.get(id), pb = b.get(id);
  if (!pa || !pb) {
    diff++;
    console.log(`${id} | — | — | ✗ 只在${pa ? "本分支" : "对照"}里有`);
    continue;
  }
  const same = pa.fragmentShader === pb.fragmentShader && pa.vertexShader === pb.vertexShader;
  if (!same) diff++;
  console.log(`${id} | ${sha(pa.fragmentShader)} (${pa.fragmentShader.length} 字) | ${sha(pa.vertexShader)} | ${same ? "✓ 逐字相同" : `✗ 不同（对照 ${sha(pb.fragmentShader)}）`}`);
}
console.log(diff ? `\n✗ ${diff} 个程序不同` : `\n✓ ${a.size} 个程序全部逐字相同`);
process.exit(diff ? 1 : 0);
