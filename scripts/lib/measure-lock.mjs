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
//
// DX-11/12（PERF-12 / TR07 反馈）：**锁必须放在主仓库根，不能放在各自 worktree 根**——每个实现代理都在
// 自己独立的 `.claude/worktrees/agent-xxx/` 里跑脚本，`repoRoot` 是各自worktree 的根，原来 `tmp/measure.lock`
// 直接拼在这个 `repoRoot` 下，等于每个 worktree 各锁各的，锁完全起不到跨代理互斥的作用（PERF-12 与 TR07
// 两个任务并行测量时互相看不到对方在跑）。`mainRepoRoot()` 用 `git rev-parse --path-format=absolute
// --git-common-dir` 找主仓库的 `.git`（worktree 与主仓库共享同一个 `.git`，这是 git 官方支持的查法），
// 取它的上一级就是主仓库根，所有 worktree 用同一把锁。取不到（不是 git 仓库、本机没有 git、旧版 git 不认
// `--path-format`）时退回传入的 `repoRoot` 本身（退化成原来的行为，不阻塞脚本）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 把任意 worktree 的仓库根换算成主仓库根（所有 worktree 共享的那个）；换算失败原样返回。 */
export function mainRepoRoot(repoRoot) {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commonDir) return path.dirname(commonDir);
  } catch {
    /* 不是 git 仓库 / 没有 git / 旧版本不认 --path-format：退回 repoRoot 本身，不阻塞脚本 */
  }
  return repoRoot;
}

export function lockDirFor(repoRoot) {
  return path.join(mainRepoRoot(repoRoot), "tmp", "measure.lock");
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

// ---------- DX-26：可重入（外层已持锁时内层不自锁）、排队名单、死锁清理 ----------
// 多个代理踩过：外层脚本（自写的 handoff/*.mjs、或 `measure-lock.mjs run -- …`）已持锁，内层再调
// dev-browser ab / passes / shader-budget，内层 tryAcquire 拿不到锁 → 等 20 分钟后放弃，或打印「锁被占用，结果可能被污染」。
// 现在锁带一个令牌：持锁成功时写进 owner.txt 的「令牌：」一行，并放进环境变量 VOYAGE_MEASURE_LOCK_TOKEN
// （子进程继承）；同一进程再次持锁（计数）或子进程带着同一令牌来持锁，都视为「已持有」，直接返回一个空 release，不等、不删锁。
// 另外 owner.txt 记「pid：」一行；等锁时若持有者进程在本机已不存在且锁建了超过 60 s，视为残留直接清掉（以前要人工删）。
export const TOKEN_ENV = "VOYAGE_MEASURE_LOCK_TOKEN";
let heldDepth = 0; // 本进程持锁的嵌套层数（>0 表示本进程持有）
let heldRelease = null;

function lockToken(lock) {
  const m = lock && lock.owner.match(/^令牌：(\S+)$/m);
  return m ? m[1] : null;
}
function lockPid(lock) {
  const m = lock && lock.owner.match(/^pid：(\d+)$/m);
  return m ? Number(m[1]) : null;
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM"; // 没权限 = 进程存在
  }
}

/** 锁是否已被「我」（本进程，或带着同一令牌的外层进程）持有 */
export function heldByMe(repoRoot) {
  if (heldDepth > 0) return true;
  const tok = process.env[TOKEN_ENV];
  if (!tok) return false;
  return lockToken(readLock(repoRoot)) === tok;
}

/** 持有者进程已退出的残留锁（只认带「pid：」行的新格式，且建锁超过 60 s）：清掉并返回 true */
function clearStale(repoRoot, log) {
  const lock = readLock(repoRoot);
  const pid = lockPid(lock);
  if (!lock || !pid || pidAlive(pid)) return false;
  let ageMs = Infinity;
  try {
    ageMs = Date.now() - fs.statSync(lock.dir).mtimeMs;
  } catch {
    /* 读不到就当很老 */
  }
  if (ageMs < 60000) return false;
  log(`[measure-lock] 持有者进程 ${pid} 已不存在（${lock.owner.split("\n")[0]}），按残留锁清掉`);
  try {
    fs.rmSync(lock.dir, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
  return true;
}

/** 尝试持锁（mkdirSync 原子操作，已存在会抛 EEXIST）。owner 是一行简短描述（脚本名 + 任务标识 + 时间）。
 * 成功返回 release() 函数；已被占用返回 null（不抛错，调用方自己决定警告还是排队等待）。
 * DX-26：锁已被本进程或外层进程（同一令牌）持有时，返回一个空 release（可重入，不自锁）。 */
export function tryAcquire(repoRoot, owner) {
  if (heldByMe(repoRoot)) {
    heldDepth++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      heldDepth = Math.max(0, heldDepth - 1);
      if (heldDepth === 0 && heldRelease) heldRelease();
    };
  }
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
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(ownerFile(repoRoot), `${owner}\n开始：${startedAt}\npid：${process.pid}\n令牌：${token}\n`);
  } catch {
    /* owner.txt 写失败不影响锁本身生效（目录已经建好，互斥已经成立） */
  }
  const prevEnv = process.env[TOKEN_ENV];
  process.env[TOKEN_ENV] = token; // 子进程继承：内层工具看到同一令牌就不再等锁
  heldDepth = 1;
  let released = false;
  const realRelease = () => {
    if (released) return;
    released = true;
    heldDepth = 0;
    heldRelease = null;
    if (prevEnv === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = prevEnv;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  };
  heldRelease = realRelease;
  // 外层 release：嵌套层数归零才真正删锁（内层先 release 时不会把外层的锁删掉）
  return () => {
    if (released) return;
    heldDepth = Math.max(0, heldDepth - 1);
    if (heldDepth === 0) realRelease();
  };
}

// ---------- 排队名单（DX-26）：等锁的进程在 tmp/measure.queue/ 下登记一个文件，等锁时打印排在前面的等待者 ----------
function queueDirFor(repoRoot) {
  return path.join(mainRepoRoot(repoRoot), "tmp", "measure.queue");
}
function enqueue(repoRoot, owner) {
  const dir = queueDirFor(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${Date.now()}-${process.pid}.txt`);
  try {
    fs.writeFileSync(f, `${owner}\n`);
  } catch {
    return () => {};
  }
  return () => {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 尽力而为 */
    }
  };
}
/** 当前排队名单（按登记时间），顺手清掉进程已不在的条目。返回 [{ file, pid, since, owner }] */
export function listQueue(repoRoot) {
  const dir = queueDirFor(repoRoot);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const m = name.match(/^(\d+)-(\d+)\.txt$/);
    if (!m) continue;
    const f = path.join(dir, name);
    const pid = Number(m[2]);
    if (!pidAlive(pid)) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* 尽力而为 */
      }
      continue;
    }
    let owner = "";
    try {
      owner = fs.readFileSync(f, "utf8").trim();
    } catch {
      /* 读不到就空着 */
    }
    out.push({ file: name, pid, since: Number(m[1]), owner });
  }
  return out;
}

/** 轮询等到锁释放（或超时）；返回 true = 已释放，false = 超时放弃。调用方在这之后自己再 tryAcquire 一次
 * （两次调用之间理论上仍可能被别人抢先，这不是严格互斥，见文件头注释）。
 * DX-26：锁已被「我」持有时立即返回 true；等待期间登记进排队名单并打印排在前面的等待者；持有者进程已退出的残留锁自动清掉。 */
export async function waitForRelease(repoRoot, { timeoutMs = 20 * 60 * 1000, pollMs = 15000, log = console.log, owner = null } = {}) {
  if (heldByMe(repoRoot)) return true;
  const start = Date.now();
  const leave = enqueue(repoRoot, owner || `pid ${process.pid}`);
  const me = `-${process.pid}.txt`;
  try {
    for (;;) {
      const lock = readLock(repoRoot);
      if (!lock || heldByMe(repoRoot)) return true;
      if (clearStale(repoRoot, log)) continue;
      if (Date.now() - start > timeoutMs) {
        log(`[measure-lock] 等了 ${(timeoutMs / 60000).toFixed(0)} 分钟，锁仍被占用（${lock.owner.split("\n")[0]}），放弃等待，继续执行`);
        return false;
      }
      const q = listQueue(repoRoot);
      const myIdx = q.findIndex((e) => e.file.endsWith(me));
      const ahead = myIdx > 0 ? q.slice(0, myIdx) : [];
      const aheadNote = ahead.length
        ? `；排在前面的等待者 ${ahead.length} 个：${ahead.slice(0, 4).map((e) => `${e.owner.split("\n")[0]}（等了 ${((Date.now() - e.since) / 60000).toFixed(1)} 分钟）`).join("；")}${ahead.length > 4 ? " …" : ""}`
        : "；前面没有别的等待者";
      log(`[measure-lock] 锁被占用（${lock.owner.split("\n")[0]}，${lock.owner.match(/^开始：(.*)$/m)?.[1] ?? ""}）${aheadNote}，${(pollMs / 1000).toFixed(0)}s 后重查...`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    leave();
  }
}

/** 等锁并持锁（ab / flight / gpu-ab / passes 等测量工具共用）。已被「我」持有时不等、返回空 release（可重入）；
 * 等锁超时则不持锁继续（打印警告），返回空 release。 */
export async function acquireOrWait(repoRoot, owner, log = console.log, { timeoutMs } = {}) {
  for (let i = 0; i < 100; i++) {
    const rel = tryAcquire(repoRoot, owner);
    if (rel) return rel;
    const ok = await waitForRelease(repoRoot, { log, owner, timeoutMs });
    if (!ok) {
      log("测量锁等待超时，不持锁继续（结果可能受别的测量影响）");
      return () => {};
    }
  }
  return () => {};
}

/** shots / check 这类「查锁但不强制」的场景用：锁存在就打印一行提示，不阻塞。返回锁信息（或 null）。 */
export function noticeIfLocked(repoRoot, context) {
  const lock = readLock(repoRoot);
  if (lock && !heldByMe(repoRoot)) {
    console.log(
      `[measure-lock] 提示：${context} 时发现测量锁存在（持有者：${lock.owner.split("\n")[0]}）——` +
        "如果对方正在做离线 FXC / 真冷启动 / 按 pass GPU 计时，这里产生的负载可能会污染它的结果（不影响本次执行本身）。" +
        "确有需要可以等它做完，或加 --respect-lock 自动等待释放。",
    );
  }
  return lock;
}
