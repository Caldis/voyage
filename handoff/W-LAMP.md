# W-LAMP · 机翼灯光

- 分支 `worktree-agent-a04959b071fb5c5b3`（已合并 master 3664d6e 前的 C10 与 DX-23/24）。开发端口 5232，对照 worktree `D:\Code\opus-test\tmp\wlamp-base`（master 8b3d5f6，端口 5292，交付前已删）。
- 归属内改动：`src/render/wing-shading.glsl.ts`（照翼面的配光、灯光照度与地平线、灯的镜面粗糙度）、`src/render/wing.glsl.ts`（wingTrace 多导出一个曲率全局量 `gWingCurv`，一行）。去亮点限幅（`wingView`）**最终没有改**，理由见下。没碰 exposure / clouds / scripts。
- 工具（本目录）：`W-LAMP-ab.mjs`（同页冻结 A/B：冻结后等 pending 0 + 30 帧；变体可存 hdrWing；`compare` 报非机翼差异并用覆盖率变体核对；`live` 模式飞行中每个 rAF readPixels、只留频闪帧；计时 job 才等测量锁）、`W-LAMP-stats.py`（翼面 ≥250 连通块、灯周径向剖面）、`W-LAMP-dots.py`（孤立亮 / 暗点 + 相邻差）、`W-LAMP-live.py`（飞行中频闪帧统计）；jobs：`-ab`（7 场景）、`-live`、`-bench`。

## 诊断

1. **小翼内侧 / 灯下的亮块**：`wingLampIntensity` 用来照翼面有三处不对——没有竖直分布（尾灯 20 cd 原样照到正上方的小翼内侧）；方向近竖直时水平角由 `dir.xz` 零头决定，20 cd / 2 cd 随零头正负来回翻（硬边亮块、灯下亮带）；`max(d², 0.04)` 在 20 cm 内是照度平台（没有梯度）。
2. **翼尖后缘一线的点列**（夜里是黑点、频闪时是白 / 黑点）：逐项排除（`tmp/screenshot/wlamp/te2`、`te8`、`enc3`、`enc6`）——`uWingEdgeAA = 0`（不超采样、不限幅）、关鼓包、关环境反射、关灯的镜面都还在，只有关灯照明才没。读回每盏灯的 n·l：暗点处尾灯 n·l ≈ 0（−0.004…+0.007 来回过零），照度又是 1/d² 放大过的，左右邻像素差几十倍。**W-STAIR 遗留里「去亮点限幅压了中心样本」的判断不成立**：把灯光从限幅里拿出来（中位 × 2、第二亮 × 2、第二暗 × 2 三种都试过）都在频闪帧里放出一串白点，已撤回。
3. **频闪一闪，翼尖内侧半米的翼面一大块死白**（night-city-low 231 px）：1500 cd 各向同性、近处照度平台。

## 修法（最终）

1. `wingLampSurfI`：照翼面专用配光。FAR 25.1393（位置灯）/ 25.1401（防撞灯）竖直分布的平滑近似（高仰角的底 0.15 / 0.2 是**估计值**：规定只给下限，真实灯罩往高仰角漏得多）；水平台阶放软 ±2°；近竖直按水平平均；翼尖频闪朝外半个空间照、朝内只漏 0.15（**估计值**，机身一侧由尾部 / 另一侧频闪负责，25.1401 允许被机体遮挡）。不用 atan（sin² 近似仰俯角、cos / sin 比阈值），冷编译从 +4.4% 降到 +2.6%。
2. 照度 `I / (d² + R²)`，R = 5 cm（圆盘光源正对的精确式；R 是**估计值**，航行灯 / 尾灯透明罩的量级，没查到具体型号尺寸）。
3. 航行灯、尾灯的 n·l 用面光源地平线 `(n·l + sinα)² / (4 sinα)`，sinα 与「像素内法线转角的一半」（`gWingCurv` × 像素足迹）取大。**频闪不加**：同页消融（`te17`）加了以后频闪帧孤立白点多一倍，不加比改前还少。
4. 灯的镜面粗糙度不再跟边缘判定走（只按材质粗糙度 + 鼓包方差；边缘像素宽波瓣、隔壁窄波瓣会沿线交替）。
   **审查返工**：原先还把像素内法线转角 spreadN² 加进 α²，小翼前缘曲率估计逐像素逐帧乱跳，航行灯旁出现一条飞行中闪烁的绿色高光线，已去掉（见下「返工」）。
5. 灯本身的亮点、云雾光晕（`wingLights`）不变（它在无机翼像素上也写）。

## 验收数字（ab6：同页冻结，d3d11，RTX 5090，高画质档，1600×1200，2026-01-16 无月）

| 项 | 场景 | 改前 | 改后 |
| --- | --- | --- | --- |
| 翼面亮度 ≥250 最大连通块（去掉灯芯 6 px） | night-city-low | 2 | 0 |
|  | night-city-low 频闪 | 223（另一块 30） | 20（与只画眩光不画灯照时相同，是频闪眩光核） |
|  | night-city-off / night-wing-on（含频闪） | ≤ 3 | ≤ 1 |
| 白色尾灯周围径向剖面（r = 5…56 px 环中位数） | night-city-low | 200, 192, 190, **214, 218**, 211, 205, 200, 195（非单调） | 231, 225, 218, 205, 192, 173, 168, 161, 152（单调） |
| 频闪灯周围径向剖面 | night-city-low 频闪 | 248 … 199 单调 | 237 … 194 单调 |
| 后缘线 80×25 裁剪孤立亮 / 暗点、相邻差（阈值 6 级） | night-city-low | 51 / 95、6.47 | 47 / 89、4.77 |
|  | night-city-low 频闪 | 9 / 39、2.00 | 5 / 37、1.64 |
| 飞行中频闪帧（页内逐帧 readPixels，200×90 裁剪，60–82 帧） | night-city-low | 相邻差 1.41、≥250 最大块 292 | 1.22、93（含频闪灯芯与眩光） |
|  | night-wing-on | 2.07、20 | 1.77、20 |
| 非机翼像素写入 | 7 场景 | — | 0；night-city-low 报出的 1311 个全部是覆盖率 > 0 的机翼像素（旧版恰好画成纯黑、与背景逐位相同）；night-city-off 同页噪声底 1.7 万像素，不作逐位判断 |
| 白天显示差（改后对改前，噪声底 old2 对 old 都是 0） | noon-cumulus / sunset-wing / 商务舱正午 | — | 37 px 最大 1 级 / 415 px 最大 2 级（≥2 的 2 个像素，翼尖）/ 38 px 最大 1 级 |
| 冷编译（离线 FXC，5 轮取最小） | wing / wing-wet | 6572 / 7774 ms | 6744 / 7927 ms（+2.6% / +2.0%） |
| 机翼 pass 批渲（benchWing(30)×7，4 轮取最小；负载下，只作参考） | sunset-wing / night-city-low / 频闪 | 0.540 / 0.610 / 0.593 ms | 0.547 / 0.610 / 0.597 ms |

- night-sea-milkyway（左座、wing-pos −4）画面里没有机翼，新旧逐位相同。
- **白天不是 0**：航行灯、尾灯白天也亮着，照翼面的物理量改了，翼尖附近有一两级的差。要严格 0 只能按昼夜门控灯照翼面，物理上不对，没做，交协调者定。

## 已知问题 / 没做

- 翼尖弯折线上的点列没有完全消失（改前是黑点、改后是浅灰点，孤立点数与相邻差都降了）；剩下的是弯折段与翼面衔接处距离场法线在一个像素里跳一度左右，单条中心射线取样，像素足迹滤波的曲率估计（四面体拉普拉斯）在那里不准。根治要在 wingTrace 里给灯光单独估一个像素足迹内的平均法线，或者让边缘判定覆盖这条线。
- 小翼内侧被尾灯照亮的范围比改前小（配光竖直分布），靠近灯处仍有从亮到暗的梯度；频闪时小翼前缘有一条细亮线（掠射受光），连续、不闪。
- T48c（exposure 局部适应）返工中；本任务不写无机翼像素，TM02 的 dW 判据不受影响。

## 返工（审查 P1 / P3，`handoff/W-LAMP-review.md`）

- P1：灯的镜面 α² 里去掉 `spreadN²`（地平线那一处的 `0.5·spreadN` 保留）。README 坑点补一句「曲率估计只能放进取 max 的地方，不能直接加进粗糙度」；着色器注释同步。
- P3：R = 5 cm、防撞灯 0–10° 相对比例低于规定的相对下限（绝对光强 1500 × 0.47 ≈ 700 cd，高于 400 cd）在注释与本文件里标明是估计 / 取舍。
- 工具：`W-LAMP-ab.mjs` 的 live 加 `all: true`（保留全部帧 + 逐帧 uStrobe / 时间戳），`W-LAMP-live.py --all` 按审查口径（频闪灭的连续三帧、时间二阶差 > 16 级的帧占比 > 5% 的像素）分区统计；job：`W-LAMP-jobs-live-all.json`。
- 复测（night-city-low 飞行中，裁剪 680,400,200,90，每变体 480 帧，页内逐帧 readPixels，同页 old / new 各录两次）：

| 变体 | 小翼前缘斜线 闪烁像素 / 每帧 >16 | 后缘弯折线 | 灯芯附近 |
| --- | --- | --- | --- |
| old（master f1894b0） | 1 / 6.8 | 65 / 20.4 | 1 / 1.7 |
| old2 | 1 / 8.5 | 56 / 25.5 | 0 / 2.4 |
| new（返工后） | 1 / 4.5 | 20 / 8.3 | 1 / 2.7 |
| new2 | 0 / 4.6 | 25 / 9.1 | 0 / 2.9 |

数据：`D:\Code\opus-test\tmp\screenshot\wlamp\liveall\`。

## 编码变体（逐像素读回着色中间量）

`W-LAMP-ab.mjs` 的变体 js 里用 `__wsPatch` 把 `shadeWing` 的 `return diffuse + spec + envSpec + lampLit + m.emit;` 换成 `return vec3(要看的三个量);`，
同时把 wing-pass 末尾换成 `gl_FragColor = vec4(wing.rgb, wing.a);`、`gl_FragColor = sc;` 换成 `vec4(0.0)`，并设 `uWingEdgeAA = 0`（只有中心射线），变体带 `"hdr": "rgb"` 读回。
要看循环里某盏灯的量，先把 `lampLit += e * (` 前插一句写全局变量（例：`if (i == 2) { gL2 = dot(e, vec3(0.3333)); gN2 = nlL; }`，并在 `vec3 gWingLamp;` 一类全局声明处补声明）。
变体 js 放在 json 里时换行要写成 `\\n`（json 里一个反斜杠 n 会被解成真换行，页面报 SyntaxError）。

## 截图

`D:\Code\opus-test\tmp\screenshot\wlamp\`：`ab6\<场景>\<变体>\full.png`（old / new / 频闪 / nowing / mask）、`blobs.png`（死白块叠加）；`te17\`（频闪地平线消融）；`live2\*.png`（飞行中频闪帧放大）；`enc3`、`enc6`（逐像素编码读回）。

## 复现

```bash
# 对照：git worktree add --detach D:/Code/opus-test/tmp/wlamp-base master；两边各起 vite（5232 / 5292）
node handoff/W-LAMP-ab.mjs --port 5232 --base 5292 --out <目录> --jobs handoff/W-LAMP-jobs-ab.json
python handoff/W-LAMP-stats.py <目录>/night-city-low old,new,old-strobe,new-strobe --overlay
python handoff/W-LAMP-dots.py <目录>/night-city-low 760,440,80,25 old,new,old-strobe,new-strobe --thr 6
node handoff/W-LAMP-ab.mjs --port 5232 --base 5292 --out <目录2> --jobs handoff/W-LAMP-jobs-live.json
python handoff/W-LAMP-live.py <目录2>/night-city-low-live 200x90 old,new
node scripts/shader-budget.mjs --baseline D:/Code/opus-test/tmp/wlamp-base/apps/voyage --only wing,wing-wet --rounds 5
```
