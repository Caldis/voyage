#!/usr/bin/env node
// DX-10：测量锁的独立 CLI。shader-budget.mjs / dev-browser.mjs cold / passes.mjs 会自动持锁，
// dev-browser.mjs shots / check 会自动查锁（见 scripts/lib/measure-lock.mjs 文件头）；
// 这个脚本给「不是本仓库脚本」的场景用——例如要跑 `pnpm --filter voyage build` / `vite build` / `vite dev`
// 之前，先手工看一眼有没有人在测量（约定，不是强制，因为我们管不到 vite 自己的 CLI）。
//
// 用法：
//   node scripts/measure-lock.mjs check            # 查一次，锁存在就打印持有者信息，退出码 0（仅提示，不阻塞）
//   node scripts/measure-lock.mjs wait              # 轮询等到锁释放（默认最多 20 分钟）再退出（退出码 0）
//   node scripts/measure-lock.mjs wait --timeout 5  # 自定义超时分钟数，超时也退出码 0（不算失败，只是放弃等待）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLock, noticeIfLocked, waitForRelease } from "./lib/measure-lock.mjs";

const VOYAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0] || "check";
  if (sub === "check") {
    const lock = noticeIfLocked(REPO_ROOT, "手工查锁");
    if (!lock) console.log("[measure-lock] 没有测量锁，可以放心跑 vite 构建 / 开发命令。");
  } else if (sub === "wait") {
    const timeoutMs = args.timeout ? Number(args.timeout) * 60000 : 20 * 60 * 1000;
    const lock = readLock(REPO_ROOT);
    if (!lock) {
      console.log("[measure-lock] 没有测量锁，无需等待。");
      return;
    }
    const released = await waitForRelease(REPO_ROOT, { timeoutMs });
    console.log(released ? "[measure-lock] 锁已释放。" : "[measure-lock] 等待超时，锁可能仍被占用，请自行判断是否继续。");
  } else {
    console.error("用法：node scripts/measure-lock.mjs <check|wait> [--timeout 分钟数]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[measure-lock] 失败：${err.message}`);
  process.exit(1);
});
