# T49 · 航向控制 / 巡航方式 · 独立审查

> 审查代理，只读。分支 `worktree-agent-ad9df9f2441dc2408`（00fbb99），对比 `master...分支`。按要求**没有开浏览器**，所有结论都来自读 diff 和 node 离线模拟。
> 日期 2026-09-27。临时工作区 `tmp/t49rev`（f485386 合并本分支）审完已删除。

## 结论：**返工**（一处 P1，改动很小）

物理公式、手动转向、盘旋、直飞、60× 长时间运行和 UI 交互都没有问题。但有一个「不操作也会出错」的回归：**不开连续航程、时间流速停着（默认状态）时，到达终点后如果要掉头超过 90°，这次掉头永远不会执行**，飞机会一直直飞下去。hnd-cts 预设飞到新千岁（北端，所有航线都在身后）必然会遇到。

## P1（必须修）

### 1. 非连续航程加时间暂停时，掉头排队永远不放行，飞机一直直飞

- **代码**：`director.ts` 的 `queueBigTurn()` 写的是 `force: () => s.simTime - t0 > BIG_TURN_WAIT_S * 1000`。
- **根因**：`main.ts` 的 `renderFrame` 只在 `director.active`（连续航程开着）或 `state.playRate > 0` 时推进 `state.simTime`，而 `playRate` 默认是 0。`relay()` 在不开连续航程时同样会触发（「不管连续航程开没开都接力」），`previewNext` / `updateCovers` 也都在 `if (!this.active) return` 之前执行。于是在晴天、白天没有穿云也没有入夜的情况下：`force` 永远是 false，`ap.holdCourse` 一直为 true，飞机机翼改平、一直直飞；`advanceFlight` 里的到达判定又被 `!ap.holdCourse` 屏蔽，之后也不会再接下一段。
- **改前**：1× 下直接以 25° 坡度转弯，大约 3 分钟掉头，这就是真实客机的做法。
- **复现**（离线）：在 `runSim` 返回之后把 `director.active = false`，调 `forceArrive()`，然后只调 `director.simDt(dt)` 和 `director.update(...)`，不推进 simTime，跑 30 真实分钟。结果：`leg-turn 排队=true；30 真实分钟后仍排队=true，holdCourse=true，simTime 变化 0 s`。
- **单测为什么没抓到**：`T49-sim.mts` 的 `runSim` 总是设 `director.active = true`，每帧都推进 simTime，没有覆盖「默认状态」。
- **修法建议**：
  1. 等待时限不要依赖 `state.simTime`。它会被时间滑块改动（往回拖同样会卡住），暂停时也不走。改成导演自己累加的时钟，例如在 `update()` 里累加 `simDt`，或者直接按真实秒计。
  2. 顺带解决已知限制第 2 条：**1× 时不排队**（或者等待时限取「8 模拟分钟」和「约 30–60 真实秒」中较小的一个）。1× 下飞过机场、背离它直飞 8 分钟（约 120 km）再掉头，不如直接 25° 转弯真实。用户最初不满的是加速时「几秒原地掉头」，1× 的正常转弯不属于这个问题。
  3. 在 `T49-test.mts` 里补一项：`active = false`、不推进 simTime、晴天，接力后掉头必须在有限的真实时间内完成。

## P2（建议，可以合并后顺手修，不用再审）

2. **与 master 有 README 冲突**：模块表 `src/rail/*` 那一行，master 已经加上了 TR03 的 `far-view.ts` 说明。解法：保留 master 的 rail 行，再用本分支的 director 行。合并前请先合并一次 master。
3. **「手动航向 / 盘旋时高度保持」说得不准确**：`updateProfile` 在 heading / hold 模式下直接 return，`targetAltKm` 就停在上一次设定的值上。如果当时处于下降段，飞机会继续降到 3 km 并保持在那里。建议进入 heading / hold 时把 `targetAltKm` 设成当前高度（直飞到达后转入盘旋的情况除外，这时本来就该停在到达高度），或者把文档改成「保持最后的目标高度」。
4. **遮挡换向（cloud）会在一帧内把航向改变最多 180°**：窗外一片白确实看不到转动，但太阳相对机舱的方向也会一下子跳变，舱内的阳光光斑和曝光可能有可见的跳动（在云里时直射光已经很弱，估计不明显）。本次没开浏览器，需要协调者或美术在合并回归时看一眼，场景是 `forceArrive()` 加上穿云。
5. **直飞时模式按钮高亮的是「自动航线」**（`sync()` 里把 direct 映射成了 route）。状态行和下拉框都显示直飞，不影响使用；但按钮的高亮和实际状态对不上。可以改成直飞时三个按钮都不高亮。
6. **调试按钮「立即触发到达」在手动航向 / 盘旋时什么都不做**（`relay()` 直接 return），而且没有任何提示。只影响调试，在 title 里写明即可。
7. **防绕圈判据在 |Δ| > 90° 时偏保守**：代码是 `2r·sin(min(|Δ|,90°))`，严格的「目标落在转弯圆内」判据是 `2r·sin|Δ|`，所以 Δ 很大时会多直飞一段才开始转。这不是 bug，而且 60× 长时间模拟里没有出现绕圈，可以保留。

## 离线复核

| 项目 | 结果 |
| --- | --- |
| `git merge-tree --write-tree master 分支` | 只有 `apps/voyage/README.md` 冲突（见 P2-2），源码无冲突 |
| 合并后 `pnpm typecheck` | 通过 |
| `check:glsl` | 全部通过（本任务没有改着色器） |
| `vite build` | 通过（只有原有的 chunk 大小警告） |
| `node src/rail/rail.test.mjs` | 60 项通过 |
| `T49-test.mts`（交接里的写法） | 全部通过，数字和 handoff 一致 |
| 自写：60× 连续航程 2 真实小时（hnd-cts 无云 / pvg-pek 间歇穿云） | 见下 |
| 自写：10× hnd-itm 60 分钟；1× / 10× / 60× 右转 170°；yangtze 接入 | 见下 |
| 自写：非连续航程 + 时间暂停下的掉头 | **卡死**（P1） |

60× 2 真实小时（每次 432 000 帧，每次模拟只要 1 秒多）：

| 场景 | NaN 帧 | 航段数 | 最大坡度 | 最慢一段（真实耗时 / 理论） | 单段累计转角最大 | leg-turn 执行方式 |
| --- | --- | --- | --- | --- | --- | --- |
| hnd-cts，无云 | 0 | 71 | 2.5° | 1.85（CTS-NRT：强制掉头前多飞 8 模拟分钟，加上 150 km 半径的转弯） | 203° | 29 次全是 forced（无云、无夜） |
| pvg-pek，间歇有云 | 0 | 80 | 2.5° | 1.73 | 195° | cloud 与 forced 混合 |
| 10× hnd-itm 60 分钟 | 0 | 6 | 14.9° | 1.15 | 152° | forced ×2 |

- 没有卡死、绕圈或 NaN。每段的累计转角都 ≤ 约 200°，说明没有在终点附近兜圈；最后一段离终点的距离一直在减小。`telemetry.maxJumpRatio` 为 1.14–1.16，位置没有跳变。
- 手动右转 170°：1× / 10× / 60× 在 3 真实分钟后，航向误差分别是 0.03° / 0.01° / 0.01°，坡度回到 0，没有来回摆动。
- 60× 下窗外转动 ≤ 6°/真实秒：接力转弯大约十几到二十几真实秒，路线偏离的代价是航段慢 15–85%。这换来的是用户感受上最重要的一点：不会在几秒内原地掉头。我认为合理。代价是 60× 盘旋半径约 150–170 km，handoff 已经如实写明。

## 重点逐条

### 1. 不操作时零回归：除 P1 外通过

- **预设直飞（无终点）**：`navDiff` 返回 null，`steer` 的命令坡度为 0。换预设时 `bankDeg = 0`，所以航向不变，和原来的 `bankDeg *= exp(-dt)` 等价。
- **航线预设 1×**：P 段增益与原来的 `ω = 0.3·Δ` 相同，坡度增加了 0.7 s 的一阶平滑和 3°/s 的限速。沿大圆的稳态跟踪误差不到 0.3°（60× 时增益按流速缩小，估算稳态误差约 0.3°）。
- **连续航程 / 背景板（B）**：`setActive` 不清除导航状态，打开连续航程不会冲掉用户的盘旋；背景板只是在 `setActive(true)` 之上加一个标志，没有受到影响。
- **奇观之门 onCover / T19b 天气导演**：`onCover` 的监听和天气导演的 `request` 与 `leg-turn` 共用同一个队列、各自用不同 id，互不覆盖。`leg-turn` 和 `rebase` 可能在同一帧放行：`rebase` 先改坐标系，`leg-turn` 随后通过 `host.geo()` 取到的是换系之后的位置，二者是一致的。
- **换原点（rebase）**：等待航线只依赖航向和计时，不依赖位置，所以换原点不会让它跑偏。
- **时间流逝 1/10/60×（不开连续航程）**：`simDt()` 写入 `timeScale = 1`，飞行按真实时间，这是对的；这时 simTime 按 playRate 走，掉头等待约 8 / 48 / 480 真实秒，只有 playRate = 0 时会卡住（P1）。
- **DX-08 freeze / benchFrame / 调试句柄**：freeze 时 dt = 0，`simDt` 写入的 `timeScale` 不变；`steer` 的 `realDt = 0`，限幅也是 0，状态完全不动，不会破坏逐像素一致。benchFrame 与 rAF 走同一个 `renderFrame`，每帧 16 ms，`timeScale` 正确。`__voyage.director.ap` 是 getter，取的是同一个 WeakMap 里的对象。**结论：在 `simDt()` 里写自动驾驶状态没有副作用。**
- **TR02 火车**：火车模式不调 `advanceFlight`，也不调 `director.update`，排队中的掉头和盘旋都冻结，切回飞机后继续。控件 `hdg / nav-dest / turn-left / turn-right / debug-arrive / [data-nav]` 都会变灰，方向键检查 `vehicle.active`。切回时，如果开着连续航程，`afterExit → onPresetChanged` 会把导航重置为自动航线；把它当作「换地点」可以接受。

### 2. 物理：通过

- 协调转弯 ω = g·tanφ/v，转弯半径 r = v²/(g·tanφ)，公式正确。
- 按「改平期间还会转过的角度」反推坡度：改平耗时 φ·S/p（模拟秒），期间平均角速度 ≈ (g/v)·φ/2，转过的角度 = cG·S·φ²/(2p)。令它 ≤ Δ，得到 φ ≤ √(2pΔ/(cG·S))，和代码一致，量纲正确（φ 与 p 都用度，cG 的单位是 1/s）。
- 25° 上限的出处写对了（PANS-OPS）；3°/s 已标「估值」，6°/真实秒已标「主观取值」。
- 等待航线：ICAO 直边在 14 000 ft 及以下为 1 分钟、以上为 1.5 分钟，代码以 4.3 km 为界，正确。右座右转、左座左转时，压坡度那一侧的舷窗朝向圆心，推理正确。简化之处（入航不分进入方式、不减速、没有风）已如实写明。
- 直飞：到达判定是 < 40 km 转入等待，出发时已经在 40 km 以内的直接进入等待；10× 和 60× 下最后 1/4 时间离伊丹的最远距离分别是 61 km 和 155 km。
- 手动转向冲过头：连按左转 210° 时冲过头 0.66°；上面 170° 的复核也没有来回摆动。

### 3. 交互：通过

- 方向键：焦点在 `HTMLInputElement / HTMLSelectElement / HTMLTextAreaElement / contentEditable` 上时不响应，TR07 的「钢轨接缝」下拉是 select，也在其中；只处理 ArrowLeft/Right，和 M / B / N / H / Esc 不冲突。直飞下拉选完后会 `blur()`，焦点不会留在下拉框里吃掉方向键。
- 按钮：pointerdown 立即转 15°，按住 0.5 s 后每 0.2 s 再转 5°；pointerup / leave / cancel 都会停下；键盘触发的 click（detail 为 0）单独处理，不会重复。
- 面板每 250 ms `sync()` 一次，拖动滑块时不去抢值，和内部状态一致（直飞时的按钮高亮除外，见 P2-5）。
- `#nav-modes` 用了 `.rates` 这个 class，但 `.rates` 只用于样式，不是事件选择器（流速按钮按 `data-voyage-rate` 绑定），不会被误绑。

### 4. 顺手发现的两个旧问题：都属实，都不是本任务引入

- **长江出发显示 SHA → SHA**：属实。yangtze 预设离最近的机场是 SHA（553 km），`airportAhead` 挑出来的也是 SHA，于是出现 `SHA-SHA → SHA-HND → …`。scs 预设同理会出现 HKG → HKG。`joinNetwork()` 从 T19a（671b4d9）起就没变过，本任务没有改动。影响只在显示，下一次接力就正常了。修法：`joinNetwork` 里 `to.code === here.code` 时，起点名改用「当前位置」，或者用 `nearestAirport` 之外的机场作为 from。
- **`.row { display:flex }` 盖住 `hidden`**：属实。`#voyage-rates` 是 `class="row rates" hidden`（master 的 index.html 第 60 行），而 `style.css:32` 的 `.row` 优先级高于浏览器自带的 `[hidden]{display:none}`。本任务没有改动这些。修法：在 style.css 里加 `[hidden] { display: none !important; }`。

### 5. (f) 与 G01-03 以及同波其他任务

- G01-03 的 worktree（`worktree-agent-a1cbcd4e3b3e1145e`）目前仍停在 f485386，工作区是干净的，还没有可比对的改动。本任务在 `ui.ts` 里改了 `setupUi` 的一行，新增了 `setupNavUi`，并改了 `setupVehicleUi` 的 planeOnly 列表；`index.html` 在「背景板模式」按钮后面插入了一段，在调试区插入了一个按钮。后合并的一方需要留意这几处。
- PERF-10（a48b777）改了 `director.ts` 的 `DirectorHost` 接口，和本任务的改动没有文本重叠。

## 开发体验反馈

- **哪里慢**：没有明显慢的环节。`T49-resolve.mjs` 这个 node 解析钩子很好用，2 小时 60× 的模拟 1 秒多就跑完了，比开浏览器快几个数量级，建议推广成 `scripts/` 下的通用工具。
- **哪里卡**：① `runSim` 在调用方的 `setup` 之前就执行了 `onPresetChanged()`，而且 `active` 写死为 true。想测「接入航线网」或「非连续航程」时，要么自己再调一次 `onPresetChanged`（这时还得把 `weather.onJump` 也 stub 掉，否则会报 `removeStorms is not a function`），要么绕开 runSim 自己写循环。② 在临时 worktree 里合并时撞上 README 冲突，要手工解决后才能跑 typecheck。
- **希望有**：给 `runSim` 加 `active` 与 `advanceSimTime` 两个选项，默认状态（不开连续航程、时间暂停）就能直接测到；P1 正是因为这个缺口才漏掉的。
