# PERF-13 审查 · 窗外程序冷编译回收

- 审查对象：分支 `worktree-agent-a9821ca63ea19ce23`（8f57d38），`git diff master...分支`（合并基 7a3273e）。
- 审查方式：只读 diff；临时工作区 `tmp/perf13rev` = master（ec2a704）+ `merge --no-ff --no-commit` 本分支，审完已删（node_modules 联接先拆）。
- **结论：通过。** 下面有 3 条不阻塞的建议和 1 条合并提示。

## 1. 变体选择

| 检查项 | 结论 |
| --- | --- |
| `wantedOutsideKey` 是不是唯一的入口 | 是。`GroundDetailVariant.pick` 每帧调用它一次，拿到「想要的键 + 退路」。main.ts 的两处调用（`renderFrame`、`benchScene`）都改成了 `pickOutside()`，全仓库已经没有别的地方直接选 `outsideMat` 来画窗外（`outsideMat` 另外只出现在启动编译批次、程序计数和 `__voyage` 调试句柄里）。唯一不经过选择函数的是首帧后 90 帧无条件预编 `OW`，这只是编译，不决定画哪个变体。 |
| `""` / `OW` / `DOW` / `DROW` 能不能覆盖所有状态 | 能。火车 → `DROW`；低空细节开着 → `DOW`；巡航时要光学或奇观 → `OW`；其余 → `""`。关掉真实地理数据时高度传 Infinity、火车传 false，所以只会落到 `""` 或 `OW`，与 master（直接画带 O/W 的 `outsideMat`）一致。画质档不改窗外的 defines（全仓库 grep `.defines` 只有两处变体构造），切档不会让变体失效。奇观模式开着、又在低空或火车上时，`DOW` / `DROW` 本身就带 O 和 W。 |
| 变体没编好时，正在显示的奇观会不会突然消失 | 实测不会。临时工作区 d3d11 冷缓存：巡航画 `OW`、天梯在场，这时把高度压到 3 km → `DOW->OW`（`DOW` 还在编，退到 `OW`，`uWonderOn=1`），约 14.5 s 后变成 `DOW->DOW`。整个过程没有退到 `""`。原因是只要想要 O/W，退路链里就有 `OW`；`OW` 一旦编好就一直可用。理论上还有一个窗口：在低空启动、`DOW` 先于 `OW` 编好、奇观已经出现，然后在 `OW` 编好之前爬升到 4.5 km 以上，奇观会暂时消失。但 `OW` 编译（约 9–12 s）一般比 `DOW`（约 12–15 s）先完成，而且爬升 0.5 km 要几分钟，所以实际上碰不到。 |
| 关掉真实地理数据时奇观 / 光学是否照常 | 实测正常：`groundOn=false` 并召唤天梯后 → `wanted=OW shown=OW wonderOn=1 pending=false`。 |
| `opticsWanted` 的上界是否保守 | 保守。我逐项核对了着色器的覆盖公式：smoothstep 的最大斜率是 0.75，所以每段带子遮挡的比例 ≤ 0.75·2w/b × (len+2w)/(2b)，Π(1−cᵢ) 的补 ≤ Σcᵢ，合起来 ≤ 0.375·Σ2w(len+2w)/b²。按几何重算 Σ2w(len+2w) = 168 + 137 + 27 + 22 ≈ 354 m²，≤ 360；投影到垂直阳光的平面只会让长度变短，所以代码里取 0.4 × 360 是上界。CPU 用 `sunY`，着色器用逐像素的 `−rd.y`：影子只画在反日点附近 45 m + 1.5b 以内，那里 `−rd.y ≈ sunY`，两边都有 0.02 下限。宝光和晕只要强度 > 0 就选 `OW`。`uWonderOn` 只取 0 或 1（`wonders/system.ts` 的 `syncUniforms`），判据 `> 0.5` 没有问题。optics / wonders 的 update 在 `pick` 之前执行（main.ts 427、444 行，然后才是 532 行），读到的是本帧的值。 |
| 阈值附近会不会闪 | 两个变体都编好之后，`OW` ↔ `""` 的切换最多丢掉 0.2% 的影子压暗（白云上不到 0.5/255），看不出来。 |

## 2. 默认程序

- `check:glsl` 全部通过，共枚举 42 个程序（新增 `outside-extras`），新断言 1c 通过。
- **断言是有效的**：我把 `WONDER_SKY_COMMON` 外面那层 `#ifdef OUTSIDE_WONDER` 删掉，1c 立刻 `[FAIL] outside-default：预处理后仍含 wonderSky, wonderStrut, wonderSpheroid, uWonderOn`；恢复后通过。
- 又用 glslangValidator `-E` 预处理了默认程序，搜 `optics*|OPTICS_*|wonder*|bessel*|uSeatSign`，只剩 `OPTICS_AIR_DISPERSION OPTICS_HORIZON_REFRACTION opticsComposite opticsSunDisk opticsTrueHeight uOpticsFlash`，也就是太阳盘、绿闪和合成函数本身。`OW` 程序里 J0/J1、`opticsGlory`、`opticsPlaneShadow`、`opticsHaloRadiance`、`wonder*` 全都在。
- 太阳盘和绿闪留在默认程序里是对的：太阳常驻，消融只占 −2%，而且蜃景 / 色散（`uOpticsFlash`）没有像宝光、晕那样的「强度为 0」开关，拆出去就得每个日落都切变体。
- **与 master 逐字相同**：我用 `PERF-13-parity.mjs` 对**当前 master**（已含 C01+C02、G01-03）复跑，`OW` ↔ master outside-default（1849 行）、`DOW` ↔ master outside-ground-detail（2131 行）、`DROW` ↔ master outside-rail（2296 行）三对全部逐字相同；默认程序 1418 行。`opticsComposite` 的 `#else` 分支 `L*cloud.a + cloud.rgb`，在因子为 1、晕为 0 时与变体在浮点上完全相等，推导成立。

## 3. main.ts 的 3 行

- `pickOutside = () => groundDetail.pick(renderer, groundOn ? altitudeKm : Infinity, groundOn && rail.active)`。关掉地理数据时 `active` 立刻变成 false（Infinity > 4.5），不会进入 `DOW` / `DROW`，和 master 一样不画低空细节和火车远景。飞机和火车在这个模式下画的内容与 master 相同（master 画的就是带 O/W 的完整默认程序，也就是现在的 `OW`），区别只有：`OW` 编好之前的约 10 s 里，O/W 暂时不画。
- 火车模式的退路是 `DROW → DOW → OW → ""`，与 master 的 `rail → detail（若已编好）→ base` 等价。火车模式下不会主动编 `DOW`，这一点也和 master 相同。
- 我的两张检查截图在 `tmp/screenshot/PERF-13-review/`（`a-ground-off-tether.png`、`b-low-tether.png`）。

## 4. 脚本等待

- `scenarios.mjs` 和 `regression.playwright.js` 的等待都有上限：先跑 2 帧（rAF），然后最多等 480 × 250 ms = 120 s，不会一直等下去。`pending` 在变体编译失败时返回 false，不会因为失败卡满 120 s。冻结只跳过 `clouds.render`，`pick` 仍然每帧执行，所以 `wanted` 不会停在旧值上。
- 它和 PERF-10 的 `cloudVariantPending` 是先后两段，彼此不冲突。两边的编译在后台同时进行，所以第二段通常很快就结束。实际代价只是每个页面的第一个白天巡航场景冷缓存多等约 10 s。
- 小瑕疵：如果某一帧 `opticsWanted` 恰好落到 `""`，等待会提前结束，但丢掉的只是 < 0.2% 的影子，不影响对比。

## 5. 冷启动数字

- 审查时机器负载高：CPU 约 60%，另有 38 个 chrome、30 个 node 进程，还有其他代理在跑。按简报这种情况只作参考，所以**没有复测 `dev-browser cold`**。
- 离线侧的证据已经够强：`OW` / `DOW` / `DROW` 三个变体与 master 对应程序逐字相同，默认程序预处理后从 1849 行降到 1418 行，拿掉的正好是消融里 −34~38% 的那两块。「真冷启动 13.4 → 11.1 s」是有负载时交替 5 轮取的最小值，方向可信，具体数字请在波次收尾的安静窗口由性能工程师复测后再写进账本。
- 顺带一个旁证：审查浏览器冷缓存下 `OW` 在启动后约 11.6 s 编好，与交付说的 10–12 s 一致。控制台没有 error；warning 只有 FXC 的 X4000「可能未初始化」，master 上本来就有。

## 不阻塞的建议

1. **冷启动后光学「跳出来」**：白天在云上冷启动的前约 10 s 没有宝光和本机影子，`OW` 编好后是在一帧之内出现的，没有渐变。云顶很近时宝光和影子都明显，这个跳变能察觉到。建议以后让 `optics.ts` 在 `shown` 从 `""` 变成 `OW` 时，把 `uOpticsGlory.x` 和影子压暗程度用约 1 s 渐显（纯 CPU 端，不增加编译）。这一条与 `?optics=all` 要等约 10 s 是同一个根因，交付第 4 条已经记了。
2. **`probe.mjs --patch` 的 `"outsideMat"` 在白天巡航时改不到实际画出来的程序**：屏幕上画的是 `OW`（`groundDetail.extrasMaterial`），也就是 `groundDetail.variants.get("OW").material`，而不是 `outsideMat`。建议在 README 调试节或 `probe.mjs` 头注释里补一句：补丁 `outsideMat` 前先看 `__voyage.groundDetail.variantStatus.shown`，或者让 probe 同时给已编好的变体打补丁。低空的 `DOW` 以前就有这个问题，现在白天巡航也会遇到，所以更常见了。
3. 火车模式下仍会在第 90 帧后台预编 `OW`，和 `DROW` 抢编译线程，可能让火车远景晚到一点。影响小，可以不改；要改的话，可以在 `rail` 期间推迟 `OW` 的预编。

## 合并提示

- master 已前进到 8c2483b（PERF-12 已合并）。`git merge-tree` 显示只有 `README.md` 和 `research/compile-ledger.json` 两处文本冲突，代码文件（main.ts 等）都能自动合并。合并后重跑一次 `check:glsl`，确认 README 的 sampler 表与 PERF-12 的改动一致。

## 开发体验反馈

- **哪里慢**：临时工作区的 `pnpm install` 加 `check:glsl`（42 个程序）约 3–4 分钟，主要耗在 check:glsl 上；浏览器实测冷缓存要等 `OW`（约 12 s）和 `DOW`（约 15 s）编完。
- **哪里卡**：(1) 写在工作区根目录的临时 `.mjs` 解析不到 `vite` / `glslang` 依赖（ERR_MODULE_NOT_FOUND），必须放进 `apps/voyage/` 下。(2) `git worktree remove --force` 删不掉带 pnpm 联接的目录，要先删掉所有重解析点，再 `Remove-Item` 并 `worktree prune`。(3) 当时 master 被检出在主工作区，建临时工作区要加 `--detach`，SOP 里已经写了。
- **希望**：`PERF-13-parity.mjs` 这种「变体与改动前程序预处理后逐字比较」的做法很好用，建议泛化成 `scripts/` 下的通用工具（参数是程序 id 对），以后拆变体的任务都能直接用。`variantStatus` 调试句柄很方便，审查时用它一眼就能看到退路链。
