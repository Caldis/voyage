# WS05（建木巨构化）轻量审查报告

**结论：通过。** 分支 `worktree-agent-a6c955395377e41aa`（f817cec）合并到当前 master（复核时 6fbcf08，WS04 已合并）无冲突；共用函数改动对天梯是恒等的（代码论证成立，且用噪声底校准过的像素级对照确认差异落在跨端口渲染噪声范围内，不是回归）；非奇观场景窗外默认程序预处理后与 master 逐字相同；奇观变体不在冷启动批次；typecheck / build / check:glsl / 控制台全部通过，0 字节文件检查通过；与在途 WS04 / TW02 无文件级冲突，WS08 尚未开始实质改动。

审查方式：只读 diff + 独立复核 worktree `D:\Code\opus-test\tmp\ws05rev`（已按约定自行删除），未改代码。

## 1. 共用函数改动对天梯的影响 —— 通过

`wonderStrut`（`apps/voyage/src/render/wonder-sky.glsl.ts`）新增两个 `out` 参数（`perpO`、`uO`）与残差校验：

```glsl
uO = (sig - sa) / span;
float u = clamp(uO, 0.0, 1.0);
...
float res = abs(sig - s - k * r) * sn;
return (u == uO && res < 2.0 * wPix) ? wonderStrip(perpO / wPix, mix(thA, thB, u) / wPix) : 0.0;
```

- 牛顿迭代循环体本身逐字未改（对照 master 同函数确认），唯一变化是循环结束后新增的 `res < 2.0 * wPix` 门槛。
- 天梯稳定缆的唯一调用点固定 `bend = 0.0`（直线撑杆），此时 `r(u)` 对 `sig`是仿射关系，牛顿法对仿射函数任意起点一步收敛，两步迭代后残差只剩舍入误差，恒远小于 `2·wPix`，门槛不生效——与交接文档的论证一致。
- `wonderCapRef` 只在建木（非天梯）分支被调用；天梯分支在 `if (tether) { ... return L; }` 内提前 `return`，代码路径上不可达。
- 逐字比对了 `if (tether) { … return L; }` 整段代码块（master 行 475–587 对 review 分支行 562–674）：**逐字节完全相同**（`diff` 输出为空），塔身、四层环站、旗云、灯组、`cc` 变量的赋值与使用全部未动。

**像素级复核（关键，因为实现者只给了代码论证）**：在独立 worktree（master 合并 WS05 之后，端口 5287）与主分支（端口 5181，6fbcf08）上，用固定种子 `seed=0.37`、`distKm=220`、固定机位、`coverage: 0`（完全关云，避开云噪声）、`__voyage.freeze` 冻结，对 `ws-tether-noon`、`ws-tether-night-up`、`wonder-tether-dusk` 三个场景逐像素比较：

| 场景 | master vs 合并版 | 噪声底（master vs 另一个独立 master 进程，同代码） |
| --- | --- | --- |
| ws-tether-noon | 均差 0.59/255，最大 59.67，超阈值(8) 1.436% | 均差 0.54/255，最大 59.67，超阈值 1.158% |
| ws-tether-night-up | 均差 0.14/255，最大 150.67，超阈值 0.058% | 均差 0.30/255，最大 164.33，超阈值 0.281% |
| wonder-tether-dusk | 均差 0.23/255，最大 61.33，超阈值 0.204% | 均差 0.22/255，最大 46.33，超阈值 0.30% |

用两个**完全同代码**的 master 独立进程（5181 对 5289）做了噪声底对照：三个场景下"master vs 合并版"的差异与"master vs master"的噪声底在同一量级（night-up 场景甚至合并版比噪声底更小）。这与仓库已知坑点一致（DEV_SOP："非奇观场景 noon-cumulus 跨端口本身就差 5/255"）。结论：**天梯渲染无可归因于 WS05 的回归**，差异是跨进程/跨端口渲染噪声（推测与抗锯齿边缘的亚像素抖动或 GPU 上下文相关，不随帧数收敛），不是代码改动引入的。

## 2. system.ts 的 `uWonderShape.w` —— 通过

```ts
u.uWonderShape.value.set(look.radiusKm, front, look.skin, look.beacons ? 1 : -a.seed);
```

- 该行只在 `a.def.layer !== "cloud"` 时才会执行（`syncUniforms` 里 `if (a.def.layer === "cloud") { this.syncVolume(...); return; }` 提前返回）；`layer: "sky"` 的奇观目前只有 `tether`（`beacons: true`）与 `jianmu`（`beacons: false`）两个，`fogcity` / `floatcity` / `w00-probe` 都是 `layer: "cloud"`，根本走不到这一行，**不受影响**。
- `tether` 的 `beacons` 恒为 `true`，三元表达式恒定求值为字面量 `1`，与 seed 无关——不是"有条件地不变"，是**代码结构上不可能变**。
- `jianmu` 的 `beacons: false`，取 `-a.seed`；`a.seed` 来自 `rand01()`，值域 `[0,1)`，故 `-a.seed` 恒落在 `(-1, 0]`，不会与天梯用到的 `1`、也不会与着色器里 `uWonderShape.w > 0.5` 的两处航标灯判断（489、549 行）产生混淆。
- 着色器侧 `jSeed = -uWonderShape.w` 还原出建木的种子；确认了 `uWonderParams`（另一条本可以带 seed 的通道）只在 `syncVolume`（`layer === "cloud"`）里赋值，天梯/建木所在的 `sky` 层管线确实没有别的现成通道能带 seed，复用 `.w` 的做法有必要性依据。
- 截图 JSON 元数据里天梯场景返回 `"天梯 · 停留 · 方位 90° · 220 km · 塔高 34.8 km · 环站 5 只"`，渲染完整（塔、环站、灯组均正常出现），印证 `.w=1` 分支未被破坏；建木截图（见下）渲染出与 seed 相关的、不同尺寸的树，未与天梯混淆。

## 3. 非奇观场景：窗外默认程序逐字不变 —— 通过

用 `scripts/shader-parity.mjs --base <主分支 apps/voyage 目录>` 枚举全部着色器程序做真预处理对照：

- `outside-default`：预处理后逐字相同（原始文本因宏/ifdef 钩子不同，属预期）。
- 仅 `outside-extras`、`outside-ground-detail`、`outside-rail` 三个含 `OUTSIDE_WONDER` 的变体不同，首处差异行正是 `wonderCapRef` 的新增与 `wonderStrut` 的签名变化——符合预期，不是意外扩散。
- 其余全部程序（`scene-*`、`seat-*`、`wing*`、`cloud-*`、`ocean-*`、`exposure-*`、`atmosphere-*`、`rays-*`、`wonder-layer`）逐字相同。

`check:glsl`（`lint-shaders.mjs`）里 "窗外默认程序不含罕见光学 / 天幕层奇观代码（PERF-13）" 断言通过，双重确认默认程序不含奇观代码。

## 4. 冷启动批次 / 构建 / 控制台 / 在途分支冲突 —— 通过

- `dev-browser.mjs cold --port 5287`：`窗外材质的程序数: 1`（只有 `outside-default` 进冷启动批次），真实硬件渲染（`ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 …) D3D11`，非 WARP 软渲染）。
- `pnpm --filter voyage typecheck`：通过。
- `pnpm --filter voyage build`：通过；`dist/assets` 无 0 字节文件（只有 5 个非空产物）。
- `check:glsl`（`lint-shaders.mjs`）：全部断言通过，含场景表同步（`scenarios.mjs` ↔ `regression.playwright.js`）与 sampler 数核对。
- 控制台：天梯三场景截图、建木六场景截图（`handoff/WS05-scenes.json`）期间均 **0 条 console error / pageerror**。
- **merge-tree 冲突核查**（`git merge-tree --write-tree`）：
  - WS05 → 当前 master（含已合并的 WS04）：**干净合并**，`catalog.ts` 里 `jianmu` 与 `floatcity` 两个条目都完整保留，无损坏。
  - WS05 → TW02（`worktree-agent-a153ee093663d3a16`，仍在 WIP）：文件集合零重叠（WS05 只碰 README / handoff / `wonder-sky.glsl.ts` / `catalog.ts` / `system.ts`；TW02 碰 `far-towers.ts`（新文件）/ `clouds.ts` / `main.ts` / `weather-director.ts` / `weather.ts`），`master+WS05` 再合并 TW02 **干净通过**。（注：WS05 分支自身 vs TW02 分支直接 merge-tree 会在 `main.ts` 报冲突，但核实后那是 TW02 与已进 master 的 STROBE-CLOUD 之间的既有冲突，与 WS05 无关——WS05 分支自己完全不改 `main.ts`。）
  - WS08（`worktree-agent-ab85d31a7f01a2786`）：复核时相对 master **diff 为空**，尚未开始实质改动，无冲突可言，需等它落地后再核。

## 附：复核环境

- worktree：`D:\Code\opus-test\tmp\ws05rev`（`git -C <路径> merge --no-commit worktree-agent-a6c955395377e41aa` 于 master 6fbcf08 之上，`Automatic merge went well`）+ `pnpm install`，端口 5287；噪声底对照用纯 master worktree `tmp\ws05rev-mbase`，端口 5289。审查结束后两个 worktree 均已用 `git worktree remove --force` + 手动清理残留目录删除，未改动、未删除实现者的任何文件。
- 截图与对照数据留在 `tmp/screenshot/ws05rev/`（已在 `.gitignore` 范围内，未提交）。
- 全程使用真实 GPU 渲染（ANGLE D3D11，NVIDIA RTX 5090），未触发软渲染回退。

## 需要协调者关注（非阻塞，仅记录）

- system.ts 的 `uWonderShape.w` 复用是"归属外一行"，交接文档已标注需要协调者确认——按上面第 2 节的分析，这行改动是安全的，可以确认接受。
- 冷编译 OW 变体 +13–22%（超个人任务 10% 门槛，交接文档已自报），需要在波次收尾时按 SOP 的"一波累计 ≤15%"门槛统一复核，不是本次轻量审查的范围（本审查只确认奇观变体没有意外进入冷启动批次）。
