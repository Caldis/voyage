# PERF-14 审查（独立审查 + 美术视角）

- 审查对象：分支 `worktree-agent-ae3e95f93a3e4d63a`（cfb2969），`git diff master...` 共 17 个文件。
- 对照：临时工作区 `tmp/perf14rev`（master 394e537 上 `merge --no-ff --no-commit`），开发服务器 5284（合并后）/ 5285（master 主仓库）。审完已删（先拆 node_modules 联接）。
- **结论：通过。** 没有阻塞问题；下面的「合并注意」要协调者在合并时处理，「非阻塞建议」可以顺手做或排进后续任务。

## 合并注意（协调者）

- **`src/main.ts` 有一处文本冲突**（分支基于 ed6378f，master 之后合了 TM01）：TM01 在 `pass.render(cabinMat, hdr)` 前面加了 `exposure.finalMat.uniforms.uClouds.value = clouds.texture;`，本分支在同一个位置加了 `pass.render(cabinClass.seat(), hdrSeat);`。**两行都保留**就行（两者互不相关，顺序无所谓）。我在临时工作区就是这样解的，typecheck 和 check:glsl 都通过。
- master 从 ed6378f 到现在只改了 `clouds.ts`、`exposure.ts`、`main.ts`（各一处），没有碰 scene.ts 里被搬进 `CABIN_LIGHTS_SETUP` 的那段灯光代码，不存在「搬走的代码在 master 上又被改、合并后悄悄丢改动」的问题。

## 静态检查（合并后）

- `pnpm --filter voyage typecheck` 通过。
- `pnpm check:glsl` 全部通过：45 个程序；新断言 1d 的 8 项都是 OK（scene-default / scene-economy 不调用 shadeSeat、traceSeats；seat-default / seat-economy 调用；wing 不调用 waterOnPane，wing-wet 调用）；sampler 表 scene 6/9 与 README 一致。

## 重点 1：座椅 pass 与舱内合成的契约

| 检查项 | 结论 |
| --- | --- |
| 覆盖率 a 与原来 `seat.cov` 是否等价 | **等价。** 主分支 scene.ts 里 `seat` 只用到 `cov` 和 `shadeSeat` 的颜色两样（`seat.t` 没被 main 用到）。座椅 pass 写的是**非预乘**的 `vec4(shadeSeat(...), seat.cov)`，舱内合成照旧用 `mix(…, seatCol, seatCov)`，公式没变。目标是 RGBA32F、Nearest、`texelFetch` 按同一像素读，cov 与颜色都原样传过来（实测 `hdrSeat.texture.type = 1015`，即 FloatType，1600×1200）。`cov ≤ 0` 时写 0，原来的 `seat.cov > 0.0 ? shadeSeat : 0` 也是 0。座椅着色里没有 dFdx / fwidth，拆开以后「early return 之后导数未定义」这类问题不存在。 |
| 边缘像素 | cov 由 `traceSeats` 按最近距离 / 像素宽度算出，在两个程序里是同一份代码、同一个 `pixAng` 公式；a−b 零回归（见重点 4）在座椅轮廓上也是逐像素 0。 |
| 先算权重的跳过逻辑（PERF-12） | `hidden = seatCov >= 1.0`，`kView`、`colFixed`、`outsideMask` 都只是把 `seat.cov` 换成 `seatCov`，没有别的改动。`rd.z < 1e-4` 的早退分支同样只做了替换。 |
| 倒影里要不要座椅 | 不需要改：窗板倒影（`cabin-reflect.glsl.ts`）用的是自己的解析座椅模型（`RF_SEAT_Y`、`eSeat` 等），从来不读 `traceSeats` / `shadeSeat`，本任务对它没有影响。阅读灯光点、窗板开口的遮挡都在合成权重里，没有变。 |
| `cabinLightsSetup` 共用后灯光是否逐位一致 | 是：`CABIN_LIGHTS_SETUP` 是原 main 开头那段的逐字搬移（我逐行对过 diff），两个程序用同一个 uniforms 对象（`createSeatMaterial(sceneMat.uniforms)`，实测 `seat.uniforms === cabin.uniforms`）。舱内合成的 eCabinRefl / mainTint 照旧通过 out 参数拿回。 |
| 两舱切换是否成对 | 是。`CabinClassVariant.prepare` 一次编「舱内 + 座椅」两个程序，各自绑定自己的目标（`hdr` / `hdrSeat`）发起编译，`Promise.all` 之后逐个检查 `diagnostics.runnable`，两个都成功才把 `mats[c]` 换成这一对并置 ready；`pick()` 更新 `shown` 之后 `seat()` 取同一个 `shown`，同一帧里不会出现舱内是经济舱、座椅是商务舱的情况。实测真走面板路径切到经济舱：`shown = economy`，舱内与座椅材质都带 `CABIN_CLASS_ECONOMY`，座椅材质名仍是「座椅」（passes.mjs 能认出来），画面上右下是经济舱的织物座椅，无 console error。 |
| resize / 画质档 / DPR | `resize()` 里加了 `hdrSeat.setSize`；画质控制器降 DPR 时调的就是这个 `resize()`（quality.ts:339–340），所以三种情况都会跟着重建。 |
| 反馈回路 | 座椅程序没有声明 `uSeat`（只在 `SCENE_FRAG` 里声明），画进 `hdrSeat` 时不会同时读它。 |

## 重点 2：机翼 WING_WET

- **「窗干时恒为 0」的判定是严格的。** 全仓库写窗板湿度的只有一处：`flight.ts:94`（`updateTurbulence`，在云里且外面够暖时变湿，T29 / T31 的「云中凝水」也是走这里），`main.ts:486` 每帧把它拷进 `uWetness`，机翼 pass 的 `pick` 读的就是这个值（同一帧、在拷贝之后）。脚本里的 `wetness = 0` 只是清零。
  门限：JS 用 `wetness > 0.001` 选变体，着色器里 `waterOnPane` 开头是 `wet <= 0.001` 直接返回 0。double 转 float32 的舍入是单调的，JS 判「≤ 0.001」时 GPU 上的 float 也 ≤ float(0.001)，不会出现「JS 选了默认程序、GPU 却该有水珠」；反方向（JS 选了湿窗变体、GPU 判干）两者结果都是 0，也没有跳变。
- **变体没编好时**：`pick` 返回默认程序（不画空、不画错），只是机翼像素上的水珠少一圈暗边；窗板上的水珠本身（舱内合成里的折射、透镜化）不受影响。变体在首帧后第 120 帧开始后台编译，窗一湿会立刻提前开始。实测编好用时 8.8 s（`compileMs = 8823`），之后 `shownWet = true`。首帧起就在云里时，最坏情况是前约 9 s 机翼上的水珠少暗边、编好那一帧暗边一下子出现。这是细节缺失，不是锯齿或闪烁，湿度本身约 3 s 才涨满，可以接受。
- **`wingEnv` 改成循环**：`for (int i = min(uWingSteps, 0); i < 2; i++)` 两次调用的参数与原来一一对应（i=0 → coatRough / envSharp，i=1 → rough / envBase），数学上等价。干窗 sunset-wing 的 a−b 最大 3/255，794 个像素（占 0.04%）散在全屏，均值 0，属于 FXC 重排浮点运算的量级，肉眼不可见。

## 重点 3：帧时间

我自己跑了 `passes.mjs --baseline 5285 --only economy-ahead,noon-cumulus --frames 60 --rounds 4`（CPU 51–52%，只作参考），取中位数：

| 场景 | 本分支 舱内 + 座椅 | master 舱内 |
| --- | --- | --- |
| noon-cumulus | 0.277 + 0.016 = 0.293 | 0.292 |
| economy-ahead | 0.172 + 0.079 = 0.251 | 0.229（+0.022 ms） |

结果与实现者一致。0.016 ms 基本就是整屏写一张 RGBA32F 的带宽（1600×1200×16 B ≈ 31 MB）。经济舱看前方那 +0.02 ms，是座椅着色搬到另一个 pass 以后多出来的一次整屏读写，**不需要返工**，但有几个便宜的优化可以考虑：

1. **scissor 到座椅的屏幕包围盒**：座椅都在本排 / 前排，几何固定，CPU 上用头部位置投影出一个保守的矩形，座椅 pass 只画这块，舱内合成在矩形外直接当 cov = 0。这样大多数视角（看窗、看机翼）的 0.016 ms 固定开销几乎没了。经济舱看前方的座椅本来就占满全屏，这招帮不上，那里的 +0.02 ms 省不掉。
2. **降格式**：不建议直接换 RGBA16F，实现者说得对，太阳在屏幕玻璃上的高光会超过 65504。如果以后想省带宽，可以存「颜色 ÷ 当前曝光的某个固定倍数」再用半精度，但这会把曝光状态引进座椅 pass，得不偿失。
3. 实现者自己提的「非座椅像素 discard + 每帧 fast clear」和第 1 条可以二选一，第 1 条更简单。
4. 显存：多一张全分辨率 RGBA32F，1600×1200 约 31 MB，4K 约 133 MB。可以接受，记一笔就行。

## 重点 4：零回归证据可信不可信

- **「`--pair` / `--base-shader` 冻结失效」这个发现属实。** `dev-browser.mjs` 的 `shootOne` 每拍完一张都调用 `window.__voyage.benchFrame(30)`，而 `benchFrame` 直接调 `renderFrame(last + 16)`，不经过 `frame()` 的冻结。我在 biz-day-ahead 上不加绕法对照：**a−a2（换回自己）有 4.9% 的像素差 > 8、max 158**，a−b 3.3%——噪声底比要测的信号大得多，没绕开时的数据都不能用。实现者把 `ab-biz` 标成无效数据，这个处理是对的。
- **正对照**（确认换着色器真的反映到截图上）：同一机位把 `seatCol` 乘 1.05，a−b 的 mean 0.63、max 3，而**超过阈值 8 的像素是 0**。这说明管线本身是灵敏的，但也说明**「超阈值 8 的像素 = 0」对座椅这种暗面上 5% 的亮度差不敏感**，判零回归应该看 max / mean。实现者的汇总表写的是「超阈值像素全部为 0」，另外写了 biz-day-ahead 的 max 5；我复核时 max 和 mean 也都看了（见下表）。
- **我自己用同样的绕法跑了 3 组**（绕法是 `v.benchFrame = () => 0`，基线用 5285 上的 master 着色器；跑之前查过测量锁，没有锁）：

| 组 | 场景 | a−b | a−a2（噪声底） |
| --- | --- | --- | --- |
| 商务舱夜间开灯看前方 | biz-on-ahead | max 0 / mean 0 | 0 |
| 商务舱白天看前方（附带） | biz-day-ahead | max 0 / mean 0（实现者那次是 max 5，这次逐像素相同） | 0 |
| 经济舱白天默认坐姿 | econ-day-seated（`PERF-14-econ-pre.js`） | max 0 / mean 0 | 0 |
| 湿窗 sunset-wing | `PERF-14-wet-pre.js`，`--material wingMat` | 两轮都是 max 0 / mean 0 | 第一轮 52 个像素（max 36，排成机翼前缘的一串点），第二轮 0 |
| 干窗 sunset-wing（附带） | `--material wingMat` | max 3、794 个像素、mean 0 | 0 |

  湿窗第一轮的噪声底不是 0，但 a−b 是 0，第二轮也复现不出来，我判断是某一拍的时机问题，与本分支的改动无关。不过这说明**噪声底偶尔会跳**，每组最好跑两轮。
- 结论：零回归证据可信。商务舱、经济舱的舱内合成与 master 逐像素相同；湿窗变体与 master 的机翼逐像素相同；干窗默认程序与 master 相差 ≤ 3/255，而且只在极少数像素上。

## 重点 5：冷启动

`dev-browser cold --port 5284 --baseline 5285 --repeat 2 --wait-quiet` 跑了 2 次，共 3 组有效数字（第一次只留下了第 2 轮的输出），跑之前查过测量锁，没有锁，CPU 约 48%：

| 轮 | 本分支（合并 master 后） | master 394e537 | Δ |
| --- | --- | --- | --- |
| 1 | 9 969 | 13 606 | −26.7% |
| 2 | 9 641 | 13 033 | −26.0% |
| 3 | 9 245 | 12 731 | −27.4% |

批次分解：座椅 1.6–1.7 s、舱内 4.3–4.7 s、机翼 6.9–7.1 s、窗外 6.6–7.6 s。和实现者说的一样，关键路径现在是窗外，机翼紧跟在后面（有一轮机翼比窗外还晚 0.28 s）。约 −3.4 s，比实现者报的 −2.9 s 还略好一些，目标（≥ 1.5 s）达到。各材质的程序数都是 1，没有首帧同步重编。

## 非阻塞建议

1. **湿窗变体的预编会和别的按需变体抢编译线程。** 首帧后约 1–2 s 开始，占一个线程编约 8–9 s。如果启动时正好还要编地面细节（GroundDetailVariant）/ 窗外 OW 变体 / 经济舱，那些会被拖慢。建议预编前先看一眼别的变体有没有在编，有就往后推（例如 `groundDetail.variantStatus` 或 `cabinClass.status` 里有 compiling 时先不开始）。
2. **回归截图的时序不确定性**：单独跑 `--only in-cloud`（或别的开局就湿窗的场景）时，截图可能落在湿窗变体编好之前，机翼上的水珠有时有暗边、有时没有。建议 `applyScene` 在 `state.wetness > 0.001` 时等 `wingVariant.state` 变成 ready / failed（参照 cirrus-noon 等 `cirrusLayerState` 的写法），或者至少在截图 JSON 里记下 `wingVariant.shownWet`。
3. **dev-browser 的 `swapMaterialShader`**（不在本任务归属）：`Object.values(cabinClass.mats).includes(m)` 在本分支之后永远是 false（值变成了 `{cabin, seat}`），舱内材质会绑 hdrOutside 去编译。结果不受影响（我的正对照也证明了换着色器是生效的），但建议改成 `some(p => p.cabin === m || p.seat === m)`，座椅材质绑 `hdrSeat`。`cabinClass.mats` 和 `target` 在 TS 里是 private，脚本是靠运行时字段在用它们，最好给它一个公开的只读访问器。和 `benchFrame` 绕过冻结的问题一起交给 DX-22。
4. `handoff/PERF-12-ab.mjs` 失效，实现者已经在 handoff 里说明了，是历史脚本，不用改。
5. passes.mjs 里「机翼」和「机翼（湿窗）」两行混在一起（applyScene 之后探针还是上一处的结果，湿度会涨上来），同一场景前后两次测的机翼帧时间不能直接比。建议 passes 在测量前把 `state.wetness` 钉住，或者按场景 JSON 显式设湿度。

## 美术视角

- 商务舱 / 经济舱各坐姿、各灯光场景的舱内合成与 master 逐像素相同，座椅的轮廓抗锯齿、明暗、和侧壁的衔接都没变，没有新的锯齿或闪烁。
- 湿窗变体编好之前机翼上的水珠少一圈暗边，这是一处很小的细节缺失，不违反「宁可小，不要糊」；编好那一刻的突变在湿度爬升阶段基本看不出来。经济舱真实切换后的画面（织物座椅、窗板水珠、机翼）正常。

## 开发体验反馈

- **最大的坑**：`shots --pair / --base-shader` 的噪声底默认不是 0（`benchFrame(30)` 绕过冻结），而且工具不会提示。不知道这一点的人会把 5–48% 的噪声当成回归。好在实现者找到了，并写进了 README。建议 DX-22 在工具里直接修掉（冻结时 shootOne 不跑 benchFrame，或者全部截图拍完再测帧时间），并在 a−a2 不为 0 时打印醒目警告。
- **阈值 8 太钝**：正对照里 5% 的座椅亮度差，超阈值像素是 0。建议 `PERF-14-abdiff.mjs` / compare 的汇总默认同时报告 max 和「> 0 的像素数」，判零回归看这两项，不看超阈值像素数。
- `--scenes-file` 按仓库根解析、`--out` 也按仓库根解析，但前者给相对当前目录的路径会直接报「找不到文件」。两者的解析规则一致固然好，报错时最好把解析后的绝对路径打印出来。
- `cold` 我用 `tail` 截了输出，第 1 轮的数字丢了。建议 `cold` 结束时打印一个汇总块（每轮两边的 totalMs + 最小值 / 中位数），像 passes 的 Δ 行那样放在最后。
- 耗时：临时工作区 `pnpm install` 2 s（依赖全部复用）。整个审查大部分时间花在零回归截图和冷启动 / passes 测量上，没有排队等锁。合并时 main.ts 的文本冲突要手工解（分支基于 ed6378f，没有跟进 TM01），好在只有一行。
