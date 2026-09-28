# TW02 · 远景对流塔层 独立审查

审查对象：分支 `worktree-agent-a153ee093663d3a16`（`038df63`），相对 master。重档审查（跨模块、新增程序、碰热点文件 main.ts / clouds.ts）。
环境：RTX 5090，ANGLE d3d11（`GL_RENDERER` 已核对为硬件渲染），1600×1200，画质 high（另测 low）；测量工具页面默认带 `voyage=0`，连续航程场景显式 `--query "&voyage=1"`；`ab` 按锁排队后执行；变体 js 每个都写全 `enabled` / `override` 状态。

## 结论：需返工（一处小修，协调者合并时可以直接改）

合成、历史、零回归、去重逻辑都没问题。只有一个阻塞：**scissor 的包围盒高度没算上穹顶，生长期的塔顶被平着切掉一刀**。改一行就行，不需要重新审查形态和光照。

## 阻塞问题

### B1 scissor 上沿只到 `top + 1.6 km`，生长期塔的圆顶被切平

- **位置**：`src/clouds/far-towers.ts:561`（`computeScissor` 里的 `for (const alt of [0, t.top + 1.6])`）。
- **现象**：着色器里塔身画到 `h < top + domeH + 0.3`，`domeH = mix(R·0.9, 0.7, anvil)`（`far-towers.ts:188`）。生长期没有砧（anvil = 0）时，R = 7.8 km 的塔穹顶有 7 km 高；砧刚开始铺开（anvil 0.3）时穹顶也还有 5 km 左右，都远超过 1.6 km。scissor 按 `top + 1.6` 投影，圆鼓鼓的塔头就在屏幕上一条水平线处被截平。截图对照（同一机位，只换 scissor）：`tmp/screenshot/tw02rev/clip/m.png`（全图，上：原样；下：scissor 改成整屏）和 `z.png`（塔顶放大 2 倍）。上图左边那座生长期的塔顶是平的，中间 anvil 0.3 那座的上冲穹顶也被削掉一截；下图三座都是圆顶。画质 low（raw 降到 800×600）截出来一样（`tmp/screenshot/tw02rev/clip-low/m.png`）：scissor 正好是 high 档的一半，缩放没有问题，问题只在包围盒高度。
- **为什么阻塞**：一条水平直线切出来的平顶，正好是「贴片感」的来源，属于 DEV_SOP 排期第①档的「明显伪影」。塔从出生到约 age 0.25 都是这个形态，连续航程里每个新生系统都要经过这一段。实现者的验收截图全是成熟 / 消散期，所以没看出来。另外实现者的 GPU 数字是在收紧 scissor 之前量的（handoff 表里有注明），收紧后没人再核对过画面。
- **修法**：包围盒上沿按着色器同一公式取，例如
  ```ts
  const domeTop = t.top + t.R * 0.9 * (1 - t.anvil) + 0.7 * t.anvil + 0.3;
  for (const alt of [0, Math.max(t.top + 1.6, domeTop)])
  ```
  scissor 会高出几十个像素，GPU 成本仍在 0.01 ms 这个量级。
- **复测**：`node scripts/dev-browser.mjs shots --port <端口> --angle d3d11 --scenes-file apps/voyage/handoff/TW02-review-clip.json --out tmp/screenshot/tw02/review-clip`，把 `rev-clip-scissor` 和 `rev-clip-full` 的塔顶裁出来比，应当一样圆。第二个场景把 `computeScissor` 换成整屏，只在当前页生效，不改代码。

## 逐项核查

### 1. 合成正确性（afterMarch 钩子）

- **混合公式**：raw 的格式是 (RGB 辐亮度, A 透射率)。`DST_ALPHA, ONE` 与 `ZERO, SRC_ALPHA` 合起来就是 `rgb += T_vol·L_塔`、`T *= T_塔`，也就是「塔在所有体积云后面」的正确 over 合成。提前返回的像素写 `(0,0,0,1)`，是恒等元，不改 raw。
- **GL 状态复原**：混合状态由 three.js 按材质管理，下一个 `NoBlending` 材质（resolve）会自动关掉混合。深度测试和深度写都关着，raw 的深度附件（T38 云深度）一位不动。scissor 用 render target 自带的 `scissor` / `scissorTest`，画完就复位；下一次 `setRenderTarget(next)` 会用 `next` 的 scissor 覆盖 GL 状态，resolve 的 `next.scissorTest` 不受影响。`prepare()` 里 `compileAsync` 前后都把 render target 设回原样。以上都没问题。
- **帧缓冲**：画进的就是 `this.raw`（float 目标），`EXT_float_blend` 做了检测。没有这个扩展时整层关掉并打一条 warn，不会退回到错误写法。
- **时间累积**：
  - resolve 重投影用的 dRep 是「3×3 按不透明度加权的深度」。塔像素没有体积云，深度纹理是 1（400 km），权重是塔的不透明度，所以远塔按 400 km 重投影。旋转时完全正确；平移时视差误差对 170–760 km 的塔只有每帧百分之几像素，看不出来。
  - 远塔突然消失时（关掉、被体积云接走、切换连续航程），邻域夹取在一帧内把历史夹掉。实测：带两座塔累积 8 s 后 `enabled = false`，第 2 帧截图（`tmp/screenshot/tw02rev/ghost/m.png`）没有任何残影。
  - reset / onJump：resolve 的 reset 帧本来就不读历史；`onJump` 清了 `farConsumed`，并把 `farAtReal` 置成 `-Infinity`，下一帧重取，不会拿旧地点的单体配新原点。
  - 实现者用 `ab` live 量过飞行中闪烁像素：cur 0 / cur2 0 / off 0。
- **不同画质档 / 分辨率缩放**：`computeScissor` 用 raw 的宽高投影，公式与 `cabinRay` 互逆（已对照 `view.glsl.ts`）。low 档的 scissor 正好是 high 档的一半，位置对得上。

### 2. 重复与跳变（weather-director.ts）

- **去重**：`farTowerCells` 每次调用都按当前 `weather.storms` 过滤掉「已摆放系统」，再用 `farConsumed` 过滤掉「摆放过的系统」，id 按 `#` 前缀对系统。`run()` 在 `addStorm` 之后才 `farConsumed.add`，名额不够提前 return 时不会误加。体积雷暴被 PASSED_KM 回收以后，远景层也不会把它放回来（已经在机尾后面）。`onJump` 会一并清空。逻辑正确，看不出重复出现的路径。
- **出现 / 消失**：
  - 距离两端各有 40–60 km 的淡变，强度 0.25→0.4 也有淡变。
  - 程序编好、或从无到有时，整层有 6 s 淡入。
  - 切走的时机跟着体积摆放（视野外，或借云 / 夜遮挡），不会当面换。
  - 飞行中位置按漂移逐帧外推，是连续的。
  - 非阻塞的边角情况见下面 N4–N6。

### 3. 默认程序逐位不变

- **合并演练**：在 `tmp/tw02rev-merge` 建了 master（`a338cbb`，已含 WS04 / WS05）的工作区，合并本分支**无冲突**。合并后 typecheck 通过。
- **`shader-parity --base <master>`**（合并工作区对 master）：44 个程序逐字相同，新增 1 个（`far-towers`）。
- **`check:glsl`**（合并工作区）：全部通过，包括 sampler 速查表和场景表同步。
- **非冻结开关对照**（补上实现者只在冻结下测过的缺口）：`ab --cloud-live`，noon-cumulus，变体 cur / off / cur2 各两轮，每个变体都显式写全 `override = null; enabled = …`。作业文件：`handoff/TW02-review-zero-live.json`。
  - 变体之间对参照的差（mean）是 0.104 / 0.104，同一变体两轮之间的噪声底是 0.12 / 0.12 / 0.115，**变体间差不超过噪声底**。
  - 亮度 126.26–126.27；相邻差（横纵平均）2.34–2.36；对角差 3.42–3.44；HSV 饱和 31.3。三个变体一致。
  - live 120 帧的平均二阶差：cur 0.255 / off 0.25 / cur2 0.231，同样是噪声范围。
  - cur2 里的断言（`voyage=0` 下 `towers` 为空、`active` 为假）没有抛错。
  - 代码层面也成立：`render()` 在没有塔时第一个分支就 return，不发任何 GL 调用。

### 4. 观感（兼美术总监视角）

连续航程截图都在 `tmp/screenshot/tw02rev/look/`：

- **夏季午后** `rev-v1-0714-1500.png`（南海 7/14 15:00，航向 225°，放大见 `z1500.png`）：
  - 窗内西北地平线上 11 座远塔：262–268 km 的飑线，334–341 km 的消散塔，594–698 km 的在霾后。
  - 整体**读得出是「远处一排积雨云」**，不是贴片：塔脚被霾吃掉，平直砧顶，越远越灰，色温和体积云一致。
  - 不足：飑线四个单体的砧连成一张等厚的平板，板下塔与塔之间露出规整的「门洞」，像桥 / 桌子；塔身侧面接近竖直的圆柱。
- **黄昏** `rev-v1-0714-1840-back.png`（18:40，太阳高度 3.4°，窗外朝北，与太阳方位差约 60°，侧逆光；放大见 `zdusk.png`）：
  - 330 km 的远塔砧顶和塔顶被染成粉橙，下半截偏灰，符合「黄昏只染顶部」。同画面左侧 110 km 处是体积雷暴，两者色调协调，没有重复出现同一系统。
  - 不足：砧的上下沿是两条过直的平行线（像板），侧光下塔身出现竖向条纹。
- **月夜** `rev-v1-0729-2200.png`（7/29 22:00，满月，月亮高度 36°、在观察者身后东南方；放大见 `z2200.png`）：
  - 422 km 的三座塔画成暗褐色的「蘑菇 / 桌子」剪影，**比身后的地平线天空还暗**。满月下正对月光的远砧应该是银灰色、比夜空亮。
  - 同一画面里地平线附近的远处体积云也是同样的暗褐色，所以这很可能是夜间空气透视整条管线的问题，不是 TW02 引入的（实现者 `tw02/d6/m.png` 的月夜调试图也是这样）。记为遗留，建议美术总监 / 大气方向看一次。

按 DEV_SOP 的「降级」规则，以上形态问题属于③类细微打磨，记为遗留，不阻塞。实现者在 handoff「还不像的」里列的 ①–④ 我同意，下面补几条。

### 5. 构建与控制台

- worktree：`pnpm --filter voyage typecheck` 通过；`pnpm --filter voyage build` 通过；`find dist/assets -type f -size 0` 为 0。
- 合并工作区：typecheck 通过。
- 控制台：`check --query "&voyage=1"`（默认首载）没有 console error / pageerror；本次全部 shots / ab 期间也没有 console error（只有 EOX 瓦片 CORS，已聚合，不计）。
- 性能：没有重测。改动只是 scissor 高度，实现者量的 0.006 ms 在 B1 修好后会略增，但量级不变。

## 非阻塞遗留

- **N1 形态（③类）**：
  - 飑线相连的砧是等厚平板，塔与塔之间出现规整「门洞」；
  - 砧的上下沿过直，像板；
  - 生长期塔的气泡大小均匀，像泡沫（实现者 ②）；
  - 侧光下塔身有竖向条纹。

  建议交给 TW04（积雨云重做）一起对照真实照片打磨：砧底做成从塔向下风逐渐抬升的楔形，相邻单体之间的砧底加入乳状云 / 下垂，不要平切。
- **N2 月夜远塔比天空暗**（见上面第 4 项）：疑似夜间空气透视的管线问题，远塔上最显眼。建议美术总监确认后另开任务。
- **N3 横向剔除半径**：没有砧的塔在理论上可能超出 `ext = max(1.8R, 1.55Ra + 1)`（`far-towers.ts:173` 与 `:555`，两处要同步）。算法是 rC 最大约 1.1R，加上吹斜 0.7R，再加鼓包 1.56 km。把 ext 放大到 3R + 3 做了 A/B（`tmp/screenshot/tw02rev/ext/m.png`），四座横向吹斜的生长期塔两图一样，实际没切到。修 B1 时可以顺手放宽，也可以不管。
- **N4 连续航程关掉时远塔瞬间消失**：`cells = null` 时 `towers` 直接清空，没有淡出。只发生在用户手动切换时，可以接受；想更平滑的话，可以让 fadeIn 反向走完 1–2 s 再清空。
- **N5 形态参数按 1 s 取样阶跃**：`age01` / `strength` 每真实秒更新一次，两次之间不插值。1× 时看不出；高倍时间流速下，砧半径 / 塔顶每秒会跳一小格。可以把 age 的变化率一起传下来，在帧内外推。
- **N6 截断与遮挡的边角情况**：
  - `FAR_MAX = 32` 按距离截断，第 33 座进出时没有淡变。本次最多见到 18 座，没有触发。
  - 系统在「夜」遮挡下被体积摆放接走时，远塔当帧消失，而体积雷暴可能按构图挪到别处，满月夜里理论上能看见。
- **N7 深度语义**：远塔在云深度（右半）里一律算 400 km，dRep 也按 400 km。结果有两点：
  - WS05 的建木（200–260 km，「实体挡远云」）会把所有远塔都排到自己后面，包括 170–260 km 本来在它前面的塔；
  - 近处云边与远塔相邻时，3×3 重投影深度会被远塔往 400 km 拉一点。

  两者都很少见，也看不出来。TW04 / TW06 改成按 raw 深度前后合成时一起处理（实现者已在 handoff 注明）。

## 复现

```bash
# B1 scissor 切顶（原样 vs 整屏 scissor；把 quality 改成 low 可复测缩放）
node scripts/dev-browser.mjs shots --port <端口> --angle d3d11 --scenes-file apps/voyage/handoff/TW02-review-clip.json --out tmp/screenshot/tw02/review-clip
# 非冻结零回归（noon-cumulus，cloud-live，变体显式写全开关）
node scripts/dev-browser.mjs ab --port <端口> --angle d3d11 --cloud-live --jobs apps/voyage/handoff/TW02-review-zero-live.json --rounds 2
# 合并演练 + 逐字对照（在 master 合并本分支的临时工作区里）
node scripts/shader-parity.mjs --base D:/Code/opus-test/apps/voyage
node scripts/lint-shaders.mjs
```

黄昏、月夜、横向剔除和残影的场景文件在本 worktree 的 `tmp/tw02rev/`（`look-scenes.json`、`dusk-scenes.json`、`ext-scenes.json`、`ghost-scenes.json`）。`tmp/` 被忽略，没有提交；需要时由协调者转交。

## 开发体验反馈（审查）

- **慢**：`ab` 等测量锁约 2 分钟。连续航程场景每个约 40 s（两次 onJump + 雷暴编译）。
- **卡**：
  - 想截「黄昏逆光有远塔」，需要自己写 js 从 `farTowerCells` 挑方位、反推航向，第一次挑中的系统在 onJump 之后被体积摆放接走，只截到侧逆光。再次附议实现者提的 `shots` 场景字段 `faceBearing` / `faceTarget`。
  - 同一页想对照「改 scissor / 改 ext」只能拆成两个场景分别重载，体积云会变。`ab` 的变体如果能 patch `farTowers.mat` 这类非 `__voyage` 顶层的材质（按点路径），就能同页比。
- **有效**：`ab --cloud-live` 的噪声底 + 显式变体状态，一次就能说清非冻结零回归。`dev-browser` 自动断言硬件渲染，省了手动核对。
