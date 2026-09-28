# WS-STAR · 天梯 / 建木身后的星透过奇观（交接）

worktree `D:\Code\opus-test\.claude\worktrees\agent-af531b83f0926617c`，端口 5294。状态：**已交付**（确有透星，已修）。

## 结论

**确有透星**，已修：`src/render/outside-pass.ts` 里 `#ifdef OUTSIDE_WONDER` 段只有 `#ifdef WONDER_PILLARS`（巨柱群）分支写了 `gStarVis *= 1.0 - gWonderCov`，`#else`（天梯 / 建木走的 `wonderSky`）完全没有这一行。夜里点星会穿透锚塔 / 树干继续显示——不是巨柱群那种「未乘可见前沿」的问题，`wonder-sky.glsl.ts` 里 `vis`/`visF` 已经正确处理了浮现 / 退场前沿（见下「浮现中」一节），单纯是这一行漏写了。

修法：把这一行从 `WONDER_PILLARS` 分支里挪到两个分支外、`#endif` 前统一乘一次：

```glsl
#ifdef OUTSIDE_WONDER
#ifdef WONDER_PILLARS
  L = wonderPillars(L, rd, hitGround ? tGround : 1e9);
#else
  L = wonderSky(L, rd, hitGround ? tGround : 1e9);
#endif
  gStarVis *= 1.0 - gWonderCov; // 奇观实体挡住它身后的点星（点星在舱内程序画，只认这个标记）
#endif
```

`gWonderCov` 是 `WONDER_SKY_COMMON`（`src/render/wonder-sky.glsl.ts`）里的共用全局变量，`wonderPillars` 与 `wonderSky` 都会写它，挪到分支外对 OWP（巨柱群）预处理结果没有影响。

## 为什么会漏（机制）

点星不是这段代码直接画出来的 RGB：`outsideRadiance()` 只把 `gStarVis`（这个像素是不是天空）乘进 `main()` 里的 alpha 通道——

```glsl
// main()
float starVis = gStarVis * cloud.a;
...
gl_FragColor = vec4(min(view, vec3(uHdrMax)), 1.0 + starVis * tr.a);
```

真正的点星由**舱内程序**按这个 alpha 值决定亮不亮（注释「点星在舱内程序画，只认这个标记」，T41）。也就是说：即使 `wonderSky()` 自己把 RGB 背景正确地画成了不透明的塔身 / 树干，只要 `gStarVis` 没被压下去，舱内程序仍然认为「这里能看到点星」，会在塔身 / 树干上叠一个亮点——这是两条独立的通道，RGB 挡住了不代表 alpha 也挡住了。

## 核实过程（含走过的弯路，供以后参考）

### 直接代码核对（最终依据）

- 改之前：`git -C <worktree> show HEAD:apps/voyage/src/render/outside-pass.ts | grep -n gStarVis` 只有 3 处（声明、`=1.0`、`*=` 在 `WONDER_PILLARS` 分支内），`main()` 里 `starVis = gStarVis * cloud.a` 会拿到未衰减的值。
- 回退代码复测（真实编辑文件、不是运行时补丁）确认：改之前 OW 材质编译出的 fragment shader 源码里 `gStarVis *=` 只出现在 `WONDER_PILLARS` 分支；改之后（挪到分支外）在 OW 材质源码里出现且仅出现一次，位置在两个分支的 `#endif` 与 `wonderSky()`/`wonderPillars()` 调用之间。

### 视觉核实：为什么截图对照不够干净

按简报设想「放大看奇观轮廓内是否有星点、按亮点计数对比轮廓外」直接做了，但遇到两个真实的方法论坑，记录下来供以后同类核实参考：

1. **夜景曝光极高 + 全屏眩光（veiling glare bloom）会把任何非零值糊成白色**：把 `outsideRadiance()` 的返回值临时替换成 `vec3(gStarVis, gWonderCov, 0)` 做调试可视化时，天空本身大片 `gStarVis=1`（红），bloom（`src/render/bloom.ts`，13 点下采样 + 帐篷滤波逐级累加，专门做大范围散射）会把这一大片红色的能量扩散到画面各处，包括奇观轮廓内——即使轮廓内的真实值已经被修复压到接近 0，bloom 扩散进来的量在这种极端曝光下经过色调映射后仍然显示成白色，看不出修复前后的差别。缩小调试可视化的生效范围（只在屏幕上一个远离奇观边缘、几像素大小的窗口输出，其余像素强制黑）可以大幅压低 bloom 的干扰，但没能完全消除（bloom 的最粗一级本身就是把全图压缩到十几乘十几像素，任何非零源都会往外漏一点）。
2. **分两次独立起页面拍摄「改之前 / 改之后」，镜头位置和灯光动画相位不是逐帧可比的**：`ws-tether-night` 等场景没有写死 `offset`，飞机位置由「打开页面到冻结经过了多久真实时间」决定（README 坑点「跨页面截图对比，云的位置取决于等编译等了多久」，PERF-10，同一类问题）；缆上的暗白灯光脉冲、环站频闪也按 `uTime` 走。两次分开跑 `shots`（哪怕都用 `--pair` 冻结）内部各自的冻结时刻不同，直接做「改前 on 截图」减「改后 on 截图」的差图，天梯本身的灯光相位差和一点点镜头漂移会混进结果，不能单独当作「点星差异」的证据。

在这两个限制下，本次核实最终以**代码读证**为主要依据（漏改的那一行、以及挪动后逐字核对确实生效），辅以以下视觉证据（供参考，非决定性）：

- `tmp/screenshot/WS-STAR/before-full/`：改之前，真实场景（非调试补丁）on/off 对照，`ws-tether-night(.a/.b).png`、`ws-tether-night-up`、`ws-jianmu-night-tmp`（照抄 `ws-jianmu-dusk`、time 改 1320 的临时场景）、`ws-jianmu-night-tmp-up`。
- `tmp/screenshot/WS-STAR/after-full/`：改之后，同样四组 on/off，同一 `--pair` 手法。
- `tmp/screenshot/WS-STAR/before-reveal-tether/`、`after-reveal-tether/`：天梯 `reveal: 0.3`（浮现中）on/off，改前 / 改后。
- `tmp/screenshot/WS-STAR/before-reveal-jianmu/`、`after-reveal-jianmu/`：建木 `reveal: 0.3`，改前 / 改后。
- `tmp/screenshot/WS-STAR/diffmask_tether-night_crop.png`：改前 on 与改后 on 的逐像素差异（阈值 15），裁到天梯所在区域放大——差异点密集沿着缆线（每 2 km 一盏灯的位置）和锚塔各级退台边缘分布，和奇观自身的几何边界高度吻合；也有一部分是上面第 2 点说的镜头 / 灯光相位漂移，无法把两者完全分开。
- `tmp/screenshot/WS-STAR/cable_before.png` / `cable_after.png`：同一缆线区域裁图放大的直接对照（非差分）。

### 浮现中（reveal 0.3）

`tmp/screenshot/WS-STAR/before-reveal-tether/` 与 `after-reveal-tether/`：`reveal: 0.3` 时只有锚塔最底下一级台露出来（`wonder-sky.glsl.ts` 的 `visF = (1 − smoothstep(0.35·front, front, s)) · …` 在函数最前面就 `if (visF <= 0.0) return L;` 早退，front 以上的部分连覆盖率都不会去算），这部分逻辑改之前就是对的，不需要额外改；改前改后在这个场景下天空区域几乎没有差异（`diffmask` 全黑，只有地平线水面噪声），符合预期——因为浮现中只露出一小截，样本里恰好没有星点落在这一小截轮廓上，不代表浮现前沿有问题（前沿本身的裁剪见上，`visF` 直接控制了 `wonderSky()` 的早退，天生不会在未显形部分画出任何东西，包括不会设 `gWonderCov`，所以就算没有这次的 `gStarVis` 修复，未显形部分也不会透星；透星只发生在**已经显形、且 RGB 上明确画成了不透明实体**的部分）。

## 与简报预期的偏差：shader-parity 结果

简报预期「默认程序与 DOW / DROW / OWP 逐字不变，只有 OW 变」。实测：

```
node scripts/shader-parity.mjs --base master
```

| 程序 | 结果 |
| --- | --- |
| `outside-default` | ✓ 预处理后逐字相同 |
| `outside-extras`（OW） | ✗ 预处理后不同（预期内，本次修复目标） |
| `outside-ground-detail`（DOW） | ✗ 预处理后不同 |
| `outside-rail`（DROW） | ✗ 预处理后不同 |
| `outside-pillars`（OWP） | ✓ 预处理后逐字相同（`gStarVis *=` 挪到分支外，对 OWP 的展开结果没有变化） |
| 其余全部程序（atmosphere / cloud / bloom / exposure / scene / seat / wing / ocean / rays / wonder-layer …） | ✓ 全部逐字相同 |

**DOW、DROW 也变了，不止 OW**——原因：`OutsideKey` 的 `D`（`GROUND_DETAIL`）、`R`（`RAIL`）和 `W`（`OUTSIDE_WONDER`）是相互独立的宏，DOW = `D+O+W`、DROW = `D+R+O+W`，两者和 OW 一样都没有 `WONDER_PILLARS`，预处理时都会走 `#else` 分支调 `wonderSky()`。这一行原来就漏在这个共用分支里，DOW / DROW 编译出来的低空细节 / 火车远景变体一样会透星，只是这两个变体使用场景更窄（低空、火车模式）不容易被注意到。挪到分支外统一乘一次，三个变体的漏洞一起修掉——这是符合预期的正确结果，不是改动范围失控；只是和简报预写的「只有 OW 变」不一致，如实记录在这里。**没有改动 `WONDER_PILLARS` 分支本身（巨柱群 `outside-pillars` 逐字不变），也没有碰 `pillars.glsl.ts` / `pillar-shape.ts` / `catalog.ts` / `system.ts`。**

## 验收

- `pnpm --filter voyage typecheck`：过。
- `node scripts/lint-shaders.mjs`（`check:glsl`）：全部通过。
- `pnpm --filter voyage build`：过；`find dist/assets -type f -size 0`：无输出（没有 0 字节文件）。
- `node scripts/shader-parity.mjs --base master`：见上表，`outside-default` / `outside-pillars` 逐字相同，`outside-extras` / `outside-ground-detail` / `outside-rail` 预处理后不同（预期内、原因已写清）。
- 截图期间控制台：全部 `shots` 调用均报告「截图期间没有 console error / pageerror」。

## 归属文件

只改了：
- `src/render/outside-pass.ts`（本次唯一的代码改动，一行搬家）
- `README.md`（奇观坑点：更新 WS07 遗留的那条，标注 WS-STAR 核实与修复结果、shader-parity 偏差说明）
- `handoff/WS-STAR.md`（本文件）

没有碰 `src/wonders/pillars.glsl.ts`、`src/wonders/pillar-shape.ts`、`src/wonders/catalog.ts`、`src/wonders/system.ts`、`src/render/wonder-sky.glsl.ts`（WS08 也在 `src/wonders/` 下开发，本任务没有改这个目录下任何文件）；`scripts/scenarios.mjs` / `scripts/regression.playwright.js` 也没有改（建木夜景是临时场景，只通过 `dev-browser.mjs shots --scenes-file` 用完即弃，没有写进两张场景表，`check:glsl` 的两表同步检查因此仍然通过）。

## 怎么复现

```bash
cd D:\Code\opus-test\.claude\worktrees\agent-af531b83f0926617c\apps\voyage
node scripts/dev-browser.mjs shots --port 5294 --only ws-tether-night,ws-tether-night-up \
  --scenes-file apps/voyage/tmp/ws-star-scenes.json \
  --out apps/voyage/tmp/screenshot/WS-STAR/after-full \
  --pair "" --pair "v.wonders.clear(); v.wonders.enabled = false;"

node scripts/dev-browser.mjs shots --port 5294 --only ws-tether-night \
  --out apps/voyage/tmp/screenshot/WS-STAR/after-reveal-tether \
  --pair "v.wonders.trigger('tether', { forwardOffsetDeg: 0, distKm: 220, reveal: 0.3, seed: 0.37 });" \
  --pair "v.wonders.clear(); v.wonders.enabled = false;"

node scripts/shader-parity.mjs --base master
```

`apps/voyage/tmp/ws-star-scenes.json`（临时场景文件，仓库里没有提交，复现时按需重建）：字段同 `scripts/scenarios.mjs` 的 `SCENES` 条目，`ws-jianmu-night-tmp` 照抄 `ws-jianmu-dusk`，把 `time` 从 1070 改成 1320（夜里）。

控制台手动核实：`__voyage.wonders.enabled = true; __voyage.wonders.trigger("tether", { forwardOffsetDeg: 0, distKm: 220, reveal: 1, seed: 0.37 })` / `trigger("jianmu", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.37 })`。

## 开发体验反馈

- **哪里慢**：本任务九成时间花在「怎么证明一个只影响 alpha 通道、又被夜景极端曝光和全屏眩光淹没的差异」这件事上。常规的「on/off 截图找亮点」「裁图放大目视」对这类 bug 几乎失效——点星不在 RGB 里直接画，调试用的 `return vec3(gStarVis, gWonderCov, 0)` 会被下游的曝光 + bloom 洗白，缩小可视化范围只能缓解不能根治。
- **哪里卡**：想直接读 `hdrOutside`（`window.__voyage.hdrOutside`，正是 bloom 之前的原始渲染目标）的原始像素绕开曝光 / bloom，但 `THREE.WebGLRenderer` 实例没有暴露在 `window.__voyage` 上，`page.evaluate` 里 `import("three")` 也解析不到裸模块名（不在 Vite 的静态导入图里），拿不到 `renderer.readRenderTargetPixels`，只能放弃这条路。
- **希望**：如果以后还要核实「只影响 alpha / 不直接体现在 RGB」的 bug，建议要么给 `window.__voyage` 加一个 `renderer` 的调试句柄（哪怕只读），要么在 `dev-browser.mjs` 里补一个「读某个 render target 某个像素原始值」的子命令——这类 bug 在这条渲染管线里大概率还会再出现（alpha 通道传标记给下游 pass 这个模式目前只用在点星上，但不排除以后还有）。
- 最终能定案，靠的是**读 diff**（确认漏了哪一行、位置对不对）而不是截图——这类「逻辑上一眼能看出、画面上极难截出来」的 bug，DEV_SOP 里「审查以读 diff 为主」的原则同样适用于核实阶段，供协调者参考。
