# PERF-WING · 压缩机翼程序的冷编译（W-EDGE 的前置）

- 分支 `worktree-agent-a8dcd60b2b0aec1e1`，开发端口 5246，对照 5306（`D:\Code\opus-test\tmp\perfwing-base`，detach master 60cc7f2）。
- 归属：`src/render/wing*.ts`，只做等价重构。工具与数据：`handoff/PERF-WING-*`，原始输出在 `tmp/perfwing/`（已忽略）。
- 状态：**交付**（机翼 pass 帧时间 +2–3% 待协调者取舍，见 §4）。

## 结论先说

1. **机翼程序的冷编译大头不在求交循环，在着色**：同一时刻消融（`shader-budget --variants`，3 轮最小值），去掉整个 `shadeWing` 调用 −69%；
   `sdWing` 各部件合计约 −30%；W-STAIR 下界 −0.2%、自阴影段 −1.8%、鼓包 −2.6%。
2. **着色里最贵的一块是翼尖灯的位置 `wingLampPos(i)`**：它只取决于 uniform（翼尖弯曲），却在 `shadeWing` 的灯循环（套在 5 条子射线的循环里）和
   `wingLights` 的灯循环里各内联一份（下标是循环变量，`i == 2` 的尾灯分支还要再调三次 `wingTipLE`）。消融：着色里那份 −13.3%、光晕里那份 −5.9%。
3. **改法（已提交 bc92f32）**：`main` 里每个像素调一次 `wingLampsSetup()`，三次**常数下标**的 `wingLampPos(0/1/2)` 存进三个全局 `vec3`，
   两处灯循环改读 `wingLampAt(i)`。常数下标让 FXC 折掉按 i 的分支、三份共用的翼尖角度只算一遍。
   离线 FXC（`--baseline` 对照 master，5 轮最小值）：**wing 6854 → 4905 ms（−28.4%），wing-wet 8383 → 5758 ms（−31.3%）**。
   同样的「只算一次」写成守卫循环（下标不是常数）只有 −12%。

## 1. 关键路径（`dev-browser cold`，d3d11，1600×1200）

「批次各程序编好（ms）」，改动前（master，单独 5 轮，安静时）：

| 程序 | min | median |
| --- | ---: | ---: |
| 云 #0/#1/#2 | 795 / 795 / 989 | 799 / 799 / 991 |
| 座椅 | 1557 | 1562 |
| 舱内 | 4195 | 4226 |
| 窗外 | 6469 | 6580 |
| **机翼** | **6817** | **7109** |
| 后台编译总时长 | 6817 | 7109 |

**改动前机翼已经是关键路径**（比窗外晚 0.35 s 最小值 / 0.5 s 中位）：W-STAIR + W-LAMP 之后余量已经是负的。

改动后与 master 交替 5 轮（`cold --baseline 5306 --repeat 5`；这一段机器负载较高，两边都比上表慢）：

| 程序 | 当前 min / median | master min / median |
| --- | ---: | ---: |
| 座椅 | 1564 / 1644 | 1597 / 1650 |
| 舱内 | 4679 / 5043 | 4999 / 5232 |
| **机翼** | **5283 / 5720** | 7677 / 8116 |
| 窗外 | 7509 / 7681 | 8160 / 8632 |
| 后台编译总时长 | **7509 / 7681** | 8404 / 8632 |

机翼真冷编译 −31%（最小值）/ −30%（中位），后台编译总时长 −11%；关键路径回到窗外程序，**机翼比窗外早约 2.0 s（中位）**。

## 2. 逐项数据（离线 FXC `/O1`，`--variants`，3 轮最小值，同一批次内相对比较）

### 2.1 消融（不等价，只为找钱花在哪）——`PERF-WING-abl*.mjs`

| 去掉 | wing Δ |
| --- | ---: |
| 整个着色（`shadeWing` 换成常数） | **−69.2%** |
| 小翼距离场 `sdWingTip` | −13.7% |
| 襟翼 + 缝翼 + 扰流板距离场 | −8.0% |
| 短舱距离场 | −3.4% |
| 整流罩距离场 | −3.1% |
| 鼓包法线 | −2.6% |
| 自阴影段 | −1.8% |
| W-STAIR 分段下界（uniform 分支） | −0.2% |
| 材质 `wingSurface` 整体 | −39.7% |
| 其中：翼面材质 / 小翼材质 / 短舱材质 | −19.7% / −18.2% / −8.1% |
| 灯照翼面整段（灯循环体） | −21.4% |
| 其中：着色里的 `wingLampPos` 换常数 | **−13.3%** |
| 其中：照翼面的配光 `wingLampSurfI` | −3.1% |
| 光晕 `wingLights` 整个 | −11.0% |
| 其中：光晕里的 `wingLampPos` 换常数 | **−5.9%** |
| 其中：云雾平均光强那一次 `wingLampIntensity` | +1.1%（噪声，常数方向被 FXC 折掉了） |
| 环境反射 `wingEnv` | −8.8% |
| 着色挪出子射线循环（粗，不等价） | 约 −6%（循环嵌套本身不是主因） |

### 2.2 求交循环：简报点名的几项（在新基线上，`PERF-WING-trace.mjs`）

| 项 | 现状 | 等价改写 | wing Δ | 采用？ |
| --- | --- | --- | ---: | --- |
| 循环界 const + uLoopGuard | 已是 `min(uWingSteps, 0)` 起步 + uniform 推出的 `total` | 改回常数起点 `i = 0`（反例） | +2.7%（没被展开：slots 不变） | 否 |
| sdWing 单调用点 | HLSL 里 `f_sdWing` 只有一处调用（求交 / 法线 / 阴影三段共用一个循环） | — | — | 已满足 |
| 子射线 4+1 是否在循环外重复内联 sdWing | 否：`wingView` 的 5 次循环里只有一处 `wingTrace` | — | — | 已满足 |
| W-STAIR 下界的 uniform 分支是否生成两份 | 否：消融只差 −0.2% | 去掉外层 `if (uFlap‖uSlat)`，只留内层两个 if | −2.1% | 否（巡航时每步多算一次 `wingFullSectionDist`，为 2% 不值） |
| 跳过部件的三目 | ANGLE 已翻成 if/else | 先算再覆盖（无条件求值） | +0.8% | 否 |
| 小翼包围早退 | `return` 早退 | 单出口 if/else | −1.2%（MAD 大，噪声内） | 否 |
| 取样点三目的顺序 | 求交在第一支 | 求交放最后（W-EDGE v5 的写法） | +3.3% | 否（B′ 用了这个写法，是它的成本之一） |

### 2.3 `[loop]` 语义（ANGLE 下）

ANGLE 只在「含梯度指令的不连续循环」前面写 `LOOP`，它在 HLSL 里定义为 `#ifdef ANGLE_ENABLE_LOOP_FLATTEN → [loop]`；
求交循环、灯循环都没有 `LOOP`。GLSL 里写不出 `[loop]` / `[fastopt]`，直接改 HLSL 用 fxc 计时（`PERF-WING-hlsl-loop.mjs`，3 轮最小值）：

| HLSL 改动 | Δ | slots |
| --- | ---: | ---: |
| 定义 `ANGLE_ENABLE_LOOP_FLATTEN`（所有 LOOP = `[loop]`） | −1.7% | 2964 |
| 求交循环加 `[loop]` | +1.0% | 2962 |
| 求交循环加 `[fastopt]` | +1.1% | 2962 |
| 子射线循环去掉 LOOP | 0% | 2962 |

都在噪声内：循环已经不被展开，属性帮不上忙，不值得去找 ANGLE 开关。

### 2.4 另一个坑：着色放在任何循环外面时，隐式求导的采样会让 FXC 试图展开循环

粗实验把 `shadeWing` 挪出子射线循环后 fxc 直接失败：`X3511 unable to unroll loop`（`wingEnv` 的 2 次循环里 `skyRadiance` 的纹理采样是隐式 LOD）。
ANGLE 只给「在不连续循环里被调用」的函数生成 `…Lod0` 版本（采样换成 `SampleLevel(…, 0)`），挪出循环就用回隐式求导采样。
包一层带 `break` 的 1 次循环就恢复。以后把含纹理采样的函数挪出循环时要记得。

## 3. 画面：同页冻结 A/B（`dev-browser ab`，`hdrWing` float 读回）

`PERF-WING-mkjobs.mjs` 生成 jobs（old = 5306 活页面的机翼着色器原文，主 + 湿窗一起换；cov = 覆盖率读回；noLamp = 旧版关翼尖灯照翼面，
用来标「灯照到的像素」；oldNG / newNG = 两边都去掉灯本身的亮点与光晕 `wingLights`）：

| 场景 | 机翼像素 | 非机翼不同像素 | 机翼不同像素（其中灯照到的） | 机翼最大相对差 | newNG 对 oldNG |
| --- | ---: | ---: | ---: | ---: | --- |
| sunset-wing | 116073 | **0** | 9011（8615） | 2.9e-4 | 逐位 0（另一轮 88 像素、7.7e-7） |
| 商务舱正午 | 80481 | **0** | 10431（9656） | 3.3e-3（见下） | 逐位 0 |
| 云里（湿窗变体） | 217476 | **0** | 4541（3130） | 6.7e-4 | 逐位 0 |
| 夜城低空 | 138007 | **0** | 11042（10802） | 3.1e-3（绝对 1.1e-8） | 逐位 0 |

- 截图（8 位）对 old 最大差 0.3 / 255（一个通道 1 级），差 > 8 的像素 0；非机翼（覆盖率 0）逐位 0，窗外遮罩 α 逐位 0。
- **机翼区不是 0 的原因**：差异只在 `wingLights`（光晕）存在时出现——把两边的 `wingLights` 都去掉，新旧逐位相同；
  而旧程序自己去掉 `wingLights` 后，机翼像素就会变（最大差处 new == oldNG ≠ old）。也就是说旧程序里 FXC 把两处内联的灯位置算式
  和各自上下文一起优化（非 IEEE 严格的重结合），灯照到的翼面随「光晕在不在」差最后几位；新程序灯位置只算一份，结果和「旧程序去掉光晕」逐位相同。
  改灯位置本身的新写法（守卫循环 B）与常数下标 A 在页内逐位相同，不是常数折叠造成的。
- 商务舱正午：之前单独一次运行出现过一个像素 0.18 的相对差（绝对 3.56）。复查（`tmp/perfwing/ab5`，2 轮）：两轮逐位一致，最大相对差 3.3e-3（像素值约 1180 的太阳高光上绝对差 0.066），newNG 对 oldNG 逐位 0。
  每次 `ab` 运行冻结在不同的时刻（翼尖弯曲 / 颠簸相位不同），那一次正好有一个像素落在相对值很小的地方；所有运行里「两边都去掉光晕后逐位相同」都成立，根因同上，不是新写法算错。

## 4. 机翼 pass 帧时间（`gpu-ab --time wing`，8 轮 ABBA，安静机器，带两侧 A/A）

`PERF-WING-mkgpu.mjs` 生成 jobs；old2 = master 自己的 A/A，A2 = 当前写法的 A/A。三次独立运行（`tmp/perfwing/gpu-jobs{,2,3,4}.json`）：

| 场景 | old 中位 ms | A（当前）×old | old2 ×old | 其他写法 ×old |
| --- | ---: | --- | --- | --- |
| sunset-wing | 0.590–0.645 | ×1.022 / ×1.016 / ×1.021 / ×0.997 | ×0.989 / ×1.006 / ×0.991 | V ×1.014，W ×1.017，B ×0.983，G ×1.027 |
| 商务舱正午 | 0.524–0.534 | ×1.022 / ×1.024 / ×1.028 / ×1.017 | ×0.997 / ×0.993 / ×1.002 | V ×1.018，W ×1.040，B ×1.034，G ×1.035 |
| 云里（湿窗） | 0.816–0.844 | ×1.023 / ×1.013 / ×1.018 / ×1.030 | ×0.995 / ×0.992 / ×0.998 | V ×1.013，W ×1.012，B ×1.036，G ×1.016 |
| 夜城低空 | 0.680–0.686 | ×1.019 / ×1.031 / ×1.029 / ×1.031 | ×1.011 / ×1.001 / ×1.004 | V ×1.015，W ×1.027，B ×1.013，G ×1.036 |

- **机翼 pass 帧时间约 +2–3%（0.01–0.02 ms）**，old 的 A/A 在 ±1% 内，所以这是真的，大多数判定为「在离散度内」，个别判「显著变慢」（门槛 3%）。
- 试过的写法（都与 A 同画面）：V = 两处灯循环前就地算（冷编译 **+50%**，又进了子射线循环，否决）；W = wingView / wingLights 两个入口各算一次（冷编译与 A 相同）；
  B = main 里用守卫循环算一次（冷编译 −12%）；G = 只提着色里那份、光晕里照旧（冷编译约 −13%）。帧时间全都 +1.5–4%，
  所以不是「全局变量跨 wingView 活着」（W 没改善），而是灯位置离开灯循环以后 FXC 对灯循环 / 着色的排布变了。没找到既省冷编译又不升帧时间的写法。
- **取舍（请协调者定）**：冷编译机翼 −2.4 s（启动关键路径 −0.9 s），换每帧 +0.01–0.02 ms（机翼 pass 0.52–0.86 ms 的 2–3%）。我倾向采用 A；如果「不升」是硬门槛，就不能合。

## 5. B′（park/W-EDGE 的 `handoff/W-EDGE-v5-probe.diff`）在新基线上的冷编译

补丁能原样打上。本分支 + B′ 对本分支（`tmp/perfwing-base` 切到 94dc148），`--baseline` 5 轮最小值：

| 程序 | 新基线 | 新基线 + B′ | 增量 | 对 master（改动前） |
| --- | ---: | ---: | ---: | ---: |
| wing | 4711 | 5209 | **+10.6%**（+0.5 s） | 6854 → 5209，−24% |
| wing-wet | 5788 | 6189 | **+6.9%**（+0.4 s） | 8383 → 6189，−26% |

- **余量**：按绝对时间算，B′ 之后机翼仍比 PERF-WING 之前快 1.6 s；真冷启动里机翼约 5.3 + 0.5 ≈ 5.8 s，窗外 7.5 s，**机翼离关键路径还剩约 1.7 s**。
- 按相对门槛算：B′ 单项 +10.6% 刚过「单任务 ≤ 10%」，但它的基线已经被本任务压了 28%，一波累计仍是大幅净降。建议协调者按绝对余量放行 B′。

## 6. 账本与收尾

- `research/compile-ledger.json` 追加 94dc148：wing 4723 / wing-wet 5661 ms（5 轮最小值，slots 2962 / 3574，temps 77）。
- README「着色器编译」坑点加了一条（PERF-WING）。
- check:glsl、typecheck、build 通过，dist 无 0 字节文件；所有 ab / gpu-ab 运行 console error 0 条。
- 对照 worktree `tmp/perfwing-base` 已删，dev server 已关。

## 复现

```
node handoff/PERF-WING-mkjobs.mjs handoff/PERF-WING-ab-jobs.json          # 同页 A/B（apps/voyage 下）
node scripts/dev-browser.mjs ab --port 5246 --base 5306 --jobs apps/voyage/handoff/PERF-WING-ab-jobs.json --rounds 2 --out tmp/perfwing/abN
node handoff/PERF-WING-mkgpu.mjs ../../tmp/perfwing/gpu-jobs.json
node scripts/dev-browser.mjs gpu-ab --port 5246 --base 5306 --jobs tmp/perfwing/gpu-jobs.json --rounds 8 --time wing
node scripts/shader-budget.mjs --baseline <master 的 worktree> --only wing,wing-wet --rounds 5
node scripts/shader-budget.mjs --variants handoff/PERF-WING-abl.mjs --only wing --rounds 3   # abl2 / abl3 / trace / lamps / lamps2 / lamps3 同理
```
（`ab` / `gpu-ab` 的 `--jobs` 路径按仓库根解析。）
