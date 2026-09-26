# SC-4 · 云程序与场景并行编译：交接

- 分支：`worktree-agent-a274eca7fda8b5e02`（基于 master，中途 `git merge master` 两次，合到了 SC-1+2、SC-3、T04「台风打磨」之后的 `0231cd1`）
- 状态：**已交付**，等审查。只改了 `apps/voyage/src/main.ts`（启动编排段）、`apps/voyage/src/boot/progress.ts`、`apps/voyage/src/boot/timings.ts`、`apps/voyage/index.html`。**没有碰 `src/clouds/*` 一个字符**（T04 归属），也没碰 `scene.ts`（SC-3 归属）。
- 开发服务器：本任务用 5254（`cd apps/voyage && pnpm exec vite --port 5254 --strictPort`）。

## 改了什么

原来的启动编排（T16 留下的写法）：`renderer.compileAsync` 只把场景（`sceneMat`）和机翼（`wingMat`）两个程序放进同一批后台编译；云光线步进程序（`Clouds.marchMat`）要等这一批编完之后，**单独调用一次 `clouds.render()` 强制触发编译**（同步阻塞，约 7~10 秒，视云层复杂度），编完立刻用 `clouds.snap()` 撤销这次「假调用」在时间累积上留下的痕迹。

SC-4 把 `marchMat` 和它的时域累积 resolve（`Clouds.resolveMat`，同样会在首次使用时同步编译）也塞进和场景/机翼**同一批** `compileAsync`：

```ts
const batch: ReadonlyArray<readonly [THREE.ShaderMaterial, THREE.WebGLRenderTarget]> = [
  [sceneMat, hdr],
  [wingMat, hdrWing],
  [cloudsInternal.marchMat, cloudsInternal.raw],
  [cloudsInternal.resolveMat, cloudsInternal.history[0]],
];
```

四个材质各自绑定自己真正要画进去的渲染目标再发起编译（和原来场景/机翼的写法完全一致的理由：ANGLE 的 D3D11 后端按链接时绑定的帧缓冲生成像素着色器的输出布局，绑错要在首帧同步重编一遍）。`Promise.all(jobs)` 一起等，编译在驱动侧并行。

编译批次 resolve 之后，不再需要 T16 那种「假渲染 + `clouds.snap()` 撤销」——因为现在根本没有在真正首帧之前调用过 `clouds.render()`，`Clouds` 内部的 `reset` / `frame` / `history` 状态从头到尾没被碰过，真正首帧本来就是干净的第一帧。**但见下面「新发现的问题」，实际上还是保留了一次触发调用**，原因见那一节。

### 访问 `clouds.ts` 私有字段的方式

`marchMat` / `resolveMat` / `raw` / `history` 在 `Clouds` 类里都是 `private`（`clouds.ts` 归 T04，本任务约定不碰）。TypeScript 的 `private` 是编译期检查，`class` 字段本身（不是原生 `#私有字段`）在运行时就是普通的可枚举属性，所以用一次类型断言就能读到，不需要改 `clouds.ts`：

```ts
interface CloudsInternals {
  marchMat: THREE.ShaderMaterial;
  resolveMat: THREE.ShaderMaterial;
  raw: THREE.WebGLRenderTarget;
  history: THREE.WebGLRenderTarget[];
}
const cloudsInternal = clouds as unknown as CloudsInternals;
```

**这是权宜之计，不是理想状态**。等 T04 收敛、clouds.ts 稳定下来之后，建议给 `Clouds` 补一个正式的公开方法（而不是把四个字段整体公开），例如：

```ts
// clouds.ts 里加一个方法（不改现有字段的可见性）
/** 供启动编排用：把云光线步进 / resolve 两个程序绑进它们各自真正的渲染目标，返回 compileAsync 需要的 [材质, 目标] 对 */
warmupTargets(): Array<[THREE.ShaderMaterial, THREE.WebGLRenderTarget]> {
  return [
    [this.marchMat, this.raw],
    [this.resolveMat, this.history[0]],
  ];
}
```

`main.ts` 那边就能换成 `clouds.warmupTargets()`，不用类型断言。这个小改动建议随手带上，风险很低（新增方法，不改现有签名），但按约定本任务没有直接改 `clouds.ts`，留给 T04 或协调者定夺。

## 新发现的问题：compileAsync 批次 resolve 之后，第一次真正 render() 仍会同步卡住约 3~5 秒

排查「首帧渲染」阶段莫名变慢时发现的，**和 SC-4 的改动本身没有因果关系，是一个更底层、之前一直被掩盖的现象**：

- `renderer.compileAsync(...)` 内部只是提交编译/链接命令然后轮询 `COMPLETION_STATUS_KHR`（非阻塞），`Promise.all(jobs)` resolve 时四个材质的 `isReady()` 确实都是 `true`（用 `renderer.properties.get(mat).currentProgram.isReady()` 单独验证过）。
- 但是：**批次刚 resolve 之后，第一次真正调用 `renderer.render()`（不管是哪个材质）都还会额外同步卡住主线程约 3~5 秒**。用 `performance.now()` 把 march 和 resolve 的首次渲染分开单独计时：march 自己只要 8~15 ms（远小于它在 T16 时代的真实编译时间，说明 compileAsync 确实把编译本身的开销吃掉了），卡住的是"这批编译完之后第一次真正 `render()`"这件事本身——换成先渲染谁、渲染几次，卡住的永远是第一次，和具体材质无关。
- 验证过它不是「material 特有」：把手动触发的材质从 `march+resolve` 换成只有 `march`，卡顿准时挪到了下一个真正的 `render()`（`ocean.update()`，日志里显示为「海面 FFT 程序编译」从 100~200 ms 涨到 3.4~4.2 s）；完全不手动触发，则挪到「首帧渲染」阶段（从 ~0.9 s 涨到 4.6~5 s）。三种摆法总时长的「尾巴」（`shaders` 阶段结束之后到首帧画完的全部耗时）基本不变，只是名字换了。
- **这不是 SC-4 引入的新问题**：master 原来的写法（`clouds.render()` 触发编译 + `snap()` 撤销）里，这笔开销一直存在，只是和 march/resolve **从零开始的真实编译时间**叠在一起，从来没有被单独观测到——T16 的交接文档里那句「云光线步进这一步本身仍会卡住主线程约 7 秒」，实际上是「真实编译时间」+「这笔约 3~5 秒的开销」的总和。
- 怀疑的根因（没有再往下查，超出这次的时间预算）：ANGLE/D3D11 把一大批并行编译的结果第一次整合进设备状态（可能是创建 input layout / shader reflection，也可能是把新编译的着色器写盘进 GPU 进程自己的磁盘缓存）有一个不受 `KHR_parallel_shader_compile` 覆盖的同步开销，和场景着色器本身大小无关（SC-3 把场景编译从 71 s 压到 19 s 之后，这笔开销的量级几乎没变）。**建议开一个新的 DX 专项去查**（可能需要 `chrome://tracing` 或者去问 Chromium/ANGLE 的 issue tracker），这次没有再深入。

**应对方式**：既然这笔开销跑不掉，干脆主动触发一次（`pass.render(marchMat, raw)` 紧接着 `pass.render(resolveMat, history[0])`），让它落在语义还算贴切的「云光线步进程序编译」阶段里，而不是任由它随机砸到「海面 FFT」或「首帧渲染」——那样反而会让以后排查的人怀疑错了地方。

**这意味着验收标准里「`__voyageStartup` 里「云光线步进程序编译」≤ 0.5 s」这一条严格来说没有做到**：这个 tick 现在只反映「已经不用再等 march/resolve 从零编译」，但仍然包含上面这笔约 3~5 秒的开销。**真正实现的验收是「省下真实编译时间」，不是「这个阶段完全消失」**——见下面的数字。

## 数字（d3d11，RTX 5090，本机 GPU 全程有其他代理并发占用，噪声较大，均为真冷启动、各测一次或两次配对对照）

测的是**当前 master**（含 SC-3「海面只内联一次」+ T04「台风打磨」之后）的状态，不是这次改动开始时的旧 master——中途 master 已经合并了别的任务，本文档的数字已经按最新基线重测过。

| 阶段 | master（不含 SC-4） | 本分支（SC-4） |
| --- | --- | --- |
| 场景 / 机翼着色器编译（后台，`shaders`） | 20.1 s / 20.8 s（两次） | 21.6 s / 22.5 s / 19.4 s（三次） |
| 云光线步进程序编译（`cloudMarch`） | **9.4 s / 10.2 s**（从零编译，含上面那笔约 3~5 s 的「结算」开销） | **4.8 s / 4.8 s / 4.9 s**（编译已经并进上一批，只剩「结算」开销） |
| 海面 FFT / 曝光眩光 / 首帧渲染（三项合计） | 1.0 s / 1.1 s | 1.0 s / 1.0 s / 1.0 s |
| **`shaders` 结束之后的「尾巴」总计** | **10.4 s / 11.2 s（均值 10.8 s）** | **5.9 s / 5.8 s / 5.9 s（均值 5.8 s）** |
| 真冷启动总耗时 | 32.4 s / 33.7 s（均值 33.0 s） | 29.3 s / 30.1 s / 27.2 s（均值 28.9 s） |
| 场景 / 机翼 / 云 march / 云 resolve 材质的程序数 | 1 / 1（无云的编译数据） | 全部 1（没有首帧重编） |

**「尾巴」（跳过噪声最大的 `shaders` 阶段之后的部分）稳定省下约 5 秒**，这是本任务最可信的数字，重复多次都在 ±0.2 s 内。**总耗时**因为 `shaders` 阶段本身噪声就有 ±1~2 s（本机 GPU 被其他代理占用导致），配对对照下平均省约 4.2 s，没有稳定摸到「约 6 s」，但方向和量级都对。

## 验收对照

- `window.__voyageStartup` 里「云光线步进程序编译」≤ 0.5 s：**没做到**（见上面「新发现的问题」，实测约 4.8~4.9 s，这笔开销在 master 原写法里也存在，只是被真实编译时间掩盖了，不是本任务能在 `main.ts` 范围内消除的）。
- 真冷启动总时间比 master 少约 6 s 左右：**部分做到**，`shaders` 结束后的尾巴稳定省约 5 s，总耗时因 `shaders` 阶段本身噪声大，配对对照下均值约省 4.2 s。
- 启动期间无 ≥1 s 的主线程冻结：**没做到**，但比 master 好：master 原有一次约 9.4~10.2 s 的冻结（`cloudMarch` 阶段整体都在同步渲染），本分支把冻结压缩到约 4.8~4.9 s，并且确认冻结**不会**泄漏到无关阶段（`海面 FFT` / `首帧渲染` 在所有测试里都保持正常量级，见下面「怎么验证的」）。
- 首帧后画面与 master 一致：**做到**，noon-cumulus、in-cloud 两个场景目测一致（云、海面随时间变化的部分本身就不是逐帧相同）。
- `window.__voyageStartup` 语义不变：**做到**，字段集合和触发时机都没变（只是内部把 `cloudMarch` 阶段的编译工作挪到了 `shaders` 阶段的 compileAsync 批次里），新增了 `云 resolve 材质的程序数` 一个调试字段。
- 热启动 ≈1 s：**做到**，命中磁盘缓存时实测 1.10 s（`模块加载到这里` 到 `首帧渲染` 全部 <150 ms）。

## 进度清单调整

- `boot/progress.ts` 的 `BOOT_STAGE_IDS` 从 7 项减到 6 项，去掉了独立的 `cloudMarch` 阶段（现在它和 `shaders` 是同一批 compileAsync，没有独立的「完成时刻」可打勾了）。
- `index.html` 里 `shaders` 对应的清单文案从「场景与机翼着色器」改成「场景 / 机翼 / 云光线步进着色器」，反映合并后的真实范围。
- `boot/timings.ts` 的 `DEFAULT_TIMINGS` 同步去掉 `cloudMarch` 的默认估算；`shaders` 的默认值（80000ms）没动——真实数字会在第一次运行后通过 `localStorage` 自我修正。
- `window.__voyageStartup`（debug tick，不是进度清单）仍然保留「云光线步进程序编译」这一项，方便观察这笔「结算」开销的量级变化。

## 怎么验证的

- 私有 headless：`node scripts/dev-browser.mjs cold --port 5254 --repeat 1`（`--angle` 默认 d3d11，符合验收口径）。
- 冻结检测：没有提交进仓库，脚本留在这个 worktree 的 `tmp/review-sc4/`（gitignored）：
  - `cold-freeze-check.mjs`：用 `requestAnimationFrame` 打点代替读 DOM 文本——rAF 回调本身在主线程冻结时就不会跑，相邻两次时间戳之差就是这段时间主线程被卡住了多久。跑法：把它临时拷到 `apps/voyage/scripts/`（ESM 得从有 `playwright-core` 的 node_modules 底下解析），`node scripts/_tmp-freeze-check.mjs 5254`，用完删掉临时拷贝。
  - `warm-check.mjs`：先用 nonce 破缓存真冷启动一次（填充 GPU 进程自己的磁盘着色器缓存），**在同一个 page 上直接 `page.goto` 刷新**（不新建 context、不加 nonce）验证热启动；踩过一个坑——如果热启动那一步是**新建 context**（哪怕在同一个 `browser` 进程里），依然会被当成冷启动对待（约 27~52 s），必须是同一个 page 刷新才会命中缓存，命中之后是 1.1 s。这条值得写进 README「坑点」，不确定是不是 Playwright `chromium.launch()`（没给 `--user-data-dir`）默认给每个 `newContext()` 分配独立 GPU 缓存路径导致的。
- 截图：`tmp/screenshot/sc4-baseline-v2/`（当前 master）与 `tmp/screenshot/sc4-after-v2/`（本分支），`noon-cumulus.png` / `in-cloud.png`。另有一组更早的对照（`sc4-baseline/` `sc4-after/`），是在 SC-3/T04 合并进来之前测的，只用来验证"改动前后画面一致"这个结论本身没变，数字不采用。
- 程序数校验：`window.__voyageStartup` 里 `场景材质的程序数` / `机翼材质的程序数` / `云光线步进材质的程序数` / `云 resolve 材质的程序数` 四项，本分支全部实测为 1。

## 坑

- **中途 master 移动了**：开始这个任务时先 `git merge master`，但排查「新发现的问题」花了很长时间（约 1 小时的真冷启动测试，每次 27~120 秒不等），期间协调者把 SC-1+2、SC-3、T04 都合并进了 master。第一次 `git diff master..HEAD` 时吓了一跳，以为自己的分支丢了一大堆东西，实际上是本地 `master` 分支本身随共享仓库一起前进了（worktree 共享 `.git/refs`，不是我这边有问题）。**教训：长时间任务中途要记得 `git log --oneline master -5` 确认基线有没有动，动了就重新 `git merge master` 一次再继续测**，不然测出来的基线数字是过时的（这次因此重测了一整轮，数字表格里已经是重测后的版本）。
- **`git checkout <ref> -- <files>` 会覆盖当前工作区里同名文件的一切未提交改动，包括你以为已经"存在"但其实还没 commit 的部分**。这次为了做「改动前 / 改动后」真冷启动对照，反复 `git checkout HEAD~1 -- ...` / `git checkout HEAD -- ...` 切换，中途忘了先 `git commit` 就直接切了一次，把「新发现的问题」那一节对应的代码改动（`resolveMat` 纹理预绑定、显式触发渲染、`云 resolve 材质的程序数` 调试字段）冲掉了两次，得凭记忆重打一遍。**以后做这种「切基线对照测试」的操作，每完成一版有意义的改动就立刻 commit，不要攒着**。
- Vite dev server 在 `git checkout` 切换基线文件时会通过文件监听自动 reload，不用手动重启；但这次为了保险，在 master 合并之后重启了一次 dev server（怕文件被大批量替换时 chokidar 漏掉某个文件的变更事件），没实测过不重启是否也没问题。
- 热启动测试必须在**同一个 page** 上 `goto` 刷新，新建 `browser.newContext()`（即使在同一个 `browser` 进程里）依然会退化成冷启动，细节见上面「怎么验证的」。

## 还能做但本任务没做（供协调者取舍）

- **消除「结算」开销本身**：需要更深的 Chrome/ANGLE 侧调查（`chrome://tracing`、或者对照 Chromium issue tracker），可能发现是磁盘缓存写入阻塞、或者是 D3D11 设备状态整合的已知限制。建议单独开一个 DX 专项，用这次的发现（「和材质无关，只和'这批 compileAsync 之后第一次 render()'有关」）作为起点。
- **把海面 FFT（`OceanWaves` 的 `evolve` / `butterfly` / `finalize` 三个材质）和曝光/眩光也塞进同一批 compileAsync**：SC-4 报告原文提到过这个可能性，但它们各自的真实编译时间已经很小（100~200 ms），即使全部消除，对总时长的贡献也有限，加上 `OceanWaves` 是一个多级 pass 的流水线（ping-pong、butterfly 迭代），接入更复杂，这次没做，优先级不高。
- **给 `Clouds` 补一个正式的公开 `warmupTargets()` 方法**（上面「访问私有字段」一节已经给出建议实现），替换掉本分支里的类型断言写法，等 T04 收敛后可以顺手做。
