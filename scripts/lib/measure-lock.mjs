// DX-10：测量锁。多个代理并行开发时，离线 FXC / 真冷启动 / 按 pass 的 GPU 计时互相污染彼此的结果
// （research/PERF_REPORT_wave6.md 开发体验反馈：「希望有…一个『测量锁』：性能工程师测量时，其他代理暂停
// 编译 / 截图。这次靠协调者口头通知，还是撞上了一次不明来源的 cc1」）。约定（详见 README「调试与验证」）：
//   - **持锁**（测量期间独占）：shader-budget.mjs 的离线 FXC 计时、dev-browser.mjs 的 `cold`（真冷启动）、
//     passes.mjs 的按 pass GPU 计时。
//   - **查锁但不强制等待**：dev-browser.mjs 的 `shots` / `check`，以及任何 vite 构建类命令（`pnpm --filter voyage
//     build` / `vite build` / `vite dev` 等——这些不是本仓库自己的脚本，管不到，约定上手工跑一次
//     `node scripts/measure-lock.mjs check` 看一眼，见 scripts/measure-lock.mjs 和 README）。发现锁存在时只打印
//     提示，不阻塞；传 `--respect-lock` 时改成轮询等锁释放。
// 实现：`tmp/measure.lock` 是一个目录，`mkdirSync` 在大多数文件系统上是原子操作，天然互斥——和 DEV_SOP「浏览器锁」
// 的 `tmp/browser.lock` 同一手法（那把锁给 Playwright MCP 共享浏览器用，这把锁给「测量期间机器要安静」用，
// 两者正交，互不替代）。`owner.txt` 写持有者描述 + 开始时间。这不是严格的分布式互斥（两次读—写之间仍有极小的
// 竞态窗口），目标是「大概率避免互相干扰」，不是绝对正确性。

import fs from "node:fs";
import path from "node:path";

export function lockDirFor(repoRoot) {
  return path.join(repoRoot, "tmp", "measure.lock");
}

function ownerFile(repoRoot) {
  return path.join(lockDirFor(repoRoot), "owner.txt");
}

/** 读锁的持有者信息；没有锁返回 null。owner 是 owner.txt 的原文（可能有多行）。 */
export function readLock(repoRoot) {
  const dir = lockDirFor(repoRoot);
  if (!fs.existsSync(dir)) return null;
  let owner = "(未知，owner.txt 缺失或读取失败)";
  try {
    owner = fs.readFileSync(ownerFile(repoRoot), "utf8").trim();
  } catch {
    /* 尽力而为：owner.txt 缺失也不影响「锁存在」这个判断 */
  }
  return { dir, owner };
}

/** 尝试持锁（mkdirSync 原子操作，已存在会抛 EEXIST）。owner 是一行简短描述（脚本名 + 任务标识 + 时间）。
 * 成功返回 release() 函数；已被占用返回 null（不抛错，调用方自己决定警告还是排队等待）。 */
export function tryAcquire(repoRoot, owner) {
  const dir = lockDirFor(repoRoot);
  // tmp/ 本身可能还不存在（新 worktree、或从没跑过测量）：先确保父目录存在（recursive，本身就是幂等的，
  // 不会因为并发也在建它而报错），再对锁目录本身做**非**递归的 mkdirSync——这一步才是真正的原子互斥。
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir, { recursive: false });
  } catch (err) {
    if (err && err.code === "EEXIST") return null;
    throw err;
  }
  const startedAt = new Date().toISOString();
  try {
    fs.writeFileSync(ownerFile(repoRoot), `${owner}\n开始：${startedAt}\n`);
  } catch {
    /* owner.txt 写失败不影响锁本身生效（目录已经建好，互斥已经成立） */
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  };
}

/** 轮询等到锁释放（或超时）；返回 true = 已释放，false = 超时放弃。调用方在这之后自己再 tryAcquire 一次
 * （两次调用之间理论上仍可能被别人抢先，这不是严格互斥，见文件头注释）。 */
export async function waitForRelease(repoRoot, { timeoutMs = 20 * 60 * 1000, pollMs = 15000, log = console.log } = {}) {
  const start = Date.now();
  for (;;) {
    const lock = readLock(repoRoot);
    if (!lock) return true;
    if (Date.now() - start > timeoutMs) {
      log(`[measure-lock] 等了 ${(timeoutMs / 60000).toFixed(0)} 分钟，锁仍被占用（${lock.owner.split("\n")[0]}），放弃等待，继续执行`);
      return false;
    }
    log(`[measure-lock] 锁被占用（${lock.owner.split("\n")[0]}），${(pollMs / 1000).toFixed(0)}s 后重查（--respect-lock）...`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** shots / check 这类「查锁但不强制」的场景用：锁存在就打印一行提示，不阻塞。返回锁信息（或 null）。 */
export function noticeIfLocked(repoRoot, context) {
  const lock = readLock(repoRoot);
  if (lock) {
    console.log(
      `[measure-lock] 提示：${context} 时发现测量锁存在（持有者：${lock.owner.split("\n")[0]}）——` +
        "如果对方正在做离线 FXC / 真冷启动 / 按 pass GPU 计时，这里产生的负载可能会污染它的结果（不影响本次执行本身）。" +
        "确有需要可以等它做完，或加 --respect-lock 自动等待释放。",
    );
  }
  return lock;
}
