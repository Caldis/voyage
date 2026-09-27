// C01 / C02 同页 A/B 变体（给 C01-measure.mjs 的 --vfile）：
//   old  = 页面内把云步进的受光段改回 C01 之前的原文 + 关掉 C02 锚定（近似 master；uWhiteout 仍在写，in-cloud 改前的统计判据本来就 ≈ 1）
//   prev = 第一次交付（无扩散尾巴）；c01 = 只有 C01（关锚定）；new = 现在的代码
//   *_na / refE：去掉空气透视、S 换成同照度朗伯白面，给 C01-albedo.py 算有效反照率
// 原文从 git 取（C01 之前的提交 5fba326，改了基线就换这个哈希）
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const VOYAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.C01_BASE || "5fba326";
const NEWSRC = fs.readFileSync(path.join(VOYAGE, "src/clouds/clouds.ts"), "utf8");
const OLDSRC = execSync(`git show ${BASE}:apps/voyage/src/clouds/clouds.ts`, { cwd: VOYAGE, encoding: "utf8", maxBuffer: 1 << 26 });
function block(src, start, endIncl) {
  const i = src.indexOf(start);
  const j = src.indexOf(endIncl, i);
  if (i < 0 || j < 0) throw new Error("找不到块 " + start.slice(0, 30));
  return src.slice(i, j + endIncl.length);
}
export const OLD_MS = block(OLDSRC, "      // 多次散射近似（Wrenninge 2013）：", "mix(1.0, powder, 0.5 * (1.0 - smoothstep(0.3, 0.9, cosT)));");
export const NEW_MS = block(NEWSRC, "      // 银边（T12）：水滴的散射里", "vec3 sunLight = keyLight(r, up) * sunScatter;");
export const TAIL = "sunScatter += (tailK / (4.0 * M_PI)) * (1.0 / (1.0 + 0.1125 * od) - exp(-od));";
const NOAP = [["L = L * apT + apL * (1.0 - T);", "L = L * 1.0;"]];
const REF = [["vec3 S = sunLight + ambient;", "vec3 S = (keyLight(r, up) * max(dot(up, uKeyDir), 0.0) + skyIrradiance(r, up)) / M_PI;"]];
export const VARIANTS = {
  old: { march: [[NEW_MS, OLD_MS]], exp: { uDayEvAnchor: [15, 0] } },
  prev: { march: [[TAIL, ""]] },
  c01: { exp: { uDayEvAnchor: [15, 0] } },
  new: {},
  refE: { march: [...NOAP, ...REF] },
  old_na: { march: [[NEW_MS, OLD_MS], ...NOAP] },
  new_na: { march: NOAP },
};
