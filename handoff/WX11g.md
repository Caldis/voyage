# WX11g · 海面风速按天气场（交接）

分支：本 worktree（基于 master `ecb57ea`）。状态：完成，待审查。设计：`research/WX11-DESIGN.md` 的 WX11g 一节与坑 C。

## 复现立足点

```bash
cd apps/voyage
npx vite --port 5245 --strictPort          # 对照：master worktree 起 5305
# 1) 若干风速档同页 A/B（4 场景 × 8 变体，含 master 着色器 7 m/s 的零回归变体）
node scripts/dev-browser.mjs ab --port 5245 --base 5305 --jobs apps/voyage/handoff/WX11g-ab-jobs.json --variants apps/voyage/handoff/WX11g-ab-variants.json --out tmp/screenshot/WX11g/ab1
# 2) 换档瞬间逐帧（解冻、页内每个 rAF 读画布）：恒定 7 / 6→8 连续扫过 7 m/s 档 / 7→10 阶跃（正对照）
node scripts/dev-browser.mjs ab --port 5245 --rounds 1 --jobs apps/voyage/handoff/WX11g-live-jobs.json --out tmp/screenshot/WX11g/live
python apps/voyage/handoff/WX11g-live.py tmp/screenshot/WX11g/live/low-sea-glint-live
# 3) 主线程长帧：1× 巡航 + 强制跳档 / 连续扫风速，改后对改前
node apps/voyage/handoff/WX11g-hitch.mjs --port 5245 --port2 5305
# 4) GPU：sunset-wing 整帧，master 着色器 / 当前 7 m/s / A/A / 两档混合中（8.5 m/s）
node scripts/dev-browser.mjs gpu-ab --port 5245 --base 5305 --time frame --rounds 8 --jobs apps/voyage/handoff/WX11g-gpu-jobs.json
# 5) 连续航程：各地各月 jump 后的海面风，东海 1 月 60× 一模拟小时
node apps/voyage/handoff/WX11g-voyage.mjs --port 5245
```

## 做了什么

| 文件 | 内容 |
| --- | --- |
| `src/ocean/waves.ts` | 频谱只在 9 个风速档 `WIND_LEVELS = [0, 1.5, 3, 5, 7, 10, 13.5, 17.5, 22]` 上算；两个 h0 槽位（下档 / 上档），风速在两档之间时按比例混合（`uMix`），风速可以每帧连续变、零 CPU；缺档交给 Worker，这一帧保持原海况（`stats.holds`）；每次预取当前一对 + 两侧各一档，缓存留 4–5 档（每档 3 MB）。混合后的斜率 / 波高方差按「标准差线性混合」，白浪阈值按实际风速的 Monahan 覆盖率连续算。阵风斑漂移改为 CPU 逐段积分（`updateDrift` → `uOceanFoam.z`）。`stats` 扩充（见 README 坑点） |
| `src/ocean/spectrum.worker.ts`（新） | 后台算 `buildSpectrum`，转移数组回主线程；出错时主线程停用 Worker、改同步算 |
| `src/ocean/fft.glsl.ts` | 相位推进 pass 加 `uH0b` / `uMix`：`if (uMix > 0.0) h0 = mix(h0, texelFetch(uH0b, …), uMix)`（`uMix = 0` 时逐位等于改前） |
| `src/render/ocean.glsl.ts` | `gustFactor` 的漂移从 `uWind * uTime * 1e-3` 改读 `uOceanFoam.z`（一行，设计表里列为可选归属；原因见「踩到的坑」） |
| `src/weather-director.ts` | 每次取样（300 模拟秒）算海面 10 m 风 `seaSurfaceWind`（海面 Charnock 粗糙度从 850 hPa 推，陆地上空不用 `sfc` 的陆地值），以 ≤ 4 m/s / 模拟小时（`approach` 缓入）逼近、写 `state.wind`；换预设（jump）直接对齐；用户拖滑条后从新值接着走；`describe()` 多一段「海面风 x m/s」 |
| `README.md` | 海 / 地面坑点三条：频谱不能在主线程随风速重算、着色器里不能写「速度 × 时间」当漂移、海面风由导演写 |

**没有改** `main.ts`（`state.wind` 本来就每帧传给 `ocean.update` 和 `uWind`，只改了写入方）、clouds、wing、exposure、ground、`weather.ts`。

## 档位与海况的依据

- 档位：大致一档一个蒲福风级（WMO 蒲福风级表的风速区间与海况描述）：0 无风（只剩涌浪，镜面）、1.5 软风上沿（鱼鳞状涟漪）、3 轻风（小波，波峰光滑不破碎）、5 微风（波峰开始破碎、零星白浪）、7 和风（白浪较多）、10 劲风（中浪，白浪很多）、13.5 强风（大浪，白沫成片）、17.5 疾风（浪堆起，白沫顺风成条）、22 大风。**7 必须是一档**：面板默认值，默认场景频谱逐位不变。
- 海况公式（本任务没有新加，改前已有、现在随风速连续变）：白浪覆盖率 Monahan & O'Muircheartaigh 1980（W = 3.84e-6·U^3.41，上限 10%）；总斜率方差 / 耀斑宽度 Cox & Munk 1954（σ² = 0.003 + 0.00512·U，着色器里按 `uWind` 逐像素算）；风浪谱 JONSWAP（Hasselmann 1973，风区 100 km），方向扩展 Mitsuyasu 1975 / Hasselmann 1980。实测（`ocean.stats`）：Hs 0 m/s 1.30 m（只剩涌浪）→ 7 m/s 1.78 → 10 m/s 2.37 → 13.5 m/s 3.06 → 22 m/s 4.48 m；白浪 5.2 m/s 0.11%、10.8 m/s 1.28%、15.2 m/s 4.13%、17.4 m/s 6.50%。
- 导演的变化率 4 m/s / 模拟小时：短波与白浪几分钟到半小时跟上风、风浪波高要几小时 [教科书量级]，取折中 [估算]。

## 频谱重算的 CPU 开销（坑 C）

- `buildSpectrum` 实测 **每次 20–40 ms**（Node 同进程 6 次中位 37.8 ms；页面 Worker 里 22 ms；启动时同步 70 ms，与冷启动其余工作并行抢 CPU），比旧注释的「十几毫秒」重，远超 5 ms 门槛 → 放进 Worker。
- 主线程剩下的：上传一档 h0（768×256 RGBA32F，3 MB，`initTexture` 立即上传）**0.2 ms**；混合比变化时的 uniform 计算（反查正态尾概率 60 次二分）微秒级。

## 验收结果

**1. 若干风速档同页 `ab`**（`tmp/screenshot/WX11g/ab1/`，冻结、每变体两轮，噪声底全 0；拼图 `ab1/<场景>-montage.png`）

| 场景 | 0 → 7 → 20 m/s 的变化 | master 着色器 7 m/s 对当前 7 m/s |
| --- | --- | --- |
| low-sea-glint | 相邻差 1.28 → 2.85 → 3.31，亮度 114.9 → 123.6 → 126.3：无风时耀斑是一条窄而亮的镜面光柱，风越大越宽、越碎、越铺开 | 0 / 0（**但这个场景 0.6 km 画的是低空细节变体，换 outsideMat 原文碰不到它，这一行不算证据**） |
| night-sea-milkyway | 月光耀斑同样由窄变宽（差异小：夜里整体暗） | 第一次 0.063 / 5.3、第二次 0 / 0 |
| sunset-wing（海面） | 平均差对 7 m/s：0 m/s 1.47、20 m/s 0.61 | 第一次 0.139 / 33 / 7710 像素、第二次 0 / 0 |
| route-hnd-cts | 海面在画面里很小，20 m/s 平均差 0.21 | 0 / 0 |

master 对照第一次的非零差：阵风斑漂移现在是 CPU 双精度算好再转 float32，改前是着色器里 float32 连乘，差 1 ulp，冻结时刻不同时会让耀斑闪烁格子边上的像素翻转（README「拆程序后海面闪光成片单像素翻转是正常的」）；把当前着色器补回 `uWind * uTime` 的变体 `oldGust` 与 master、当前三者逐位相同（`WX11g-gust-*.json`，第二次运行）。

**2. 换档瞬间无跳变**（`live`，解冻、页内每 rAF 读 600×450 裁剪区，8×8 块平均压掉耀斑 8 Hz 闪烁后看相邻帧块差）

| 变体 | 块差中位 | 跨 7 m/s 档的那一帧 | 最大 |
| --- | ---: | ---: | ---: |
| 恒定 7 m/s | 0.517 | — | 0.637 |
| 6 → 8 m/s 连续扫（0.8 m/s / 真实秒，导演在 60× 下的约 12 倍） | 0.468 | **0.466**（前后帧 0.44–0.50） | 0.530 |
| 7 → 10 阶跃（正对照） | 0.495 | 6.550 | 6.550 |

**3. 主线程无 > 16.7 ms 帧因频谱重算**（`WX11g-hitch.mjs`，low-sea-glint，1× 巡航；跳档 = 0→22→0 每 1.5 s 换一档，缓存从冷开始；连续扫 = 1 m/s / 秒 0→20→0）

| | 跳档：帧 > 16.7 ms / ocean.update 最大 | 连续扫：帧 > 16.7 ms / ocean.update 最大 |
| --- | --- | --- |
| 改后 | **0** / 0.7 ms（3307 帧，longtask 0） | **0** / 0.5 ms（5181 帧） |
| 改前（master） | 16 / 49.7 ms（longtask 1） | 998 / 58.6 ms（几乎每帧重算，帧间隔中位 39 ms） |

改后整轮频谱计算 27 档、等频谱 10 帧（跳档时新档在 Worker 里算好之前停在旧海况上，约 20–40 ms）。

**4. `gpu-ab` 海面 pass 不升**（sunset-wing，`--time frame`，8 轮 ABBA）：master 着色器 2.285 ms；当前 7 m/s ×0.993 [0.984, 1.006]；A/A ×0.993；两档混合中 8.5 m/s（相位推进多一次 texelFetch）×0.997 [0.989, 1.009]，全部在离散度内。

**5. 连续航程**（`WX11g-voyage.mjs`，jump 后）：东海 1 月 10.8 m/s（白浪 1.28%）、西太 1 月 15.2（4.13%）、西太 7 月 0.9（0%）、南海 5 月 5.2（0.11%）、骏河湾 1 月 17.4（6.50%）。东海 1 月 60× 一模拟小时：风速 10.49 → 14.17（目标 18.32，限速在走），跨档 1 次、频谱计算 1 档、等频谱 0 帧，ocean.update 最大 1.1 ms；7757 帧里 3 帧 > 16.7 ms（最大 39.7 ms，ocean.update 没有超过 1.1 ms 的，是别处——60× 下地面 / 云，没有深查）。天气场本身的分布（Node，一个月每 3 小时）：日本海 1 月中位 11.8、p90 15.6；南海 5 月中位 4.0；西太 7 月中位 6.1 m/s。设计验收「日本海 1 月寒潮航段 ≥ 10 m/s」：中位 11.8，满足。

另外：typecheck、build（`dist/assets` 无 0 字节文件，`spectrum.worker-*.js` 已单独打包）、`check:glsl` 全部通过；`dev-browser check` 与以上所有运行 console error 0 条。

## 海浪方向常量（按设计只评估，未改）

- 现状：`spectrum.ts` 的 `WIND_DIR = 0.6`（CPU 频谱的风浪主方向，两道涌浪方向也按它加偏移），`ocean.glsl.ts` 的 `WIND_DIR = 0.6`（阵风斑、风痕的拉长方向）。
- 第一步（CPU 频谱的方向）现在很便宜：频谱已经在 Worker 里按档算，只要缓存键从「档」变成「(档, 方向档)」，方向按 30° 量化，风向变化时两份方向的 h0 同样可以混合过渡（两个方向的海浪叠加，物理上就是风转向时的交叉海）。代价：方向换档时要多算 1–2 档（Worker，不卡主线程），缓存翻倍。**涌浪不应当跟本地风转**：`SWELLS` 的方向要改成与本地风无关的常量（或来自远处风暴），否则风一转涌浪也转，不对。
- 第二步（着色器里的 `WIND_DIR` 改 uniform）碰的是窗外场景程序（冷启动关键路径），按设计单独做离线 FXC + `gpu-ab --time scene`。注意阵风斑的漂移已经改成 CPU 积分，方向可变之后漂移要积分成二维位移（`uOceanFoam.zw` 或新 uniform），否则风向一变阵风斑同样会瞬移。
- 估计工作量：S–M；建议等 WX11b（方向接入）合并后一起看，方向同样只在大变化时换档。

## 踩到的坑

- **频谱重算比注释写的重一倍多**：注释「十几毫秒」，实测 20–40 ms（启动时 70 ms）。识别 / 复测：`ocean.stats.buildMs` / `syncBuildMs`。
- **着色器里 `uWind * uTime` 当漂移**：风速一变，阵风斑按「Δ风速 × 页面运行秒数」瞬移；风速连续变化时整片以「运行秒数 × 风速变化率」的假速度滑。改前拖面板滑条就有这个问题，只是没人拖。已写进 README。
- **`a = 0` 时没预取上档**：第一版预取的是「需要的档 + 两侧各一档」，风速正好落在档上（默认 7 m/s）时上档不在列表里，从 7 往上走的第一帧要等 Worker。改为总是预取 [i, i+1, i−1, i+2]。7→10 阶跃对照里 10 m/s 当帧就到（没有等待帧）。
- **低空海面场景换 `outsideMat` 原文碰不到画面**：low-sea-glint（0.6 km）画的是低空细节变体（`GroundDetailVariant`，另一个材质对象），`ab` 换 outsideMat 原文不报错、差异恒为 0；`gpu-ab` 会直接报「计时区间里没画到被改的材质」。低空海面要验证着色器零回归，用高空海面场景，或以后给 ab 加一个「当前实际画的窗外变体」的材质别名（见开发体验反馈）。
- **`gpu-ab` 认不出 `ocean.evolve`**：`materials: {"ocean.evolve": "base"}` 能读到原文、也确实画了，但计时区间的材质识别表里没有它（显示为 ShaderMaterial），直接报错，只能不对照它。
- **连续航程的流速是 `director.rate`**，不是 `state.playRate`（后者只管不开连续航程时的时间流速）；测 60× 要设前者。

## 需要协调者注意 / 没做

- 面板「海面风速」滑条不会跟着导演写的值更新（`ui.ts` 不归本任务）。要显示可以在 ui 的 sync 里读 `state.wind`，或者看信息栏新加的「海面风 x m/s」。
- 骏河湾 1 月 17.4 m/s、西太 7 月 0.9 m/s 是 WX11a 风场给的（太平洋一侧冬季风偏强、副高下偏弱），数值上限以风场为准，本任务不改 `weather.ts`。
- 60× 连续航程里有零星 20–40 ms 帧（与海面无关，ocean.update ≤ 1.1 ms），没有查来源。
- 湖泊 / 河流的涟漪（`inland-water.glsl.ts`、`terrain-shading.glsl.ts` 的碎浪）也读 `uWind`，只按振幅用、没有速度 × 时间，风速连续变化没有跳变问题；它们属于 ground，没动。
- 对照 worktree `tmp/WX11g-base` 交付前已删。
