# PUB-3：发布后复核（第一部分：安静窗口性能 + 全量回归）

性能与回归测量代理，中档、只测不改代码。2026-09-29，主仓库 `D:\Code\opus-test` master（`05d8fbc`），用现有 5181 dev server（PID 60156，测量结束未关闭——这是协调者/其他会话起的常驻服务，不是本代理起的，按简报要求不动它）。全程持测量锁（`cold` / `bench` / `gpu-ab` 均自动持锁），GL_RENDERER 全程核对为硬件渲染 `ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)`，不是 WARP / SwiftShader。测量工具打开页面默认带 `voyage=0`（dev-browser.mjs 内置），未额外传参。

## 结论摘要（先说有没有阻塞级问题）

- **全量回归（59 个场景）控制台 0 error / 0 pageerror**，无失败场景。**不是发布阻塞项**。
- **自动画质档确认会降档、降档后画面仍可用**（截图见 §3）。**不是发布阻塞项**。
- **冷启动从 09-27 记录的 9.1 s 退步到本次最小值 11.28 s（+24%）**。未到「明显卡死」程度（加载遮罩内，不是白屏崩溃），但明显退步，**建议排一个 PERF 任务定位**，不建议算发布阻塞（不影响功能，只是等待变长）。
- **用户分辨率（3840×1950）下，全部 8 个代表场景的帧时间都已超过 160 Hz 的 6.25 ms 预算**（103%–247% 不等），其中晴天场景（noon-cumulus、sea-sc、clouds-variety）相对上一轮 PERF_PREVIEW_wave8（09-28）的数字**涨了 50%–90%**，是本轮最值得关注的发现。这不算「发布阻塞」（自动画质档会接管、且用户机器是 160 Hz 高刷屏，60 Hz 门槛还有余量——见 §2 换算），但**已经吃光了 wave8 报告里说的「本波美术项还有 0.4–0.9 ms 余量」**，建议下一波先派 PERF 复测归因，暂停继续往晴天场景加 GPU 负担。

---

## 1. 冷启动（d3d11，`dev-browser.mjs cold --port 5181 --angle d3d11 --repeat 3 --wait-quiet`）

| 轮 | 总时长 | 窗外程序编好 | 机翼程序编好 | 舱内程序编好 |
| --- | ---: | ---: | ---: | ---: |
| #1 | 12.290 s | 9.580 s | 8.988 s | 6.837 s |
| #2 | 11.403 s | 8.659 s | 6.548 s | 4.671 s |
| #3 | 11.282 s | 8.497 s | 6.407 s | 4.478 s |
| **min/median/max** | **11.282 / 11.403 / 12.290 s** | 8.497 / 8.659 / 9.580 s | 6.407 / 6.548 / 8.988 s | 4.478 / 4.671 / 6.837 s |

**对比 WORKLOG 09-27 立足点记的 PERF-14 数字 9.1 s（最小值）：本次最小值 11.28 s，+24%。** 关键路径仍是窗外程序（与 09-27 一致），但窗外程序编好耗时本身从当时的量级明显变长。09-27 之后合并了 WS 系列巨构（含 WS09 垂直大陆返工）、SPEC 系列、REFLECT-OFF、FOCUS-ZOOM、STROBE-FLASH 等大量窗外/机翼程序相关改动，按 DEV_SOP 冷编译门槛（单任务 ≤10%、一波累计 ≤15%）逐项都在预算内，但**累计效应叠加到了这个量级**，没有单独复测过。

**判断**：未到「明显卡死」（页面有加载遮罩、11–12 s 内正常显示），但相对旧立足点是实打实的退步，建议排 PERF 任务用 `shader-budget.mjs --bisect` 逐项二分归因，而不是当场在本任务里改代码（本任务只测不改）。

---

## 2. 用户分辨率（3840×1950）代表场景帧时间

**口径**：`dev-browser.mjs bench --port 5181 --viewport 2560x1300 --dpr 1.5 --rounds 3 --frames 30 --wait-quiet`（画布 = 2560×1300×1.5 = 3840×1950，与用户屏幕一致，高画质档默认）。每场景两列：`cpu`＝批渲读回耗时，`gpu`＝`EXT_disjoint_timer_query_webgl2` 计时，取三轮里位于终端输出的稳定值（工具本身按场景各跑一段，未做 ABBA 配对，数值仅供量级参考，不是 `gpu-ab` 级别的显著性判断）。

| 场景 | 本次 cpu | 本次 gpu | wave8（09-28，同口径） | 变化 | 占 6.25 ms 预算 |
| --- | ---: | ---: | ---: | ---: | ---: |
| noon-cumulus | 9.033 ms | 9.543 ms | 5.37 ms | **+68%～+78%** | 145%～153% |
| sea-sc | 6.462 ms | 7.031 ms | 3.72 ms | **+74%～+89%** | 103%～112% |
| clouds-variety | 8.449 ms | 8.778 ms | 5.64 ms | **+50%～+56%** | 135%～140% |
| night-city | 11.668 ms | 11.244 ms | 7.45 ms | **+51%～+57%** | 180%～187% |
| storm-day | 10.606 ms | 10.715 ms | 9.04 ms | +17%～+19% | 170%～171% |
| storm-sc-low | 10.286 ms | 10.486 ms | 9.08 ms | +13%～+15% | 164%～168% |
| typhoon-bands | 12.896 ms | 13.394 ms | 15.46 ms | **−17%～−13%（改善）** | 206%～214% |
| route-hnd-cts（连续航程默认首屏代表） | 8.754 ms | 8.485 ms | 无对照（wave8 未测） | — | 136%～140% |
| ws-pillars-noon（奇观：巨柱群，正午） | 7.742 ms | 7.554 ms | 无对照 | — | 121%～124% |

**交叉核对（1600×1200，`--viewport 1600x1200 --dpr 1`，与 wave8 §1.1 同口径）**：

| 场景 | 本次 cpu/gpu | wave8 1600×1200 | 变化 |
| --- | ---: | ---: | ---: |
| noon-cumulus | 4.617 / 4.671 ms | 2.48 ms | +86%～+88% |
| sea-sc | 2.884 / 2.861 ms | 1.50 ms | +91%～+92% |
| clouds-variety | 4.847 / 4.907 ms | 3.0–4.1 ms | +18%～+63%（在区间高端） |
| night-city | 5.878 / 5.836 ms | 3.61 ms | +62%～+63% |
| storm-day | 5.049 / 4.862 ms | 4.26 ms | +14%～+19% |
| storm-sc-low | 4.928 / 5.393 ms | 6.83 ms | **−19%～−28%（改善）** |
| typhoon-bands | 8.23 / 8.139 ms | 7.42 ms | +10%～+11% |

**读法与疑点（未在本任务范围内深挖根因，留给下一波 PERF）**：
- **两种分辨率下的相对涨幅高度一致**：晴天 / 夜城场景（noon-cumulus、sea-sc、clouds-variety、night-city）无论 1600×1200 还是用户分辨率都涨了 50%–92%，而雷暴类场景涨幅小得多（storm-day +14%～19%、typhoon-bands +10%～11%），storm-sc-low 甚至在 1600×1200 下**改善了 19%～28%**。这个「晴天涨得凶、风暴涨得少甚至降」的模式与 wave8 §0 结论「TW01 让雷暴云 pass 天生更贵、但晴天场景余量很薄」的方向一致——怀疑是有一项**对所有场景都生效的固定开销**（例如 VOY-DEFAULT 默认开启连续航程后 director 逐帧运行的成本、或某个窗外/机翼程序的常量分支）新增或变重了，被风暴场景本来就很大的云步进耗时「摊薄」得不明显，但在晴天场景里占比暴露得很清楚。这只是一个假设，需要下一波用 `gpu-ab`（同页 ABBA 配对、比对 09-27 前后提交）做按 pass 的显著性验证才能确证，本任务未做代码改动、也未做跨提交 bisect。
- **user 分辨率下已经没有任何代表场景在预算内**：wave8 报告说「晴天积云还剩 0.6–0.9 ms 余量、俯视云海 2.5 ms 宽裕」，现在 noon-cumulus 超预算 45%、sea-sc 也过线了（103%）。wave8 §0 第 7 条建议的执行顺序（先压 storm-sc-low 腾抵消）已经不适用，storm-sc-low 现在反而是相对健康的一项（1600×1200 下还降了）。
- **奇观场景（ws-pillars-noon）与连续航程首屏（route-hnd-cts）单独看不算离谱**（用户分辨率 7.5–8.8 ms），但仍超预算 20%–40%，说明「默认体验」本身现在就要靠自动画质档兜底，不是靠余量。

---

## 3. 自动画质档（`--quality auto` + 大画布模拟过载）

**口径**：`shots --viewport 3840x2160 --dpr 2 --quality auto`（画布 7680×4320，约为用户画布像素的 8.6 倍，刻意制造远超正常使用的过载），场景 noon-cumulus / storm-sc-low / typhoon-bands。

| 场景 | 降档后帧时间 | 降档情况 |
| --- | ---: | --- |
| noon-cumulus | 8.733 ms | 工具打印警告：自动档降到「min」档 |
| storm-sc-low | 9.45 ms | 同上，降到「min」 |
| typhoon-bands | 14.51 ms | 同上，降到「min」 |

**结论**：自动画质档**确认会随帧时间降档**（从高档一路降到最低档 `min`，README/PERF-5 定义的档序是 高 → 中 → 低 → 最低，本次直接命中最低档，说明过载幅度确实很大——canvas 面积比用户屏幕大近 9 倍，属于刻意的极端压测）。截图核验（`tmp/screenshot/pub3-auto/{noon-cumulus,typhoon-bands}.png`）：降到最低档后画面仍然完整可用——云的体积感、窗外光照、机翼材质都在，没有出现黑屏/纹理缺失/明显撕裂；能看出云缓冲分辨率降低带来的边缘略柔和，属预期内（PERF-5 的既定设计：低档 `cloudScale` 变小），不是发布阻塞级瑕疵。

降档后仍然普遍超预算（min 档 typhoon-bands 仍要 14.5 ms），这是极端压测（8.6× 画布）下的正常结果，**不代表用户实际使用场景会撞到这个数字**——用户屏幕本身就是画质档的设计基准（wave8 §2 条款 1：高档 = 用户分辨率整幅）。自动降档机制本身工作正常，是这次要验证的核心结论。

---

## 4. 全量回归

**口径**：`dev-browser.mjs shots --port 5181 --out tmp/screenshot/pub3-regression`（未加 `--only`，跑 `scenarios.mjs` 全部场景；未用 Playwright MCP 版 `regression.playwright.js`，二者按 README 是等价路径，选了不占浏览器锁的一个）。

**结果：59 个场景全部截图成功，截图期间控制台 0 error / 0 pageerror，无失败场景。** 外站瓦片（EOX / OpenFreeMap / AWS 地形）跨域错误按工具既有策略聚合计数、不计入错误数（本次日志里也没有触发聚合提示，说明这批场景没有大量瓦片报错）。

各场景 1600×1200 默认画质档下的帧时间（附带产出，供参考，不是本报告 §2 的权威口径）：

```
noon-cumulus 4.227  sunset-wing 3.8  sea-sc 2.603  sea-sc-low 2.467
storm-sc 6.487  storm-sc-low 5.79  dusk-earthshadow 2.803  clouds-variety 5.053
cirrus-noon 4.603  backlit-close 4.697  low-sea-glint 2.393  in-cloud 4.733
storm-day 5.94  typhoon-eye 11.647  typhoon-bands 12.153  typhoon-outer 8.593
fuji-day 3.223  night-city 5.87  night-city-on 5.55  night-city-off 5.67
route-hnd-cts 4.017  route-hnd-cts-night 4.063  fuji-west-seam-low 2.573
night-city-low-west 5.397  economy-ahead 2.85  night-sea-milkyway 2.27
night-sea-fullmoon 2.42  wonder-tether-dusk 2.787  ws-tether-noon 3.217
ws-tether-noon-up 2.16  ws-tether-dusk-up 1.947  ws-tether-night 2.88
ws-tether-night-up 2.033  ws-tether-sea 2.907  wonder-jianmu-day 2.873
ws-jianmu-dusk 2.83  ws-jianmu-dusk-up 2.153  ws-pillars-noon 3.337
ws-pillars-noon-up 2.503  ws-pillars-dusk 3.25  ws-pillars-night 3.46
ws-pillars-sea 3.48  ws-vcont-noon 3.98  ws-vcont-noon-up 2.68
ws-vcont-dusk 3.89  ws-vcont-night 4.023  ws-vcont-sea 3.617
ws-vcont-backlit 3.71  ws08-noon 3.343  ws08-dusk-up 2.167
ws08-night-nm-up 2.483  wonder-fogcity-night 4.243  wonder-floatcity-day 4.423
wonder-floatcity-dusk 4.483  rail-oito-default 3.85  rail-oito-curve 3.897
bow-rain 4.283  bow-cloud 3.56  bow-cha 4.627
```

**失败场景清单：无。**

---

## 复现命令

```bash
cd D:\Code\opus-test\apps\voyage

# 冷启动（min 值判定）
node scripts/dev-browser.mjs cold --port 5181 --angle d3d11 --repeat 3 --wait-quiet

# 用户分辨率代表场景帧时间
node scripts/dev-browser.mjs bench --port 5181 --viewport 2560x1300 --dpr 1.5 \
  --only noon-cumulus,clouds-variety,sea-sc,night-city,storm-day,storm-sc-low,typhoon-bands,route-hnd-cts,ws-pillars-noon \
  --rounds 3 --frames 30 --wait-quiet

# 1600x1200 交叉核对（与 wave8 同口径）
node scripts/dev-browser.mjs bench --port 5181 --viewport 1600x1200 --dpr 1 \
  --only noon-cumulus,clouds-variety,sea-sc,night-city,storm-day,storm-sc-low,typhoon-bands,route-hnd-cts,ws-pillars-noon \
  --rounds 3 --frames 30 --wait-quiet

# 自动画质档降档验证（极端过载）
node scripts/dev-browser.mjs shots --port 5181 --viewport 3840x2160 --dpr 2 --quality auto \
  --only typhoon-bands,storm-sc-low,noon-cumulus --out tmp/screenshot/pub3-auto

# 全量回归（59 场景，控制台 error/pageerror 统计）
node scripts/dev-browser.mjs shots --port 5181 --out tmp/screenshot/pub3-regression
```

截图产出：`tmp/screenshot/pub3-auto/`（3 张，自动画质降档验证）、`tmp/screenshot/pub3-regression/`（59 张，全量回归基线，可作为下一波截图对比的参照）。

---

## 给协调者的建议

1. **不建议因本报告延后发布**：控制台零错误、自动降档机制工作正常、59 个场景全部截图成功。用户屏幕 160 Hz 高刷但实际体验以自动画质档兜底，功能层面没有阻塞项。
2. **建议下一波排一个 PERF 任务**（暂拟 PERF-16）：
   - 用 `dev-browser.mjs cold --baseline` 与 09-27 前的提交（或找一个更早的锚点提交）交替测，定位冷启动 9.1 → 11.28 s 的具体贡献项；
   - 用 `gpu-ab` 对 noon-cumulus / sea-sc / night-city 做 ABBA 配对、与 09-27/09-28 附近的提交对照，验证「晴天场景涨 50%–90%、风暴场景涨幅小或降」这个不对称模式，找出是否有一项对所有场景生效的固定开销（怀疑方向：VOY-DEFAULT 连续航程默认开启后 director 逐帧成本、或某个窗外/机翼常量分支）；
   - 复测后重新给 wave8 式的「余量表」定档，晴天场景当前已无正向余量，后续美术类需求预审要按这份新数字走，不能再引用 wave8 的旧余量。
3. 本报告未改代码、未提交，`git status` 应该只多出 `tmp/screenshot/pub3-*` 与本文件（均不提交由协调者处理）。
