# WS07 巨柱群 · 独立审查

- 审查对象：分支 `worktree-agent-aa70e24ec0af1cabd` @ `5f27621`，对照 master `f38e88c`（分支已包含 master，`git merge-tree` 无冲突，合并即快进）。
- 环境：私有 headless，`GL_RENDERER = ANGLE (NVIDIA GeForce RTX 5090 … D3D11)`，1600×1200，DPR 1，画质高；页面地址都带 `voyage=0`（dev-browser 自带）。分支 5355、master 固定提交的临时 worktree（`tmp/ws07rev-master`）5356。
- 截图：主仓库 `tmp/screenshot/WS07-review/`（`p/` 五个场景开 / 关，`rev/` reveal 0.01 对照，`rail/` 火车模式，`w-br` / `w-m1` / `w-m2` 现有奇观分支 / master / master 二次）。

## 结论：通过（无阻塞项），附三条建议合并前或下一波顺手修的小问题

## 核对结果

| 项 | 结果 |
| --- | --- |
| `typecheck` / `pnpm --filter voyage build` | 过；`find dist/assets -type f -size 0` 无输出 |
| `check:glsl` | 全部通过，`outside-pillars` 语法 OK、含奇观代码断言 OK |
| `shader-parity --base <master worktree>` | 45 个程序全部相同：`outside-default / -extras(OW) / -ground-detail(DOW) / -rail(DROW)` 预处理后逐字相同，只新增 `outside-pillars` |
| 控制台 | 全部截图运行 0 console error / pageerror（瓦片 CORS 已聚合，不相关） |
| 现有奇观零回归（天梯 `ws-tether-noon`、建木 `wonder-jianmu-day`、浮空城 `wonder-floatcity-day`、灯城 `wonder-fogcity-night`） | 分支×master 超阈值(4)像素数 97.5k / 48.9k / 76.5k / 55.9k，全部 ≤ master×master 噪声底 115.3k / 87.5k / 285.6k / 65.4k；建木差图是云 / 海面 / 树冠边缘的亚像素噪声，没有结构性差异。与 shader-parity 结论一致 |
| catalog 插入位置 | `pillars` 插在建木之后、fogcity 之前；`wonderById` 按 id 查、`candidates` 按权重抽，顺序只影响抽样序列（同一 rollIndex 抽到的奇观可能变），不影响任何现有奇观的画法 |
| system.ts 5 处 | 只在 `skin === 2` 时生成 / 写 `uPillar*`；天梯 `tether` 路径未动；`describe()` 分支正确 |
| OWP 未编好 | `wantedOutsideKey` 对巨柱群返回 `{ key: "OWP", fallback: [""] }`，`pick()` 只退到已编好的材质 → 编好前画默认程序（不画奇观），不黑不闪 |
| 冷启动批次 | OWP 只在 `uWonderOn && skin == 2 && !rail` 时 `prepare`，`PREWARM_AFTER_FRAMES` 只预编 OW → 按代码不可能进冷启动批次（与实现者 `dev-browser cold` 实测一致） |
| 页面内编译时长（参考） | `variantStatus`：OWP 24.0 s、OW 26.2 s（两者同时后台编、机器上有别的代理在跑 FXC，只作量级参考） |
| GPU 在场增量（持测量锁复测） | 正午 +0.28 ms（A/A ×0.992），≤ +0.6 ms ✓，详见「性能」 |

## 阻塞问题

无。

## 非阻塞问题（按严重度）

### 1. 浮现 / 退场期间「看不见的柱子」照样挡星、裁远云（建议合并前修，一行）

- 位置：`src/wonders/pillars.glsl.ts:215`（`gWonderCov = max(gA.w, gB.w);`）。
- 现象：`rev/`：`ws-pillars-night` 用 `reveal: 0.01` 触发（柱子只露出地平线上一截），与奇观关对比，**整根柱子的轮廓范围内点星都没了**（差图 `rev/ws-pillars-night.d.png`：柱子上半截还没长出来的地方一颗颗星消失）；远云同理会被 `cloudBeforeGround` 按柱深裁掉。浮现 120 s、退场 120 s 里，夜空会出现几条「没有星星的竖带」，形状就是还看不见的柱子。
- 根因：天梯 / 建木（`wonder-sky.glsl.ts:633`、`:825`）写 `gWonderCov` 时都乘了可见度 `vis`，这里没乘 `visk`（可见前沿）。几何循环里覆盖率是不带前沿的。
- 修法：几何循环里算覆盖率时就乘上前沿可见度，例如 `pillars.glsl.ts:161` 之后加 `cov *= 1.0 - smoothstep(0.35 * uWonderShape.y, uWonderShape.y, clamp(si, 0.0, P.w));`（或只在 215 行对 gA / gB 各乘自己的 visk）。只影响 OWP，不碰其它程序。
- 识别：夜景 reveal < 1 时与关奇观做差，差图里柱子上段出现离散的星点差。

### 2. 火车模式下巨柱群退场的 120 s 被画成建木（实测确认，严重度低）

- 位置：`src/render/outside-pass.ts:354`（`!w.rail` 时才走 OWP，火车走 DROW，DROW 里的 `wonderSky` 把 skin 2 当建木：`wonder-sky.glsl.ts:260` `tether = z < 0.5`）。
- 实测：`rail-oito-default` 里强制 `trigger("pillars", { distKm: 190, reveal: 1 })`，`describe()` = 「巨柱群 · 退场中」，差图 `rail/d.png` 在窗口顶部画出了**建木的树干与枝杈**（最大差 8/255，这个机位被山与车窗内框挡掉大半，很淡）。
- 触发条件：巨柱群在场时切到火车模式（高度掉到 4.5 km 以下 → 退场 120 s；若火车传送到 1500 km 外也退场）。巡航自然触发不会走到这里（`minAltitudeKm: 6`），属于用户手动切换的冷门路径；画出来的是错误奇观，但淡、短、会自己消失。
- 修法（任选其一，都不改 OW / DOW / DROW 的着色器）：进入火车模式时 `wonders.clear()`（main.ts / rail 切换处一行）；或 `WonderSystem.syncUniforms` 里 skin 2 且 `ctx.altitudeKm < 1` 时把 `uWonderOn` 置 0。
- 同类小问题：巨柱群退场期间若降到 4 km 以下（`detail` = true），仍选 OWP（不含 GROUND_DETAIL），低空细节要等柱子退完才开始编 DOW，最多晚约 120 s 出现。影响很小，记录即可。

### 3. OWP 只在在场时才开始编（页面内约 10–25 s）：`reveal = 1` 直接出现的路径会「整群突然冒出来」

- `wantedOutsideKey` 只在 `uWonderOn > 0.5` 后才要 OWP。正常浮现（reveal 从 0 起，前沿先藏在霾里）编好时前沿还低，看不出；但「奇观之门」`onCover → trigger(..., { reveal: 1 })` 以及调试 `reveal: 1` 触发，会在编好的那一刻整群完整出现。目前 `preferGate` 没有任何代码置 true，门这条路径实际不走，所以不阻塞；将来接入奇观之门时要在 `pendingGate` 是巨柱群时就 `prepare` OWP（或巨柱群不走门）。

## 观感（兼美术总监）

- **方柱群（正午 / 仰看 / 黄昏 / 夜）**：读得出「巨构」——主柱出画、柱脚埋进云海与霾、同高度旗云与航迹云只到柱子脚踝、远柱越来越淡越蓝，尺度链条成立。不是烟囱。但整体偏「半透明的玻璃摩天楼群」：下半截被空气透视冲得很淡（物理上说得通），加上退台 + 夜里一圈圈环带暖白灯，远看有一点「未来城市天际线」的味道，少了「混凝土整块」的重量感。记遗留，不阻塞。
- **圆柱群（`ws-pillars-sea`）**：仍然读成「白色 PVC 管 / 烟囱」——高光均匀、分段环像管箍。实现者自己也标了。**建议把方柱比例从 0.6 提到 0.85 左右**（`pillar-shape.ts:84` 一处常数），或给圆柱加更强的竖向色差 / 风化，降低四成出现概率里看起来像模型的风险。
- **黄昏地影**：可信，一眼能比出哪根更高，是这个奇观最好看的一张。瑕疵：明暗交界是一条**一像素硬的水平线**，受光段整段同一种粉红。真实的地影边缘有几 km 的半影、越靠近交界越红越暗（掠射光穿过长大气路径）。建议交界按高度做 1–3 km 的渐变并往深红过渡。记遗留（中）。
- **夜**：剪影 + 柱顶同步红灯 + 环带稀疏暖白灯，克制，可信；红灯在 1600×1200 下只有一两个像素，偏弱但不违和。
- 闪烁：未复测 `ab live`（实现者三场景 0 闪烁像素，我的截图里轮廓 / 环带 / 前棱没有锯齿与台阶）。

## 性能

持测量锁复测（等 ab / shader-budget 释放后自动取锁），`gpu-ab --time frame --rounds 8`，`ws-pillars-noon` 开 / 关 / 开 A/A：
开 2.224 ms、关 1.946 ms（×0.869，显著），**在场增量 +0.28 ms**；A/A ×0.992 [0.983, 1.003]，在离散度内；console error 0。与实现者 +0.28 ms 一致，≤ +0.6 ms ✓。
离线冷编译（OWP 13.7 s < OW 15.3 s）未复测：OWP 不在关键路径，仅在巨柱群在场时后台编。

## 开发体验反馈

- 哪里慢：测量锁排队（ab、gpu-ab、shader-budget 连着占锁）。
- 哪里卡：`shots` 只给一个 `--pair` 时不输出任何文件（也不报错），要给两个 pair 才落盘；`shots` 的 js 返回值只写进 json 的 `jsOut`，命令行不打印。
- 希望：`shots` 单 pair 时按普通场景落盘或报错。
