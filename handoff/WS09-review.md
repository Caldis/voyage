# WS09 垂直大陆（OWV 变体）· 独立审查

- 审查对象：分支 `worktree-agent-a91d86c1d55d28f48` @ `5ea27fe`，对照 master `41ef39f`（分支基于 1734cda，master 此后只多了一条 WORKLOG 提交）。`git merge-tree --write-tree master <分支>` **无冲突**。
- 环境：私有 headless，`GL_RENDERER = ANGLE (NVIDIA GeForce RTX 5090 … D3D11)`（硬件渲染），1600×1200，DPR 1，画质 high，URL 带 `voyage=0`；ab / gpu-ab 自动持测量锁。分支 dev 服务器 5377，master 临时树 `tmp/ws09rev-master` 在 5378（审完已关、已删）。
- 截图：主仓库 `tmp/screenshot/WS09-review/`（`br/` 五个回归场景、`o-br|o-br2|o-m1|o-m2/` 现有奇观两两对照、`ab-live/`、`ab-turn/`、`gpu/`、`switch/`、`rail/`、`sun/` 逆光、`z/` 放大）。脚本在主仓库 `tmp/ws09rev/`（场景 / jobs 生成器、`cmp.py`、`framelum.py` 逐帧亮度）。
- 逆光复现场景：本 worktree `apps/voyage/handoff/WS09-review-backlit.json`（`shots --scenes-file`，4 个场景：3.9° 开 / 关、18.9°、42.5°）。

## 结论：需返工（一处：逆光时整块大陆看不见，太阳被「隐形的墙」挡掉）

其余各项（正确性、变体选择、非大陆程序零回归、闪烁、整帧刷白、GPU 增量）都过。返工只动 `continent.glsl.ts` 的前景内散射一段，不影响其它程序，改完只需复拍逆光场景 + 五个回归场景 + 一轮 `ab` live。

## 核对结果

| 项 | 结果 |
| --- | --- |
| `typecheck` / `pnpm --filter voyage build` | 过；`find dist/assets -type f -size 0` 无输出 |
| `check:glsl` | 全过（退出码 0，117 条 OK）：`outside-continent` 语法 OK；「只有 outside-continent 含垂直大陆代码」6 + 1 条断言 OK；OWV 含罕见光学 / 奇观代码、不含天环代码 |
| `shader-parity --base <master 树>` | 47 个程序全部相同：`outside-default / -extras(OW) / -ground-detail(DOW) / -rail(DROW) / -pillars(OWP) / -ring(OWT)` 预处理后逐字相同，**所有云程序（默认 / 风暴 / 台风 / 天气 / 奇观 / resolve …）逐字相同**；只新增 `outside-continent` |
| `clouds.ts` depthOn 加 `uContOn` | 只改 JS 布尔式：非垂直大陆时 `uContOn = 0`，式子与改动前逐项相同；云程序文本逐字不变（上一行）。`this.view` 是 `sceneMat.uniforms`，`wonders.uniforms` 已 `Object.assign` 进去，`uContOn` 读得到。默认 / 天气云程序 shader-parity 相同 |
| 控制台 | 全部 shots / ab / gpu-ab 0 console error / pageerror |
| OWV 链接 | 当前代码 **编译链接成功**：每个场景 `variantStatus.OWV.state = ready`（页内冷编 27.4 s，与 OW 同时后台编时约 45 s），`shown = OWV` |
| 非大陆奇观零回归（`ws-tether-noon` / `ws-pillars-noon` / `ws08-noon`，分支 ×2、master ×2，都等到变体编好：OW / OWP / OWT） | 分支×master 超 8 级像素 29k–121k，master×master 60k / 99k / 106k，分支×分支 95k / 94k / 116k——同一量级，差在云 / 海浪（与 shader-parity 一致） |
| GPU 在场增量（`gpu-ab --time frame --rounds 8`，ws-vcont-noon，开 / 关 / 开） | 2.508 vs 1.996 ms（**+0.51 ms**），A/A ×1.005 [0.998, 1.012]——复现实现者数字，≤ +0.6 ✓ |
| 冷编译（离线 FXC） | 按协调者立场不测、不阻塞，收尾安静窗口统一复测 |

### 变体选择（读码 + 同页切换序列实测，`switch/`、`rail/`）

- 自然浮现（reveal 0 召唤）：OWV 编译期间 `wanted OWV / shown ""`，退默认，窗口亮度 113.5–114.5 平稳（不黑不闪）。
- 罕见光学同在（`optics.force.halo`）：仍选 OWV（O + W + V，光学照画）✓。
- 天环 → OWT；巨柱群 → OWP；**巨柱群 → 大陆**（`uWonderShape.z` 残留 2 但 `uWonderOn = 0`）→ OWV ✓；大陆 → 天梯 / 建木 → OW（`uContOn` 每帧先清 0）✓；天环 → 大陆 → OWV ✓；`clear()` 后 `uContOn = 0`、回 OW / 默认 ✓。
- 火车模式（`rail-oito-default` 冻结后召唤）：`DROW / DROW`、`uContOn = 1、uWonderOn = 0`，召唤后与召唤前 / 清掉后的画面一致（冻结同页对照里的差是一次与大陆无关的一次性变化，召唤后 = 清掉后逐位同计数）——不会被画成建木 ✓。
- 低空：3 km 时大陆进退场（`altitude < minAltitudeKm − 1.5`），退场 120 s 内仍选 OWV（不含 GROUND_DETAIL），detail 晚到——与天环同类，记遗留。

### 闪烁 / 整帧刷白（`ab` live 240 帧，阈值 16、帧占比 > 5%；jobs 的 `pre` 先等 OWV 真编好——实现者的 jobs 没等，见遗留 5）

| 场景 | 顶沿 / 岩壁 / 脚下与云 闪烁像素 | 逐帧平均亮度：相邻最大跳变 / 偏离中位最大 / 死白像素每帧 |
| --- | --- | --- |
| 正午巡航 cur / cur2 | 0/0/0 · 0/0/0 | 0.01–0.02 / 0.36 / 0 |
| 黄昏巡航 | 0/0/0 · 0/0/0 | 0.01 / 0.12 / 0 |
| 夜巡航 | 0/0/0 · 0/0/0 | 0.01 / 0.22 / 0 |
| 云海巡航（航迹云、瀑布、云墙） | 0/0/0 · 0/0/0 | 0.01 / 0.30 / 0 |
| 正午转 25° on / off / on2 | 0/0/0（三者） | 0.15 / 转向带来的缓慢漂移 / 0 |
| 正午转 50° | 0/0/0（三者） | 0.15 / — / 0 |
| 黄昏转 25°（我加的） | 0/0/0（三者） | 0.03–0.14 / — / 0 |

没有闪烁、没有整帧刷白，冻结静帧两轮逐位 0。

## 阻塞问题

### 1. 逆光（太阳在岩壁背后 / 上方）时整块大陆几乎看不见，只剩三道瀑布白线和一条航迹云挂在天上；太阳圆盘被挡掉，却看不到挡它的东西

- 位置：`src/wonders/continent.glsl.ts:420–422`（`lFront = max(apL, …)`；剪影压暗只按 `duskW` 做）。
- 现象（`tmp/screenshot/WS09-review/sun/`，左座、航向 0 → 窗朝西，种子 0.61，230 km）：
  - `sun-behind-on.png`（太阳高 3.9°，正落在岩壁后面）：岩壁与天空同色、完全隐形；画面里只有三根竖直的瀑布白线、顶上几根黑色细尖（孤峰），太阳和日晕消失（`sun-behind-off.png` 同机位有太阳）——读成「太阳被 bug 吃掉了」，碰「巨构」目标，也不像任何实物。
  - `sunW-960`（18.9°）、`sunW-840`（42.5°）同样看不见（`sunW-all.png` 左、中）；`sunW-1050`（−0.5°）正常成剪影（右）——因为 `duskW = 1 − smoothstep(−0.02, 0.06, uSunDir.y)` 只在太阳高度 < 约 3.4° 时生效，3.4° 以上逆光一律失效。
- 出现频率高：`sunWeight` 在太阳高度 −4…8° 时权重最大（3），召唤方位在窗口外侧 ±25°，只要这一侧的窗朝着太阳（黄昏朝西 / 清晨朝东的那一侧座位）就会撞上。
- 根因：前景内散射 `apL` 来自空气透视 LUT，默认那段空气全被太阳照着；岩壁朝相机的一面在阴影里、自身辐亮度很小，于是「岩壁 ≈ 前面的空气 ≈ 同方向的天空」。真实情况是太阳在墙后时，相机与岩壁之间的空气在岩壁自己的影子里（墙高 H、太阳高 α，影长约 (H − y)/tan α：α = 4° 时 400–1300 km，远大于 230 km），这段内散射应当大部分没有——所以逆光的高墙是暗剪影。
- 修法（只在 OWV 里，一两行）：按「前景空气有多少在岩壁影子里」再压一次，和黄昏剪影共用 `min(lFront, Lbg·0.78)`：
  ```glsl
  // 替换 :422。太阳在崖面背后（水平方向）时，相机到岩壁之间的空气落在岩壁自己的影子里：影长 (Hc − y)/tanα 占视线长度的比例
  vec4 gs1 = isCloud ? gB1 : g1;                       // 云那一步用近块的几何
  float az = isCloud ? gB2.x : g2.x;
  vec3 nWh = E * cos(az) + S * sin(az);                // 崖面水平外法线（窗外坐标；g2.x = atan(mh.y, mh.x)）
  vec3 sH = uSunDir - up * dot(uSunDir, up);
  float behind = smoothstep(0.0, 0.25, -dot(nWh, sH) / max(length(sH), 1e-4));
  float shadowF = behind * clamp((gs1.z - gs1.y) * length(sH) / max(dot(uSunDir, up), 0.02) / max(tk, 1.0), 0.0, 1.0);
  lFront = mix(lFront, min(lFront, Lbg * 0.78), max(duskW, shadowF));
  ```
  （未实测，只给方向；系数 0.78 与黄昏共用，逆光时可以再暗些，按图调。注意 `gs1.z − gs1.y` 在顶沿以上为负，clamp 到 0 即可。）这样低太阳逆光 → 整块剪影（和 −0.5° 那张一致）；高太阳（42°）影长只占视线的两三成 → 轻度压暗、仍读得出轮廓。新增的除法都有 max 保护，改完照例跑一次 `ab` live 看逐帧亮度。
- 验收：`handoff/WS09-review-backlit.json` 四个场景，3.9° / 18.9° 能一眼看出岩壁轮廓（剪影或压暗），太阳被挡的地方看得到挡它的实体；五个回归场景不变（它们都不是逆光）；`ab` live 一轮无闪烁。
- 识别：太阳在奇观方位时截图，瀑布 / 航迹云 / 孤峰尖悬在天上而看不见岩壁。

## 非阻塞遗留（按严重度）

1. **正午顺光岩壁偏「磨砂玻璃 / 冰」**（中，实现者已自报遗留 2）：`ws-vcont-noon` / `-noon-up` / `-sea` 读得出巨构（层叠岬角一层比一层蓝、顶沿孤峰、脚下云海、侧向出画，尺度链条清楚），但岩面是大块柔边斑驳 + 几条贯穿各块的亮横带（缓坡层），放大（`z/noon-mid.png`）像低频噪声贴图，靠近「宁可有雾，也不露低清贴图」的边。黄昏 / 夜两张是这组最好的。方向同实现者：压暗默认岩性、横带（ledge）按块 / 按段错开，别整片同一高度。
2. **按需变体编好那一刻，已浮现的下段一帧跳出**（中低）：自然浮现时 OWV 页内编 15–45 s，此时 reveal 0.12–0.37、前沿 14–40 km，编好那帧起这段岩壁突然出现。与 OWP / OWT 同一机制（以前已接受）。一行修法：`WonderSystem.update` 里 `rising` 阶段在窗外变体 `pending` 时不推进 `elapsed`（需要 main.ts 把 `groundDetail.pending` 传进来）。
3. **逆光时岩壁不在云海 / 海面上投影**（中，实现者遗留 4）：阻塞 1 修好后，低太阳逆光时墙成了剪影，但海面的太阳反光带、云的受光仍照常（按物理整个机位都在影子里）。修起来要进云合成，先看图再定。
4. **低空退场期间 detail 晚到最多 120 s**、**OWV 编译期间罕见光学暂停**（低）：同 WS08 审查遗留 4 / 5；OWV 的退路也可以改成 `["OW", ""]`（大陆在场时 `uWonderOn = 0`，OW 里的 wonderSky 第一行就返回，安全）。
5. **实现者的 `WS09-live-jobs.json` / `turn-jobs.json` / `gpu-jobs.json` 没等 OWV 编好**（低，测量方法）：`ab` 只跑 90 帧 + 等 `ground.pending`，冷页面上 OWV 要 27 s，第一个 job 可能量的是默认程序（这次我在 `pre` 里等 `groundDetail.pending` 复测，结论一致）。建议给这几个 jobs 加同样的 `pre`，或 `ab` / `gpu-ab` 统一等 `groundDetail.pending`（DX）。
6. **按需变体链接失败只 `console.warn`**（低，基础设施）：`LazyVariant` 失败打 warn，shots 统计 0 error（实现者踩过）。建议失败改 `console.error`，回归就能自动抓到（不属本任务）。
7. 瀑布在正午 / 云海机位像几道竖直的光柱（和底色反差大、宽度均匀），航迹云是一条贯穿全窗的双线——都在设计内，观感上略像「贴上去的线」，可随遗留 1 一起调。

## 观感（兼美术总监）

- **正午平视 / 仰看**：成立，巨构尺度清楚；质感偏磨砂（遗留 1）。
- **黄昏**：顶沿被染成暖色、下段在地影里成剪影，交界是几像素的软过渡（`z/dusk-line.png`），和天空的地影界同高，**没有硬线**；逐帧亮度平稳，无刷白。
- **夜**：最好的一张——挡住星空的一整块剪影、月光下受光面淡淡可见，星点只在轮廓外。
- **云海**：长墙 + 瀑布 + 航迹云，脚被云海吞掉，尺度对比强。
- **逆光**：不成立（阻塞 1）。

## 开发体验反馈

- 哪里慢：OWV 冷编 27–45 s，每个新页面的第一个场景都要等；`shots` 不等按需窗外变体，要自己在 js 里轮询 `groundDetail.pending`，而且**要先等几帧**（召唤后 `wanted` 要到下一帧 `pick` 才更新，立刻查 `pending` 是 false，我第一次因此截到了没编好的 OWP / OWT）。
- 哪里卡：`--scenes-file` 与 `--only` 并用时 `--only` 不生效（WS08 审查已报，仍在）；`ab` 的 `pre` 返回值不写进 summary，只能从「场景就绪 35 s」间接判断等过了。
- 希望：`shots` / `ab` / `gpu-ab` 统一「召唤后等 N 帧再等 `groundDetail.pending`」；回归清单加一个逆光奇观场景（这次的问题五个回归场景都拍不出来）。
