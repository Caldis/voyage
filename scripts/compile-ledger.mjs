#!/usr/bin/env node
// DX-10：编译预算账本。第 6 波性能工程师复测反馈里提到「账本没有 owner，门槛口径不一致」
// （research/PERF_REPORT_wave6.md §3.5：「每一项单看都『≤ 门槛』，可门槛本身就有 5/10/15/20% 四种说法，
// 也没有账本」）。这里把账本落成一份权威数据（research/compile-ledger.json），而不是散在 PERF 报告的
// Markdown 表格里手抄——`shader-budget.mjs --ledger` 可以直接追加一行，PERF 报告引用本文件而不是重复数字。
//
// 用法：
//   node scripts/compile-ledger.mjs                       # 等价于 --emit-md：打印全部账本条目的 Markdown 表格
//   node scripts/compile-ledger.mjs --emit-md              # 同上
//   node scripts/compile-ledger.mjs --emit-md --programs cloud-march,outside-default   # 只看这几个程序的列
//   node scripts/compile-ledger.mjs --list                 # 逐行打印条目摘要（日期、提交、备注、程序数）
// 追加一行不需要手写 JSON：`shader-budget.mjs --ledger`（跑完默认流程后自动调用 appendLedgerEntry）；
// 这个文件本身只导出 loadLedger / appendLedgerEntry / renderMarkdown 给 shader-budget.mjs 用，
// 以及一个小 CLI 方便直接看账本内容。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOYAGE_ROOT = path.join(HERE, "..");
export const LEDGER_PATH = path.join(VOYAGE_ROOT, "research", "compile-ledger.json");

/** 读账本；文件不存在时返回一个空账本（不抛错，第一次追加会自然创建文件）。 */
export function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) {
    return { $note: "DX-10：编译预算账本，见 scripts/compile-ledger.mjs 文件头注释。", unit: "ms（fxc /O1 离线编译最小值）", entries: [] };
  }
  return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
}

/** 追加一行并写回磁盘，返回更新后的账本对象。entry 形状：
 * { date, commit, label, quick, jobs, rounds, programs: { [programId]: { min, median, mad, note? } } } */
export function appendLedgerEntry(entry) {
  const ledger = loadLedger();
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  ledger.entries.push(entry);
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
  return ledger;
}

/** 渲染成可以直接贴进 README / PERF 报告的 Markdown 表格。programs 为空时用全部条目出现过的程序 id 并集
 * （按首次出现顺序），给太多列时建议用 --programs 只挑关心的几个。 */
export function renderMarkdown(ledger, { programs } = {}) {
  const entries = ledger.entries || [];
  const progSet = programs && programs.length > 0 ? programs : [...new Set(entries.flatMap((e) => Object.keys(e.programs || {})))];
  const lines = [`| 日期 | 提交 | 备注 | ${progSet.join(" | ")} |`, `| --- | --- | --- | ${progSet.map(() => "---").join(" | ")} |`];
  for (const e of entries) {
    const cells = progSet.map((p) => {
      const r = e.programs && e.programs[p];
      if (!r) return "—";
      return `${Math.round(r.min)}${r.note ? "†" : ""}`;
    });
    lines.push(`| ${e.date} | \`${e.commit}\` | ${(e.label || "").replace(/\|/g, "\\|")} | ${cells.join(" | ")} |`);
  }
  lines.push("", "†该程序离线计时不可信（见 shader-budget.mjs 的 OFFLINE_UNRELIABLE / README 坑点），数字仅供参考。单位 ms（fxc /O1 最小值）。");
  return lines.join("\n");
}

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledger = loadLedger();

  if (args.list) {
    console.log(`== 编译预算账本（${LEDGER_PATH.replace(VOYAGE_ROOT, "apps/voyage").replace(/\\/g, "/")}） ==`);
    for (const e of ledger.entries || []) {
      console.log(`${e.date}  ${e.commit}  ${e.label || ""}（${Object.keys(e.programs || {}).length} 个程序，rounds=${e.rounds ?? "?"}${e.quick ? "，/Od" : ""}）`);
    }
    return;
  }

  // 默认（无参数）或 --emit-md：打印 Markdown 表格
  const programs = args.programs ? String(args.programs).split(",").map((s) => s.trim()) : null;
  console.log(renderMarkdown(ledger, { programs }));
}

const isMain = path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
if (isMain) main();
