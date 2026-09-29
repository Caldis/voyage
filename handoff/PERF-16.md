# PERF-16：晴天场景帧时间回退二分调查

性能二分调查代理，中档、只测不改代码。2026-09-29，在 `D:\Code\opus-test\tmp\perf16-bisect`（从主仓库建的临时 worktree，5302 端口）逐提交对照 `55cd90f`（wave8 所在提交）与 `master`（`11ac09e`）。全程 `--wait-quiet`（等 CPU 降到 50% 以下再测），但**未能拿到真正的安静窗口**——详见 §0，这是本次调查最重要的发现，直接决定了后面结论的置信度。

## 结论摘要（先说会不会阻塞发布 / 要不要立即返工）

- **PUB-3 报告的「50%–92% 晴天场景帧时间回退」基本不成立，主要是 wave8（09-28）那批基线数字本身偏低造成的假象，不是 09-28 之后的代码引入了这么大的回退。** 同一时刻、同一口径直接复测 `55cd90f`（wave8 所在提交）本身，得到的数字（noon-cumulus 4.3–5.1 ms、sea-sc 3.0–3.6 ms）已经比 wave8 报告里记的 2.48 ms / 1.50 ms 高出 70%–140%，且和 PUB-3 测 master 的数字（4.6 ms / 2.9 ms）、本次测 master 的数字（5.3 ms / 3.4 ms）落在同一量级。
- **冷启动确认有一个较小的真实回退（约 +7%–9%），不是 PUB-3 说的 +24%。** `55cd90f` 冷启动 min 9.0 s（两轮 9.03 / 9.42 s，接近 wave8 记的 9.1 s），`master` 冷启动 min 9.86 s（两轮 9.86 / 9.88 s）——PUB-3 记的 11.28 s 大概率也是被并发负载抬高的。
- **本次调查环境不是真正的安静窗口**：`nvidia-smi` 显示测量期间 GPU 持续 48%–58% 占用、显存 5.6 GB、频率 2850 MHz（接近 3090 MHz 上限），来自其他并发的 agent 会话（`tasklist` 看到十几个 chrome.exe / node.exe），而 `dev-browser.mjs --wait-quiet` 只检查 CPU，不检查 GPU。这导致**同一个提交前后两次 bench 能差 15%–20%**，单次 bench 序列的逐提交二分不可靠，没能可信地把回退钉到某一个具体合并提交上。
- **不建议据此立即返工任何一个合并**：目前证据只支持「冷启动有约 7%–9% 的小回退、来源未定位」，晴天场景帧时间层面**没有找到可复现的、超出测量噪声的回退**。建议排一个后续任务在真正空闲时段用 `gpu-ab`（同页 ABBA，能部分抵消系统性漂移）重新核实，而不是现在就动代码。

---

## 0. 环境核验：这次是不是真的安静窗口

`dev-browser.mjs cold --wait-quiet` / `bench` 的 `--wait-quiet` 只等本机 **CPU** 占用降到 50% 以下，不检查 GPU。测量期间用 `nvidia-smi` 连续采样：

```
utilization.gpu, memory.used, clocks.current.graphics
57 %, 5636 MiB, 2857 MHz
58 %, 5636 MiB, 2857 MHz
52 %, 5636 MiB, 2850 MHz
55 %, 5636 MiB, 2850 MHz
54 %, 5642 MiB, 2850 MHz
```

此时**我自己没有在跑任何测量**（页面早已关闭），GPU 仍然持续 48%–58% 占用、5.6 GB 显存在用。`tasklist` 同时能看到十几个 `chrome.exe` / `node.exe` 进程，符合仓库当前「多代理并行开发」的常态（DEV_SOP「并行测试造成的卡顿可以忽略」条款本身也承认了这一点，但同时要求「性能结论的可信度」要在安静窗口复测——本次没能做到）。

**后果**：同一个提交，先后两次 `bench`（都过了 `--wait-quiet` 的 CPU 检查）结果能差 15%–20%（见 §1 表格里 `55cd90f` 和索引 8 的两次复测）。这说明 **PUB-3 报告本身、以及 wave8 报告本身，很可能都受到了同样的问题**：`--wait-quiet` 通过不代表真的独占了 GPU。

---

## 1. 第一步：同一时刻同一口径直接测 `55cd90f` 与 `master`

口径：`node scripts/dev-browser.mjs bench --port 5302 --viewport 1600x1200 --dpr 1 --only noon-cumulus,sea-sc --rounds 3 --frames 30 --wait-quiet`，与 PUB-3 §2「交叉核对」同口径。

| 提交 | 场景 | 第 1 次测 | 第 2 次测（同提交复测） |
| --- | --- | ---: | ---: |
| `55cd90f`（wave8） | noon-cumulus | 4.469 / 4.325 ms | 5.106 / 5.074 ms |
| `55cd90f`（wave8） | sea-sc | 2.998 / 3.086 ms | 3.362 / 3.612 ms |
| `master`（`11ac09e`） | noon-cumulus | 5.390 / 5.627 ms | 5.314 / 5.497 ms |
| `master`（`11ac09e`） | sea-sc | 3.371 / 3.543 ms | 3.383 / 3.280 ms |

对照 wave8 报告原文记的数字：noon-cumulus 2.48 ms、sea-sc 1.50 ms。**`55cd90f` 本身现在（同一台机器、同一份代码，隔一天）测出来已经是 3.0–5.1 ms / 3.0–3.6 ms，比 wave8 报告的数字高 70%–140%。** 这印证了任务简报里的怀疑：wave8 那批数字「未确认持测量锁」，本身偏低，**不是可信的回退基线**。

`55cd90f` 与 `master` 两两对照：`55cd90f` 两次测量本身就横跨了 `master` 两次测量的区间（4.3–5.1 ms vs 5.3–5.4 ms），**在这个噪声水平下无法确认 `55cd90f` → `master` 之间存在一个稳定的、可复现的回退**——即使有，量级也远小于 wave8 对比出的「50%–92%」。

---

## 2. 二分过程（逐提交对照表）

沿 `git log --first-parent 55cd90f..master`（126 个一层提交）做二分，每步：`git checkout`（PowerShell 里 `git -C` 操作 `tmp/perf16-bisect`，本 worktree 隔离规则不让 Bash 直接 `cd`/`git -C` 到共享路径下的临时 worktree）→ 锁文件无变化则跳过 `pnpm install` → 重启 5302 → `bench --viewport 1600x1200 --dpr 1 --only noon-cumulus,sea-sc --rounds 3 --frames 30 --wait-quiet`。

| 索引 | 提交 | 说明 | noon-cumulus | sea-sc |
| --- | --- | --- | ---: | ---: |
| 0（基线） | `55cd90f` | wave8 所在提交 | 4.469/4.325 ms（复测 5.106/5.074） | 2.998/3.086 ms（复测 3.362/3.612） |
| 1 | `bc784ac` | 合并 C-FLAT（云受光面压平） | 4.568 / 4.470 ms | 2.942 / 2.904 ms |
| 8 | `b61f29d` | 合并 VOY-DEFAULT（连续航程默认开，但测量带 `voyage=0`） | 4.153/4.338（复测 4.893/5.185） | 2.771/2.840（复测 3.377/3.397） |
| 10 | `add9f73` | WX11g-b 合并前一个看板提交 | 5.022 / 5.048 ms | 3.581 / 3.294 ms |
| 11 | `190c70e` | 合并 WX11g-b（海面耀斑闪点公式改写） | 4.883 / 5.129 ms | 3.376 / 3.251 ms |
| 16 | `b1b0036` | FOCUS-ZOOM 追加需求（board only，代码未合并） | 4.851 / 4.952 ms | 3.268 / 3.537 ms |
| 32 | `e82e927` | W-EDGE 交付审查中（board only） | 5.100 / 5.603 ms | 3.551 / 3.747 ms |
| 63 | `d6ebaea` | 合并 STROBE-FLASH 之后一个看板提交 | 5.370 / 5.510 ms | 3.584 / 3.908 ms |
| 末（master） | `11ac09e` | master | 5.390/5.627（复测 5.314/5.497） | 3.371/3.543（复测 3.383/3.280） |

**读法**：如果这是一次可信的二分，应该能看到数字沿提交顺序单调爬升到一个台阶再稳定。实际情况是：索引 0 的两次复测（4.3–5.1 ms）本身就跨过了索引 8、10、11、16、32、63 全部的取值范围（4.15–5.6 ms）——**整条二分序列的波动幅度和「回退」的量级是同一个数量级**，二分定位在这个噪声水平下**不成立**。

**曾经怀疑过、后来证伪或无法确认的候选**：
- **索引 8→11（VOY-DEFAULT→WX11g-b）第一次测像是一个台阶**（4.15/2.77 → 4.88/3.38），一度怀疑是 WX11g-b 改写的海面耀斑闪烁公式（`ocean.glsl.ts`，泊松抽样改成连续分布 + 一次向量化整数哈希）引入了额外 ALU 开销。但**把索引 8 单独复测一次**，直接得到 4.89/5.19、3.38/3.40——和索引 11 几乎一样，说明第一次的低值是噪声，不是 WX11g-b 的效果。尝试用 `gpu-ab` 的 `patch` 机制在 master 上做消融（把 WX11g-b 新公式原地替换回旧的分支公式），但文本查找在编译后的 `sceneMat` 里找不到精确匹配（大概率是 `ocean.glsl.ts` 的 TypeScript 模板字符串被拼接 / 处理过，和源文件里的原始文本不是逐字节相同），**这条消融没有跑成功，WX11g-b 是否有真实代价仍未验证**，留给下一次任务。
- **C-FLAT（云受光面压平，多次散射代价 ×2）**：索引 1 的数字（4.57/2.94）和索引 0 基线（4.3–5.1/3.0–3.6）落在同一区间，且该提交自己的审查记录写明「gpu-ab 持平」，**没有证据支持它是回退来源**。
- **PERF-STORM（`00531d1`）**：这是本波唯一一个**经过受控测量确认的真实性能变化**——合并记录里写明「雷暴云步进 ×0.74–0.75、用户画布整帧 ×0.83–0.84（审查通过、Sonnet 复测）」，即风暴类场景变快了。这**可以解释 wave8→master 对比里「风暴 / 台风场景涨幅小、甚至变快」的现象**：不是晴天场景多花了钱被风暴场景摊薄，而是风暴场景本身有一次独立的、真实的性能优化，把 wave8 对比表里「晴天涨、风暴不涨」的不对称模式部分解释掉了——**不需要额外假设一个「所有场景通用的固定开销」**。

---

## 3. 消融尝试与限制

- 尝试用 `gpu-ab` 的 `patch` 变体对 WX11g-b 的海面闪烁公式做同页 ABBA 消融，因编译后材质文本与源文件文本不完全一致（可能是构建过程对 GLSL 片段做了拼接 / 归一化）而失败，**没有拿到可信的单项消融证据**。工具与 job/variants 文件留存：`handoff/PERF-16-mkjobs.mjs`（从源文件精确抠取 patch 文本的生成脚本）、`handoff/PERF-16-gpu-jobs.json`（生成的 jobs，留作下次任务参考，需要先解决材质文本不匹配的问题才能跑通）。
- 由于 §0 的环境问题（GPU 被并发进程占了近一半），本任务没有跑通\*\*任何一次\*\*可信的、超出噪声的消融对比；**没有一条「A 比 B 慢 X%」的结论是在受控条件下测出来的**，全部止步于「候选被证伪」或「候选未验证」。

---

## 4. 冷启动

口径：`node scripts/dev-browser.mjs cold --port 5302 --angle d3d11 --repeat 2 --wait-quiet`（受时间限制只跑 2 轮，不是标准的 3 轮）。

| 提交 | 轮 1 | 轮 2 | min |
| --- | ---: | ---: | ---: |
| `55cd90f`（wave8） | 9420 ms | 9033 ms | **9033 ms** |
| `master`（`11ac09e`） | 9880 ms | 9863 ms | **9863 ms** |

- `55cd90f` 的 min（9.03 s）和 wave8 报告记的 9.1 s 基本吻合——冷启动对 GPU 并发负载没那么敏感（编译主要在 CPU 上），所以这个数字比帧时间的数字可信得多。
- `master` 的 min（9.86 s）比 `55cd90f` 高约 **+9.2%**，比 PUB-3 报告的 11.28 s（+24%）低得多。**判断：冷启动确实有一个真实但较小的回退（约 7%–9%），PUB-3 的 11.28 s 大概率也被同一批并发负载抬高了**（PUB-3 用的是协调者常驻的 5181 dev server，测量当天很可能同样有其他代理在跑）。
- 各阶段耗时里，`master` 的「窗外」编译从 `55cd90f` 的 6.6–7.0 s 涨到 6.7–7.1 s，「机翼」从 5.1–5.3 s 涨到 6.1–6.4 s——机翼编译涨幅更明显。09-28 之后合并的机翼相关改动有 STROBE-FLASH（夜间频闪配光、雾前向散射闭式积分）、W-EDGE（轮廓解析覆盖率）等，但**只测了 2 轮、且同样没有排除 GPU/CPU 并发干扰对离线编译的影响（`shader-budget.mjs` 对负载更敏感，±20–40%）**，这条线索需要下一波用 `shader-budget.mjs --chain` 沿提交链单独测机翼程序才能坐实，本任务没有做到这一步。

---

## 5. 建议

1. **不建议现在就为任何一个合并（C-FLAT、VOY-DEFAULT、WX11g-b、STROBE-FLASH…）开返工任务**：晴天场景帧时间层面没有找到超出测量噪声的、可复现的回退证据；冷启动确认有约 7%–9% 的小回退，但没能定位到具体合并。
2. **给协调者的流程建议**：`dev-browser.mjs --wait-quiet` 应该在 CPU 检查之外**再检查一下 GPU**（`nvidia-smi` 或类似手段），哪怕只是打印一条警告——这次的教训是「过了 --wait-quiet 不代表环境干净」，PUB-3 和 wave8 很可能都栽在这一点上。这是一个可以低成本落地的 DX 改进，建议排进 DX 任务。
3. **真正要坐实晴天场景有没有回退、回退多少，需要一个没有其他代理并发跑浏览器的窗口**（例如夜间批次、或协调者临时暂停所有并行开发几分钟），到时优先用 `gpu-ab`（同页 ABBA，能部分抵消系统性漂移，比跨进程 `bench` 更抗干扰）而不是本任务用的逐提交 `bench` 序列。
4. **`handoff/PERF-16-mkjobs.mjs` / `PERF-16-gpu-jobs.json` 留作下次任务起点**：先解决「编译后 `sceneMat` 文本与源文件 `ocean.glsl.ts` 文本不完全一致」这个问题（可能要从 `--base-shader` 读到的运行时 fragmentShader 原文出发反推 patch 文本，而不是直接读 TS 源文件），才能把 WX11g-b 的消融真正跑通。
5. **冷启动的「机翼」编译涨幅**（5.1–5.3 s → 6.1–6.4 s）值得下一波用 `shader-budget.mjs --chain "55cd90f,<STROBE-FLASH>,<W-EDGE>,...,11ac09e" --program wing --rounds 3` 沿链条测，比真冷启动更抗负载干扰，能把「机翼编译涨了多少、哪个合并贡献的」钉得更准。

---

## 复现命令

```bash
# 建临时 worktree（主仓库 tmp/ 下）
git worktree add D:/Code/opus-test/tmp/perf16-bisect 55cd90f
cd D:/Code/opus-test/tmp/perf16-bisect && pnpm install

# 起 5302 dev server（Bash 里 nohup，PowerShell 里 Start-Process 在这台机器上报「不是有效的 Win32 应用程序」，改用 Bash）
cd apps/voyage && nohup pnpm exec vite --port 5302 --strictPort > /tmp/x.log 2>&1 &

# 帧时间对照
node scripts/dev-browser.mjs bench --port 5302 --viewport 1600x1200 --dpr 1 \
  --only noon-cumulus,sea-sc --rounds 3 --frames 30 --wait-quiet

# 冷启动对照
node scripts/dev-browser.mjs cold --port 5302 --angle d3d11 --repeat 2 --wait-quiet

# 切换提交对照（worktree 隔离规则下，git 操作改用 PowerShell）
# PowerShell: git -C D:\Code\opus-test\tmp\perf16-bisect checkout <提交>

# GPU 并发负载核验
nvidia-smi --query-gpu=utilization.gpu,memory.used,clocks.current.graphics --format=csv,noheader
```

---

## 开发体验反馈

- **最花时间的环节**：反复 `git checkout` + 重启 dev server + `bench` 的二分循环，每步约 2–3 分钟（安装依赖判断 + 重启 + 测量），126 个提交的完整二分理论上要十几步，本任务受限于环境噪声中途改变了策略（放弃精细二分，转成「确认回退是否真实」）。
- **最卡的地方**：
  1. worktree 隔离规则下，`Bash` 工具**不能** `cd` 或 `git -C` 到 `tmp/perf16-bisect`（哪怕是自己刚建的临时 worktree，只要不在自己的 worktree 路径下就被拒），只能改用 `PowerShell` 工具做所有 git 操作；而 `PowerShell` 的 `Start-Process -FilePath pnpm` 在这台机器上报「不是有效的 Win32 应用程序」（pnpm 是 shim/批处理，`Start-Process` 直接调用会失败），起 dev server 只能退回 `Bash` 的 `nohup … &`。两个工具各管一半，来回切换容易漏步骤（比如漏了关旧端口的进程）。**希望有**：一条「worktree 隔离下如何用 PowerShell 起后台 vite/node 服务」的复现命令写进 README 或 DEV_SOP，不用每次现试。
  2. `dev-browser.mjs --wait-quiet` 只查 CPU 不查 GPU，是本次最大的坑，导致前半段二分数据基本作废。**希望有**：`--wait-quiet` 顺手打印一行 `nvidia-smi` 摘要（哪怕不阻塞），或者提供一个独立的 `--check-gpu-quiet` 开关。
  3. `gpu-ab` 的 `patch` 机制要求查找文本在**编译后的材质源码**里逐字节匹配，而不是在 TypeScript 源文件里——想从源文件反推 patch 文本容易失败（本任务就踩了），文档里没写清楚两者的关系、也没给出「先用 `--base-shader <端口>` 读运行时原文再做 patch」这类推荐流程。
- **怎么绕过去的**：冷启动测量对 GPU 并发负载不敏感，转而把它当作更可信的信号源；帧时间层面退而求其次，只给出「噪声范围内无法确认」的诚实结论，不硬凑一个二分答案。
- **希望有**：一个「测量锁 + GPU 空闲检测」合一的脚本，在多代理并行开发的日常里，能让性能类任务提前知道「现在测了也白测」，而不是测完才发现数字不可信。

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016y6hSYV47jmqaRvVkgSr1F

---

## 协调者更正（2026-09-29）：本报告与 PUB-3 的帧时间数字受 GPU 占用污染

PERF-16 观察到「测量期间 GPU 被占用 48–58%」，当时归因为并发代理。协调者复查：**真正的来源是协调者自己在 12:52 为线上验收打开、之后没关的 Playwright MCP 页面**（https://caldis.github.io/voyage/ 持续实时渲染）。关掉后 GPU 从 51% 降到 8%，同期没有其他代理在跑。
影响：PUB-3 第 2 节帧时间与本报告的两端对照都在这份负载下测，**绝对值偏高、两端比较也不可靠**；冷启动对 GPU 负载不敏感，+7–9% 的结论相对可信。
处理：在 GPU 空闲（nvidia-smi 利用率 < 10%）时重测，另立 PERF-16b。教训写进 DEV_SOP：用完浏览器页面立刻关；测量前查 GPU 利用率，不只查 CPU。
