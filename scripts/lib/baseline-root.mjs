// DX-11/12：把「另一个 voyage 应用根 / 含 apps/voyage 的仓库根 / 一个 git 提交」统一解析成一个可以直接
// 当 voyage 应用根用的目录路径。shader-budget.mjs 的 --baseline/--chain、dev-browser.mjs 的 --base-shader
// （--pair/--ab 的 A/B 着色器同页对照，PERF-12/TR07 反馈追加）共用同一套解析规则，避免各自维护一份
// 微妙不一致的判断（例如「传了目录还是端口还是提交」这类边界情况）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** value 是否「看起来是」一个已存在的目录（含 apps/voyage 的仓库根，或本身就是 voyage 应用根）。
 * 是则返回 voyage 应用根的绝对路径；目录不存在返回 null（调用方决定接下来当端口号还是提交处理）；
 * 目录存在但认不出结构就直接抛错（不是「看起来不像」，是「像但用不了」，不该被静默当成别的东西）。 */
export function resolveExistingDirRoot(repoRoot, value) {
  const trimmed = String(value).trim();
  const candidate = path.isAbsolute(trimmed) ? trimmed : path.join(repoRoot, trimmed);
  if (!fs.existsSync(candidate)) return null;
  const asAppRoot = path.join(candidate, "apps", "voyage");
  if (fs.existsSync(asAppRoot)) return asAppRoot;
  if (fs.existsSync(path.join(candidate, "scripts", "lint-shaders.mjs"))) return candidate;
  throw new Error(`目录 "${value}" 存在，但既不是含 apps/voyage 的仓库根，也不是 voyage 应用根（没有 scripts/lint-shaders.mjs）`);
}

/** 在 workdir（通常 tmp/ 下的一次性对照 worktree）签出一个提交，返回它的 voyage 应用根。workdir 不存在
 * 就用 `git worktree add --detach` 新建；已经是个 worktree 就 `git checkout --detach` 切过去——跨调用
 * 复用同一个 workdir，省去每次都重新 `pnpm install` 的等待（和 shader-budget.mjs --chain 的约定一致）。
 * 首次使用（node_modules 不存在）会跑一次 `pnpm install --filter voyage`。 */
export function resolveCommitRoot(repoRoot, commit, workdir, { log = console.log } = {}) {
  if (!fs.existsSync(path.join(workdir, ".git"))) {
    fs.mkdirSync(path.dirname(workdir), { recursive: true });
    log(`[baseline-root] 创建临时对照 worktree：${workdir}（提交 ${commit}）`);
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", workdir, commit], { stdio: "inherit" });
  } else {
    log(`[baseline-root] 复用已存在的临时 worktree：${workdir}，切到提交 ${commit}`);
    execFileSync("git", ["-C", workdir, "checkout", "--detach", commit], { stdio: "inherit" });
  }
  const voyageRoot = path.join(workdir, "apps", "voyage");
  if (!fs.existsSync(path.join(voyageRoot, "node_modules"))) {
    log('[baseline-root] 首次使用，跑一次 "pnpm install --filter voyage"（后续复用这个 worktree 会跳过这一步）...');
    execFileSync("pnpm", ["install", "--filter", "voyage"], { cwd: workdir, stdio: "inherit", shell: process.platform === "win32" });
  }
  return voyageRoot;
}
