# TM02 独立审查（白天窗外局部色调映射 + 修 TM01 机翼迷彩亮斑）

- 对象：`worktree-agent-a1ef80f4d6dd2dfb1`（f271dea），范围 `git diff master...worktree-agent-a1ef80f4d6dd2dfb1`；实现者交接 `handoff/TM02.md`。
- 复核环境：临时 worktree `tmp/tm02rev`（master 70732f4 + `merge --no-commit` 本分支），5218；对照 master = 主仓库 5181。审完已 `worktree remove` + `Remove-Item` + `prune`，5181 未动。
- 全部截图都确认是高画质档（自写脚本 `quality.setTier("high")`、`shots` 场景里带 `quality: "high"`，JSON 里 `tier/level = high`），1600×1200，d3d11，RTX 5090。
- 原始数据：`tmp/screenshot/tm02rev/`（`occ/` 机翼判据直读 + 三变体截图，`pair/` 同页换 master 曝光着色器 A/B，`flicker/` 云实时波动）。审查脚本放在 scratchpad（`tm02rev-occ.mjs`、`tm02rev-math.py`、`tm02rev-edge.py`、`tm02rev-wingzone.py`、`tm02rev-cmp.py`），没进仓库。

## 结论：**通过**

机翼判据的前提（机翼 pass 在没有机翼的像素上逐位照抄）实测成立，美术总监 wave7 第 1 条在 biz-seated / noon-cumulus / route-hnd-cts / economy-ahead / sunset-wing 的翼面上**逐像素为 0**（关掉判据时同一批像素最大 +11～15 级）。局部色调映射的数学离线扫过：单调、无 NaN、无负增益，平滑渐变处与 TM01 逐位相同，不会产生新的带或阶梯。零回归同页 A/B：云里、黄昏、夜景（关灯 / 开灯 / 银河）最大差 ≤ 1 级；白天场景差值只来自本任务的两处改动。冷编译 +2.6%，帧时间可忽略。和 G07、C11 都没有合并冲突。

以下问题都不阻塞合并。第 1 条是注释写错了，建议合并时顺手改掉（两行）；其余记进看板或 README 坑点即可。

## 问题（按严重度）

### 1.【低 · 文档与实际不符】「中间段与全局一致、局部项只在收回段起作用」不成立，中间段的细节斜率实际是 1.46–1.58，不是 1.4

- 位置：`src/render/exposure.ts` 分支版第 288 行（「sd = s 时…与全局曲线相同，不会出光晕」）、第 294 行（「中间段按上面的泰勒关系与全局曲线一致，局部项只在收回段起作用」）；`handoff/TM02.md` 第 106 行（「细节按 1.4、大尺度按 1.3」）。
- 证据（`tm02rev-math.py` 按着色器原样复刻，低通 b 固定、像素在 b ± 0.05 档内变化，AgX 之前的对数斜率）：

| b（档） | 0.5 | 1.0 | 1.5 | 2.0 | 2.5 | 3.0 | 4.0 | 4.5 | 5.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TM02 细节斜率 | 1.21 | 1.46 | 1.52 | **1.58** | 1.25 | 1.19 | 1.08 | 0.90 | 0.88 |
| TM01 全局斜率 | 1.15 | 1.30 | 1.30 | 1.29 | 1.03 | 0.77 | 0.76 | 0.76 | 0.88 |

- 原因：`s1 = (sd − 1)·H' + κ·G(b)`（第 318 行）里的 κ·G 项并不只在收回段起作用，中间段 G 已经涨到 0.45 档，因此多出 0.18 的斜率。加上 sd = 1.4 ≠ s = 1.3，中间段本身也不满足泰勒一致。noon-cumulus / cu-side 那 0.6–0.8 级、8 px 的「云边内侧略亮」就是从中间段来的（实现者表里的数，方向与此吻合）。
- 影响：画面上没问题。实测光晕 ≤ 1.3 级，同页 A/B 下 storm-day 与 master 的最大差只有 3 级，没有任何 ≥ 2.5 级的像素。问题在于注释会误导后面的人：以为中间段不会出光晕，再调 κ / sd 时就不会去看中间段。
- 修法：把两处注释改成「中间段细节斜率 = sd + κ·G(b)（定稿参数下约 1.5–1.6，AgX 之前）；光晕靠值域回落控制，不靠泰勒一致」，TM02.md 第 106 行同步改。如果确实想让 κ 只补肩部，可以写成 `loc.y * gb * (1.0 − q.x + q.y)` 这类「只在顶点之后生效」的权重，但这样会改变定稿指标，要重跑 int_c 与 band，本次不建议动。

### 2.【低】机翼剪影上的抗锯齿过渡像素整像素不提亮：背后是受光云时，剪影外沿有一条 1 px、暗 4～13 级的线

- 判据是「有没有被机翼改过」，是二值的（1e-5 → 1e-4 的 smoothstep 实际上等于阶跃）。边缘像素是 a·机翼 + (1 − a)·云，理想的提亮应是 (1 − a) × 邻居提亮，现在给的是 0。
- 证据（`tm02rev-edge.py`，被判挡住、且 4 邻域有未挡像素的边界像素）：biz-seated 边界 1796 px，其中邻居提亮 > 2 级的 90 px，邻居提亮中位 7.0、p90 11.8、最大 13.1 级，边界像素自身提亮恒为 0。economy-ahead 81 px（中位 3.7），sunset-wing 62 px（中位 5.6）。集中在整流罩端面这类竖直边（x = 804）。放大图 `occ/biz-strobe0/edge_crop.png`（off | final | 差 ×8，×4 放大）上肉眼看不出，因为整流罩本身是深灰。
- 性质：线和机翼剪影重合，不会跟着云滑动，边缘像素本身和 TM01 之前逐位相同，所以不属于闪烁或锯齿。以后如果美术总监在白色翼尖 / 小翼贴着亮云的机位看到发暗的描边，根因就在这里。
- 修法（可选，不必现在做）：机翼 pass 已经算出覆盖率 `wing.a * m`，走 MRT 或把它写进 `hdrWing` 以外的一张 R8 目标，门控改乘 `1 − 覆盖率`。代价是改机翼程序的输出布局，实现者评估过（冷编译、测光的双线性采样），所以没这么做，我同意这个取舍。

### 3.【低 · 记录】薄雾里翼尖灯的散射光会让判据把大片天空 / 海面判成「被挡住」；实测对画面没有影响

- 翼尖灯在 `uCameraFog > 0` 时往整个窗外加单次散射光（`wing-shading.glsl.ts` 的 `wingLights`），这时机翼 pass 就不再是逐位照抄。实现者写的「翼尖灯光晕只在云里才有，云里门控本来就是 0」只说对了一半：`uniformField` 按测光的均匀度判断，薄雾（进出云边）时并不等于 1。
- 证据（`tm02rev-occ.mjs` 直读 hdr / hdrWing，关掉探针后把 `clouds.cameraDensity` 钉成 0.02，频闪钉亮）：noon-fog2-s1 有 342k 像素部分排除、426k 像素完全排除，频闪灭时是 115k（只有机翼）。掩码图 `occ/noon-fog2-s1/occmask.png`：大片天空与海被排除，亮积云上的相对差 < 1e-5，没被排除（图中红色）。
- 画面影响：final 与 noOcc 的差在频闪亮 / 灭时完全相同（0.98% 像素 > 1 级，都是机翼本身）。final 帧间差 12.53%，noOcc 12.76%，off 12.25%，都是频闪本身造成的，判据没有让高光段额外闪。原因是被排除的都是天空 / 海 / 暗处，这些像素的 hiGate 本来就是 0（云不透明度门控），或者本来就不在高光段。
- 修法：不用改。建议在 README 坑点「按屏幕位置读云缓冲…」那条补一句：「判据在薄雾 + 频闪时会把天空 / 海判成被挡，因为那里本来就不吃增益，所以无害；以后若把高光段扩到天空，要先把翼尖灯散射从判据里分出去」。

### 4.【低 · 已知遗留，严重度评估】地形 / 奇观剪影挡在云前仍按背后的云提亮：5 个场景里都没复现出可见问题

- 云缓冲不按地形深度裁剪（`clouds.ts` 的右半深度只供窗外程序判断云在山前还是山后），所以这个遗留确实存在。
- 实测（off vs final 差图 `occ/<场景>/d_final_off.png`、`pair_small.png`）：fuji-day、自设的 fuji-cloudy（4.5 km、云量 0.45）、fuji-cloudy-low（3.2 km、云量 0.5）的富士山区域差值恒为 0：远山有雾，亮度在膝点以下，背后也基本没有云。wonder-jianmu-day 的剪影上没有差值。wonder-floatcity-day 的浮空城整体 0，只在树冠边缘有几个零散像素（`occ/wonder-floatcity-day/sil_crop.png`，≤ 几级）。
- 评估：**低**。剪影通常被大气压暗到膝点（中灰 +0.5 档）以下，不吃增益。真正的风险机位是「近距离、正午、受光的雪顶或白色奇观挡在亮积云前」，另外远处的飞机（traffic）也属于同类，但它们太小。建议保留 README 里「窗外 pass 输出有效云不透明度」的根治方向，不单独开任务，等美术总监在低空山区场景看到了再排。

### 5.【低 · 性能记录】每像素多读一次 RGBA32F 全屏纹理

- 冷编译（`shader-budget --only exposure-final,exposure-adapt --baseline D:/Code/opus-test --rounds 11 --wait-quiet`，按最小值）：**exposure-final 80 vs 78 ms（+2.6%）**，exposure-adapt 44 vs 44（+0.0%）。单任务门槛是 10%，远低于门槛。实现者报的 +0.0% 在噪声范围内，以本次数字为准，这一波累计请性能工程师在安静窗口统一复测。
- 帧时间（`passes.mjs --baseline 5181 --only noon-cumulus,clouds-variety --frames 30 --rounds 5`）：曝光合成中位 0.036 vs 0.030 ms（noon）、0.036 vs 0.021 ms（variety），+0.006～0.015 ms。均值噪声很大（一次 +157%、一次 −21%），按中位看。
- 带宽：`uPreWing` 在 1600×1200 是 30.7 MB/帧（16 B/px），5090 上约 0.02 ms，但在 200 GB/s 级的集显 / 笔记本上约 0.15 ms，4K 下翻两倍多。可选优化：把两次 `texelFetch` 挪进 `if (hiGate > 0.0)`。天空、舱内、夜里、云里的像素跳过读取，空间上连贯，分支代价小；但 exposure-final 以前实测「带 if 编译 +7–10%」（T48 注释），要先用 shader-budget 验证。现在不必做，记给性能工程师。
- sampler：曝光合成 4 → 5（uHdr、uAdapted、uBloom、uPreWing、uClouds），远低于 WebGL2 的 16 与 ANGLE D3D11 的限制；`check:glsl` 的 README sampler 表比对通过。

## 重点审核项逐条

### 1. 机翼遮挡判据

直接在页面里用 `readRenderTargetPixels` 读 `cabinClass.target`（= main.ts 的 `hdr`，也确认了 `uPreWing.value === 它的 texture`）和 `hdrWing`，逐像素算着色器同款的逐通道相对差（`occ/summary.json`）：

| 条件 | 两目标尺寸 / 类型 | 完全相同 | 有差但 < 1e-5 | 部分排除 | 完全排除 |
| --- | --- | ---: | ---: | ---: | ---: |
| biz-seated 频闪灭 | 1600×1200 / Float 同 | 1839574 | 0 | 0 | 80426 |
| biz-seated 频闪亮 | 同 | 1838989 | 0 | 0 | 81011 |
| biz-seated 湿窗（WING_WET 变体已换上） | 同 | 1839251 | 1 | 1 | 80747 |
| biz-seated 舱灯关 | 同 | 1838789 | 0 | 1 | 81210 |
| economy-ahead（经济舱变体） | 同 | 1805255 | 0 | 0 | 114745 |
| sunset-wing / noon-cumulus / route-hnd-cts | 同 | 逐位同 | 0 | ≤ 2 | 机翼 |
| night-city（频闪亮） | 同 | 1783041 | 0 | 1 | 136958 |
| in-cloud（频闪亮、湿窗） | 同 | 1036400 | 0 | 550974 | 332626（云里 hiGate = 0，无影响） |
| 薄雾 0.02 + 频闪亮 | 同 | 见第 3 条 | | | |

- 代码层面核对了 `wing-pass.ts`：`m ≤ 0` 时直接返回 `sc`；`wing.a == 0` 时根本不进合成分支，`col = sc.rgb`；唯一无条件叠加的是 `wingLights`，灯核外 smoothstep 恰为 0，雾里散射见第 3 条。没有 dither，没有 MSAA（两个目标都没设 samples），没有 TAA / jitter。半精度路径（没有 `OES_texture_float_linear` 时）是 half → fp32 → half 的往返，精确；`min(col, uHdrMax)` 在半精度下是 6e4，只可能截到太阳核，而太阳核属于天空，云不透明度门控本来就是 0。两个目标都在 `resize()` 里按同一个 drawing buffer 尺寸 `setSize`，画质档改的是 DPR，改了会一起 resize，不存在分辨率不一致。曝光合成画到屏幕（`pass.render(finalMat, null)`），和两个输入都不是同一个目标，没有读写回环。
- 美术总监的验收条款「翼面逐像素与关闭 TM01 的差 ≤ 1 级」（`tm02rev-wingzone.py`，被判挡住的像素上 final − off）：biz-seated（频闪灭 / 亮、湿窗、舱灯关）、economy-ahead、sunset-wing、noon-cumulus、route-hnd-cts **平均 0.000、最大 0**；同一批像素在 noOcc（即合并时 TM01 的行为）下平均 1.56～1.67、最大 11～15 级，15～25% 的像素 > 3 级。night-city、in-cloud 两者都是 0（门控本来就关）。
- 未接线的回退：`uPreWing = null` 时 three 绑的是 1×1 空纹理，越界 texelFetch 读到 0，按「不排除」处理。启动时 `exposure.render` 的首次调用就走这条路，没问题。

### 2. 局部色调映射数学

`tm02rev-math.py`：饱和度偏移 0～2 档 × 低通 −2～8 档 × 像素 −3～8 档，步长 1e-3：
- 输出 `l + gain` 对 l 单调，最小导数 **0.605**（sat 0.2、b 3.0、l 3.74，收回段 + 顶端淡出叠加处），没有 NaN，没有负增益（末尾 `max(…, 0)` 兜底）。
- 固定像素、只动低通：|∂gain/∂b| 最大 0.43。增益对 b 连续，值域回落 `d/(1+(d/σr)²)` 与顶端淡出都是 C0 以上，不会产生台阶。
- b = l（平滑渐变、低通等于像素）时 TM02 与 TM01 **逐位相同**（最大差 0），天空渐变、云内缓坡不会出现新的带。
- 低通尺度：`uBloom` 最细一级（半分辨率，约 2 px）占 45%，因此 σ ≤ 2 px 的纹理被当作细节，2–8 px 的结构有一半仍按曲线收回。实现者 README 坑三写得准确（最亮段只回到 ×0.97 的原因）。
- 门控（白天 × 非均匀视野 × 窗外遮罩 × 云不透明度 × 新增的非机翼）完整保留：局部项乘在同一个 `hiGate` 上（第 419 行），同页 A/B 下天空、海面像素都不变。
- 时间稳定性（`dev-browser flicker --cloud-live --frames 32 --crop 480,420,640,500`，局部项开 / 关各一页）：clouds-variety relStd 0.0111 vs 0.0103（+8%，与细节斜率 1.4/1.3 同比，属于预期，不是新闪烁），relLow16 0.0011 vs 0.0011，爬行 0.0195 vs 0.0195；storm-day 各项持平。

### 3. 零回归（`shots --pair 'v.benchFrame = () => 0;' --base-shader 5181 --material exposure.finalMat`，同页 a = TM02、b = master 曝光着色器、a2 = 噪声底）

| 场景 | TM02 vs master 最大差 / >1 级 | 噪声底 a vs a2 |
| --- | --- | --- |
| in-cloud | 1 / 0% | 0 |
| dusk-earthshadow | 0 / 0% | 0 |
| night-city（T48 夜间色度） | 1 / 0%（b vs a2；a 拍的时候地面瓦片还没到齐，a vs a2 本身就差 250 级，见开发体验反馈） | — |
| night-city-on（开灯倒影上限） | 1 / 0%（同上） | — |
| night-sea-milkyway | 1 / 0% | 0 |
| typhoon-bands / storm-day | 3 / 2.1% · 1.3% | 0 |
| clouds-variety / wonder-floatcity-day | 3 / 4.9% · 4.5% | ≤ 1 |
| sunset-wing | 8 / 0.26% | 0 |
| noon-cumulus / biz-seated / economy-ahead（T47 交界） | 12 · 12 · 10 / 2.6% · 1.4% · 1.6%（均值为负：去掉的就是翼面亮斑） | 0 |

- ≥ 250 占比 master → TM02：sunset-wing 0.360% → 0.360%，wonder-floatcity-day 0.090% → 0.090%，noon 0.001% → 0.001%，其余 0 → 0。
- 台风 / 雷暴只有 ≤ 3 级的局部项差；台风外围卷云盖过曝不属于色调映射，实现者的归因（追加 2）我没有复测，数字自洽：typhoon-outer-11 在高光段下的增益为 0。

### 4. 性能：见问题第 5 条。

### 5. 接线与在途任务

- `main.ts` 只多一行，在 `uClouds` 接线之后、机翼 pass 之前赋 `hdr.texture`（纹理对象不变，每帧赋值只是保险）。
- `git merge-tree --write-tree`：TM02 + G07（a3f4b41，改 main.ts 第 67 行 `ground.attachGl` 与 README）无冲突；TM02 + C11（a9f7428，改 clouds.ts resolve 与 scenarios.mjs）无冲突。C11 只在 `uCloudImmersion > 0.02`（云里）改 resolve，而云里 hiGate = 0，不影响本任务的门控。
- 合并后的临时树：`tsc --noEmit` 通过，`pnpm --filter voyage check:glsl` 全部通过（含 README sampler 表比对），`pnpm --filter voyage build` 通过，所有截图过程中控制台 error 只有 EOX 影像瓦片的 CORS（外部服务，master 上也有，与本任务无关）。

## 开发体验反馈

- **哪里慢**：场景冷启动 + 等地面瓦片占了大头（每个带地面的场景约 1 分钟）。整个审查约 70 分钟，其中跑浏览器约 40 分钟。
- **哪里卡**：
  1. 验证「机翼 pass 逐位照抄」没有现成工具。`__voyage` 没有直接暴露 `hdr`，只能走私有字段 `cabinClass.target`。建议 `__voyage` 加一个 `hdr` 字段，或者给 `probe.mjs` 加一个「两个渲染目标逐像素相对差」的子命令：以后凡是「用 pass 前后差当判据」的设计都能复用。
  2. 想在冻结状态下模拟「薄雾」，要先 `clouds.probe = () => {}`，否则异步探针读回会把手设的 `cameraDensity` 覆盖掉，第一次没注意，白跑一轮。建议在 README「调试」里补一句，或者加一个 `__voyage.debugCameraDensity` 覆盖值。
  3. `shots --pair` 的 a 张在夜景（night-city / night-city-on）上会在地面瓦片没到齐时就拍，a 与 a2 差 250 级、19% 像素；b 与 a2 才是逐位可比的。`--settle` 应该能解决，但 `--pair` 模式下默认不等，建议 `--pair` 带地面的场景默认 settle，或者至少在输出里提示「a 与 a2 不一致，噪声底无效」。
  4. 我的自写截图脚本在 04:06 左右跑的时候，别人的测量锁（passes.mjs，5211）还在，脚本只打印了提示，没有等（自写脚本没接 `--respect-lock`）。如果对方那一轮 GPU 计时噪声偏大，可能和我有关。建议 `measure-lock.mjs` 导出一个 `await waitLock()`，让临时脚本一行就能接入。
- **怎么绕过去的**：直读私有字段；手动禁用探针；night 场景改比 b vs a2。
