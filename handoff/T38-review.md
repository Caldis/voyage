# T38 审查结论（独立审查代理）

- 分支：`worktree-agent-a5d0252070994f81a`（fe0e851），审查范围 `git diff master...worktree-agent-a5d0252070994f81a`
- 触发必审：(a) 云缓冲格式变了（跨模块契约）；(b) 越界改热点 outside-pass.ts / wing-pass.ts；(d) 新增采样
- **结论：通过**（有 4 条非阻塞的小问题，可合并时顺手改或记进看板）

## 1. 云缓冲的所有读取点

全仓（合并到当前 master b083dec 之后）grep `uClouds` / `clouds.texture` / `history[0].texture`：

| 读取点 | 状态 |
| --- | --- |
| `outside-pass.ts` 取云（含 `outside-ground-detail` 变体，同一份源码） | 已改 `cloudBufferColor` |
| `outside-pass.ts` 地面遮挡 | 新增 `cloudBufferDepth`（`textureLod`，在 `onGround` 分支里安全） |
| `wing-pass.ts` 雾色 | 已改 `cloudBufferColor`；`uClouds` 通过 `...sceneUniforms` 共享同一个 uniform 对象 |
| 舱内 / 倒影 / 曝光测光 / bloom | 读的是 `hdrOutside` / `hdrWing`，不读云缓冲 |
| 奇观 W00 / W02 / W03（含本分支之后合进 master 的 W03 浮空古城） | 奇观在 `marchWonderMat` 里写进 raw，不读 history；W03 没有新增读取点 |
| resolve 自己的历史 | 已按半边取 |
| `scripts/probe.mjs` 的 `cloud` 别名 | 读的是整张两倍宽的图，README 新坑点写了；脚本头注释没更新（见问题 3） |

没有漏改。master 在分支基点 f97eb59 之后合进的 T47 / T48 / W03 都没有新增读取点，试合并无冲突。

跨中缝：
- `cloudBufferColor` 把 x 夹到 `w − 0.5` 纹素，`cloudBufferDepth` 夹到 `[0.5, w − 0.5]`，双线性过滤不会取到另一半；左边缘靠 ClampToEdge。
- resolve：邻域 3×3 读的是单倍宽的 `raw` 和深度附件，不跨半；`fc` 已减掉半边偏移，`cabinRay` 用 `fc` 重建方向，两半的重投影一致；历史取样 `hx` 按半边夹 `[0.5, w − 0.5]` 再加偏移。
- `setSize` 只把 history 设成 `2w`，`raw` / `wonderSurf` / `uCloudResolution` 仍是 `w`，resolve 里的 `gl_FragCoord.x >= uCloudResolution.x` 判断成立。

## 2. 深度编码精度

- 存的是 (深度 × 不透明度, 不透明度)，深度 ≤ 400 km。支持浮点线性过滤时 history 是 32 位浮点（T46）；退回半精度时最大 400，远小于 65504，相对精度约 1e-3，对 1.0–1.3 的比值门限够用；不透明度 1e-3 仍是半精度的正规数。
- 相除用 `max(d.y, 1e-4)`：不透明度 < 1e-4 时 D 被压小，结果是 k = 1 保留云，而这时云本来就几乎透明，没有风险。
- 邻域夹取对两个通道**分别**夹，夹出来的 (x, y) 可能不是任何一个真实像素的组合。我推了一下上界：x 只会被夹到 `mn.x` 以上或 `mx.x` 以下，y 同理，而 `mn.x ≤ 400·mn.y`，所以夹完 D 仍 ≤ 400 km，不会产生离谱值；云边上 D 会有一些偏差，属于可接受的时间累积误差。
- 步进里的 `depth` 本来就是按 T·(1 − stepT) 加权的平均深度，resolve 再乘不透明度累积，两层加权含义一致。

## 3. 「云深度 ÷ 地面距离」渐变

- 只在 `onGround`（`uGroundOn` 且 `groundHit` 命中）时执行：天空像素、没开真实地理的开阔海面都不经过。
- 真实地理里的海面也是 `onGround`，但视线打到海面之后不可能再有云（已在云底以下），D ≤ tGround，k = 1，不受影响。
- 奇观像素：`wonderSky` 改的是背景 L，`cloudBeforeGround` 只改 cloud；W00 的奇观表面写进了云深度，奇观在山后时也会被去掉，这正是对的。
- 问题 1（非阻塞，观感）：门限是相对值 1.0–1.3。山在 38 km 时，D = 45 km（1.18 倍）的云仍保留约 35%；山在 150 km 时要 195 km 以外的云才完全去掉。山脊正后方贴着的云会以半透明的形式透到山前。可以考虑绝对量和相对量取小，例如 `smoothstep(t, t + min(0.3t, 5 km), D)`，或者用空着的 B/A 通道存第二矩再判断（handoff「还不够好」第 1 条已提到）。这次的截图场景里看不出来，不阻塞合并。

## 4. T44 遗留（台风塔）

- `gLightLen` 只在雷暴 / 台风那条（不展开的）受光循环里赋值，循环结束就清零；它只在 `HUR_BANDS_LIGHT` 里读取。普通积云的展开循环、云影图、占据网格、探针调用精简密度时都是 0，等价于原来的 `smoothstep(0, 0.35)`。
- 腰身写在 `bandTowerSdf` 里，只有台风雨带塔会调用（完整版和受光版共用，形状一致）；半径最多 ×1.115，还在 `rho > 1.6·Rt + 2.5` 的剔除半径以内。这个 SDF 只进 smoothstep 算密度，不用来跳步，所以不存在 Lipschitz 失真的问题。
- 环境光的改动要求 `nearHur`（`uHurricane.w > 0.5`），雷暴场景和普通积云不受影响。
- 问题 2（非阻塞，文档与范围）：条件是 `nearHur && stormW > 0.5 && 离台风中心 > 2.5Re`，覆盖的是眼外**所有**风暴云，包括裙边、砧、螺旋雨带，不只是塔身。砧在 9–13 km，原来按 0–20.5 km 归一化时 h01 约 0.5，现在约 1，变亮了。截图里的砧看不出问题，但 handoff 和注释写的是「眼外塔」，应当改成「眼外的风暴云」，免得后人误判影响范围。
- 重函数调用点：`cloudDensityLite` / `hurricaneDensity*` 的调用点数量没变；没有新增循环。窗外程序只增加了 `cloudBeforeGround`（很轻）和一次 `textureLod`。

## 5. 静态检查（试合并到 master b083dec）

- `pnpm --filter voyage check:glsl`：全部通过；outside-default / outside-ground-detail 用了 14/16 个 sampler（没有增加），scene 用了 5/16；wing、cloud-resolve 语法检查通过。
- `pnpm --filter voyage typecheck`：通过。
- 临时 worktree 已删除并 prune。

## 6. 画面（兼美术总监视角）

- `final-fuji.png` / `fuji-dawn-c30`：改前是一条远处的云带横切山腰，山顶像浮在带子上；改后富士山整座露出来，山前的积云带完整保留，山体轮廓处没有光晕，也没有断开的云边。云量 0.05 的前后几乎一样（本来就应该不变）。**铁律「随机性 / 真实感」上是明显进步。** 山体轮廓的台阶锯齿是地面 clipmap 的老问题，不属于本任务，但它现在更显眼了（山更完整），建议排进地面任务（违反「宁可小，不要糊 / 锯齿优先」）。
- `final-typhoon.png`：左边那座近塔，下半截的「拱洞」暗块和半腰的水平分界没有了，侧面有了一节节的起伏，不再是直筒。代价是整座塔的明暗对比变弱，读起来更「软」、更平。另外塔身背光面上有一些圆形的浅色斑点（隆起的亮顶），分布比较规整，近看有点像贴上去的圆片（改前就有，这次因为整体变亮而更明显）。问题 4：可以交给下一轮台风观感任务处理，不阻塞。

## 需要改的小问题（都不阻塞）

1. 相对门限 1.0–1.3 在近山时会让贴在山脊后面的云半透明地透出来（见 §3），建议改成绝对量和相对量取小，或者上第二矩。
2. 环境光归一化的作用范围是「眼外所有风暴云」，不只是塔，注释和 handoff 要改成准确的说法（见 §4）。
3. `outside-pass.ts` 的 uniform 注释写的是「右半 R 云的平均深度」，实际是 RG = (深度 × 不透明度, 不透明度)；`scripts/probe.mjs` 头注释里的 `cloud` 别名也应当补一句「T38 起两倍宽，右半是深度」。
4. 近塔背光面的圆形斑点，以及塔的整体对比偏平（观感，见 §6），留给后续台风任务。

另：handoff 已经如实记下 resolve +0.02–0.06 ms，以及可以只读 A 通道的精简做法，同意列为后续优化。

## 开发体验反馈

- 在 scratchpad 里建的临时 worktree 路径太长（约 250 个字符），`check:glsl` 用 Node `spawnSync` 调 glslangValidator.exe 时报 ENOENT，所有程序都显示 `[FAIL]` 而且没有错误信息，很容易被误判成着色器坏了。直接在 Git Bash 里跑同一个 exe 是正常的。改到 `D:\Code\opus-test\tmp\t38rev-merge` 后通过。建议：`lint-shaders.mjs` 在 spawn 出错（`res.error`）时打印错误并提示「路径过长」；SOP 里的审查模板把临时 worktree 放在 `tmp/` 下，不要放 scratchpad。另外 `git worktree move` 不能跨盘。
- scratchpad 根目录里有别的代理留下的 `bisect.py`，它会遮蔽 Python 标准库的同名模块，导致 `from PIL import Image` 在导入 `random → bisect` 时崩掉。要用 `python -P` 才能绕开。建议别的代理的脚本加上前缀（本身就有这条约定），或者统一用 `python -P` 跑。
- `check:glsl` 的 sampler 统计只覆盖 scene / outside，不含 wing；这次 wing 没有增加 sampler，但以后改机翼时就查不出来，建议把 wing 加进统计。
