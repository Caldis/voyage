# PERF-13 · 窗外程序冷编译回收（交付）

- 分支 `worktree-agent-a9821ca63ea19ce23`，端口 5213，对照 5273（`D:\Code\opus-test\tmp\perf13-base`，master `7a3273e` 的 detached worktree）。
- 状态：**已完成**。必审（碰了热点 outside-pass.ts、main.ts；新增程序 / 变体）。
- 测量期间机器上还有 3 个代理在跑（C01+C02、PERF-12、G01-03），离线 FXC 的中位数 / MAD 噪声很大，判定一律按交替多轮的最小值。

## 改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `src/render/outside-pass.ts` | `WONDER_SKY_COMMON` 与 `wonderSky` 调用点包进 `#ifdef OUTSIDE_WONDER`；变体键 `OutsideKey`（`""` / `OW` / `DOW` / `DROW`）、`outsideVariantDefines` / `outsideVariantFragment`（运行时与离线枚举共用）、**唯一的选择函数 `wantedOutsideKey`**（返回想要的键 + 没编好时的退路）；`GroundDetailVariant` 改为管理全部窗外变体（类名、`status` / `railStatus` / `railCompileMs` / `railMaterial` 保留），新增 `pending`、`variantStatus`、`wanted` / `shown`、`extrasMaterial`，首帧后 90 帧后台预编 `OW`；`LazyVariant` 可带材质名、编译失败 `console.warn` |
| `src/render/optics.glsl.ts` | 宝光 / 本机影子 / 幻日 / 22° 晕（含贝塞尔函数、uniform、冰的常数）进 `#ifdef OUTSIDE_OPTICS`；太阳圆盘 + 绿闪留在默认程序；`opticsComposite` 在函数体里分 `#ifdef`；声明顺序保持原样 |
| `src/render/optics.ts` | 新增纯函数 `opticsWanted(uniforms)`：宝光 / 晕份额 > 0，或本机影子的压暗上界 > 0.2% |
| `src/render/wonder-sky.glsl.ts` | 只改文件头注释 |
| `src/main.ts`（3 行） | `pickOutside()`：关掉真实地理数据时也走 `groundDetail.pick`（高度传 Infinity、不进火车变体），两处调用点改用它。启动批次没改（`outsideMat` 就是默认变体 `""`） |
| `scripts/lint-shaders.mjs` | 登记 `outside-extras`（OW）；DOW / DROW 改用 `outsideVariantDefines`（老树沿用手拼）；sampler 统计从源码开头的 `#define X 1` 读宏；新断言 1c：`outside-default` 预处理后不含罕见光学 / 天幕层奇观标识符，三个变体必须全都含（有区分力） |
| `scripts/scenarios.mjs` + `regression.playwright.js` | `applyScene` 在云变体等待之后先跑两帧、再等 `groundDetail.pending`（最多 120 s） |
| `README.md` | 速查表一行、sampler 表（多 `outside-extras`）、模块表 outside-pass 一行、坑点「着色器编译」一条（四个小坑） |
| `research/compile-ledger.json` | `shader-budget --rounds 3 --jobs 1 --ledger` 追加一行（提交 7a10129） |
| `handoff/PERF-13-*.mjs` | `shots`（零回归截图，冻结 + 写死偏移 / 时刻 / 光学种子 / 频闪）、`parity`（变体与 master 预处理后逐字比较）、`hitch`（预编 / 切换期间帧时间） |

## 消融排行（`shader-budget --variants`，master 树，交替 2 轮取最小，机器有负载，单项噪声 ±20% 以上）

| 撤掉 | outside-default Δmin | outside-ground-detail Δmin | 处理 |
| --- | ---: | ---: | --- |
| 海面 `oceanRadiance` | −40% | −34% | 核心内容（开阔海面无处不在），不拆 |
| **罕见光学（宝光+影子+晕）+ 天梯 / 建木 + 太阳圆盘** | **−38%** | −36% | — |
| **罕见光学（宝光+影子+晕）+ 天梯 / 建木** | **−34%** | −12%（噪声） | **拆（本任务）** |
| 天梯 / 建木 `wonderSky` | −20% | −24% | 拆（W） |
| 交通（远处飞机 / 航迹云） | −16% | −8% | 常驻内容，不拆 |
| 罕见光学（宝光+影子+晕） | −15% | −11% | 拆（O） |
| 谷地雾 | −5% | −6% | 太小 |
| 太阳圆盘 + 绿闪 | −2% | +4% | 太阳常在，留默认 |
| 点星残留（T41）/ 银河（T09） | 0% | 0% | 无 |
| 云影、道路灯带（T08/T43）、城市夜光、湖河、闪电、地形阴影、宝光 / 影子 / 晕单项 | 噪声内（−2% ~ +43%，正值全是负载噪声） | 同 | 不拆 |

原始数据：`tmp/perf13/ablate.json`（对照 worktree 里）、`D:\Code\opus-test\tmp\perf13-ablate.log`；补丁文件在 scratchpad `perf13-ablate.mjs`（20 个单项撤回）。

## 变体表与组合取舍

| 键 | 宏 | 何时编 | 何时画 | 离线 FXC（`--ledger` 那轮最小值） |
| --- | --- | --- | --- | --- |
| `""` | — | 启动批次（关键路径） | 巡航且罕见光学看不出、没有天幕层奇观；任何变体没编好时的兜底 | **6.07 s**（同轮 5 轮对照：5.76 s vs master 10.98 s；消融轮 master 8.83 s） |
| `OW` | OUTSIDE_OPTICS + OUTSIDE_WONDER | 首帧后 90 帧后台预编；想要时立即开始 | 巡航时 `opticsWanted` 或 `uWonderOn` | 8.97 s（= 改动前的 outside-default，预处理后逐字相同） |
| `DOW` | GROUND_DETAIL + O + W | 离地 < 4 km（原节奏） | 低空细节开着 | 11.98 s（= 原 outside-ground-detail，逐字相同） |
| `DROW` | GROUND_DETAIL + RAIL + O + W | 进入火车模式（原节奏） | 火车 | 12.38 s（= 原 outside-rail，逐字相同） |

- **为什么 O、W 不分开**：本机影子是纯物理的，白天在云上几乎总是「看得出」（noon-cumulus、fuji-day、jianmu 都选中 OW），O 并不稀有；W 只在奇观模式下出现。分成 O / W / OW 三个只多编一个程序、省不了关键路径。
- **为什么低空 / 火车不再拆 O、W**：它们本来就是按需后台编的，不在关键路径上；再拆就是 D×{O,W} 的组合爆炸（最多 8 个），收益为零。
- **退路**（`wantedOutsideKey` 给出）：DROW → DOW → （需要 O/W 时）OW → `""`；DOW → （需要时）OW → `""`；OW → `""`。退到 `""` 时宝光 / 影子 / 晕 / 天幕层奇观暂时不画，其他逐像素照旧（`opticsComposite` 在 O 因子为 1、晕为 0 时浮点上精确等于 L·a + rgb）。

## 触发策略

1. 启动批次只编 `""`（main.ts 未改）。
2. 每帧 `pick` → `wantedOutsideKey`（读共用 uniforms：`uOpticsGlory/Halo/Shadow`、`uSunDir`、`uWonderOn`，这一帧的 optics / wonders 已写好）。想要的变体未开始编就开始。
3. 首帧后 90 帧无条件后台预编 `OW`（实测白天在云上的默认页面第一帧就想要 OW，编译立刻开始）。
4. 天幕层奇观召唤时 OW 若没编好：奇观暂不画，编好下一帧出现（浮现本来从地平线霾里开始）。回归截图等 `groundDetail.pending`。

## 数字（d3d11，RTX 5090，1600×1200）

- **真冷启动**（`dev-browser cold --wait-quiet`，与 master 交替 5 轮）：本分支 **11 116 / 11 503 ms**（最小 / 中位；11 116, 11 503, 11 396, 11 659, 11 683），master 13 410 / 13 503（13 410, 13 521, 13 503, 13 561, 13 477），**−2.0 s（−15%），目标 ≤ 13 s 达成**。后台批次 8.8–9.3 s（master 11.1–11.2 s），首帧 0.51–0.53 s 不变。关键路径现在是 scene-default（7.7 s）/ wing（7.5 s）。
- **离线 FXC**：outside-default 5.76 s（5 轮对照，master 10.98 s，−48%；消融轮 master 最小 8.83 s → 改后约 −35%）；账本那轮 6.07 s。
- **帧时间**（`passes.mjs --baseline 5273 --rounds 3 --frames 30`，窗外 pass 本分支 / master）：noon-cumulus（OW）0.407 / 0.400，sunset-wing（`""`）0.394 / 0.410，route-hnd-cts-night（`""`）0.339 / 0.352，night-sea-milkyway（`""`）0.362 / 0.385——OW 持平，默认程序省 3–6%。
- **后台预编 / 切换**（`PERF-13-hitch.mjs`，冷缓存）：启动后 20 s 最长帧 44 ms、无 > 50 ms 的帧，OW 10.3 s 编好；召唤天梯切 OW 最长帧 12.5 ms；启动后立刻召唤：OW 11.9 s 编好后出现，期间最长帧 25 ms。
- **零回归**（`PERF-13-shots.mjs` 冻结 + settle，`PERF-10-matrix.mjs` 均值 / p99，本分支 n、master b 各两次）：14 个场景「n vs b」都在「同代码两次」范围内。例：noon-cumulus n-b 0.50–0.93 / b1-b2 0.46、n1-n2 0.85；wonder-tether-dusk 0.43–0.71 / 0.27–0.36；wonder-jianmu-day 0.43–0.81 / 0.41–0.56；optics-all-glory 0.40–0.56 / 0.43–0.46；optics-all-halo 0.51–0.99 / 0.99–1.47；wonder-floatcity-day 0.94–1.45 / 0.94–1.86；夜景（第二批，频闪钉灭）night-city 1.53–1.74 / 1.43–1.65、route-hnd-cts-night 1.26–2.90 / 1.13–2.85、night-sea-milkyway 0.14–0.39 / 0.19–0.28。rail-oito-default：n4 对 b 0.45、n3 对 b 1.91（n3-n4 1.55，p99 只有 3）——两轮本分支之间也差这么多、且 DROW 与 master 程序逐字相同，是时序（等待时长）不同带来的整体小偏移，不是渲染差异。
  第一批夜景有两张整窗发白：翼尖频闪被冻结在亮相，与窗外 pass 无关（README 坑四）。
- `check:glsl` 全部通过（42 个程序；新断言 1c 通过）；typecheck 通过；截图期间无 console error。
- 预处理比对（`PERF-13-parity.mjs`）：OW ↔ master outside-default、DOW ↔ master outside-ground-detail、DROW ↔ master outside-rail 全部逐字相同；默认程序预处理后 1418 行（master 1849 行）。

## 已知问题 / 没做的

1. 回归截图里 OW 编好之前（冷缓存约 10 s）场景要等；`applyScene` 已等 `pending`。
2. 面板上没有「罕见光学 / 奇观准备中」提示（ui 不在归属；奇观编好前不出现，看起来只是晚几秒）。
3. 海面（−40%）和交通（−16%）是剩下最大的两块，但都是常驻内容；若以后要再压窗外，方向是海面着色本身的开销（PERF 另议）。关键路径已转到 scene-default / wing（PERF-12 在做 scene）。
4. `?optics=all` 这类调试参数启动时也要等 OW 后台编好（约 10 s）才出现。

## 怎么复现

```bash
pnpm --dir apps/voyage exec vite --port 5213 --strictPort --host 127.0.0.1
node apps/voyage/handoff/PERF-13-parity.mjs <master 的 apps/voyage>
node apps/voyage/handoff/PERF-13-shots.mjs 5213 tmp/screenshot/PERF-13/n1     # 对照端口同样跑两次
node apps/voyage/handoff/PERF-10-matrix.mjs tmp/screenshot/PERF-13 b1 b2 n1 n2
node apps/voyage/handoff/PERF-13-hitch.mjs --port 5213 [--early]
node apps/voyage/scripts/shader-budget.mjs --baseline <master 的 apps/voyage> --only outside-default,outside-extras --rounds 5 --jobs 1 --wait-quiet
node apps/voyage/scripts/dev-browser.mjs cold --port 5213 --wait-quiet          # 与 master 端口交替
```
浏览器控制台：`__voyage.groundDetail.variantStatus`。
