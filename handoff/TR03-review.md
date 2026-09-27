# TR03 · 火车远景接入 · 独立审查

- 审查对象：分支 `worktree-agent-ac14bb478e8ff993d`（3f6af34，已暂停、未合并），对照 master 226b3d1（审查结束时 master 已前进到 6900fd6，见 §5）
- 审查方式：读 `git diff master...分支`；临时工作区 `tmp/tr03rev`（master + `merge --no-ff --no-commit` 本分支）与 `tmp/tr03rev-base`（master），离线检查 + 私有浏览器（dev-browser.mjs，d3d11，RTX 5090）截图对比；审完已删除两个工作区并 prune
- 必审理由：(a) 高度 clipmap 改 32 位浮点；(b) 热点 outside-pass.ts / main.ts；(d) 新增窗外 RAIL 变体；(e) applyScene 日期记录顺序

## 结论：返工（小）

只有 1 项必须修（§1.2，R32F 高度纹理没有做「不支持浮点线性过滤」的回退，飞机模式在这类设备上会丢掉全部地形）。改动大约十几行，修完不需要重新整轮审查，协调者核对这一处后就可以合并。其余各项要么通过，要么是建议。

## 1. 飞机模式零回归

### 1.1 着色器：通过（独立复核）

- `node src/rail/shader-parity.mjs <master>`：29 个程序全部相同（outside-default / outside-ground-detail 是「预处理后逐字相同」），outside-rail 是新增程序。
- parity 工具的「预处理」会用 `resolveConditionals` 展开**所有** `#ifdef`，而且把没写在文本开头的宏都当成未定义，所以两边同一个块里的差异有可能被一起删掉、看不出来。我另写了一个更严格的比对（只展开 `RAIL` 条件，其他 `#if*` 原样保留），结果是 29 个程序与 master 的**原始文本**逐字相同；outside-default / outside-ground-detail 里各有 10 处 RAIL 钩子。可以确定，飞机程序经过 GLSL 预处理后和 master 完全一致。
- 云合成（T38 `cloudBeforeGround`）：飞机走的 `#else` 分支就是原来那一行，没有动。飞机的山脊、云边不会变化。
- 代价：原始文本变了，浏览器的程序缓存会让飞机窗外程序冷编译一次（交接文档里已写明）。

### 1.2 高度纹理改 R32F：**必须修**

`clipmap.ts` 把 `height` 改成了 `RedFormat + FloatType`，`minFilter / magFilter = LinearFilter`，但**没有判断 `OES_texture_float_linear`**。注释里写的是「three 初始化时已启用」，实际上 three 只会在设备支持时才启用它，并不能保证一定有。

- 后果：设备不支持这个扩展时，R32F 加线性过滤的纹理在 WebGL2 里是「不完整」纹理，采样一律返回 0。飞机模式的 `terrainHit`、`terrainNormal`、`terrainShadow` 和霾（haze.glsl 读 `uGroundHeight`）会看到一块平地，**富士山、所有山都会消失**。只有 CPU 侧的 `heightAt` 不受影响。
- 仓库自己有先例：`luts.ts:269`、`clouds.ts:928` 和 `main.ts:110`（HDR）都按 `ext.has("OES_texture_float_linear")` 决定用 32F 还是半精度；README 速查表「精度」一条也写着「有 `OES_texture_float_linear` 时」才用 32F。这一处是唯一没有回退的 32F 线性纹理。
- 修法建议：`GroundClipmap` 构造时传入 `floatLinear` 标志（main.ts 里已经有 `floatHdr` 可以直接用）。CPU 侧一律保留 Float32Array（`heightAt`、`coarseGrid` 精确）。不支持时，纹理用 `HalfFloatType`，在 `upload()` 里按层用 `toHalfFloat` 转成 Uint16Array 再上传。火车模式在这类设备上会退回「台地」效果，可以接受；另一条路是改成 `NearestFilter` 加着色器里手工双线性，但那样会改飞机程序，不推荐。
- 顺带把 README 坑点里「three 已启用」的说法改掉。
- 在本机（RTX 5090，支持该扩展）上 R32F 对飞机画面没有可见影响：fuji-day 合并版对 master 平均差 0.33/255，noon-cumulus 0.79/255，都低于 master 自己跑两次的噪声（1.27 / 0.77）。内存从约 0.9 MB 增加到 1.8 MB（256² × 7 层 × 4 B），每次重建上传 256 KB（原来 128 KB），相比影像的 4 MB/层可以忽略。
- 依赖高度纹理的其他路径（T02 地面细节、T38、PERF-9 Worker 合成）：只有窗外程序（ground.glsl / haze.glsl）读 `uGroundHeight`，云程序不读；高度数据在主线程解码，不经过 Worker 传输，`upload()` 用的是 `.set()`，类型变化不影响。CPU 侧从半精度改成精确值，`floor`、`coarseGrid` 最多差 0.5 m，没有可见影响。

### 1.3 main.ts 两处 `groundDetail.pick(..., rail.active)`：通过

`rail = false` 时，`pick` 跳过火车分支，`detail.prepare` 的条件 `aglKm < 4 && !rail` 等价于原来的 `aglKm < 4`，滞回和返回值与原来逐行相同。`LazyVariant` 用 `base.fragmentShader` 加上 `{...b.defines, GROUND_DETAIL: 1}`，和原来的 `prepare` 等价，编译目标 target 的处理也没有变。`createOutsideMaterial` 往共用 uniforms 里并入 4 个 `uRail*`，飞机程序不声明它们，three 不会上传。

## 2. RAIL 变体正确性

- **相对相机高度**：`railAltAlong` 的写法 `q/(√(rc²+q)+rc)` 数学上正确（等于 |p| − rc），全程不在 6360 附近相减。求交、阴影、`gh.alt` 都用相对量，只有 `groundLand` 里 `keyLight / skyIrradiance` 用的 `h = length(P) − BOTTOM` 仍是粗值，这两个量是平滑函数，没有问题。✓
- **近处 250 m 平面 → 600 m 渐变**：`railTerrainHeight` 在 r ≤ 0.25 时恰好等于平面，步进的起点 `hPrev = uRailNearGroundKm` 和它连续；基准平移在 1–4 km 内渐隐。✓
- **基准差（12 点中位数）**：mode.ts 取两侧 ±120 / ±300 m、前后 ±150 m 共 12 点，至少 4 个有效点才更新，超过 60 m 视为 0，时间常数 2 s。实现符合描述。✓
- **步长放大 / 逼近预估是否漏交、穿山**：`floorStep = k·t`（4–10%）比飞机版的 `0.004t` 大 10–25 倍，而且没有飞机版的 `dq` 上限。理论上，离视线竖直距离小于 k·t/1.5 的窄山脊可能被一步跨过去。实测方法：临时把 k 改成 0.004、`uRailSteps = 3000` 作为参考图，与交付版对比。curve 场景平均差 0.09/255。default 场景的差异只是远山轮廓上 1 像素的细线，近处的条纹是列车在等待期间蠕动造成的，见 §6。两个场景里**都没有整段山脊丢失或被穿透**。另外，细找（±12% / ±3%）在找到 `cj < 0` 时会给 occ = 1 或 cov = 1，能兜住大部分跨步。结论：可以接受。建议恢复时加一个 `uRailStepK` 调试 uniform，方便以后在陡峭线路（木曾、飞騨）上复测。
- **「没打到地形一律当天空」**：只在 `#ifdef RAIL` 里（outside-pass 的 `tGround = -1.0`、railTerrainHit 里的返回值）。飞机模式经 §1.1 确认预处理后逐字相同，**绝不会生效**。✓ 局限：火车模式里「没有海」。以后走根府川这类海岸线时需要重新处理（交接文档写了「内陆线路」，建议在 README 坑点里也写一句）。
- **步数用完时当作打在最后一步**：条件 `alt(t) < 相机海拔` 只对向下的视线成立，合理。
- **河道限宽 12 m**：mode.ts 的 `RAIL_WATERWAY_MAX_M` 注释标了「（米，估）」，交接文档和 README 也写了估值。✓ 飞机模式下是 `Infinity`，`Math.min(w, Infinity)` 不变；Worker 的 structured clone 支持 Infinity。✓ 调试 23 确认 default 场景近处那条横贯窗口的浅色带是真实的水体遮罩（与线路平行的河道），不是渲染缺陷。
- FXC 约束：新循环的上限都是 `uRailSteps` 或「常量 + `uLoopGuard`」。✓ `skyRadiance` 在火车变体里多了一个调用点，只影响火车变体。check:glsl 全过，outside-rail 用到 14/16 个 sampler。

## 3. 轮廓抗锯齿与云的覆盖率混合

- 只写在 `#ifdef RAIL` 里，飞机的 T38 路径没有动（§1.1）。✓
- 调试 26 看起来正常：红色是覆盖率，蓝色（occ）出现在层叠山脊的边上。
- 观感：default 场景的阿尔卑斯山脊边缘干净；curve 场景的地平线附近（放大 3 倍，`tmp/screenshot/TR03-review/curve-horizon.png`）仍能看到一段段 1 像素的水平台阶，还有一条贯穿窗口的 1 像素亮线（调试 23 显示是河道的水面）。交接文档已列为已知问题。按铁律，这属于**闪烁候选**，列车一动就可能爬行。不阻塞本次合并，但建议 TR05a 开工前用 `flicker` 跑一次 curve 的连拍，给出爬行指标基线。

## 4. applyScene 日期顺序

- 修复是对的：`__voyageInitialDate ??=` 挪到设置任何场景参数之前，第一个写了 date 的场景不会再被当成「初始日期」。现有回归表的第一个场景 noon-cumulus 没有写日期，所以全量跑时行为不变；只有 `--only` 以带日期的场景开头时才会得到修正。
- 两份场景表保持同步，check:glsl 的「场景表同步」通过。DX-10 的可选链和判空在 scenarios.mjs 里保留着。
- 实测：rail-oito-default（日期 2026-08-05）之后接一个不写日期的 fuji-day 副本，太阳高度、方位、位置都和单独跑 fuji-day 一致（24.3° / 249°，34.998°N 138.719°E），画面差 1.32/255，接近噪声。`vehicle: "plane"` 放在 DEFAULTS 最后，在「飞机场景跟在火车场景后面」这种顺序下也能正确切回飞机。

## 5. 与 DX-10、以及审查期间新合并的 TR07 的冲突

- 对 226b3d1（含 DX-10）：`git merge-tree` 无冲突，`merge --no-ff --no-commit` 自动合并成功。
- 审查结束时 master 已到 6900fd6（合并了 TR07）。再试一次合并：只有 **`apps/voyage/README.md` 有内容冲突**（两边都在火车坑点 / 模块表附近加了内容）。代码文件没有重叠，TR07 改的是 audio / ui / rail/audio-rail。恢复时两边都保留即可。

## 6. 离线复核与画面

| 项 | 结果 |
| --- | --- |
| typecheck | 通过 |
| check:glsl | 全部通过（含 outside-rail、sampler 表、场景表同步、README 表格） |
| shader-parity（对 master） | 29/29 相同，另有 1 个新增 |
| 严格比对（只展开 RAIL） | 29/29 与 master 原始文本逐字相同 |
| 控制台 | 所有截图轮次都没有 console error / pageerror |
| 飞机 noon-cumulus / fuji-day（合并版对 master，--freeze --settle） | 0.79 / 0.33（/255），master 自身重复的噪声是 1.27 / 0.77 |
| 火车 default / curve | 能出图，火车变体状态 ready，帧时间 5–7 ms（shots 的单次读数，只作参考） |

截图（已保存到 `tmp/screenshot/TR03-review/`）：`rail-oito-*.png`、`*-debug23/26.png`、`curve-horizon.png`、`default-horizon.png`、`refdiff-default.png`（步长参考图的差异热图）、`fuji-day-master/merged.png`。

**观感（美术总监视角）**：远景的山、霾、云层次都对，default 场景的北阿尔卑斯可信。近处 250 m 平面带目前是大块平涂的绿，curve 场景里还有迷彩式的斑块（`railNearCover`），**明显是占位**，离「近处是起点」差得很远。交接文档已经说明这一块交给 TR04 / TR05 的走廊层来画，本任务的验收口径是远景，所以不否决。但要在看板上写明：TR04 / TR05 合并之前，火车模式不适合作为展示画面。

## 7. 其他问题（建议，不阻塞）

1. **火车场景不能逐像素复现**：`teleport(s, 1, 0)` 之后列车会从 0 起步加速，截图时信息栏已经显示 4–6 km/h，`--freeze` 也钉不住列车。所以两次截图之间近处的斑块和河道都会错开（`refdiff-default.png` 里的条纹就是这个原因）。建议 RailMode 提供 `hold`（或者让 freeze 也冻结 `train`），场景 js 里调用它。
2. 第一次截 curve 时，截图那一刻信息栏显示「地面瓦片加载中（100）」：场景 js 等完瓦片后又 `teleport` 了一次，可能触发新的一批瓦片，`--settle` 没有等到。瓦片缓存热了以后第二次截图正常。建议场景 js 在第二次 teleport 之后再等一轮 `pending === 0`。
3. TRAIN.md 里的验收场景名 `rail-azumino-noon` 与实际的 `rail-oito-default / curve` 对不上，恢复时统一一下（改文档即可）。
4. 冷编译：outside-rail 只在进入火车模式时编译，不在飞机的关键路径上；权威数字按交接文档的计划留到安静窗口再测。

## 开发体验反馈

- **哪里慢**：dev-browser 的火车场景每轮约 2–3 分钟（线路数据、瓦片，加上火车变体约 19 s 的冷编译）。第一次飞机截图因为瓦片冷，位置和 master 差了 7 km（等待时间不同，飞机多飞了一段），差点被误判成回归，重跑一轮才对上。
- **哪里卡**：① `shader-parity.mjs` 的「预处理后比对」会展开所有 `#ifdef`，而且把非前缀宏都当成未定义，理论上会掩盖同一个条件块里的差异。我另写了「只展开指定宏」的严格比对才放心。建议 parity 加一个 `--only-macro RAIL` 模式，只展开新增的宏，其余原样比较。② 临时脚本放在仓库 `tmp/` 根目录时找不到 `vite`（ESM 从脚本所在目录解析包），只能挪进工作区的 `apps/voyage/` 里。③ `--freeze` 管不住列车，火车场景无法逐像素对比（§7.1）。
- **怎么绕过的**：严格比对脚本放进临时工作区执行；飞机场景各跑两次取噪声基线；步长的 A/B 用「临时改常量 + `--extra` 设 uRailSteps」。
- **希望有**：parity 的 `--only-macro`；RailMode 的 `hold` / freeze 联动；`uRailStepK` 调试 uniform；shots 输出的 json 里带「截图时瓦片 pending 数」，现在只能从 info 字符串里自己抠。
