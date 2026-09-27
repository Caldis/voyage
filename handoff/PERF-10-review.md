# PERF-10 / PERF-11 审查报告（云按天气拆变体 + resolve 提速）

- 审查对象：分支 `worktree-agent-a48b777328a0e36f1`（6ad94d2），对 master（fbefb59）的 `git diff master...<分支>`。
- 审查方式：读 diff；在 `tmp/perf10rev` 建「master 合并本分支」的临时工作区（`--no-ff --no-commit`，无冲突）离线复核。没开浏览器。
- 触发条件：(a) 云缓冲 / resolve 契约；(b) 碰了 main.ts、director、weather-director；(d) 新增 13 个程序 / 变体；(e) 全局规则（导演推迟摆放）。

## 结论：**返工（小）**

主体做得扎实：默认程序确实只剩普通云，拆分前后逐位等价，resolve 的改动也正确，冷编译收益已复核（见「离线复核」）。
返工只有两处，都是**已编好的变体和别的程序没对齐**，改动量各 5–10 行：

1. **导演预告不看卷云 / 奇观**：卷云层或体积奇观在场时，导演一摆雷暴 / 台风，整层卷云会当场变成普通层状云，或者奇观当场消失，要等 4–8 s（冷缓存）组合变体编好才恢复。master 上没有这个问题，属于视野内的跳变。
2. **云影图 / 探针的天气版和步进变体各自决定用不用**：会出现「步进没画天气，云影和舱内效果却有天气」，或者反过来。

## 一、必须修

### 1. `prepareWeather` 算出的键不含 C / W，导演在卷云 / 奇观在场时摆天气会引起整层跳变

`clouds.ts` 的 `prepareWeather`：

```ts
const key = (storm || cur.includes("S") ? "S" : "") + (typhoon || cur.includes("T") ? "T" : "");
return !key || this.requestMarch(key) === "ready";
```

- 它只检查 `S` / `T` / `ST`。问题出在 `pickMarch` 实际要的键：卷云在场（`uCloudType < 0.2`）时要 `CS` / `CT`，体积奇观在场时要 `WCS` / `WCT`。
- 复现（按代码推演）：连续航程中卷云层在场，天气场摆一个雷暴。`weatherReady("storm")` 看到 `S` 已编好，返回 true，导演摆放。下一帧 `pickMarch` 要 `CS`，没编好，按权重回退到 `S`（4 > 1），**整层卷云在视野里当场换成普通层状云的外观**。约 4–5 s 后 `CS` 编好，再换回卷云。奇观同理：`WCS` 没编好时回退到 `S`（4 > 2+1），**正在看的奇观凭空消失**，编好后再出现。
- 雷暴本身摆在视野外，所以推迟摆放对雷暴来说看不出来。但卷云和奇观就在视野里，这次跳变违反铁律「拒绝跳变」。master 的卷云 / 奇观变体本来就带着雷暴 / 台风代码，没有这个问题，所以这是**回归**。
- 修法：`prepareWeather` 按 `pickMarch` 的规则拼出完整的键，也就是当前的 W / C 位加上 S / T，对这个键 `requestMarch`，编好才返回 true。可以顺手做一件事：卷云在场且天气已预编时，后台预编 `CS` / `CT`。

### 2. 云影图 / 探针用不用天气版，没跟步进实际画的变体对齐

- `updateShadow` 和 `probe` 只看 `weatherKey() && weatherAuxState === "ready"`，不看 `marchShown`。
- 天气小程序编得比步进变体快：占据网格、云影图天气版约 2.4 s，探针约 0.8 s；步进的 `T` 约 7–9 s，`ST` 约 13.5 s。因此：
  - **面板手选台风，或调试脚本直接放台风**：大约有 5 s，海面上有台风眼壁、雨带的云影，天上却只有普通云。探针用的是天气版，舱内光照和颠簸也按台风来。
  - **雷暴 + 台风同在**（面板路径）：`ST` 编好之前步进画 `T`，云影图天气版却画了雷暴的影子。
  - **某个步进变体编译失败**（`failed`）：云影 / 探针会**一直**带着一个画不出来的天气系统。
- 反方向同样会发生：导演的 `weatherReady` 只等步进变体，不等 `weatherAuxState`。编译线程争抢时，可能先画出雷暴，云影、占据网格、探针后到。影响较小：雷暴在视野外，只是那几秒步进较慢。
- 修法：
  - 云影、探针用天气版的条件改成「`weatherAuxState === "ready"` 且 `marchShown` 含 S 或 T」。`ST` 和 `T` 共用同一个天气版云影，这点差异可以接受。
  - `prepareWeather` 在 `weatherAuxState` 是 `ready` 或 `failed` 之后才返回 true。

## 二、建议（不阻塞合并，可以一并修）

3. **云影图在分片重建途中换程序，会留下半张旧图**。`updateShadow` 在 `mat !== shadowProg` 时只设 `shadowGradual = true`。如果此时正在分片建（`shadowSlice >= 0`），`restart` 为 false，剩下的分片用新程序接着建。建完的图一部分有天气影子、一部分没有，而且 key 已经更新，要等下次漂移或太阳变化才会重建。以前只有「天气参数小幅渐变」会走这条路径，没关系；现在换程序等于有无整个天气系统，差别很大。修法：换程序时 `shadowSlice = -1`（或 `restart = true`），从第 0 片重建。
4. **变体编译失败后没有任何提示**。`S` / `T` 失败时，`weatherReady` 永远返回 false，天气场的雷暴 / 台风就一直不摆。这不会卡死：`planStorms` 是 `continue`，`planTyphoon` 是 `return`，别的规划照常，不占槽位，也不留 pending。但这是静默失效，建议 `console.warn` 一次（例如「雷暴变体编译失败，天气场雷暴停用」）。`compileAsync` 失败也会 resolve 的坑，本任务已经用 `runnable()` 检查 diagnostics，处理正确。
5. **火车视角与 PERF-11 的深度开关**。本分支是在 TR03 合并之前分出去的。开关条件 `uTerrainMax > 0.05 km` 是绝对海拔，对巡航高度没问题。火车的相机贴着地面，附近地形整体低于 50 m 的平原（沿海冲积平原）上，几十米的小丘也能挡住贴地平线的远云，这时深度不写，云会画在小丘前面。概率低，建议把条件改成「地形 > 0.05 km **或**相机离地很低」，火车模式直接常开也行。README 速查表里已经写了「别的用途要深度先改这个条件」，这里算作其中一种用途。
6. **面板手选雷暴 / 台风没有「准备中」提示**（交接已知问题 4）。只在打开页面后约 10 s 内（预编完成前）才会遇到，有磁盘缓存时不到 1 s，可以接受。建议另开 UI 小任务，照抄舱等的提示方式（`variantStatus.shown !== wanted`）。

## 三、逐项核对（通过的部分）

- **默认程序的纯净度**：跑了 `handoff/PERF-10-preproc.mjs`，用 glslangValidator `-E` 真预处理。结果：
  - `cloud-march`、`cloud-shadow-map`、`cloud-probe`、`cloud-march-cirrus`、`cloud-march-wonder` 里只剩 `uStorms[`×1（uniform 声明）和 `uFlash` 的声明，没有任何雷暴 / 台风密度、受光、闪电代码。
  - `cloud-march-typhoon` 里没有雷暴密度，`cloud-march-storm` 里没有台风密度。
- **拆分等价性**：逐段比对了默认路径和 master 在「无天气」时的行为：
  - 步长用 `wasEmpty ? 2dt : dt`，等于 master 在 `fine = 0`、`wasThin = false` 时的取值。
  - 192 步上限、`aDecay = 0.62`、层状云的 `h01`、卷云的 `ambFloor`（`stormW` 恒为 0）都一致。
  - 受光步进的 `if … else if (lightSteps == 6) {…}` 拆成 `#ifdef` 后，括号配对正确，默认程序里只剩常量 6 步的展开块。
  - 单天气变体里，另一种天气由 `cloudStormsOn()` / `cloudHurOn()` 当作不存在，作为回退时的行为正确。
- **变体管理**：
  - 所有变体共用 `marchMat.uniforms` 同一个对象（后加的 `uWonderSurf` 也能共享到）。
  - `requestMarch` 是幂等的。`pickMarch` 的子集枚举排除了只有 W 没有 C 的组合，默认程序始终可用，不会画空，也不会同步编译。
  - resize 或画质档切换时，运行时不改任何云材质的 defines，程序不会重建，也不需要重建。
  - 天气移除后，`weatherKey` 为空，想要的变体回到 `""` / `C`，这两个都已编好，所以立即切回。
  - 步进、云影、探针三个程序的一致性问题见「一、2」。
- **推迟摆放**：`weatherReady` 缺省时视为可用（兼容旧接入）。推迟摆放不占槽位，不留 pending，每次规划重新问，所以不会卡死 T19b 的状态机，编好后下一次规划就摆出去。失败时的问题见「二、4」。`ST` 的情况下导演会等 13.5 s 的组合变体编好，这是正确的。奇观之门（`openGate`）不经过 `weatherReady`，但它只在奇观**不在场**时开（`pendingGate` 要求 `!active`），而且离飞机 120 km，雷暴变体早已编好，风险可以忽略。
- **PERF-11 resolve**：
  - `texelFetch`：`fc = gl_FragCoord − 半宽偏移` 是像素中心，`ivec2(fc)` 取到的正是本纹素。邻域按每半边自己的尺寸夹到 `[0, uCloudResolution − 1]`，右半邻域不会越过中缝读到左半。`uCloudResolution` 与 `raw.setSize(w, h)` 同源，画质档缩放后也一致。
  - 窗板外 (0,0,0,1)：步进在 `paneDistance > 0.02` 处写 (0,0,0,1)，resolve 用同一个 `uHead`，同一条 `cabinRay(fc · uResolution / uCloudResolution)`，而且在 `> 0.025` 才提前退出。0.005 m 的余量约合 6–10 个云像素，邻域不会碰到窗板内。`rd.z < 1e-4`（看后方）时两边都返回 1.0，一致。奇观变体用同样的 `> 0.02` 早退。机翼 pass 只读左半，而且只在窗板内读。结论：所有视角下安全，结果逐位不变。
  - 右半按需：scissor 只画左半，停用期间窗外程序靠 `uCloudDepthOn = 0` 不读右半。重新启用那一帧用 `uResetDepth` 不取历史，resize 由 `uReset` 兜住。`clipmap` 的级别在重心重建时不会置为 invalid，所以 `maxHeightKm` 不会因为重建来回抖。0.05 km 的阈值和地面程序里「平地」的判断（`uTerrainMax < 0.05`）同一口径。山后去云在开关边界上只有重新启用那一刻右半从当帧开始累积，这正是 T38 要的「按不透明度加权」起点，不会被「无云帧 400 km」污染。T38 审查要求保留的精度保护（`max(d.y, 1e-4)`、按不透明度加权、RGBA32F）都还在。
- **脚本**：
  - `applyScene` 和回归脚本同步等 `cloudVariantPending`，上限 120 s，无天气场景下 `marchShown === marchWanted` 立即返回 false，不会永久等待；失败的变体也不算 pending。
  - `lint-shaders` 用 `addDerived` 登记变体，lenient 模式下老树缺材质会跳过，对照模式实测正常（下面 shader-budget 的输出就是这样）。
  - `passes.mjs` 改为看 `material.defines`，和 DX-10 一致，而且比原来按源码文本判断更准确。

## 四、离线复核（`tmp/perf10rev`，master fbefb59 + 本分支）

- 合并无冲突。`pnpm typecheck` 通过。
- `check:glsl` 全部通过：**41** 个片元程序。简报写的是 40，多出来的一个是 master 合并 TR03 后新增的 `outside-rail`。同名函数、sampler（窗外 14/16）、场景表同步、README 表格也都通过。
- `shader-budget --only cloud-march,cloud-march-storm,cloud-march-typhoon --baseline <master> --rounds 2 --jobs 1`。测量锁空闲，CPU 约 49%，结果只作参考：

  | 程序 | 本分支 min / 中位 | master min / 中位 |
  | --- | --- | --- |
  | cloud-march | **0.49 / 0.60 s** | 15.5 / 16.7 s（−96.9%） |
  | cloud-march-storm | 3.97 / 4.29 s | — |
  | cloud-march-typhoon | 7.63 / 8.16 s | — |

  和交接给的 0.49 / 3.9 / 7.3 s 一致。
- 临时工作区审完已删除。

## 开发体验反馈

- 交接文档把变体表、触发策略、已知问题列得很清楚，审查从「变体何时编 / 何时画」切入，很快就能定位到 `prepareWeather` 和 `pickMarch` 规则不对称。建议以后凡是「选变体」的逻辑，都只留**一个**函数算「想要的键」，`prepareWeather`、云影、探针都调用它，从结构上避免这类不对齐。
- `PERF-10-preproc.mjs`（真预处理后数标识符）很好用，建议挪到 `scripts/` 并接进 `check:glsl`：断言默认程序预处理后不含 `stormDensity` / `hurricaneDensity`，防止以后有人把天气代码写到宏外面，冷编译又悄悄涨回去。
- 分支是在 TR03 合并之前分出去的，TR03 新增的火车视角恰好碰到 PERF-11 的深度开关条件（「二、5」）。热点契约类任务合并前，最好先让实现者 rebase 到最新 master，再对照一次「新使用方」。
- 离线 FXC 在 CPU 约 50% 时 master 的默认云步进测到 15.5 s，交接写的是 13.7 s，差 13%，噪声依旧明显。这次的结论是 −96%，量级不受影响。
