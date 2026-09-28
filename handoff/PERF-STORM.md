# PERF-STORM · 雷暴 / 浓云海场景云步进降到预算内（交接，进行中）

- 分支 `worktree-agent-ae5c1bc2f798e9a35`，开发端口 **5268**（简报给的 5258 被 VOY-DEFAULT 的 worktree 占用），对照（master 92b97ee）`D:\Code\opus-test\tmp\perfstorm-base` 端口 5328。
- 改动：`src/clouds/clouds.ts`（天气宏里的步进）、`src/clouds/clouds.glsl.ts`（**只动乳状云 `pouchField` / `mammatusDensity` 两处，几何逐位不变**；C-TOFU 在同文件改形状，合并时请协调者处理）。
- 硬件渲染已核：`ANGLE (NVIDIA GeForce RTX 5090 … D3D11)`；所有测量持测量锁（ab / gpu-ab / flight / shader-budget 自带等锁）。测量期间别的代理的浏览器在跑 GPU（nvidia-smi 58%），结论一律用 `gpu-ab` 同页 ABBA 配对 + A/A。

## 结论先行

1. **钱不在步数，在乳状云**。storm-sc-low 每像素 168 步里 161 步是外壳里层状云高度以外的空白 2dt 步、有云样本只有约 2 个；把空白步跳掉（168 → 75 步）单独做 GPU ×0.99。真正贵的是砧与砧下乳状云带里每像素 20+ 次完整雷暴密度，关掉乳状云 ×0.67–0.71，几乎全是 `pouchField`。
2. **交付两项，都不改画面几何**：
   - ① 乳状云等价剪枝（`clouds.glsl.ts`）：`pouchField` 格点中心离采样点 ≥ 0.75 格先跳过第二个哈希；`mammatusDensity` 按口袋最大下垂深度剪掉砧底下更深的采样点。结果逐位不变（推导见代码注释）。
   - ② 天气外壳空域跳跃（`clouds.ts`，**只编进纯雷暴变体** `CLOUD_STORM_SKIP`）：refineOn 视线只走「层状云包络」与「雷暴包围柱」两段，之外一步跳到下一段起点；跳后半步、`lastEmpty` 同步。①之后它才显出效果（再 ×0.85）。放进台风变体会 ×1.36（寄存器压力），所以台风不带。
3. **GPU（gpu-ab，1600×1200，16 轮 ABBA，old = master 同页换回，old2 = A/A）**：

   | 场景 | master 云 ms | 交付 云 ms | 交付 / master | 只有 ①（noskip） | A/A |
   | --- | ---: | ---: | --- | --- | --- |
   | storm-sc-low | 3.17 | 2.27 | **×0.744** [0.718, 0.752] | ×0.887 | ×1.004 |
   | storm-day | 2.88 | 2.12 | **×0.749** [0.734, 0.756] | ×0.884 | ×0.990 |
   | storm-sc | 2.80 | 2.09 | **×0.742** [0.720, 0.756] | ×0.876 | ×0.998 |
   | storm-graze | 4.16 | 3.59 | **×0.876** [0.856, 0.894] | ×0.871 | ×0.994 |
   | typhoon-bands | 5.48 | — | 台风变体不含 ①②，= master（noskip 行 ×1.001） | — | ×1.005 |
   | sea-sc-low（晴天） | 0.36 | 0.35 | ×0.994（离散内） | — | ×1.012 |
   | noon-cumulus（晴天） | 0.49 | 0.50 | ×0.997（离散内） | — | ×1.002 |

   「云 ms」是 `gpu-ab --time clouds`（步进 + resolve）的中位。预审表（passes 口径）里 storm-sc-low 云步进 5.69 ms，按 ×0.744 折算约 **4.2 ms**——**没到 ≤ 4 ms 的目标**，差约 5%（见「还不够」）。

4. **用户画布 3840×1950 整帧（gpu-ab --time frame --viewport 2560x1300 --dpr 1.5，8 轮 ABBA）**：

   | 场景 | master 整帧 ms | 交付 整帧 ms | 比 | A/A | 占 160 Hz 预算（6.25 ms） |
   | --- | ---: | ---: | --- | --- | --- |
   | storm-sc-low | 9.55 | 8.04 | ×0.842 [0.826, 0.850] | ×1.008 | 153% → 129% |
   | storm-day | 9.15 | 7.55 | ×0.830 [0.812, 0.836] | ×1.002 | 146% → 121% |
   | storm-sc | 13.2 | 11.1 | ×0.856 [0.807, 0.876]（该场景离散 40%+，参考） | ×0.966 | — |
   | storm-graze | 10.55 | 9.68 | ×0.916 [0.913, 0.925] | ×0.998 | 169% → 155% |
   | typhoon-bands | 16.4 | 16.0 | ×0.986（离散内，未改） | ×1.008 | 262% |

   （benchFrame 连画 N 帧的整帧 GPU，含窗外 / 舱内 / 机翼，与预审 §1.2 的「合计」同量级但不是同一工具。晴天与夜城的用户分辨率整帧这轮没测完：sea-sc-low 场景加载超时，见「坑」。晴天 / 夜城走默认云程序，预处理后与 master 逐字相同，1600×1200 的 gpu-ab 也在离散内。）

5. **画质**：①逐位不变；②改变的是外壳空白处的采样网格。对 1/4 步长真值（`ab` cloudDump + cloud-ref / cloud-dist）：storm-sc-low 边宽中位 4.75 / 4.75（真值 4.5），α 分档 0.762/0.791/0.786/0.820 → 0.764/0.789/0.786/0.820，云区 |Δα| 0.0081 → 0.0081，Y 比 0.805 → 0.804；storm-sc、storm-day、storm-graze、typhoon-bands 同样在 ±0.01 内（`tmp/screenshot/perfstorm/sw`、`eval1`）。显示层面 cur 对 old 平均差 0.39 / 255（storm-sc-low）。
   - **有无雷暴切换**（`handoff/PERF-STORM-switch.py`，同机位层积云海有雷暴 / 无雷暴，按距离分带的 Y 比）：storm-sc-low 对 sea-sc-low 0–20 / 20–40 / 40–60 / 60–90 km 为 master 1.013 / 1.024 / 0.789 / 0.625，交付 1.012 / 1.023 / 0.786 / 0.625；storm-sc 对 sea-sc 两者逐带相同。40 km 以外的差来自雷暴本身（塔影、砧遮挡），不是采样；**没有引入新的跳变**。
   - **flight**（static / reset / cruise / turn / live，old / cur / cur2 同页，cur2 是 A/A）：storm-sc-low 近处云海、砧、storm-day 三个裁剪区全部与 A/A 同量级；巡航 / 转弯云边 edge ×1.00、σ 不变（无拖影）；live relStd ×0.94–1.03（A/A ×0.70–1.06）无闪烁。唯一系统差：storm-day 静止对真值误差 ×1.10（cur 与 cur2 都是，绝对量 0.059 → 0.066），reset@16 ×1.03；storm-sc-low 砧区反而 ×0.91。

## 冷编译（离线 FXC，`shader-budget --baseline <master> --rounds 5`，按最小值）

| 程序 | master | 交付 | Δmin |
| --- | ---: | ---: | --- |
| cloud-march | 939 | 855 | −8.9%（默认程序预处理后与 master 逐字相同，属噪声） |
| cloud-march-storm | 4414 | 4991 | **+13.1%**（第 4 轮 CPU 57%，负载下；待定因） |
| cloud-march-typhoon | 8345 | 8144 | −2.4% |

cloud-march-storm 的 +13% 超了「不升」的要求，正在拆是 ① 的 `continue`（循环里多了动态分支）还是 ② 的跳跃（见「正在做」）。

## 做过、不采用的（数字都是 gpu-ab 配对比）

| 试法 | 场景 | 结果 | 为什么不要 |
| --- | --- | --- | --- |
| 天气程序层内细步不做（noref，C10b 审查的方向） | sc-low / day / graze / 台风 | ×0.94 / 0.90 / 0.75 / 0.92 | 切程序时近处层状云整片跳（C10b 审查 25%），违背 C10b |
| 受光全走 6 步层状云支（l6） | sc-low / day / 台风 | ×0.85 / 0.92 / 0.73–0.80 | 雷暴 / 台风不再挡光，画面错 |
| 砧的受光 4 步（softL4） | sc-low / day | ×0.955 / 0.976 | 砧的明暗起伏变，收益小 |
| 占据网格 mip 2 → 1 / 0 | sc-low / day | ×0.95 / 0.94 | mip 2 是为盖住格点间漏掉的小突起（PERF-2），有漏密度风险 |
| 受光样本升出外壳顶提前结束（等价） | sc-low / day / 台风 | ×1.02 / 0.99 / 0.99 | 不省 |
| 闪电端点 / 相函数 / msKRay 挪进分支（省寄存器） | 台风 / sc-low | ×0.97–1.07 | 不省或更慢 |
| 台风雨带单体循环等价早退、受光版单体参数缓存 | 台风 | ×1.12 / ×1.10 | 更慢（寄存器 / 结构敏感） |
| 空域跳跃放进台风变体 | 台风 | **×1.36** | 台风包围柱罩住整窗，跳不掉，只多寄存器 |

台风的开销拆分（只作定位，关掉部分画面是错的）：完整雨带 58%、受光版雨带 23%、受光用解析大形 ×0.76、卷云盖 5%、眼壁 9%。

## 正在做 / 下一步

1. 冷编译 +13% 定因：`shader-budget --variants` 按 ①、② 分别撤回；若是 ① 的 `continue`，试把条件写成不带 `continue` 的 `if` 块。
2. 用户分辨率补测 sea-sc-low / noon-cumulus / night-city 整帧。
3. compile-ledger 追加一行（`shader-budget --ledger --only cloud-march,cloud-march-storm,cloud-march-typhoon`）。
4. 交付前关 5268 / 5328、删 `tmp/perfstorm-base`。

## 复现

```bash
# apps/voyage 下；5268 = 本分支，5328 = master 对照
python handoff/PERF-STORM-mkjobs.py && node scripts/dev-browser.mjs ab --port 5268 --jobs apps/voyage/handoff/PERF-STORM-diag-jobs.json --rounds 1 --out <目录>   # 步数 / 受光 / 层外步 / 层内步 / 走到哪
python handoff/PERF-STORM-mkdiag2.py  # 每像素完整 / 精简雷暴密度次数、8 步受光样本（热图）
python handoff/PERF-STORM-mkcost3.py … mkcost10.py   # 各轮 gpu-ab 拆分（见上表）
python handoff/PERF-STORM-mkeval.py && node scripts/dev-browser.mjs gpu-ab --port 5268 --base 5328 --jobs apps/voyage/handoff/PERF-STORM-gpu-jobs.json --rounds 16 --n 20 --time clouds
bash handoff/PERF-STORM-final.sh      # 交付测量链（passes 副本、用户分辨率整帧、切程序、flight）
python handoff/PERF-STORM-switch.py D:/Code/opus-test/tmp/screenshot/perfstorm/sw
```
数据：`D:\Code\opus-test\tmp\screenshot\perfstorm\`（diag0 / diag2 热图、eval1、sw、flight），日志 `D:\Code\opus-test\tmp\perfstorm-*.log`。
