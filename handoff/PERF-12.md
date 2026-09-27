# PERF-12 · 舱内合成的开销与编译回收 — 交接

分支：本 worktree（`agent-a50456d82ceaae9c5`），基于 master 226b3d1，中途合并 master 7a3273e（PERF-10、T49、WX10；舱内相关文件 master 未动）。
开发端口 5212，对照 5272（`D:\Code\opus-test\tmp\perf12-base`，detached 226b3d1，舱内文件与 7a3273e 相同）。
状态：**已完成，待审查**（碰了热点 scene.ts，按 DEV_SOP 第 5 节 (b)(d) 必审）。typecheck / build（dist/assets 无 0 字节）/ check:glsl 通过；`dev-browser check` 无 console error。

## 结论

| 指标 | 改前（226b3d1） | 改后 | 目标 |
| --- | --- | --- | --- |
| 舱内合成 GPU（商务舱，8 个场景，`passes.mjs --baseline` 同场景交替，60 帧 × 5 轮） | 0.364–0.388 ms | **0.282–0.305 ms**（−22~26%） | ≤ 0.3 ms ✔（route-hnd-cts-night 0.305，贴线） |
| 同上，经济舱（economy-ahead） | 0.286 ms | **0.223 ms** | — |
| 离线 FXC scene-default（交替 5 轮，最小值，机器有负载） | 8614 ms | 8166 ms（−5%） | ≤ 5 s ✘ |
| 离线 FXC scene-economy | 8429 ms | 7036 ms（−16%） | — |
| fxc 指令槽（确定性） | default 7899 / economy 7544 | 6878 / 6947 | — |
| 画面 | — | 13 个场景同页冻结对照：平均差 0/255、p99 0，最大 1–4.7（两处座椅轮廓 12，见下） | 零回归 ✔ |

**编译目标没达到**，原因与建议见「编译：为什么只拿回 5%」。

## 消融归因（改前代码，`handoff/PERF-12-variants.mjs`）

GPU（passes.mjs，sceneMat 换变体，30 帧 × 3；基线 0.36–0.40 ms，单次噪声约 ±0.015 ms）：

| 排名 | 项 | 省下（noon / night-city-on） | 说明 |
| --- | --- | --- | --- |
| 1 | 整个倒影（T24/T34/T42） | **−0.11 / −0.11 ms** | 执行开销（代码照编、用恒假 uniform 跳过也是 0.285）；正午也在付：跳过条件含对面舷窗，白天永远不成立 |
| 2 | T42 6 列座位循环 | −0.045 / −0.037 | 倒影内部最大的一块 |
| 3 | T34 阅读灯光点 | −0.02 / −0.012 | |
| — | 倒影其余各层（对面舷窗、天花板、两排行李架、座椅平面、头肩） | 各 < 0.01 | 单项都在噪声内，合起来约 0.05 |
| — | T41 点星、T35 亚麻 / 壳体 / 格栅 / 金属、T47 起伏 / 胡桃木 / 重映射、T29 水、缝线 | 均 < 0.015 | 噪声内 |

倒影以外（改后代码上再做一次，60 帧 × 4，首尾两次 base 0.341 / 0.340 漂移可忽略）：划痕 −0.044、侧壁 −0.055、内衬 −0.03、遮光板 −0.03、亚麻 + 细颗粒 −0.02、座椅 −0.01。
各项之和远超总数——后来查明大半是「窗板开口里的像素把侧壁 / 内衬 / 遮光板照算一遍再乘 0」，见改法 ②。

离线 FXC（scene-default，3 轮最小值，CPU 30–60%）：整个座椅 −42%（`shadeSeat` 单独换常数就是 −42%，追踪、法线、AO 都 < 3%）、整个倒影 −12~−15%，
**其余单项都在 ±10% 噪声里，而且不少「去掉」反而更慢**（去掉 `shadeWall` +17%、`shadeReveal` +10%）。经济舱同向（座椅 −32%、倒影 −19%）。
按任务的编译台阶：T35（座椅壳体、缝线、护翼…都在 shadeSeat 里）是最大来源，T41 点星在噪声内（+4% / −11%）。

## 改法

① **倒影内部**（`cabin-reflect.glsl.ts`）
- 6 列座位由「由远到近逐层 mix」改成「由近到远前后合成」（代数上完全相同：每列 col' = T·col + A，acc += T累计·A，T累计 *= T）：
  近列挡满（T累计 < 1e-4）就不算远列，**也不算整个背景**（对面侧壁、舷窗、天花板、行李架、座椅平面）——窗板下半的像素大多如此；
  视线高过这一列能画的最高处（椅背顶 + 头顶 + 屏光上界 + 2 倍虚化）就跳过这一列。
- 阅读灯光点：朝下 / 水平的射线离每盏灯 ≥ 0.4 m、高斯宽 ≤ 1.2 cm，exp 严格下溢为 0，`r.y <= 0` 直接返回。
- 光点循环 `RF_NPT` 原来是常量上限（被 FXC 展开成 20 份 rfPoint），加 `+ uLoopGuard`。
- **没改白天的跳过条件**：正午关掉倒影的差异是对面舷窗两团淡影（≤ 2–4/255，`tmp/screenshot/PERF-12/dayrefl2/heat-B.png`），看得出一点玻璃感，按「画质不降」保留。

② **按合成权重跳过**（`scene.ts`，最大的一刀）：先算 inBezel / inPane / shaded / seat.cov，再着色：
- 视线整个穿过本窗窗板开口（paneOnly）或被座椅完全挡住（hidden）时不算侧壁；
- paneOnly 且遮光板盖不到（shadeFree）时不走内衬步进（原来穿过开口的射线 `marchFunnel` 一路走满 24 步）；
- 遮光板只在 shaded > 0 时着色；座椅完全挡住时不进窗板分支；
- 调试 1–4 要看这些层，全算。跳过的都是权重严格为 0 的层，结果逐像素不变。
- 顺带：与窗外无关的各层在进窗板分支之前收成 `colFixed + kView·view`（GPU 上没测出差别，保留是因为更清楚）。

③ **点星门限**（`scene.ts`）：窗外亮度 × pixAng² ≥ 6e-7（天狼星峰值辐亮度的 200 倍，最亮的星也只让像素亮 0.5%）时不算 `starPoints`。正午整扇窗都是天空，原来每个像素都查 3×3 星表格。夜景逐像素不变（night-sea-milkyway 最大差 1.3/255）。

④ **划痕**（`cabin.glsl.ts`）：三层常量循环（18 份展开）压成一个 `18 + uLoopGuard` 循环，格号浮点递推（累加顺序不变），先只算决定「有没有」的哈希，再用「到中点距离 − 半长」排除碰不到的线段。GPU 上单独没测出差别（噪声内），编译上是去掉 18 份展开。

⑤ **编译向的循环化**（都是「常数 + uLoopGuard」，每个调用点只内联一份）：座椅部件（`sdSeats`、`shadeSeat` 选最近部件）、四点差分法线、四道缝线（`seatSeams`）、商务舱三路高光（`keySpec`）、窗上水线（原来 −2..2 常量展开 5 份）、两层水珠（两份 `waterDrop` → 一份）、内衬二分（7 份 `sdFunnel`）、擦拭纹。
  fxc 指令槽 7899 → 6878（default）、7544 → 6947（economy）。

## 编译：为什么只拿回 5%（取舍）

- 目标 ≤ 5 s 需要砍掉约 3 s。消融里只有「整个 `shadeSeat`」一项够量（−3.3 s），它内部没有哪一块单独贵；循环化、延后调用（`handoff` 里试过把 shadeSeat 挪到窗板分支之后：+4% / −2%，没用）、if 代替三目（+4% / −4%）都拿不回来。
- 画质不降的前提下，能把 3 s 拿回来的只剩结构性改法，**本任务没做，建议另开 PERF 任务**：
  a) 座椅单独一个 pass（先画舱内合成，再用座椅 pass 覆盖；要处理 alpha 打包 `packWingRef` 与 T47 交界重映射，需改 main.ts 的 pass 编排）；
  b) 各层表面（侧壁 / 内衬 / 遮光板 / 座椅）只出材质参数，光照（cabinIrradiance、windowIrradiance、keySpec、cabinEnv、金属）收成一个按层循环的调用点。
- 现状对启动的影响：PERF-10 之后启动关键路径是窗外程序（离线 9–10.6 s），舱内 7–8 s 不在关键路径上。

## 零回归（同页冻结对照）

工具：`handoff/PERF-12-ab.mjs`（同一页面 `freeze(true)` → 截本分支 A → 把当前舱等的舱内材质换成基线端口的着色器原文、等编完 → 截 B → 换回截 A2），`handoff/PERF-12-abdiff.sh` 求差。
场景表 `handoff/PERF-12-scenes.json`：night-city-on（商务 / 经济）、night-city 睡眠 / 全关、night-sea-milkyway、sunset-wing、dusk-earthshadow、noon-cumulus、biz-ahead / behind、biz 默认坐姿夜里开灯、econ-ahead / behind。

结果（`tmp/screenshot/PERF-12/ab2/`，本 worktree）：13 个场景 A−B 平均差 0/255、p99 0；最大差 1–4.7；噪声底 A−A2 除 night-city-on-econ 外都是 0（该场景 A−A2 也有 70.7 的零星点，城市灯光没冻住，A−B 与之相同）。
biz-ahead 有 2 个像素差 12（座椅轮廓抗锯齿处，浮点求和顺序变化），放大对照 `ab2/biz-ahead-zoom.png` 看不出区别。

## 数据与脚本

- 原始日志 / JSON：本 worktree `tmp/perf12/`（fxc-ablation、gpu-ablation、gpu-refl*、gpu-rest*、gpu-scr*、gpu-v1..v7、gpu-final-1..3）。
- 消融文件：`PERF-12-variants.mjs` / `-variants-gpu.mjs`（总表，**锚点对应改前代码**，在改后代码上跑会报「找不到」）、`-refl-gpu.mjs`（倒影细分）、`-rest-gpu.mjs`（倒影以外）、`-seat-fxc.mjs`（座椅内部 FXC）、`-layers-fxc.mjs`（各层 FXC）、`-seatlate-fxc.mjs`（延后调用实验）。
- 编译账本：`--ledger` 已追加（提交 a25ea62，scene-default 7850 / scene-economy 6947 / wing 7810 ms，3 轮最小值，有负载）。

## 复现

```bash
# 两个开发服务器：本分支 5212，对照 5272
node apps/voyage/scripts/passes.mjs --port 5212 --baseline 5272 --frames 60 --rounds 5 --only noon-cumulus,night-city-on,night-sea-milkyway
node apps/voyage/scripts/shader-budget.mjs --baseline <对照 voyage 根> --only scene-default,scene-economy --rounds 5 --jobs 1
cd apps/voyage && node handoff/PERF-12-ab.mjs --port 5212 --base 5272 --out tmp/screenshot/PERF-12/ab --scenes-file handoff/PERF-12-scenes.json
cd apps/voyage && bash handoff/PERF-12-abdiff.sh tmp/screenshot/PERF-12/ab
```

## 需要协调者注意

- 改了热点 scene.ts（main 的中段重排：合成权重前移、侧壁 / 内衬 / 遮光板按权重跳过、colFixed、点星门限、ReflLights 挪进窗板分支）。main.ts 未动。
- `cabin.glsl.ts` 的改动会让机翼程序（wing-pass 也拼 CABIN_COMMON / PANE_COMMON）重编一次，编出来的代码不变（离线 +0.3%）。
- 发现的工具问题（写进了 README 工具与环境）：测量锁按 worktree 根取路径，跨 worktree 不互斥。
