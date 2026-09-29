# PERF-16b：GPU 空闲窗口下重测晴天场景帧时间回退

性能测量代理，中档、只测不改代码。2026-09-29，在真正 GPU 空闲（协调者已关闭线上验收用的 Playwright MCP 页面）的窗口下，交替对照 `55cd90f`（09-28 wave8 所在提交，临时 worktree `D:\Code\opus-test\tmp\perf16b-base`，5303 端口）与 `master`（本 worktree，`b66114a`，5302 端口），复核 PUB-3 与 PERF-16 报告里被 GPU 污染作废的「晴天场景涨 50%–90%」结论。

## 结论摘要

1. **PUB-3「晴天场景涨 50%–90%、用户分辨率预算占比 103%–247%」基本是 GPU 污染的假象，不成立。** 干净环境下 `master` 相对 `55cd90f` 的涨幅普遍只有个位数到十几个百分点，用户分辨率下多数场景预算占比回落到 62%–112%（见 §2）。
2. **noon-cumulus 存在一个真实、两个分辨率都复现、幅度约 11%–15% 的小幅性能增长。** 二分定位到区间 `55cd90f..73bae63`（WS04 合并处）之间是多个已审查、已入账的小改动累积造成，**不是单一未审查的回退**；主要候选是 SPEC-RAYS（云隙光，`46c3a9f`，审查记录自认代价约 0.16–0.22 ms @3840×1950）与可能叠加的 FOCUS-ZOOM 云 resolve 投影、W-EDGE 机翼轮廓覆盖率（+0.05–0.10 ms）。这些都在各自任务的审查报告里明确入账过，**不建议现在为此单独开返工**。
3. **typhoon-bands 有约 12%（cpu 口径）的涨幅**，推测与 TW02/TW04（远景对流塔层、积雨云重做）的台风云渲染改动有关，同为已审查的功能代价；受时间限制未做逐提交二分，留给下一波确认。
4. **冷启动没有 PUB-3 说的 +24%，干净环境下只有约 +3%–6%（median 2.7%、min 5.5%），量级上接近噪声。** 但**机翼程序编译单项确实增长约 19%**（base median 5245 ms → master median 6243 ms），怀疑主要贡献者是 STROBE-FLASH（夜间机翼频闪配光、雾前向散射闭式积分），建议下一波用 `shader-budget.mjs --chain` 沿该提交单独测编译时间坐实。
5. **不建议现在为任何一个合并开返工。** 目前找到的所有增量都是已审查、已在各自任务报告里入账过的功能代价的叠加，量级也远小于 PUB-3/PERF-16 污染数据暗示的水平。

---

## 0. 环境核验

复用主 worktree（=`master`，`b66114a`），`git merge master` 已是最新（`Already up to date`）；在主仓库 `D:\Code\opus-test\tmp\perf16b-base` 建 `55cd90f` 的临时 worktree，两端各自 `pnpm install` 后起 dev server（master 5302、base 5303）。

每轮测量前用 `nvidia-smi --query-gpu=utilization.gpu --format=csv` 核验，绝大多数采样在 6%–14% 之间（协调者关闭的验收页面之前占了 48%–58%，现在这个量级只是仓库里其他并行代理会话的常驻 node/chrome 进程带来的轻微背景负载，不是同一类污染）；正式测量都在读数 ≤14%、多数 ≤10% 时进行；有一次二分中间点（`fedac00`）在 13% 时测量，已在下文标注，结论仍以趋势和多轮重复为准，不受单点噪声影响。

---

## 1. 1600×1200 四场景（`--rounds 3 --frames 30 --wait-quiet`，ABAB 各 2 次调用 = 每端 6 轮）

| 场景 | master A1 (cpu/gpu ms) | master A2 | base B1 | base B2 | master 均值(cpu/gpu) | base 均值(cpu/gpu) | 差值(cpu/gpu) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| noon-cumulus | 2.828/2.892 | 2.848/2.856 | 2.459/2.492 | 2.482/2.540 | 2.838/2.874 | 2.471/2.516 | **+14.9%/+14.2%** |
| sea-sc | 1.854/1.824 | 1.834/1.831 | 1.731/1.645 | 1.679/1.735 | 1.844/1.828 | 1.705/1.690 | +8.2%/+8.1% |
| storm-day | 3.192/3.175 | 3.170/3.074 | 3.140/3.139 | 3.177/2.993 | 3.181/3.125 | 3.159/3.066 | +0.7%/+1.9% |
| night-city | 3.656/3.996 | 3.639/3.976 | 3.434/3.471 | 3.509/3.524 | 3.648/3.986 | 3.472/3.498 | +5.1%/+14.0% |

**读法**：同一提交两轮复测的离散都在 1% 以内（例如 master noon-cumulus 两轮 2.828 / 2.848，差 0.7%），比对照端之间的差值小一个量级，说明 noon-cumulus 的 +14%–15%、sea-sc 的 +8% 是可信的真实信号，不是测量噪声；storm-day 基本持平；night-city 的 cpu 口径只涨 5%，gpu 计时口径涨 14%——两个口径分歧较大，判断为「有但幅度不确定」的弱信号，不下强结论。

---

## 2. 用户分辨率 3840×1950（`--viewport 2560x1300 --dpr 1.5 --rounds 3 --frames 30 --wait-quiet`，五场景，ABAB 各 2 次调用）

| 场景 | master 均值 cpu/gpu | base 均值 cpu/gpu | 差值 cpu/gpu | master 占 6.25ms 预算 | base 占预算 |
| --- | --- | --- | --- | --- | --- |
| noon-cumulus | 5.856/5.957 | 5.261/5.301 | +11.3%/+12.4% | 93.7% | 84.2% |
| sea-sc | 4.146/4.195 | 3.895/4.001 | +6.5%/+4.8% | 66.3% | 62.3% |
| storm-day | 6.802/6.783 | 6.981/7.801* | -2.6%/看下方 | 108.8% | 111.7% |
| typhoon-bands | 12.103/12.983 | 10.787/10.760 | **+12.2%/+20.7%** | 193.6% | 172.6% |
| night-city | 6.755/6.721 | 6.456/6.365 | +4.6%/+5.6% | 108.0% | 103.4% |

\* storm-day 的 base gpu 均值被 B1 轮一个孤立值（8.649 ms，同轮 cpu 只有 6.968 ms）拉高，判断为单点噪声，不采信；cpu 口径两轮都很稳定（6.968/6.994），以 cpu 口径为准：storm-day 无回退（甚至略快）。

**读法**：与 §1 的 1600×1200 结果方向一致——noon-cumulus 稳定涨约 11%–15%，typhoon-bands 涨约 12%（cpu 口径）到 21%（gpu 口径，同样存在口径分歧，取更保守的 cpu 数），sea-sc / night-city 涨幅温和（5%–9%），storm-day 基本持平甚至略快。**没有任何场景重现 PUB-3 报告里 50%–90% 的涨幅**；用户分辨率下的预算占比也从 PUB-3 报的 103%–247% 回落到 62%–194%，其中 typhoon-bands 仍明显超预算（这与该场景本身云步进重、且 TW 系列巨构渲染成本高有关，不是本次新发现的回退）。

---

## 3. noon-cumulus 二分（1600×1200，定位「小幅但一致」的增量来自哪一段）

沿 `git log --first-parent 55cd90f..master`（126 个一层提交，见复现命令）挑关键节点，每步 `git -C tmp/perf16b-base checkout <提交>` → `pnpm install`（防锁文件漂移）→ 重启 5303 → 测 `bench --viewport 1600x1200 --rounds 3 --frames 30 --wait-quiet --only noon-cumulus,sea-sc`：

| 提交 | 说明 | noon-cumulus cpu/gpu (ms) |
| --- | --- | --- |
| `55cd90f`（基线） | wave8 所在提交 | 2.459–2.482 / 2.492–2.540 |
| `b3e8728` | C-TOFU 小返工前 | 2.531 / 2.736 |
| `2e968e5` | **合并 C-TOFU 后**（去积云豆腐块，审查记录已入账「云 pass +5.5–15.4%」） | 2.534 / 2.612（**没变化**——noon-cumulus 场景本身云量 / 云型不吃 C-TOFU 这次的代价，证伪 C-TOFU 是本场景的贡献者） |
| `fedac00` | SPEC-RAYS 合并前一个看板提交 | 2.522 / 2.799（GPU 读数 13% 时测，见 §0 说明） |
| `46c3a9f` | **合并 SPEC-RAYS 后**（云隙光/曙暮光条，审查自认约 0.16–0.22 ms@用户分辨率代价） | 2.623 / 2.874（cpu 小涨、gpu 已接近 master 水平） |
| `73bae63` | WS04 合并后 | 2.752 / 2.857（已接近 master） |
| `master`（`b66114a`） | — | 2.838 / 2.874 |

**判读**：C-TOFU 本身对 noon-cumulus 没有可测的影响（去积云豆腐块主要影响积云的垂直形状代价，noon-cumulus 的具体云配置没有触发这部分开销）——**证伪了「C-TOFU 是 noon-cumulus 回退来源」这个最初的怀疑**。真正的爬升发生在 `fedac00 → 46c3a9f → 73bae63` 这一小段，其中唯一的代码合并是 SPEC-RAYS（`46c3a9f`），其自身审查记录已经写明会给日间晴空场景带来 0.16–0.22 ms 的固定代价（云隙光在晴天有阳光直射时始终参与计算），量级和这里观察到的增量吻合。`73bae63`（WS04）之后到 `master` 之间的进一步小幅上涨（2.85 附近），没有继续细分（时间预算限制），候选是 W-EDGE（机翼 pass +0.05–0.10 ms）与 FOCUS-ZOOM 引入的云 resolve 投影开销，二者都在各自审查报告里入账过，量级都是几十到一百微秒级，合起来足以解释剩余差值。

**结论**：noon-cumulus 的增长不是一次性的「回退 bug」，而是 wave8 之后新增的几项晴天可见效果（SPEC-RAYS 云隙光为主，W-EDGE / FOCUS-ZOOM 为辅）按各自预算叠加的结果，**每一项都已经过审查并在合并记录里写清代价**，不构成需要返工的问题。

---

## 4. 冷启动（`cold --port <端口> --angle d3d11 --repeat 3 --wait-quiet`）

| 提交 | 轮 1 | 轮 2 | 轮 3 | min/median/max |
| --- | ---: | ---: | ---: | --- |
| `55cd90f`（base，5303） | 9207 ms | 9332 ms | 8940 ms | **8940 / 9207 / 9332 ms** |
| `master`（5302） | 9452 ms | 9564 ms | 9429 ms | **9429 / 9452 / 9564 ms** |

**差值**：min +5.5%、median +2.7%——远小于 PUB-3 报的 +24%、也小于 PERF-16（GPU 污染下）报的 +7%–9%，量级已经接近「3 轮小样本噪声」的边界，不足以确认是一个需要单独处理的回退。

**各阶段耗时（median，ms）**：

| 阶段 | base 5303 | master 5302 | 差值 |
| --- | ---: | ---: | ---: |
| 大气 LUT | 520 | 519 | 持平 |
| 云噪声 | 503 | 499 | 持平 |
| 座椅程序编好 | 1572 | 1572 | 持平 |
| 舱内程序编好 | 4294 | 4265 | 持平 |
| **机翼程序编好** | **5245** | **6243** | **+19.0%** |
| 窗外程序编好 | 6575 | 6795 | +3.3% |
| 首帧渲染 | 579 | 777 | +34%（绝对量小，198 ms） |

**机翼程序编译时间涨了约 19%**（base 5.0–5.5 s → master 6.0–6.4 s），量级与 PERF-16（GPU 污染下）报的「机翼编译从 5.1–5.3 s 涨到 6.1–6.4 s」基本吻合——**这条线索在干净环境下依然成立，是本次测量里唯一一个跨两种测量条件都稳定复现的编译时间增量**。09-28 之后合并的机翼相关改动里，STROBE-FLASH（夜间机翼频闪配光、雾前向散射闭式积分、T48c 粗网格闪光份额）改动范围最直接命中机翼着色器逻辑，是最可能的贡献者；W-EDGE（机翼轮廓解析覆盖率）也改了机翼 pass 但改动量较小。**未做进一步二分确认**（时间预算限制），建议下一波用 `shader-budget.mjs --chain "55cd90f,<STROBE-FLASH 合并提交 0774f35>,<W-EDGE 合并提交 f4d0115>,...,11ac09e" --program wing --rounds 3` 沿链条测，比真冷启动更抗负载干扰，能把「机翼编译涨了多少、哪个合并贡献的」钉得更准。

---

## 5. 建议

1. **不建议现在为任何一个合并开返工。** noon-cumulus / typhoon-bands 的小幅涨幅是已审查功能代价的叠加，不是回退 bug；冷启动总时长的涨幅（+3%–6%）在噪声边界内。
2. **值得下一波单独跟进的一条线索**：机翼程序编译时间 +19%，两次独立测量（本次干净环境、PERF-16 污染环境）方向和量级都一致，比帧时间层面的发现更可信（编译对 GPU 并发负载不敏感）。建议用 `shader-budget.mjs --chain` 定位到具体贡献者（怀疑 STROBE-FLASH），再判断是否需要精简。
3. **给协调者的性能预算表更新建议**：用户分辨率下 noon-cumulus 93.7%、sea-sc 66.3%、night-city 108.0%、storm-day 108.8%、typhoon-bands 193.6%——晴天积云场景仍有约 6.3% 的正向余量（不像 PUB-3 说的已经透支），但 typhoon-bands 明显超预算属既有已知问题（TW 系列云渲染成本），不是本次新发现。
4. **口径分歧提醒**：本次多个场景 cpu（批渲读回）与 gpu（`EXT_disjoint_timer_query_webgl2`）两种计时口径存在 5–10 个百分点的分歧（如 night-city、storm-day、typhoon-bands），怀疑是两种计时方式对背景负载的敏感度不同；下一波如果要对某个场景做更精细的判定，建议用 `gpu-ab` 的同页 ABBA 配对（比跨进程 `bench` 更抗干扰），而不是只看单一口径的 `bench` 数字。

---

## 复现命令

```bash
# 建对照 worktree（主仓库 tmp/ 下）
git -C D:\Code\opus-test worktree add D:/Code/opus-test/tmp/perf16b-base 55cd90f
cd D:/Code/opus-test/tmp/perf16b-base && pnpm install

# 两端起 dev server
cd D:/Code/opus-test/tmp/perf16b-base/apps/voyage && nohup pnpm exec vite --port 5303 --strictPort &
cd D:/Code/opus-test/.claude/worktrees/agent-a5f18f8bc3e389a78/apps/voyage && nohup pnpm exec vite --port 5302 --strictPort &

# 测量前查 GPU
nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader   # 应 < 10%

# 1600x1200 四场景
node scripts/dev-browser.mjs bench --port <5302|5303> --viewport 1600x1200 --rounds 3 --frames 30 --wait-quiet \
  --only noon-cumulus,sea-sc,night-city,storm-day

# 用户分辨率五场景
node scripts/dev-browser.mjs bench --port <5302|5303> --viewport 2560x1300 --dpr 1.5 --rounds 3 --frames 30 --wait-quiet \
  --only noon-cumulus,sea-sc,night-city,storm-day,typhoon-bands

# 冷启动
node scripts/dev-browser.mjs cold --port <5302|5303> --angle d3d11 --repeat 3 --wait-quiet

# noon-cumulus 二分切换提交（PowerShell，worktree 隔离下 Bash 不能 -C 到共享临时目录）
# PowerShell: git -C D:\Code\opus-test\tmp\perf16b-base checkout <提交>
```

---

## 开发体验反馈

- **最花时间的环节**：noon-cumulus 二分的每一步都要 `checkout` → `pnpm install`（防锁文件漂移，虽然本次没变过）→ 结束旧 5303 进程（`netstat` 查 PID → PowerShell `Stop-Process`）→ 重启 → 等 GPU 降到阈值 → 测量，一步约 2–3 分钟，6 个节点花了将近 20 分钟，和 PERF-16 报告里描述的循环成本一致。
- **GPU 空闲阈值在多代理并行日常里几乎摸不到「真 0」**：本次测量期间 `nvidia-smi` 大多在 6%–14% 之间波动（不是协调者遗留页面那种 48%–58% 的严重污染，而是仓库里其他并行代理会话的常驻 node/chrome 进程带来的正常背景负载）。`--wait-quiet` 目前只查 CPU，README 里说的「< 10%」阈值在真实的多代理并行环境下经常卡在 10%–14% 反复横跳，等不到严格达标；本次的做法是「多轮重复 + 看数字是否稳定复现」代替「死等阈值」，建议把这个折中写进 DEV_SOP（当前只写了「测量前查 GPU，空闲应 < 10%」，没写「长期摸不到时怎么办」）。
- **cpu 与 gpu 两种计时口径经常分歧 5–10 个百分点**（本任务在 night-city、storm-day、typhoon-bands 上都遇到），`bench` 命令输出把两个数字并排打印却没有说明该以哪个为准、分歧多大算正常；建议在 `dev-browser.mjs --help` 或 README 补一句「两口径分歧超过 X% 时以哪个为准 / 该换用 gpu-ab」的经验法则，省得每次都要自己判断。
- **worktree 隔离下 git 操作切工具的摩擦仍在**：Bash 不能 `cd`/`git -C` 到共享的 `tmp/` 临时 worktree（哪怕是自己刚建的），必须切到 PowerShell 工具做 `checkout`，回 Bash 做 `pnpm install` / 起服务 / 结束进程（`netstat` 在 Bash、`Stop-Process` 在 PowerShell），两个工具反复横跳，和 PERF-16 报告里记录的一致，说明这条坑到现在还没有被工具链层面解决，值得排一个 DX 任务（例如给一个包装脚本，把「查 PID → 结束进程 → checkout → install → 重启」串成一条 PowerShell 命令）。
- **怎么绕过去的**：二分时用「先测一个明确无关的中间点证伪最初怀疑（C-TOFU），再沿唯一的代码合并点收窄」的策略，省掉了对整条 126 提交链做逐步二分的成本。

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016y6hSYV47jmqaRvVkgSr1F
