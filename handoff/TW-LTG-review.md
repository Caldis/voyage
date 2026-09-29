# TW-LTG 独立审查报告

审查对象：分支 `worktree-agent-acabd099855b25ac9`（提交 `a39d3f1`）相对 `master`。任务：远景塔夜间云内闪电。
审查方式：读 diff（`src/clouds/far-towers.ts`、`scripts/dev-browser.mjs`、`README.md`）+ 在该 worktree 起真实开发服务器（端口 5374，Vite）+ `scripts/dev-browser.mjs` 实测（硬件渲染，`GL_RENDERER = ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 …) D3D11`），另建两个临时对照 worktree（纯 master、master 合并本分支）做像素与 shader-parity 对照，审毕已删除。

## 结论：**通过**

四个重点逐条核实，均无阻塞问题；有若干细微遗留记在下面，不阻塞合并。

## 重点 1：默认关闪逐位不变，且不影响用户正常看到闪电

- 代码层面：`scripts/dev-browser.mjs` 的 `setFlashDisabled(true)` 把 `farTowers.hold=true; heldIntensity=0`；`advanceFlashes` 的 `hold` 分支（`src/clouds/far-towers.ts:632-638`）在此时把每座塔的 `D[i].x` 钉在 `heldIntensity=0`，着色器 `if (D.x > 1e-4)` 分支必然不进入，逐位不变有严格保证，不依赖概率。
- 实测：直接拿本分支 `git diff master...HEAD` 比较存在"跨 master 演进"的噪声（本分支切出后 master 又合并了 TW04/塔重做、WS08-b 等无关改动，直接比对会把这些也算进去）。改用正确对照——建"master 合并本分支"的临时 worktree（`tmp/tw-ltg-review-merged`，只需解掉 `README.md` 的坑点列表顺序性冲突，非代码冲突）与纯 `master`（`tmp/tw-ltg-review-master`）在默认关闪下跑同一镜头（`handoff/TW-LTG-scenes.json` 的 `tw-ltg-off`），逐像素比较：
  - `master` vs `merged`（未冻结）：max diff 51、mean diff 0.26、非零像素 21.3%；
  - **同一份 merged 代码自比两次（噪声底）**：max diff 48、mean diff 0.38、非零像素 23.7%。
  - 两者同量级，说明前者的"差异"是云步进本身的时间抖动噪声（DEV_SOP「冻结工具对云是瞎的」已知限制），不是本任务引入的回归。`D.x` 恒零已由代码逻辑严格保证，像素对比作为交叉验证，未发现额外差异。
- 普通用户入口（不经过 `dev-browser.mjs`）：`FarTowers.hold` 类字段默认值 `false`（`far-towers.ts:496`），全仓库 grep 确认 `src/main.ts` 及其它启动路径不设置这个字段，只有 `dev-browser.mjs` 的截图工具会主动关闭。用冻结 3 秒后恢复（见下）的测试里，**没有任何手动触发**，`hold=false` 的塔在恢复正常渲染后第 780ms 就自动按泊松节律亮了一次（见重点 2 的冻结测试记录），证明默认路径下闪电会正常自主触发，没有被误关。

## 重点 2：节律与性能

- **32 塔 CPU 开销**：页面内直接调用 `farTowers.advanceFlashes(1/60)`（TS `private` 不影响运行时可调用）循环 2000 次，32 塔（全部 `anvil>0.05`）：**per-call 5.30 µs**，相当于每帧 0.0053 ms，占 60 fps 帧预算（16.6 ms）的 0.03%，可忽略。
- **时间加速（playRate=600×）**：从黄昏前起播，连续 4 秒真实时间（≈2400 秒模拟时间，覆盖太阳穿过 −4° 的整个暮光窗口），逐帧采样：`dayNightFlips=1`（只有一次干净的昼夜切换，没有来回抖动）、`badSamples=0`（无 NaN / 负值）。未观察到"狂闪"。
- **冻结 / 恢复**：`__voyage.freeze(true)` 冻结 3 秒（此时 `clouds.render`→`farTowers.render`→`advanceFlashes` 整体不被调用，`this.clock` 不推进——与 `weather.ts` 同一套设计），`freeze(false)` 恢复后连续采样 8 座塔（全部 `anvil>0.05`）1.5 秒：**没有出现恢复瞬间多塔齐闪的爆发**，780 ms 才有第一座塔自然触发，此后同时活跃的塔数最多到 2（8 座独立泊松过程、平均 9 s 间隔下的正常重叠概率），符合 `this.clock += Math.min(dtS, 0.5)` 限幅设计的预期效果（`far-towers.ts:625`）。未观察到"卡住不再触发"。
- **太阳 −4° 附近开关**：`nightOk` 是硬开关（`far-towers.ts:640-643`，`D[i].set(0,0,0,0)` 无渐隐），与 `main.ts:534` 主光源切换到月光用**同一个阈值、同一种硬切**是一致的既有约定，不是本任务新增的风格。极端情况下如果恰好有一次回击衰减到一半时穿越 −4°，会瞬间归零，但这个时间窗口极窄（暮光角速度下通常几十秒到几分钟才跨过，且要求恰好有塔在闪），本次测试未复现到可见跳变；记为非阻塞细节（见下方遗留 b）。
- **整窗亮度**：用 `--allow-flash` 连续实测两组（`hold` 强制峰值 1.3、`flashNow()` 自然触发峰值 0.907）与关闪基线做全帧亮度对比（Rec.709 luma）：
  - 强制峰值 1.3：全帧均值 79.0→80.3（+1.3，约 +1.6%），亮度提升 >10/255 的像素占比仅 1.65%；
  - 自然峰值 0.907：全帧均值 79.3→80.0（+0.74），>10 的像素占比 1.60%。
  - 两组都证明效果被严格限制在地平线附近的塔区域，**没有整窗曝光 / 泛光被冲起来的迹象**，符合"夜里远处闪电应是地平线局部亮起"的要求。

## 重点 3：其他着色器程序逐字不变，far-towers 冷编译无明显增加

- `scripts/shader-parity.mjs --base master`：直接拿本分支比 master 会把 master 后续合并的 TW04/WS08-b 相关着色器改动也报成"不同"（`cloud-shadow-map-weather`、`outside-pillars`、`outside-ring` 等 9 个程序），这是 master 与本分支分叉后的正常演进，与本任务无关。改用"master 合并本分支"的临时 worktree 重跑：**48 个程序里只有 `far-towers` 不同，其余 47 个逐字相同**；`far-towers` 的唯一差异正是预期的 `uniform vec4 uFarD[32];` 声明（加在第 251 行），其余全部一致。`shader-parity` 结论成立。
- 冷编译：`far-towers` 本来就"按需后台编译，不在启动批次"（README 既有说明），`dev-browser.mjs cold --baseline` 实测的启动批次（云#0-2 / 座椅 / 舱内 / 机翼 / 窗外）里**没有 far-towers 这一项**，说明它压根不在冷启动关键路径上，两次重复测量的批次耗时差异（如"窗外"7.9s vs 10.9s）在同时有其它代理占用 GPU（`shader-budget.mjs`/`gpu-ab` 测量锁提示）时属正常噪声，与本任务无关。改动本身也只是 1 条 uniform 声明 + 两处各 6 行左右的条件分支（无新循环、无新函数、无新程序），按 DEV_SOP「冷编译只在大改着色器结构时测一次」的标准，不属于需要专门测的量级，未额外做 far-towers 自身的按需编译计时。

## 静态检查与合并

- `npx tsc --noEmit`：通过。
- `node scripts/lint-shaders.mjs`（`check:glsl`）：全部 `[OK]`。
- `npx vite build`：通过；`find dist/assets -type f -size 0`：空（无 0 字节文件）。
- 控制台：本次审查跑的全部约 10 组场景（默认关闪、hold 强制、flashNow 峰值、32 塔性能、时间加速、冻结恢复、真实天气场 accept 场景）均 **0 console error / pageerror**。
- `git merge-tree`（对 master 试合并）：只有 **1 处冲突**——`README.md` 坑点列表，TW04（已在 master）与 TW-LTG（本分支）在同一个锚点各自追加一条，是**列表顺序性冲突，不是语义冲突**（两段互不依赖，谁前谁后都行）。`far-towers.ts`、`dev-browser.mjs`、4 个新增 `handoff/TW-LTG-*` 文件全部干净合并，无需协调者额外处理代码层面的冲突。

## 非阻塞遗留

1. **`newFlashChannel` 的回击间隔公式**（`src/clouds/far-towers.ts:669`）：`t0 = this.clock + k * (0.05 + Math.random() * 0.08)` 是"下标 k 乘以每次独立重新采样的随机数"，不是"累加独立间隔"，因此不严格保证后一下的 `t0` 晚于前一下——粗算相邻两下（k、k+1）有约 3.5% 概率发生顺序反转（例如第 3 下比第 2 下先触发）。`sumFlash`（同文件 `sumFlash`）只按 `age = clock - t0 >= 0` 筛选、按指数衰减叠加，顺序反转不会报错、不会越界，且 2–4 下本来就在 100–300 ms 内互相叠加衰减，视觉上不会有可感知的跳变或变亮异常——纯粹是和文档"依次间隔 50–130 ms"的字面表述有出入。以后顺手改的话，一行修法：`t0 = prevT0 + (0.05 + Math.random() * 0.08)`（累加而非乘 k）。
2. **−4° 处的硬切**（`far-towers.ts:640-643`）：与 `main.ts` 主光源切换同阈值同风格，非本任务独有问题；若以后要打磨，可以在 ±1° 内做一个线性淡出代替瞬间归零，本次测试未复现出可见跳变，暂不需要处理。
3. 坑六（远处闪电色被空气透视吃暖）：README / handoff 已如实记录为物理结果、非 bug，复核认同，不需要处理。
4. `advanceFlashes` 每帧对每座活跃塔的 `strokes` 数组做 `filter`（产生新数组）、以及每帧新建一个 `Set` 做 id 清理，属于小的、可预期的 GC 压力；32 塔实测 5.3 µs/帧完全在预算内，仅记录以备将来塔数大幅增加时参考，不需要现在处理。

## 复现命令（本次审查用的补充脚本，未提交，仅供参考）

审查过程中额外写的场景 JSON（32 塔性能、时间加速、冻结恢复、峰值亮度）都是本地临时文件，未随本报告提交；如需复现，按交付文档 `handoff/TW-LTG.md`「复现」一节的命令跑 `TW-LTG-scenes.json` / `TW-LTG-decay.json` / `TW-LTG-accept.json` 即可覆盖本报告列出的默认关闪、自然峰值、真实天气场三类场景；32 塔 CPU 开销 / 时间加速 / 冻结恢复三项如需复核，思路是：`v.farTowers.override` 摆 N 座 `anvil>0.05` 的塔，夜间日期，之后分别（a）直接循环调用 `v.farTowers.advanceFlashes(1/60)` 计时，（b）设 `v.state.playRate` 后逐帧采样 `v.sunAltDeg()` 与 `uFarD`，（c）`v.freeze(true)` 等待后 `v.freeze(false)` 逐帧采样 `uFarD`。

---

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016y6hSYV47jmqaRvVkgSr1F
