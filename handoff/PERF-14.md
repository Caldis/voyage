# PERF-14 · 舱内 / 机翼程序冷编译回收（交付）

- 分支 `worktree-agent-ae3e95f93a3e4d63a`，端口 5214，对照 5274（`D:\Code\opus-test\tmp\perf14-base`，master `ed6378f` 的 detached worktree）；消融用另一个不跑 dev server 的 `tmp\perf14-abl`。
- 状态：**已完成，待审查**。必审：碰了热点 scene.ts / main.ts / wing-pass，新增程序（座椅 pass）与变体（WING_WET）。
- typecheck / build（dist/assets 无 0 字节）/ check:glsl（45 个程序、新断言 1d）通过；`dev-browser check` 与全部截图期间无 console error。

## 1. 关键路径分解（改前）

`main.ts` 的启动批次现在把每个程序编好的时刻写进 `__voyageStartup["批次各程序编好（ms）"]`（`dev-browser cold` 直接打印）。改前 master 代码（本分支加了计时）3 轮，机器有负载：

| 程序 | 编好时刻（ms，相对批次开始） |
| --- | --- |
| 云 ×3（步进 / resolve / 云影图） | 0.8 s |
| 窗外默认 | 8.7–11.5 s |
| 机翼 | 9.1–11.6 s |
| **舱内（商务）** | **11.0–14.5 s（关键路径，比其余晚约 2 s）** |

三个大程序确实并行编（KHR_parallel_shader_compile），墙钟 = 最慢的那个。浏览器内时间约为离线 FXC 的 1.4–1.5 倍。

## 2. 方案原型（离线 FXC，`--variants`，3 轮最小值）

舱内 scene-default（`handoff/PERF-14-ablate-cabin.mjs`，基线 8225 ms）：

| 变体 | Δmin | 说明 |
| --- | --- | --- |
| shadeSeat 换常数 | −41% | 复现 PERF-12 |
| **(a) 座椅追踪 + 着色搬走，只读一张纹理** | **−31%** | 选这个 |
| (b) 上界：座椅层光照全换常数、只留材质 | +12%（噪声） | 「光照收成一个调用点」拿不回东西，放弃 |

机翼 wing（`handoff/PERF-14-ablate-wing.mjs`，基线 7706 ms，CPU 安静）：

| 撤掉 | Δmin | 处理 |
| --- | --- | --- |
| 全部材质（wingSurface） | −43% | 常驻内容，不拆 |
| 蒙皮细节 / 小翼材质 / 短舱材质 | −23% / −22% / −15% | 常驻，不拆 |
| **窗板水珠 waterOnPane（只用于水珠暗边 k）** | **−18%** | **拆：WING_WET 变体**（干窗时 waterOnPane 恒返回 0，默认程序逐位相同） |
| 航行灯本身 / 灯照翼面 / 两者 | −11% / −5% / −16% | 航行灯白天也亮，不拆（见第 6 节） |
| 两处 wingEnv 只留一处 | −4% | **改成循环，单调用点**（逐位相同） |
| 机身投影 / 云雾 | −7% / −7% | 噪声边缘，不动 |

## 3. 改了什么

| 文件 | 改动 |
| --- | --- |
| `src/render/seat-pass.ts`（新） | 座椅 pass：`traceSeats` + `shadeSeat` → `hdrSeat`（rgb 座椅颜色、a 覆盖率；没打到座椅写 0）。目标 32 位浮点（有 EXT_color_buffer_float 时），`material.name = "座椅"`（passes.mjs 自动认） |
| `src/render/scene.ts` | 抽出 `CABIN_FRAG_HEAD`（模块 + uniform + 常数）与 `CABIN_LIGHTS_SETUP`（`cabinLightsSetup()`，原 main 开头那段灯光，逐字搬过去）两段共用；舱内 main 改读 `uSeat`（`seatCov` / `seatCol`，其余合成逻辑一字未动）；`uSeat` uniform；`CabinClassVariant` 改为按舱等管「舱内合成 + 座椅」一对程序（`seat()` 取当前舱等的座椅材质，两个都编好才切） |
| `src/render/wing-pass.ts` | 水珠暗边包进 `#ifdef WING_WET`；新增 `WingWetVariant`（`uWetness > 0.001` 时用变体；首帧后 120 帧后台预编，编好约 8 s；没编好时先画默认程序） |
| `src/render/wing-shading.glsl.ts` | 两次 `wingEnv` 写成 `min(uWingSteps,0)..2` 循环（只内联一份） |
| `src/main.ts`（最小改动） | ① 建 `seatMat` / `hdrSeat`，`uSeat` 指向它，`resize` 一并改尺寸；② 每帧在窗外 pass 之后、舱内合成之前 `pass.render(cabinClass.seat(), hdrSeat)`；③ 启动批次加 `[seatMat, hdrSeat]`，并记录各程序编好的时刻（`startup` 类型放宽为 `number \| string`）；④ 机翼 pass 走 `wingVariant.pick(renderer, u.uWetness.value)`；⑤ `benchScene` / `benchWing` 同步；⑥ `__voyage` 加 `seatMat` / `hdrSeat` / `wingVariant` |
| `scripts/lint-shaders.mjs` | 登记 `seat-default` / `seat-economy` / `wing-wet`；新断言 1d（舱内不调用 shadeSeat / traceSeats、座椅程序调用；wing 不调用 waterOnPane、wing-wet 调用） |
| `README.md` | sampler 表（scene 6/9，多了 uSeat）、模块表、渲染管线、坑点「着色器编译」一条 + 「工具与环境」一条 |
| `research/compile-ledger.json` | `--ledger` 追加一行（提交 79fa03f，7 个程序） |

## 4. 前后数字（d3d11，RTX 5090，1600×1200）

**真冷启动**（`dev-browser cold --baseline 5274 --repeat 5 --wait-quiet`，交替，机器上有其他代理）：

| | 5 轮 | 最小 / 中位 |
| --- | --- | --- |
| 本分支 | 13709, 10119, 9065, 9859, 10821 | **9 065 / 10 119 ms** |
| master | 15736, 12371, 12003, 12719, 13016 | 12 003 / 12 719 ms |
| Δ | | **−2.94 s / −2.60 s**（目标 ≥ 1.5 s ✔） |

改后批次分解（同 5 轮）：座椅 1.6–1.7 s、舱内 4.4–6.6 s、机翼 6.5–11.2 s、窗外 6.8–11.4 s。**关键路径换成窗外程序，机翼紧跟（0.2–0.7 s）。**

**离线 FXC**（`shader-budget --baseline <master> --rounds 5`，最小值）：scene-default 7330 → **3967**（−46%）、scene-economy 6599 → 4363（−34%）、wing 7281 → **6472**（−11%）、outside-default 5791 / 5903（未动，噪声）；新增 seat-default 1500、seat-economy 1026、wing-wet 7602（≈ 原 wing，后台编）。fxc 指令槽：scene-default 4832、seat-default 2200、wing 2928、wing-wet 3540。

**帧时间**（`passes.mjs --baseline 5274 --frames 60 --rounds 6`，中位数；均值被别的代理占 GPU 拉高、离群多，不用）：

| 场景 | 舱内 + 座椅（本分支） | 舱内（master） |
| --- | --- | --- |
| noon-cumulus | 0.238 + 0.016 = 0.254 | 0.292（−13%） |
| sunset-wing | 0.279 + 0.016 = 0.295 | 0.293（持平） |
| night-city-on | 0.283 + 0.016 = 0.299 | 0.297（持平） |
| economy-ahead | 0.173 + 0.076 = 0.249 | 0.229（**+0.02 ms，+9%**） |

座椅 pass 的固定开销约 0.016 ms（全屏写一张 RGBA32F）；满屏都是座椅的经济舱看前方因此多 0.02 ms。机翼：按帧加权的均值与 master 相同（0.752 / 0.751 ms，noon）。passes 里会出现「机翼（湿窗）」一行：passes 在 applyScene 之后立刻批渲，云探针还是上一处的结果，湿度会涨起来——两边一样，不是 bug。

**零回归**（`shots --pair "v.benchFrame = () => 0;" --base-shader <master> [--material wingMat]`，同页冻结换 master 着色器；噪声底 a−a2 全部逐像素 0；**超阈值 8 的像素全部为 0**）：

| 组 | 场景 | a−b |
| --- | --- | --- |
| 商务舱（换 sceneMat） | 看前 / 看后 / 默认坐姿 × 白天 / 夜间开灯 / 睡眠 / 全关（12）+ 湿窗白天 / 湿窗夜间开灯 + 云中 + sunset-wing | 16 个场景全 0；唯一非零是 biz-day-ahead 座椅轮廓上 max 5/255（浮点求和顺序） |
| 经济舱（预设置 js 给 sceneMat / seatMat 加 CABIN_CLASS_ECONOMY，`PERF-14-econ-pre.js`） | 同上 12 个 | 全 0 |
| 机翼干窗（换 wingMat，频闪钉亮） | sunset-wing、noon-wing、night-wing-lights、in-cloud | 全 0（in-cloud max 0.33） |
| 机翼湿窗（wingMat 加 WING_WET、湿度 0.9，`PERF-14-wet-pre.js`） | 同上 4 个 | 全 0 |

截图在本 worktree `tmp/screenshot/PERF-14/ab-biz2`、`ab-econ`、`ab-wing`、`ab-wing-wet`（各目录 `abdiff.json` 是汇总）。注意 `ab-biz` 是第一次没绕开 benchFrame 的无效数据。

## 5. 取舍

- (a) 而不是 (b)：(b) 的上界原型拿不回任何东西（座椅层光照换常数反而 +12%，噪声内），印证 PERF-12「FXC 时间由座椅整块与主函数叠在一起决定」——拆程序才有效。
- 座椅 pass 用 32 位浮点：半精度装不下屏幕玻璃上的太阳高光（可超 65504 → inf），暗处又进非规格数。代价是 0.016 ms 的固定带宽。
- 灯光 `cabinLightsSetup` 两个程序各算一次（座椅 pass 只在打到座椅的像素上算），换来逐位一致与单一出处。
- 湿窗变体：窗干（绝大多数时间）逐位相同；只在「刚启动 8 s 内窗上就有水」时机翼像素少一圈水珠暗边。航行灯没拆：白天航行灯也看得见，拆成变体会让白天丢灯或要常驻变体，收益为零。

## 6. 还能怎么压（窗外再快以后机翼会重新成为关键路径）

1. 航行灯本身（`wingLights`，−11%）拆成单独的加性 pass 叠到 hdrWing 上：数学上与 `col += L` 等价，但要 `EXT_float_blend`（32F 目标混合），没有时退回内联的变体。
2. 短舱材质（−15%）只在能看见短舱的座位 / 视角需要，可按 `uWingRootLE` + 头部位置做按需变体（要一个保守的可见性判定）。
3. 座椅 pass 的固定开销：非座椅像素 `discard` + 每帧 fast clear，可把 0.016 ms 再压一半（仓库目前没有 discard 的全屏 pass，PERF-6 的注释要一起改）。

## 7. 复现

```bash
# 开发服务器：本分支 5214，对照 5274（master 的 detached worktree）
node apps/voyage/scripts/dev-browser.mjs cold --port 5214 --baseline 5274 --repeat 5 --wait-quiet
node apps/voyage/scripts/shader-budget.mjs --baseline <master 的 apps/voyage> --only scene-default,seat-default,scene-economy,seat-economy,wing,wing-wet,outside-default --rounds 5 --wait-quiet
node apps/voyage/scripts/shader-budget.mjs --variants apps/voyage/handoff/PERF-14-ablate-wing.mjs --only wing --rounds 3   # 在不跑 dev server 的 master worktree 里跑
node apps/voyage/scripts/passes.mjs --port 5214 --baseline 5274 --only noon-cumulus,night-city-on,economy-ahead,sunset-wing --frames 60 --rounds 6
# 零回归（经济舱 / 湿窗把 --pair 换成 PERF-14-econ-pre.js / PERF-14-wet-pre.js 的内容；机翼加 --material wingMat）
node apps/voyage/scripts/dev-browser.mjs shots --port 5214 --scenes-file apps/voyage/handoff/PERF-14-scenes-biz.json --pair "v.benchFrame = () => 0; return 0;" --base-shader <master 的 apps/voyage> --material sceneMat --out tmp/screenshot/PERF-14/ab-biz2
node apps/voyage/handoff/PERF-14-abdiff.mjs <worktree 根> tmp/screenshot/PERF-14/ab-biz2
```
浏览器控制台：`__voyageStartup`（批次各程序编好时刻）、`__voyage.wingVariant`（state / compileMs / shownWet）、`__voyage.cabinClass.status("economy")`。

## 需要协调者注意

- `scripts/dev-browser.mjs`（不在本任务归属）有两个问题，见 README「工具与环境」新条：`--pair` 模式每拍一张都跑 `benchFrame(30)`，冻结失效（建议 shootOne 里去掉或放到所有截图之后）；`--base-shader` 不带 `--pair` 被静默忽略。另外 `swapMaterialShader` 找舱内目标用的 `Object.values(cabinClass.mats).includes(m)` 在本分支（值变成了 `{cabin, seat}`）上会退回 hdrOutside 当编译目标——两者格式相同，只影响编译绑定，不影响结果。
- `handoff/PERF-12-ab.mjs` 按旧的 `cabinClass.mats[舱等]` 取材质，本分支之后失效（用 `shots --base-shader` 代替）。
