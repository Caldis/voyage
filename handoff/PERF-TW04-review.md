# PERF-TW04 独立审查（重档）

- 审查对象：分支 `worktree-agent-ab549aa4e779753f5`，提交 ad1235f，对照 master baaa516（审查中途 master 合入了 TW-LTG，已到 622292d，见第 4 节）。
- 环境：`ANGLE (NVIDIA GeForce RTX 5090 … Direct3D11)`，硬件渲染已核；本分支在 5375，master 对照在 5376（`tmp/ptw4rev-base`，审完已删）；dev-browser 一律带 `voyage=0`；gpu-ab 持测量锁跑 8 轮 ABBA，带 A/A。
- 结论：**通过**。没有阻塞问题。有三条非阻塞遗留：交接文档里有两处结论与实测不符（残差的来源、读回耗时），还有 README 与 master 的一处文字冲突，合并时解决即可。

## 1. GPU 种子着色器 + 同步读回（storm-shield.ts / clouds.ts `updateStormSeeds`）

| 检查项 | 结果 |
| --- | --- |
| 触发频率 | 键只由各单体的 `(R, top)` 组成。导演摆放雷暴时 R / top 固定（`weather-director.ts:536` 在摆放时就按强度算好，之后没有地方逐帧改 `radius` / `top`），所以只有增删单体、或换了参数时才读回。实测平时连续 120 帧读回 **0 次**；删掉单体再按原参数加回也是 0 次（键没变，种子沿用）；加一个新参数的单体读回 1 次。天气导演让雷暴「生长」不会导致每帧读回。 |
| 首帧 / 程序没编好 | 读回在 `Clouds.render` 开头同步完成，之后才写 uniform 和画步进。新单体进场的**第一帧**，`uStormSd` / `uSatA` 就是最终值，之后 6 帧逐位不变，不会先画错一帧几何再跳。种子程序是个 5×4 像素的小程序，第一次用到时同步编译。 |
| 确定性 | 同一组单体连续强制读回 60 次，结果逐位相同。 |
| 上下文丢失 | 整个应用都没有处理 `webglcontextlost` / `restored`（master 也一样），不在本任务范围内。种子缓存在 CPU 上，上下文恢复后 uniform 每帧照常重传，不会因此额外出错。 |
| 扩展依赖 | 需要 `EXT_color_buffer_float`。项目里本来就有大量 FloatType 渲染目标和读回（probe、云缓冲），没有新增硬件门槛。 |
| 精度路径 | **现在只有一处算哈希**：种子程序算一次，march / occupancy / shadow / probe 四个程序和 CPU 上的椭圆都读同一组 uniform，内部一定一致。master 反而是四个程序各自内联一份哈希，由 FXC 分别编译，存在各算各的风险。换到 Metal 或移动端 GPU 上，种子值可能与 D3D11 不同，但那只是换了一组随机数，不会出现「伴生塔位置对不上」这类内部错位。 |

## 2. 外接椭圆

- `scripts/storm-shield.test.mts` 复跑结果：`fail=0 worst q=0.9437`，面积比 0.293。
- 足迹的形状对 R 是尺度不变的：Lx、Ly、wh 都与 R 成正比，k 无量纲，只有 +0.5 km 的余量是加法项，R 越小余量越宽。因此随机抽 R ∈ [3.5, 7] 就能代表全部半径。为防万一，另写了一个规则网格压力测试补上端点：种子 25×25（含 0 和 1）× R ∈ {2.25, 3, 4.5, 6.5, 9（gate 单体）, 10}，每组在足迹内取 401×401 个点，uniform 按 float32 舍入。结果：3750 组全部包住，最差 q = 0.9488，余量约 5%。复现：`node --experimental-transform-types --no-warnings <scratchpad>/shield-grid.mts`，脚本内容与单测同构，只是把随机抽样换成了规则网格。
- 我核对了着色器求交与 CPU 端的一致性：中心 = O + W·a0 + P·l0，其中 P = (−W.y, W.x)，符号一致；`o + dv·t` 的二次方程也没问题。**椭圆没有漏掉砧盾密度**，第 3 节的变体拆分可以直接证明这一点。

## 3. 画质与稳定

同页 ab（`--cloud-live --rounds 2`，对 master 的 march 着色器，整图，差异 0–255）：

| 场景 | 本分支对 master mean / max | 噪声底 mean / max | 亮度 / 相邻差 / 饱和度 |
| --- | --- | --- | --- |
| storm-day | 0.075–0.079 / 68–75 | 0.047–0.057 / 48–54 | 逐项相同 |
| storm-sc-low | 0.49–0.51 / 86–98 | 0.31–0.40 / 76–100 | 逐项相同 |
| tw-squall | 0.085–0.087 / 78–79 | 0.052–0.058 / 42–55 | 逐项相同 |

- 飞行闪烁（storm-day，240 帧，与实现者用的是同一套 live job）：闪烁像素数 old 1 / 4 / 1，cur 4 / 3 / 2，cur2 2 / 2 / 3（依次为砧 / 塔身 / 云海）。与噪声底同量级，**没有新增闪烁**。
- 雷暴进场 / 退场、天气跳转：见第 1 节。种子只由 (R, top) 决定，与数组下标无关；删掉中间某个单体导致下标整体前移后，各单体的伴生塔也不会跳。

**非阻塞遗留 A：交接文档和 README 对残差来源的解释不对。** 我抽查了 storm-day 远处砧顶那一行（y ≈ 413–416）和飑线砧底那一行（y ≈ 468–473），用变体拆分定位来源：

| 变体（同页、对 master march） | storm-day 第 410–420 行均差 | tw-squall 第 465–475 行均差 |
| --- | --- | --- |
| 噪声底（old 两轮） | 0.06–0.11 | 0.00–0.22 |
| cur | 0.35–0.80 | 1.82–1.86 |
| big（椭圆半轴 ÷0.6，接近外接圆） | 0.34 | 1.84 |
| oldgeom（① 整个撤回：外接圆 + 视线判断不看高度层） | 0.81 | 1.84 |
| gpuAnvil / gpuSat（砧盾常量 / 伴生塔改回着色器内算，种子仍用读回值） | 0.36 / 0.36 | 1.85 / 1.84 |
| **allGpu（种子也改回在 march 里算）** | **0.08** | **0.18** |

- 这两条线**与椭圆无关**：把椭圆放大，甚至把 ① 整个撤回，线都还在。只有把种子改回在 march 程序里算，线才消失。这说明读回的种子与 master march 程序内联算出的种子在**末几位**上略有差异（两个程序由 FXC 分别编译），砧盾半轴因此差了 ulp 量级，远处砧盾的边缘挪了不到一个像素。交接文档里「把椭圆放大到接近外接圆（半轴 ÷0.6）这条线就回到噪声底」这一说法，在本机复现不出来。
- 对画面的影响：放大 4–6 倍并排看也分不出来（`tmp/screenshot/ptw4rev/squall-crop2.png`、`squall-crop3.png`）。塔、砧、砧影的位置和形状都没有结构性差异，**不阻塞合并**。建议把 `PERF-TW04.md` 画质一节的归因改成「种子来源不同（读回值与 master march 内联值差在末位）」。

## 4. 静态检查与合并

- typecheck 通过；`pnpm --filter voyage build` 通过，`dist/assets` 下 0 字节文件 0 个；`check:glsl` 全部通过。本审查所有浏览器会话里 console error 均为 0（只有被聚合掉的 EOX 瓦片 CORS 报错，属于网络问题）。
- shader-parity：对 master 直接比，有 7 个程序不同，其中多出的 outside-pillars / outside-ring 来自 master 上的 WS08-b，不是本分支造成的。**对合并基点 f25f660 比，只有 5 个雷暴程序不同**（cloud-march-storm / severe、cloud-occupancy、cloud-probe-weather、cloud-shadow-map-weather）。默认、卷云、透镜云、奇观、台风程序都逐字相同，或预处理后相同。
- `git merge-tree`：对 baaa516 无冲突。**对合入 TW-LTG 后的 master 622292d，`apps/voyage/README.md` 有一处冲突**：TW-LTG 的「远塔云内闪电」条目和本分支的「雷暴天性能回收」条目插在同一位置（云坑点一节末尾）。两边的内容都要保留，只是文字冲突，代码文件没有冲突。WS09 分支对 `clouds.ts` 的改动与本分支能自动合并。

## 5. gpu-ab 抽查（storm-day 整帧）

`gpu-ab --time frame --viewport 2560x1300 --dpr 1.5 --rounds 8 --n 20`，持测量锁（排队等到另一个代理的 shader-budget 结束才开始），变体为 old（master march）/ cur / old2（A/A）：

| 变体 | 中位 ms | 对 old 配对比 [p25, p75] |
| --- | ---: | --- |
| old | 9.754 | 基准 |
| cur | 8.534 | **×0.875** [0.872, 0.876] |
| old2 | 9.782 | ×0.999 [0.998, 1.005]（A/A） |

与交接文档的数字吻合（×0.874，8.53 ms），**数字可信**。

## 非阻塞遗留

- **A**：残差的归因写错了，见第 3 节。改交接文档的一句话即可。
- **B：同步读回的耗时不是「几十微秒」。** 实测强制读回一次中位 5.1 ms、最大 7.5 ms。当时锁被别人占着，这组数只能作参考。原因是 `readPixels` 要等 GPU 做完已提交的上一帧，量级与云步进本身相当。好在 GPU 本来就是瓶颈：读回之后下一个 rAF 来得更早，读回帧的总间隔与平时相同（7.6 ms 左右），实际损失只是「一帧里 CPU 和 GPU 不能并行」，而且只在增删单体时发生。发布前不必改，但 `clouds.ts` 里 `updateStormSeeds` 的注释和 `PERF-TW04.md`「没做 / 剩下的」第 3 条应改成「等一帧 GPU（约几毫秒），只在增删单体时发生」。以后如果要去掉这次等待，可以改用 `readRenderTargetPixelsAsync`，并让新单体推迟到种子到位后再生效。不要用 CPU 模拟哈希。
- **C**：面板直接改天气时（事件发生在两帧之间），下一帧的 `probe()`（`main.ts:453`）会先于 `clouds.render()`（`main.ts:604`）执行。这一次探针读到的新单体常量还是默认值，影响只有一次探针采样，而且飞机位置正好落在新单体的砧盾切片里的概率极小。只记录，不必修。
- **D**：合并 master 时 README 冲突两边都保留，见第 4 节。

## 复现材料（仓库根 `tmp/`，已被忽略）

- `tmp/ptw4rev-seed.mjs`：读回次数、耗时，以及进场 / 退场时逐帧的种子值（`node tmp/ptw4rev-seed.mjs 5375`）。
- `tmp/ptw4rev-gab-*.json`：gpu-ab 用的 jobs / variants。`tmp/ptw4rev-q-jobs.json`：画质对照。`tmp/ptw4rev-live-jobs.json`：飞行闪烁。
- `tmp/ptw4rev-big-jobs.json`、`ptw4rev-geo-jobs.json`、`ptw4rev-split-jobs.json`（由 `ptw4rev-mk-split.mjs` 生成）、`ptw4rev-seed-jobs.json`：残差来源的变体拆分。`tmp/ptw4rev_rows.py`：按行统计差异。`tmp/ptw4rev_diff.py`、`ptw4rev_crop.py`：分块统计与放大裁剪。
- 截图：本 worktree 的 `tmp/screenshot/ptw4rev/{q,big,geo,split,seedsrc,live}`，放大裁剪在仓库根 `tmp/screenshot/ptw4rev/`。
