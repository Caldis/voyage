# PERF-12 · 舱内合成开销 — 独立审查（兼美术视角）

审查对象：分支 `worktree-agent-a50456d82ceaae9c5`（8b5eee1），`git diff master...分支`。
对照：临时工作区 `tmp/perf12rev`（master 3eae3c2 `merge --no-ff --no-commit` 本分支，自动合并只有 README 一处），审完已删（先拆 node_modules 联接）。
合并基 7a3273e 之后 master 改过 `exposure.ts`（C02 的 `uWhiteout` / `uDayEvAnchor`，经 `EXPOSURE_MODEL` 拼进舱内程序），所以我的 A/B 直接拿**当前 master（5181）**的舱内原文当 B，把合并也一起验了。

## 结论：**通过**

没有阻塞问题。下面几条是非阻塞的小问题，合并时顺手改掉即可，也可以留给下一个碰 scene.ts 的任务。

## 1. 「先算权重再着色」的跳过逻辑（scene.ts）

逐项推了一遍，跳过的都是**严格为 0 的权重**，不是「接近 0」：

| 跳过 | 判据 | 为什么是真 0 |
| --- | --- | --- |
| 侧壁 `shadeWall` | `hidden`（`seat.cov >= 1`）或 `paneOnly`（本窗、`inBezel >= 1 && inPane >= 1`） | `cov = 1 − smoothstep(...)` ≤ 1，`>= 1` 时 `(1 − cov)` 恒为 0；`smoothstep` 在边外返回的就是 0，所以 `inBezel`、`inPane` 在内部就是精确的 1.0，`(1 − inBezel)` 与 `(1 − inPane)·reveal` 都是 0。`reveal = wall` 这个兜底只在 `(1 − inPane)` 的位置用到，所以同样是 0。`rd.z < 1e-4` 的早退路径下，`hidden` 时 `mix(0, seat, 1) = seat` |
| 内衬 `marchFunnel` | `hidden` 或（`paneOnly && shadeFree`） | `shadeFree` ⇔ `pShade.y − shadeBottom ≤ −wS` ⇔ `smoothstep(−wS, wS, ·) = 0`，这时 `shaded` 与 `hitZ` 无关；T47 开口边那一圈（`dPane > −wP`）上 `inPane < 1`，`paneOnly` 为假，会照常进 `needReveal` |
| 遮光板 `shadeShade` | `shaded > 0 && !hidden` 才算 | `mix(a, shade, 0) = a` |
| 窗板分支 | 加了 `!hidden` | 这时 `kView = 0`、`outsideMask = 0`，T47 重映射不触发；`viewPre = 0`、`paneK = 1` 时 `packWingRef` 的 A = col，与原来一样 |

- **抗锯齿的交界像素**：窗板开口边（`0 < inPane < 1`）、座椅轮廓（`0 < cov < 1`）、遮光板下沿（`0 < shaded < 1`）都不满足任何一个跳过条件，仍按覆盖率混合。
- **`colFixed + kView·view` 的展开**：代数上和原来 `mix(wall, mix(mix(reveal, view, inPane), shade, shaded), inBezel)` 再混座椅逐项相同。T47 的 `col − outsideMask·view` 仍然成立：本窗时 `kView == outsideMask`；邻窗时 `outsideMask = 0`，不走重映射。
- **`packWingRef`** 的公式和位布局都没动。
- 视角、舱等、灯光档、云中、夜景：判据里只有几何量和 `seat.cov`，跟灯光与窗外无关，所以不存在「某个场景近 0 被跳过」的路径。火车模式用的是同一个舱内程序。实测见第 4 节。

## 2. 倒影与点星的早退

- **座位列由近到远**：`acc += T·A, T *= T_k` 与原来由远到近的 `col' = T·col + A` 逐项等价（我逐个核对了 `cBack` 的 clamp 和 `scrL` 叠加的位置）。
  「视线高过列最高处」这个上界是保守的：椅背顶 ≤ `SEAT_Y + 0.03 + wk`；头顶的中心最高 `SEAT_Y + 0.043`，y 半轴 `0.115 + 1.353·wc` → `SEAT_Y + 0.158 + 1.353·wc`（wc ≤ wk），门限是 `SEAT_Y + 0.17 + 2·wk`，≥ 两者。屏光高斯在门限处 ≥ 5.7σ，量级 `0.03·e^−32`。
  `trans < 1e-4` 时整层背景不算：丢掉的量 ≤ 1e-4 × 背景。最亮的背景是白天对面的舷窗，约为椅背亮度的 120 倍，折合 ≤ 该像素倒影的 1%；而且多数像素上近列 `cBack` 的 smoothstep 饱和到 1，`trans` 是精确的 0。**没有漏画**。
- **朝下射线不算光点**：窗板上的点 y ≤ 0.175（`PANE_HALF`）+ 抗锯齿带，灯在 y ≥ 0.6，所以距离 ≥ 0.42 m。重影 `RF_GHOST_DY = −0.011` 往下偏，邻座那盏的 `cone` 在 `r.y ≤ 0` 时为 0。s 按最坏情况取几厘米（低分辨率时 `pixAng·dist` 可能超过 1.2 cm），`exp(−(0.4/0.05)²) ≈ 1e-28`，照样下溢。**保守**。
- **点星门限**：阈值折合窗外亮度 ≈ 6e-7 / pixAng²。1600×1200 下约 **1000 cd/m²**，800 行的窗口约 440 cd/m²，只有白天的天空 / 云和日落时最亮的那一侧够得着。深暮光（1–10 cd/m²）、满月夜空、城市光污染都比它低两到三个数量级，门限不会触发。仓库的星表里没有行星（grep 过 Venus / 金星 / planet），所以按天狼星估的上界成立。实测 rv-deep-dusk（太阳 −9.3°）、rv-fullmoon 都是 A−B 平均差 0。

## 3. 循环化 / uLoopGuard / 调用点合并

逐条核对了语义：
- `scratches`：3×3×2 压成 18 次，格号递推在两个 `continue` 之前，遍历顺序和原来一样（x 外层、y 内层、k 最内）；「到中点距离 − 半长 > 覆盖宽度」可由三角不等式推出 `cov` 精确为 0。
- `waterOnPane`：水线 `dki − 2` 与水珠两层（阈值、哈希偏移、边距逐字相同，层序也不变）。
- `sdSeats` / `shadeSeat` 选最近部件：并列时取编号小的，和原来「`dB1 < dB0` 才算前排、壳体要严格更近」一致；我手推了四种大小关系。
- `seatNormal` 的四个 k 向量、`seatSeams` 的四道缝（across / along / single / 权重 / dn 方向）、`keySpec` 三路（`cabinMoodSpec` 展开，`ao` / `sqrt(ao)` / `sunVis` 移进 E，因为 keySpec 对 E 是线性的）：都等价，只有浮点求和顺序变了。
- 机翼程序拼 CABIN_COMMON / PANE_COMMON：`check:glsl` 全部通过（包括 wing 与 scene-economy）。离线编译沿用实现者的账本（wing +0.3%，在噪声内）。本机 CPU 占用 81–88%，我没有重测 FXC。

## 4. 零回归证据

**PERF-12-ab.mjs 可不可信**：可信。有三点支撑：
- 同页冻结，A2 作噪声底；
- B 的最大差不为 0（1–4.7），说明材质确实换了（假如没换成功，A−B 会恒为 0，那才是假阳性），A−A2 又是 0；
- 经济舱靠材质 `defines` 选变体，所以用商务舱的原文换经济舱的材质也成立。

**盲区**：
- `scenarios.mjs` 在每个场景把 `wetness` 清成 0，实现者的 13 个场景**都没有覆盖水珠 / 水线这次的循环化**；
- 机翼程序不在交换范围里。

**我补跑的 8 个场景**（merged 5186 对 master 5181，1600×1200，d3d11，`tmp/screenshot/PERF-12rev/ab/`，场景表 `tmp/perf12rev-scenes.json`、`tmp/perf12rev-rain.json`）：

| 场景 | 内容 | A−B 平均 / p99 / 最大 | 噪声底 A−A2 |
| --- | --- | --- | --- |
| rv-in-cloud | 云中 | 0 / 0 / 1.67 | 0 |
| rv-fullmoon | 满月、全关 | 0 / 0 / 1.67 | 0 |
| rv-deep-dusk | 太阳 −9.3°、睡眠档 | 0 / 0 / 1.33 | 0 |
| rv-lean-night-on | 贴窗（z = −0.12）、夜里开灯、城市 | 0.04 / 0.67 / 1.67 | 0 |
| rv-lean-high-sleep | 贴窗、低头位（视线朝上看倒影天花板）、睡眠档 | 0 / 0 / 1.33 | 0 |
| rv-econ-sleep-side | 经济舱、侧移 0.25 m、睡眠档 | 0 / 0 / 2 | 0 |
| rv-rain-night-on | 窗上有水（wetness 0.9）、夜里开灯 | 0 / 0 / 4.33 | 最大 214.67（城市灯光没冻住，零星点） |
| rv-rain-noon | 窗上有水、正午（截图里水珠清楚） | 0.01 / 0.33 / 1.67 | 最大 1 |

rv-lean-night-on 的热图是分布均匀的 ≤ 1.67 浮点舍入，没有成形的边或线。

**GPU**（`passes.mjs --baseline 5181`，60 帧 × 3 轮，CPU 81–88%）：舱内合成 noon-cumulus 0.391 → **0.291 ms**，night-city-on 0.397 → **0.291 ms**，与交接一致；其余 pass 都在噪声内。
typecheck、check:glsl、build 都通过（dist/assets 没有 0 字节文件）；`dev-browser check` 没有 console error。

## 5. 美术视角

逐像素零变化，画面无可评判的差异，四条铁律都不受影响，**不否决**。

实现者对「白天关掉倒影」保持克制（正午关掉后对面舷窗两团淡影少了 2–4/255，是一点「玻璃感」），我认同：3A 观感不应为 0.1 ms 牺牲这层细节。

## 非阻塞问题（建议顺手改）

1. **注释与 README 说「调试 1–4 仍全算」，并不完全对**：侧壁在 `hidden || paneOnly` 时即便开着调试也不算（只有内衬受 `dbgLayers` 保护）。调试 3 / 4 在座椅完全挡住、步进又没打到内衬的像素上，`reveal` 的兜底从侧壁色变成了黑。只影响调试视图。改法：把侧壁的条件改成 `dbgLayers || !(hidden || paneOnly)`，或者改注释。
2. **点星门限注释里的「最多 0.5%」没算两项放大**：
   - 离轴的 `cos³θ`（画面角上约 ×2.2）；
   - 小窗口 / 大视场下 `STAR_PSF_SIGMA` 被夹小，单像素份额可以从 0.35 升到约 0.6–0.7。

   最坏的情况是在门限处多出约 2%。那时背景已经 ≥ 440 cd/m²（白天），肉眼本来就看不见星，结论不变，只是注释写得偏乐观。建议改成「≤ 0.5%（画面中心、σ = 0.6 时；角落和小窗口最多约 2%）」。
3. **PERF-12-ab.mjs 的场景都是干窗**：以后用它验证窗板相关的改动，记得像本审查这样用 `--js-a "v.state.wetness=0.9"` 补上湿窗场景。可以在脚本头部的用法里加一句。

## 开发体验反馈

- **哪里慢**：两轮 A/B（8 个场景）约 15 分钟，大头是城市场景等瓦片，以及每次换材质后的编译。`passes.mjs` 两个场景约 5 分钟。读 diff、推导等价性约 40 分钟，是真正花时间的地方。
- **哪里卡**：
  1. `scenarios.mjs` 的 `applyScene` 固定把 `wetness` 清零，场景表里没法声明「湿窗」，只能靠 `--js-a` 绕（它在 applyScene 之后、冻结之前执行，正好可用）。希望场景表支持 `"wetness": 0.9` 这样的字段。
  2. 测量锁按 worktree 分，实现者已经写进 README。审查时我手工 `ls` 了主仓库和各 worktree 的 `tmp/measure.lock`，都没有锁。
  3. `PERF-12-abdiff.sh` 里的 `../../$dir` 假定输出目录相对仓库根，传绝对路径会失效，我是手写循环调 `compare.mjs` 求差的。
- **希望有**：`PERF-12-ab.mjs` 值得升格成 `scripts/` 下的通用工具（「同页冻结换着色器原文」对所有零回归类的性能任务都适用），同时让它自带求差和汇总表。
