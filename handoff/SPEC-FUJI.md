# SPEC-FUJI · 富士山笠云 / 吊し雲（交接）

分支：`worktree-agent-af1d19f0181ccd835`（基于 master `239e5d3`）。状态：完成，待审查。

## 做了什么

| 文件 | 内容 |
| --- | --- |
| `src/clouds/lenticular.glsl.ts`（新） | 解析透镜盘 SDF：笠云（笠形主盘 + 0–2 片叠盘）、下风 2–5 个吊し雲（椭圆型为主，约三成是 2–3 片「一摞盘子」）；轮廓 2、3 阶随机起伏；边缘半透明、背风边变淡；表面细纹按气流位移流过（云不动）；`lensRayInterval` 包围盒求交；`cloudDensityLens` / `layerDensityLens` 包装 |
| `src/clouds/clouds.ts` | `MARCH_FEATURES` 加 `L`（`CLOUD_LENTICULAR`，权重 3）；`wantedKey` 在 `uLens.w > 0.5` 且无奇观层时加 `L`；步进里全部改动都在 `#ifdef CLOUD_LENTICULAR`：宏替换主采样 / 展开受光步进的密度、晴空不早退、区间合并与空隙跳过、透镜云按自身盘高算环境光；uniform `uLens / uLensWind / uLensCap / uLensChain` |
| `src/weather.ts` | `FUJI_SUMMIT`（国土地理院：35°21′38″N 138°43′39″E，3775.6 m）；`Lenticular` 状态、`setLenticular` / `syncLens`、平移、气流位移；`WeatherField.orographic(t)` 出现条件；`lenticularFrom` / `lenticularDemo`；面板天气预设「富士山笠云 + 吊し雲（演示）」 |
| `src/weather-director.ts` | `planLenticular`（300 km 内按天气场定目标）、`stepLens`（生消：15 模拟分钟长出、20 分钟缩回，一次过程内风向 / 形态固定）；`?fujiCap=1` 演示；构造时给 `WeatherSystem` 挂 `toLocal` |
| `scripts/lint-shaders.mjs` | 登记 `cloud-march-lenticular` 与组合 `CL/LS/LT/CLS/CLT/LST`；新断言「默认云程序不含笠云 / 吊し雲代码、变体里全有」 |
| `README.md` | 云坑点一条（宏替换、区间合并、冻结 A/B 对云瞎） |

**不需要协调者接入热点文件**：没改 main.ts / scene.ts / outside-pass.ts；也没改 PERF-STORM 在动的天气外壳与乳状云。

## 演示入口

- URL `?fujiCap=1`：页面打开后自动切到「骏河湾上空」预设 + 面板天气「富士山笠云（演示）」，连续航程开着时导演也一直保持（`handoff/SPEC-FUJI-demo-check.mjs` 验证：preset=fuji、weather=fuji-cap、画的是 L 变体、0 pageerror）。
- 面板「天气」下拉：「富士山笠云 + 吊し雲（演示，需在富士山附近）」（西南西 20 m/s、二重笠 + 4 个吊し雲）。
- 场景：`handoff/SPEC-FUJI-scenes.json`（`shots --scenes-file apps/voyage/handoff/SPEC-FUJI-scenes.json`）。建议协调者把 `fuji-cap-low` / `fuji-cap-cruise` / `fuji-cap-dusk` 收进 `scenarios.mjs` + `regression.playwright.js`（两表要一起改，我没动）。

## 出现条件与出处（天气侧）

`WeatherField.orographic(t)`（富士山顶，每 300 模拟秒随天气场取样）：条件分 = 风速 × 风向 × 湿 × 稳定 × 早晨，再与 3 小时尺度的抽签比较。

| 因子 | 取值 | 出处 |
| --- | --- | --- |
| 山顶风速（WX11a `windAt(3.83 km)`） | 8 → 16 m/s 软门槛 | W15「≥ 约 15 m/s」（METEOROLOGY.md）；FAA AC 00-6B 山地波一章；门槛宽度 [估算] |
| 风向 | 西南西 247.5° 最多，其他方向 ×0.3 下限 | Kusaka et al. 2025, *Weather*, doi:10.1002/wea.7774（笠云 / 吊し雲多在西南西风、大致垂直于富士山长轴时出现）；下限 [估算] |
| 湿 | 夏季指数 + 大尺度云量 + 锋面 | Kusaka 2025（夏季最多）；「笠雲がかかると雨」：河口湖测候所 1933–52 年，出现后 24 h 内下雨笠云 72%、吊し雲 82%（富士山NET〈富士山と気象〉山頂にかかる雲）；系数 [估算] |
| 稳定 | 对流潜势 0.45 → 0.85 时压到 0 | 山地波需要稳定层结（Durran 2003；FAA AC 00-6B）[教科书] |
| 早晨 | 当地 7 时峰值 ±40% | Kusaka 2025（多在早晨）；幅度 [估算] |
| 吊し雲另乘 | 3.8→6 km 风速差 6 → 16 m/s 渐减 | Kusaka 2025（吊し雲伴随竖直风切变小、湿层略高） |
| 波长 | λ = 2πU/N，N = 0.011 s⁻¹，夹 5–25 km | Durran 2003 [教科书]；W15 5–25 km |
| 频度标定 | 笠云约 10%、吊し雲约 3% 的时刻 | 河口湖测候所 20 年：笠云月平均 6.1 回、吊し雲 2.0 回（每天两次观测≈60 次/月） |

**与简报「冬春多」的出入（如实报告）**：查到的观测是 Kusaka 2025（2019–2021 年 7 台实况摄像机）「笠云与吊し雲夏季最多、早晨多」，没有找到支持「冬春多」的逐月统计（河口湖测候所只查到月平均）。按「数据要真实」取观测：模型结果是暖季（5–6、9–10 月）最多、冬季最少——冬季山顶风够强但太平洋一侧冬季风干燥。7–8 月模型偏少（WX11a 风场夏季山顶风弱，风速 ≥ 15 m/s 只占 2–15%），这是风场的限制，没为此硬调。若要改成冬春多，改 `moist` 里 `summer` 的系数即可，一行。

统计（`handoff/SPEC-FUJI-stats.mts`，3 年逐时 × 3 种子）：笠云 10.6 / 12.3 / 11.9%，吊し雲 3.5 / 4.2 / 3.9%，过程约 25–27 次/月、平均 3.1–3.3 h；按月笠云 1 月 4–8% → 5–6 月 16–21% → 9–10 月 15–19% → 12 月约 7%；当地 6–9 时约 20%、16–20 时约 5%；出现时风向 86–88% 在西（W 扇区）。逐月全表见 `tmp/screenshot/SPEC-FUJI/stats.txt`。`weather-stats --multi` 的门禁未受影响（`sample()` 等原有函数一行未改，只新增函数）。
实机：`handoff/SPEC-FUJI-find.mts 2026 5` 列出天气场有笠云的时刻；`fuji-director` 场景（2026-05-01 14:30、连续航程）导演日志「富士山笠云开始形成（山顶风 242° 14 m/s）」，画 L 变体，截图 `tmp/screenshot/SPEC-FUJI/dir/fuji-director.png`（与晴天积云共存）。

## 截图（worktree 的 `tmp/screenshot/SPEC-FUJI/`）

| 场景 | 文件 | 看到什么 | 真实照片对照（描述） |
| --- | --- | --- | --- |
| 巡航 10 km 远看 | `v5/fuji-cap-cruise.png` | 富士山顶一顶二重笠，右侧下风方一串 3–4 个椭圆吊し雲，越远越小 | 从羽田—伊丹航班右窗拍到的「笠雲 + 吊るし雲」照片：山顶白色笠状盖、东北方远处几片飞碟状云，轮廓干净、表面光滑 |
| 低空侧看 | `v5/fuji-cap-low.png` | 笠扣在山顶、帽檐比山顶低，上面隔缝一片薄盘 | 河口湖 / 山中湖方向拍的「二重笠」：主笠贴着山顶，上面隔一道暗缝再有一层薄盘 |
| 黄昏 | `v5/fuji-cap-dusk.png` | 笠云与吊し雲顶面染成淡粉橙，一摞盘子的吊し雲层次清楚 | 夕照下的吊るし雲照片：顶面粉橙、底面偏灰紫 |
| 与层积云共存 | `v5/fuji-cap-sc.png` | 下面一层层积云，山顶与笠云从云海上冒出 | — |
| 与雷暴共存（LS） | `v5/fuji-cap-storm.png` | 雷暴塔与透镜云正确前后遮挡 | （测试用，气象上两者很少同时出现：稳定度因子会压掉） |

并排：`v5/montage.png`；早期版本 `v1`–`v4`（v1 平盘塑料感 → v3 笠形 → v5 缩小笠云、压平叠盘）。

## 数字

- **默认程序逐位 0**：`node handoff/SPEC-FUJI-parity.mjs <合并基点的 apps/voyage>` → 43 个程序预处理后逐字相同（含 cloud-march、storm、typhoon、severe、cirrus、wonder、shadow、probe、outside、wing…）。所以「改云必测雷暴 + 浓云海」这一条：storm-sc / sea-sc 用的程序文本与改前逐字相同，画面必然逐位不变；LS / LT 组合编译通过，`fuji-cap-storm` 实拍 LS 正常。
- **check:glsl**：全部通过（含新断言：cloud-march / cirrus / wonder / storm / shadow / probe / outside-default / wing 不含 `lensDensity` 等 6 个标识符，lenticular 变体全含）。typecheck、build 通过，`dist/assets` 0 字节文件 0 个；页面（含 `?fujiCap=1&voyage=1`）控制台 0 error。
- **冷编译**：L 变体只在需要时后台编（`pickMarch` → `requestMarch`），不在启动批次。离线 FXC（3 轮 min/med）：cloud-march 0.51/0.54 s，cloud-march-lenticular 1.76/1.83 s，cloud-march-storm 4.35/4.70 s（负载下测，只作参考）。
- **GPU**（`gpu-ab --time clouds` 8 轮 ABBA，带 A/A；RTX 5090、1600×1200；机器被其他代理占着，CPU 27–66%）：

| 场景 | 有透镜云 | 撤掉透镜云（默认程序） | 增量 | A/A |
| --- | --- | --- | --- | --- |
| fuji-cap-low（笠云占画面大） | 0.298 ms | 0.065 ms | +0.23 ms | ×1.002 |
| fuji-cap-cruise | 0.195 ms | 0.065 ms | +0.13 ms | ×1.002 |
| fuji-cap-sc（下面有层积云） | 0.516 ms | 0.393 ms | +0.12 ms | ×1.003 |

  增量来自：视线进包围盒后的步进（晴空时原来根本不步进）+ 展开受光循环里多一次解析密度。只在富士山 300 km 内、条件满足（约 10% 的时间）时付。建议上限 0.3 ms @5090 这档；超了先报。
- **飞行中不闪**（`ab` 的 `live`，360 帧、飞机照常飞，阈值 16 级）：fuji-cap-low 笠云区闪烁像素 1 / 1（cur / cur2 同代码噪声底），每帧超阈值 4.1 / 2.3（撤掉透镜云的对照 2.2）；fuji-cap-cruise 笠云 / 吊し雲 1 / 吊し雲 2 闪烁像素全部 0。`handoff/SPEC-FUJI-ab-jobs.json`。

## 踩到的坑

- 透镜云高度并进外壳让主循环走过去会用完 384 步 → 单独求区间 + 空隙跳过（README 已记）。
- 冻结 A/B 截图对云是瞎的：`nolens`（撤掉透镜云）的冻结截图与 `cur` 逐位相同，不是没生效；`gpu-ab` 的 js 变体要在每个变体里自己把状态设回来。
- 笠云第一版是平盘：侧看像飞碟而不是笠；把中面往外往下弯（sag 0.45–0.7 km）才读成「扣在山顶的斗笠」；叠盘弯得太狠侧看成一只翘起的角，叠盘只弯主盘的 35%。
- scenes 文件路径相对仓库根（`apps/voyage/handoff/…`），`--only` 与 `--scenes-file` 一起用时 `--only` 过滤掉了文件里的场景（退出码 1、无输出）。

## 没做 / 遗留

- 透镜云不进云影图 / 探针：地面上没有笠云的影子；飞机穿过吊し雲时探针不知道（不会白屏）。要做就给云影图加一个 L 变体（小程序）。
- 受光步进 2.8 km 以外、雷暴 8 步那支受光（LS 变体里雷暴附近）不含透镜云自遮挡。
- 近看笠云顶面有静帧细颗粒（1 spp 受光噪声，与普通云同级，③类）。
- 频度月分布与简报「冬春多」不同，见上文；7–8 月偏少受 WX11a 夏季风场所限。
- 只做了富士山；日本阿尔卑斯、台湾中央山脉的背风波没做（W15 提到）。

## 怎么复现

```bash
cd apps/voyage
npx vite --port 5273 --strictPort --host 127.0.0.1
node scripts/dev-browser.mjs shots --port 5273 --scenes-file apps/voyage/handoff/SPEC-FUJI-scenes.json --out tmp/screenshot/SPEC-FUJI/x
node scripts/dev-browser.mjs ab --port 5273 --jobs apps/voyage/handoff/SPEC-FUJI-ab-jobs.json
node scripts/dev-browser.mjs gpu-ab --port 5273 --jobs apps/voyage/handoff/SPEC-FUJI-gpu-jobs.json --time clouds --rounds 8
node --experimental-transform-types --no-warnings handoff/SPEC-FUJI-stats.mts 3 "20260927,1,777"
node handoff/SPEC-FUJI-demo-check.mjs 5273
git worktree add --detach ../../tmp/SPEC-FUJI-base 239e5d3 && node handoff/SPEC-FUJI-parity.mjs ../../tmp/SPEC-FUJI-base/apps/voyage
```
