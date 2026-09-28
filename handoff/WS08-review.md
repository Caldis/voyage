# WS08 天环（轨道环弧，OWT 变体）· 独立审查

- 审查对象：分支 `worktree-agent-ab85d31a7f01a2786` @ `5528fbe`，对照 master `950e6c8`（分支基于 732fc61；审查开始时 `git merge-tree` 无冲突，master 只多了 VOY-HKG，碰的是 director.ts / routes.ts。**审完 master 又前进到 ff5953c，出现冲突，见「合并注意」**）。
- 环境：私有 headless，`GL_RENDERER = ANGLE (NVIDIA GeForce RTX 5090 … D3D11)`，1600×1200，DPR 1，画质 high，URL 带 `voyage=0`。
  「master 合并本分支」临时树 `tmp/ws08rev-merge` 在 5361，master 临时树 `tmp/ws08rev-master` 在 5362（审完已删）。ab / gpu-ab 自动持测量锁（排队等过另一个代理的 ab）。
- 截图：主仓库 `tmp/screenshot/WS08-review/`（`br` / `br2` 分支两轮、`m1` / `m2` master 两轮、`br3` 巨柱群单跑、`disk-moon` 修法实测、`ab-live/`）。复现用的场景 / 补丁在主仓库 `tmp/ws08rev/`（`scenes.json` 给 js 末尾加了「等 groundDetail.pending」、`patch-moon.js`）。

## 结论：需返工（一处，一到两行，月亮那行已实测），另有与新 master（ff5953c）的冲突要解——两者都能由协调者合并时直接处理，不必再审

## 核对结果

| 项 | 结果 |
| --- | --- |
| `typecheck` / `pnpm --filter voyage build` | 过（merge 树）；`find dist/assets -type f -size 0` 无输出 |
| `check:glsl` | 全部通过：`outside-ring` 语法 OK；「只有 outside-ring 含天环代码」断言 6 个程序全 OK；outside-ring 含罕见光学 / 奇观代码 OK |
| `shader-parity --base <master 树>` | 46 个程序全部相同：`outside-default / -extras(OW) / -ground-detail(DOW) / -rail(DROW) / -pillars(OWP)` 预处理后逐字相同，只新增 `outside-ring`（OWT） |
| 控制台 | 全部 shots / ab / gpu-ab 运行 0 console error / pageerror（瓦片 CORS 已聚合，不相关） |
| 现有奇观零回归（天梯 `ws-tether-noon`、建木 `wonder-jianmu-day`、浮空城 `wonder-floatcity-day`、巨柱群 `ws-pillars-noon`；冻结 + settle） | 分支(br2)×master 超 4 级像素 27k–75k / 100k–129k / 96k–124k / 58k–73k，master×master 噪声底 70k / 94k / 94k / 58k，分支×分支 68k / 150k / 232k——**都在同一量级**，差图是海浪 / 云边 / 建木树冠轮廓的亚像素噪声，无结构差异。与 shader-parity 一致。四个场景实际画的变体：OW / OW / OW / OWP（与 master 同） |
| wantedOutsideKey（读码 + 实测） | ①天环：`uRingOn && !rail` → OWT，退路只有默认（不画天环），截图实测 `wanted OWT / shown OWT`；②天环不写 `uWonderOn` / `uWonderShape`，`syncUniforms` 对 ring 提前 return，所以 OW / DOW / DROW 里的 `wonderSky` 看到 `uWonderOn = 0` 直接返回——**火车模式（DROW）下天环不会被画成建木**（WS07 那类问题不存在，只是切火车时天环直接消失，见遗留 3）；③巨柱群 → 天环：残留 `uWonderShape.z = 2` 但 `uWonderOn = 0`，不会误进 OWP；天环 → 天梯：`uRingOn` 置 0、`uWonderOn = 1`、skin 0 → OW；④罕见光学与天环同时在场：OWT = O + W + T，光学照画；⑤低空 detail：天环在 4.5 km 以下退场（60 s），这段时间仍选 OWT、DOW 晚到（见遗留 4）。实测「浮空城 → 巨柱群」「天环 → 巨柱群」两种顺序 OWP 都在 15–30 s（负载下）编好切过去 |
| catalog.ts 分配表 | 与代码一致：0 天梯 / 1 建木（wonder-sky）、2 巨柱群 `PILLARS_SKIN`（OWP）、3 天环 `RING_SKIN`（`uRingOn`，OWT） |
| OWT 未编好 | 退默认，不画天环、不黑不闪；页面内编译 10.5–22 s（负载下），浮现 60 s，前沿从地平线霾里起，编好时前沿还低 |
| 浮现期覆盖率 | `gRingCov = … * visF`，前沿以上不挡星（WS07 审查问题 1 的同类错误没有犯） |

## 性能（持测量锁，`gpu-ab --time frame --rounds 8`，天环开 / 开（A/A）/ 关，关 = 切回不带天环的程序）

| 场景 | 开 ms | A/A | 关 对 开 | 在场增量 |
| --- | ---: | --- | --- | ---: |
| 正午 `ws08-noon` | 1.941 | ×0.994 [0.990, 0.999] | ×1.003 [0.992, 1.013]（离散度内） | ≈ 0 |
| 黄昏仰看 `ws08-dusk-up` | 1.330 | ×0.996 [0.982, 1.004] | ×0.949 [0.936, 0.974]（显著） | **+0.035–0.07 ms** |
| 无月夜 `ws08-night-nm-up` | 1.532 | ×0.994 [0.989, 0.999] | ×0.977 [0.967, 0.999]（离散度内） | ≈ +0.02–0.04 ms |

全部远低于参考上限 +0.6 ms ✓。（变体只改 uniform / js，gpu-ab 跳过了程序切换核对；ab live 里「关」的画面确实没有天环、程序按 `wantedOutsideKey` 退回，可以认为切换生效。）

## 闪烁（`ab` live，解冻飞行 240 帧，二阶差分阈值 16、帧占比 > 5% 算闪烁像素；实现者的 `handoff/WS08-live-jobs.json` 原样复跑，OWT 程序）

| 场景 | 区域 | on | on2 | off |
| --- | --- | --- | --- | --- |
| 正午 | 环 / 支柱 | 0 / 0 | 0 / 0 | 0 / 0 |
| 黄昏仰看 | 受光段 / 交界与地影段 | 0 / 0 | 0 / 0 | 0 / 0 |
| 无月夜 | 近段灯 / **远段** | 0 / **10** | 1 / **1** | 1 / 0 |

无月夜远段 on / on2 分别 10 / 1 个闪烁像素（区域约 15 万像素），在同代码两次之间的波动范围内；每帧超阈值约 6.5–7 个像素（off 为 0.06），量级与沿环奔跑的光脉冲（设计如此、9 km/s）一致，**看不到灯串爬动 / 锯齿闪烁**。冻结静帧同代码两轮逐位 0。OWT 化没有带来闪烁回归。

## 合并注意：审查期间 master 前进到 `ff5953c`（WS-STAR），现在有两处冲突

上面的全部核对都是对 `950e6c8` 做的（当时 `merge-tree` 无冲突）。审完再查，master 已合并 WS-STAR，`git merge-tree` 报 `README.md` 与 `outside-pass.ts` 冲突：

- `outside-pass.ts`：WS-STAR 把 `gStarVis *= 1.0 - gWonderCov;` 从巨柱群分支里挪到 `#endif` 之后，给所有天幕层奇观共用。解决方式：保留本分支的 `#elif defined(ORBIT_RING)` 分支（含 `gStarVis *= 1.0 - gRingCov;` 与阻塞 1 的月亮修法），把 WS-STAR 那行留在 `#ifdef WONDER_PILLARS … #endif` 之后。OWT 里 `wonderSky` 不会被调用，`gWonderCov` 一直是 0，多乘这一次也无害（`gWonderCov` 在 `WONDER_SKY_COMMON` 里声明，OWT 有 W 宏，编得过）：
  ```glsl
  #ifdef WONDER_PILLARS
    L = wonderPillars(L, rd, hitGround ? tGround : 1e9);
  #elif defined(ORBIT_RING)
    L = orbitRing(L, rd, hitGround);
    gStarVis *= 1.0 - gRingCov;
    if (!hitGround) L -= gRingCov * moonDisk(rd) * sunTransmittance(uCamR, rd.y);
  #else
    L = wonderSky(L, rd, hitGround ? tGround : 1e9);
  #endif
    gStarVis *= 1.0 - gWonderCov; // WS-STAR 的共用行（原注释保留）
  ```
- `README.md`：两边都在奇观坑点末尾追加条目，两边都保留即可。
- 解决冲突后，协调者要在合并结果上重跑 `check:glsl` 和 `shader-parity --base <ff5953c>`（OW / DOW / DROW / OWP 预处理后应与 ff5953c 逐字相同，只新增 outside-ring），再跑一次 `ws08-dusk-up` 看月亮是否被挡住。

## 阻塞问题

### 1. 月亮圆盘（与晕）透过天环画出来——就在自己的回归场景 `ws08-dusk-up` 里（修法两行，已实测）

- 位置：`src/render/outside-pass.ts:211`（天空路径 `L += moonDisk(rd) * tUp + starRadiance(...)`）先把月亮 / 银河加进背景，`:227` `orbitRing` 只做 `L + ringAdd`，不减去身后的东西；`:234` 太阳圆盘 `opticsSunDisk` 更是在奇观之后才加。
- 现象：`br2/ws08-dusk-up.png`（月亮 5.8°、照亮 99%）月亮正落在天环的地影段里，圆盘和一圈光晕完整地画在环带上，环读起来像一条透明的玻璃带——与「横贯天空的实心巨构」直接冲突，而且这张会成为回归基线。实现者在「已知问题」里自报过（「天环遮日的机会很少」），但回归场景本身就撞上了，频率不低：环横贯 36° 宽、月亮在低空的机会很多。
- 修法（只进 OWT，其它程序预处理后不变）：在 `outside-pass.ts` 的 `#elif defined(ORBIT_RING)` 分支里 `gStarVis *= 1.0 - gRingCov;` 之后加一行：
  ```glsl
  if (!hitGround) L -= gRingCov * moonDisk(rd) * sunTransmittance(uCamR, rd.y); // 月亮在环身后：被环挡掉（天空内散射在环前面，不动）
  ```
  实测（`disk-moon/ws08-dusk-up.a/.b.png`，页面内给 OWT 材质打补丁）：月亮与晕都被挡掉，环带其余处与原来逐像素一致，没有负值 / 黑斑。
  太阳同理，建议一起改成（`#ifdef` 包住，默认 / OW 等程序文本不变）：
  ```glsl
  #ifdef ORBIT_RING
    L += opticsSunDisk(rd, hitGround) * (1.0 - gRingCov);
  #else
    L += opticsSunDisk(rd, hitGround);
  #endif
  ```
  太阳这行没有实测（回归场景里没有太阳在环后的机位；这个场景太阳在地平线下）。建议用乘法而不是在环分支里「减」：我第一次在同一页面连续几个场景叠打了补丁（`--pair` 的修改会留到后面的场景，减法被重复套用），出现过大块黑盘（负值被 bloom 放大）；用乘法不存在重复减成负数的问题。单独、只套一次的月亮那行是干净的。银河（`starRadiance`）同样会透过环，但暗得多，算一次的代价不值，记遗留。
- 识别：`ws08-dusk-up` 里月亮圆盘出现在环带内；修好后那里应只剩地影段的淡灯点。

## 非阻塞遗留（按严重度）

1. **无月夜中段的「疏密」色块读成低清贴图（中高，建议下一波优先）**：`ws08-night-nm-up` 近段是一粒粒清楚的钠灯点（好），但从第二座枢纽往下，像素足迹大过约 3 km 后灯点换成 `mix(0.5 * dens, …)` 的面亮度，`dens` 是 28 × 20 km 的 value noise 过 `smoothstep(0.45, 0.9)`——屏幕上是一块块边缘发虚、近似方格的粉灰斑（放大图 `z-night-mid.png`），像一张被放大的低清纹理，碰到铁律「宁可小，不要糊」「宁可有雾，也不露低清贴图」。它不闪（ab live 已证），所以不阻塞。方向：远段把疏密的对比随足迹一起收（`smoothstep` 的区间随 `farP` 放宽、或加一层更细的倍频），让它过渡成均匀的暗橙光带而不是斑块；或远段保留少量可分辨的亮灯点（按格子取，能量守恒）。`ws08-dusk-up` 的地影段也有同样的淡方块。
2. **黄昏受光 / 地影交界是一条一像素硬的横切线**（中，和 WS07 巨柱群同一个毛病）：真实地影边缘有半影、越靠近交界越红越暗。`ringLightT` 在 `perigee` 跨过 `BOTTOM` 时是硬切（`ring.glsl.ts:120`），可按太阳视半径给几 km 的软边。
3. **切到火车模式时天环直接消失**（低）：DROW 不含 OWT，`wantedOutsideKey` 在 rail 时不选 OWT，天环不会画错（好），但会从「在场」一帧跳没，而不是走 60 s 退场。冷门路径，记录即可。
4. **低空细节在天环退场期间晚到最多 60 s**（低）：天环 4.5 km 以下才退场，detail 4 km 以下就要 DOW，但只要 `uRingOn` 还是 1 就选 OWT（不含 GROUND_DETAIL）。同 WS07 的同类记录。
5. **OWT 编译期间罕见光学暂停**（低）：`OWT` 的退路只有 `""`。OW 在天环在场时是安全的（`uWonderOn = 0`，`wonderSky` 第一行返回），可以把 `outside-pass.ts:367` 的 `fallback: [""]` 改成 `fallback: ["OW", ""]`，这样召唤天环的那 10–20 s 里正在显示的幻日 / 晕不会闪没。一行，可顺手。
6. **白天的环偏「半透明的玻璃带」**（观感，低）：`ws08-noon` 读得出巨构——跨满整窗、两侧出画、枢纽是等距的「刻度」、支柱从地平线霾里升到腹面，远近一目了然，不是贴图或淡带；但带面上的铺板 / 窗带像磨砂玻璃，天空蓝透过来，有一点 UI / 全息的味道。物理上说得通（大气外、按「加」合成），实现者已记；若用户想更「实」，提高腹面反照率即可。
7. 文档小出入：`catalog.ts` 条目注释写「仰角 7–18°」，`ring-shape.ts` / 交接写 5–13°；`outside-pass.ts` 的 OWT 注释写「离线 FXC 约 18 s」，现在实测约 11 s。
8. 银河透过环（见阻塞 1）；缆塔 420–650 km 内淡出而不是被云遮挡（实现者已记）。

## 观感（兼美术总监）

- **正午**：成立。一道横贯窗口的巨弧、两侧出画，枢纽刻度 + 一根缆塔从地平线升起，尺度链条清楚，读成「横贯天空的巨构」。见遗留 6。
- **黄昏**：受光段（最亮的东西、结构保留）→ 红色交界 → 地影段（几乎隐形、只剩灯）是这组里最好看、最「真」的一张；月亮透出（阻塞 1）与硬交界线（遗留 2）是主要瑕疵。
- **无月夜**：近段城市灯火可信、有尺度；中远段斑块是本任务最出戏的地方（遗留 1）。无闪烁。

## 开发体验反馈

- 哪里慢：测量锁排队（别的代理的 ab 占了一阵）。OWT / OWP 在负载下页面内编译 10–30 s，shots 场景要自己在 js 里轮询 `groundDetail.pending`。
- 哪里卡：`shots --scenes-file` 与 `--only` 并用时 `--only` 不生效（跑了文件里全部场景）；`--pair` 的 js 对材质的修改会留到同一页面后面的场景，后面的场景就叠了多次补丁（我因此一度看到黑盘，后来单场景重测才分清），建议 `--pair` 每个场景前复原被改过的材质，或文档里写明。
- 希望：`shots` 场景自动等 `groundDetail.pending`（天环 / 巨柱群的回归场景都需要）；gpu-ab 对「只改 uniform」的变体也能报出计时区间里用的窗外程序键。
