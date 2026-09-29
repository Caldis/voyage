# NIGHT-AP-1 独立审查（空气透视 LUT 并入月光）

审查对象：分支 `worktree-agent-a0e48ac5dbcc6dee8` @ `bd976dd`（合并基 = 当前 master `8a3e7c3`）。审查代理（重档），2026-09-29。
环境：RTX 5090，ANGLE d3d11 硬件渲染（每个脚本都核对了 `GL_RENDERER`），1600×1200，画质 high，URL 带 `voyage=0`，测量全程持测量锁（中间排队等过 TW04 审查的 ab）。分支页 5367（临时工作区 `tmp/NAP1rev-merge` = bd976dd），master 页 5368（`tmp/NAP1rev-base`）。两个临时工作区审完已删。

## 结论：**通过**

没有阻塞问题。物理与数学正确，白天 / 无月夜逐位不变的论证成立并复测为 0，满月夜三个场景复现了交付报告的数字，暮光切换在 HDR 里也只有很小的镜像误差。下面列了四条非阻塞遗留，其中第 1 条（`check:glsl` 漏拦两种回退）建议在合并时或下一波顺手补上。

## 1. 正确性（读 diff + 推演）

- `integrateSegment2` 与原 `integrateSegment` 逐项对照：步进、介质、`stepT`、能量守恒积分式 `(S − S·stepT)/σt` 都一样。两路光源的相函数、到光源的透射率、多次散射分开算，次要光源乘 `bScale`，这样合成是对的。`uApSecondLocal.w ≤ 0.5` 时走的仍是原来那一行 `integrateSegment`，uniform 也相同：主导光源是太阳时，`uSunDirLocal` 由 `dom[1] = sunDir[1]` 构造，与改前的 `sunCosZenith` 同源；`uApDir` / `uApIlluminance` 在同一帧里与 `uSunDir` / `uSunIlluminance` 取同一个值（`SUN_ILLUMINANCE_KLUX`，`uSunDir` 在别处没有被改写，已 grep 核对）。所以「次要光源 < 1/1000 时走旧代码，结果逐位不变」**成立**。
- 次要光源的方位：先转到「主导光源方位 = 0」的坐标系，再放进 z ≥ 0 那半边，与 LUT 用 `|方位差|` 查表的方式一致。主导光源在天顶附近（`lh < 1e-5`）时有兜底。
- 主导光源判定（`luts.ts:436–444`）：估计值 = 照度 × 地平线天光系数（log 表插值），比较时带 25% 回差（折成 log 约 0.1 个数量级）。逐个边界情况看：
  - **月亮在地平线附近或以下**：天光系数按月亮高度角连续下降，−2° 时约 10^−3.3。太阳 −20° 时月亮仍然主导，LUT 里按「地平线下的月亮」积分，`sunTransmittance` 会给出地影，物理上合理，不会跳变。
  - **新月 / 月食**：新月的照度约 1e-6 klux，而且昏暮时离太阳很近，比值远低于 1e-3，不会积分这一路。月食整个项目都没有建模（`magnitudeToKlux` 只看星等），天空视图 LUT 也一样，前后一致，不在本任务范围。
  - **海拔**：表只有 0.3 / 3 / 10.7 / 13 km 四档，超出范围夹到端点，中间在 log 域线性插值，连续。火车（0.3 km 档）、低空、巡航都落在表内。
  - **太阳长时间停在 −12° 附近（高纬度夏夜）**：输入量都是平滑的天文量，25% 回差对应太阳高度约 0.1–0.35°（表在 −13° 到 −11° 之间的斜率是 0.28–0.9 数量级/度）。太阳在最低点附近慢慢过去，最多来回切换一两次，不会逐帧抖动；每次切换的幅度见 §3。
  - 「次要光源开始积分」的 1e-3 门限没有回差，但跨过门限时次要光源只占约千分之一，实测那一帧的变化与相邻帧的噪声同量级（§3）。
  - 32 位浮点下没有下溢：`Math.max(…, 1e-30)` 只用于比值；表在 −30° 以下按斜率外推，最小约 1e-40，在双精度范围内。
- 台风：`hurricaneShadowedInscatter` 与 `HUR_BACKLIT_AP_CUT` 只在 `uSunDir.y > 0.02` 时生效，这时太阳必然主导（月亮估计比太阳小 5 个数量级以上），LUT 就是太阳那一路，`hurricaneSunVis` 按太阳算**合理**。
- 奇观三处（`wonder-sky` / `pillars` / `ring`）原先对月光有一项几何比例的近似补偿，写法是 `max(apL, …)`，现在 LUT 里已经带上月光，这里取最大值而不是相加，**不会把月光算两遍**。只是注释已经过时（见遗留 2）。

## 2. 覆盖完整

- grep 了 `aerialPerspectiveUvw` / `uAerialInscatter(S)` / `uAerialTransmittance(S)`：一共 9 个文件 13 处查表，全部改成 `uApDir`，所有内散射也都改乘 `uApIlluminance`（traffic、ring 两处包括在内）。三个消费材质（云的 marchMat 等三处、远塔、sceneMat）都展开了 `atmosphere.sharedUniforms`，新 uniform 能传到。CPU 侧没有读这两张 LUT 的地方。
- `check:glsl` 新检查的拦截测试（`handoff/NIGHT-AP-1-review-lint-mut.sh`：在临时工作区里每次改回一处、跑 lint、再恢复）：

| 改回的地方 | 拦住了？ |
| --- | --- |
| far-towers 查表 `uApDir → uSunDir` | 拦住（exit 1） |
| clouds 台风分段查表 `uApDir → uSunDir` | 拦住（19 个程序） |
| terrain / traffic 的内散射 `× uApIlluminance → × uSunIlluminance`（与采样写在同一行） | 拦住 |
| ring 查表 | 拦住 |
| **clouds.ts:881 `apL *= uApIlluminance` → `uSunIlluminance`** | **漏拦**（exit 0） |
| **far-towers.ts:138 `apL = I * uApIlluminance` → `uSunIlluminance`** | **漏拦**（exit 0） |

  原因是第二条正则要求采样和乘照度写在同一行，最重要的两个消费方（云合成、远塔）恰好把这两步拆成了两行。见遗留 1。

## 3. 观感（截图：仓库根 `tmp/screenshot/NAP1rev/`）

同页冻结 A/B（`handoff/NIGHT-AP-1-run.mjs`，base = `apMoon=false`，new2 / base2 是噪声底，都为 0），另外在 master 页上拍了同一场景作跨页对照。两页的场景完全一样：远塔列表、月亮 / 太阳位置逐项相同。

| 区域（behind） | master HDR | 分支 base | 分支 new | noAP |
| --- | --- | --- | --- | --- |
| 远塔砧 L / 饱和 / 屏幕 | 0.0109 / 0.95 / 29 22 21 | 0.0106 / 0.96 | **0.0299 / 0.33 / 56 56 59** | 0.044 |
| 远塔塔身 | 0.0062 / 0.81 / 16 12 13 | 0.0060 | **0.0255 / 0.11 / 48 52 56** | 0.032 |
| 地平线远云带 | 0.0089 / 0.55 | 0.0087 | **0.0241 / 0.03 / 46 50 55** | 0.028 |
| 近处云 | 0.0264 / 0.58 / 58 58 56（米黄） | 0.0263 | 0.0322 / 0.28 / **56 58 60（银灰）** | 0.034 |
| 地平线天空 | 0.0223 | 0.0224 | 0.0224 | — |

- 分支 base 与 master 在 HDR 上差 1–4%，这是跨页后云持续演化带来的差异；同页的 base 与 base2 为 0，所以 `apMoon=false` 可以当作 master 用。
- **满月在身后**：远砧、远塔身、远云带从暗褐 / 黑红剪影变成冷灰，融进地平线的亮带（`behind-zoom.png`：上 master、中 base、下 new）。**近处夜景没有被整体提亮**：自动曝光跟着场景变亮而下调，整屏均值 30.3 → 30.7，近处云的屏幕亮度 58 → 58，只是由米黄变成银灰；地平线天空的屏幕值反而从 52/61/67 降到 42/50/55（HDR 不变，是曝光造成的）。仍然读成月夜。
- **月亮在前**：远云带由橙褐变成中性，地平线附近的海面也多了一层月光空气光，更显纵深（`front-master_base_new.png`）。435 km 那座远塔在 master 里是黑剪影，现在几乎完全融进地平线，符合研究 §3「冷灰或中性灰的暗影」的下限。
- **无月**：分支 base 与 new 的 HDR、截图逐位相同；与 master 的差（平均 0.72 级）就是跨页的云演化。
- 新发现（非缺陷）：云间海面的 HDR 在 behind 场景里 +50%（0.0124 → 0.0187）。这是地形 / 海面消费方 `terrain-shading` 也补上了月光空气光，研究里的实验只换了云和远塔，所以没量到。海面约为地平线天空的 0.83 倍，屏幕 32/40/46 → 36/45/51，合理。
- **暮光切换**：用 `NIGHT-AP-1-twilight.mjs` 的参数化副本，选了镜像误差最大的构型：上弦月（2026-07-21，日月方位相差约 75°），窗户分别朝向「太阳关于月亮竖直面的镜像方位」（航向 57）和另一侧（航向 335），×40 时间 live 逐帧读回。切换发生在太阳 −14.2°，那一帧的窗区变化是 0.009 / 0.017 级；开始积分次要光源那一帧是 0.011 / 0.016 级。**但这个时刻截图几乎全黑**（×40 时间下曝光跟不上，冻结后也很暗），按 8 位截图量不出东西。所以我另写了 `handoff/NIGHT-AP-1-review-switch-hdr.mjs`：拨到切换点，正常时间下等 20 s，冻结后读回 hdrOutside，比较强制太阳主导和强制月亮主导两种情况。结果：整图相对差均值 0.66%（噪声底 0.10%），p99 为 14%（上半窗 26%），相对差 > 25% 的像素占 0.5%，集中在远处的云上。这就是镜像误差，只在切换那一帧出现一次，而当前曝光下这个时段屏幕近乎全黑，看不出来。
- 四条铁律：远景「宁可有雾」得到改善；没有新增锯齿或闪烁；近处的受光没有变化。**观感通过。**

## 4. 白天逐位不变 / 性能抽查

- `NIGHT-AP-1-parity.mjs` 抽查 noon-cumulus（太阳 57°）、sunset-wing（+1.2°）、fuji-day（23.7°）三个场景：cur 对 old、cur2 对 old2 的空气透视 LUT 内散射 / 透射率、云 raw、hdrOutside **全部为 0**。sunset-wing / fuji-day 的 cur 对 cur2、old 对 old2 在 hdrOutside 上不为 0，这是场景冻结后自己在漂移，与交付报告里 dusk 的情况相同，与改动无关。
- GPU（`gpu-ab --time frame`，8 轮 ABBA，twilight-10，太阳 −10°、两路都在积分）：new 7.18 / old 6.64 ms，配对比 ×0.979 [0.947, 0.999]，A/A 对照 ×0.962，**在离散度内**。开跑时 CPU 占用 54%，这组数只作抽查参考。冷编译没有另测（消费方只换了 uniform 名，交付报告里的增量都在噪声内）。

## 5. 构建 / 合并

- `pnpm --filter voyage typecheck`、`build` 都通过，`find dist/assets -type f -size 0` = 0；`check:glsl` 全部通过（含新检查）。
- 所有测量脚本记录的页面 / 控制台 error 都是 0（run ×3、master ×3、twilight ×2、switch-hdr、parity、gpu-ab）。
- `git merge-tree` 试合并：与当前 master（`8a3e7c3`）**无冲突**（本分支已经包含 master）；与 TW04 分支（`worktree-agent-ad1bf37ef35a6b70e` @ `e3fc071`，大改 clouds）试合并也**无冲突**。TW04 没有新增空气透视查表（grep 过它的 diff），合并后不需要另外改名。

## 非阻塞遗留

1. **`check:glsl` 漏拦「只把照度改回 `uSunIlluminance`」**（`scripts/lint-shaders.mjs:980`，拦截测试见 §2）。一行级修法：在 `AP_BAD` 里加 `/\bapL\s*\*=\s*uSunIlluminance\b/, /\bI\s*\*\s*uSunIlluminance\b/`。更稳妥的做法是按程序检查：凡是采样了 `uAerialInscatter(S)` 的程序，`main` 可达的代码里必须出现 `uApIlluminance`。这类回退在满月夜会把空气光放大约 4×10⁵ 倍，一眼就能看出，所以不阻塞合并。
2. 过时注释：`render/wonder-sky.glsl.ts:534`（「空气透视 LUT 只有太阳一路」）、`wonders/pillars.glsl.ts:257`、`wonders/ring.glsl.ts:355`（「月光那一路的内散射没有 LUT」）。现在 LUT 已经含月光，`max(apL, 几何近似)` 里的近似项只在它更大时起作用，建议把注释改成这层含义。以后可以评估这项近似还有没有必要保留（属于③类打磨）。
3. 暮光切换的验收口径：交付报告里「切换帧 0.03 级 / 镜像误差 0.08–0.12 级」是在曝光还没跟上、屏幕近乎全黑的截图上量的，基本量不出东西。以后涉及暮光的任务，请改用 HDR 读回（本审查的 `switch-hdr` 脚本）。按 HDR 量，局部远云有约 0.5% 的像素跳 25% 以上。另外，上弦月、太阳 −14° 时整窗接近全黑，这是改动前就有的曝光问题（old 同样如此），与本任务无关，可以请美术总监看一眼是否合理。
4. 月亮在前方时，435 km 远塔几乎完全融进地平线，连淡淡的暗影都不剩。在目标区间内，记下来供美术总监参考。

## 复现

- 拦截测试：`bash handoff/NIGHT-AP-1-review-lint-mut.sh <可随意改动的 voyage 目录>`（会逐处 `sed` 修改再 `git checkout` 恢复，**不要指向实现者的 worktree**）。
- 切换点 HDR：`node handoff/NIGHT-AP-1-review-switch-hdr.mjs --port <端口> --heading 57 [--date 2026-07-21 --sun -14.2]`，再运行 `python handoff/NIGHT-AP-1-review-hdrdiff.py <输出目录>`。
- 月夜三场景：`node handoff/NIGHT-AP-1-run.mjs --port <端口> --scene behind|front|nomoon`（同页 A/B）；跨页对照 master 时，把脚本里 `uApIlluminance` 的读取改成可选即可。
