# TW-LTG · 远景对流塔层夜间地平线闪电 交接

分支：当前 worktree 分支（合并 master 时 `already up to date`）。依据：`src/clouds/far-towers.ts` 文件头新增段落、`handoff/TW02.md` 遗留问题「闪电：远塔不打闪…可另开小项」。
用户背景：夜里在巡航高度常能看到地平线上几百公里外的雷暴一闪一闪照亮云塔内部（热闪电 / heat lightning），听不到雷声，频率每几秒到十几秒一次，常成串 2–4 下。

## 做了什么

| 文件 | 改动 |
| --- | --- |
| `src/clouds/far-towers.ts` | 新增第 4 个 per-塔 uniform `uFarD[32]`（强度、放电点相对塔心的世界系水平偏移 x/z、放电点绝对海拔）；`FarTowers` 类新增 `hold`/`heldIntensity`（语义照抄 `weather.ts`）、`advanceFlashes()`（每帧按泊松节律推进每座塔的闪光状态）、`newFlashChannel()`（一串新回击，2–4 下，位置在塔身内部随机取）、`sumFlash()`（当前帧合成强度，指数衰减）、`flashNow(id?)`（调试：立刻触发一串，不经过 hold）；着色器在塔身 / 砧受光公式之后各加一段「点光源在散射介质里的经验衰减项」（`FT_FLASH_COLOR`、`FT_FLASH_K`、`FT_FLASH_R`）。**只改了 far-towers 自己的 uniform 与小程序，不碰云步进，不新增其他程序** |
| `scripts/dev-browser.mjs` | `setFlashDisabled()` 原来只设 `weather.hold`，现在一并设 `farTowers.hold`（找不到 `__voyage.farTowers` 时不报错，只是不设）；`--allow-flash` 的帮助文案提一并提到 `far-towers.ts` |
| `README.md` | 模块表 `far-towers.ts` 一行补一句；远景塔坑点节追加坑五（调试踩的 TTL 陷阱）、坑六（远处闪电色被空气透视吃暖） |
| `handoff/TW-LTG-scenes.json` / `TW-LTG-accept.json` / `TW-LTG-decay.json` | 复现用的场景表（见下「复现」） |

### 触发节律与合成（`src/clouds/far-towers.ts` 文件头有全文）

- **门控**：只有 `anvil > 0.05`（已经开始铺砧，冰晶化）的塔才会打闪，纯浓积云塔（没有砧）不打；只在夜间 / 暮光（太阳高度 < −4°，从 `shared.uSunDir.y` 反算 `asin`，和 `main.ts` 切换主光源到月光同一阈值）触发，白天 `uFarD` 恒为 0。
- **泊松节律**：每座塔独立一个状态（`Map<id, FlashState>`，按塔的 `id` 持久化，`towers` 数组本身每帧重建），平均 9 s 一次（比近处雷暴的 5 s 稍稀）；一次触发生成 2–4 下回击，间隔 50–130 ms，每下随机初始强度 0.7–1.4、随机衰减时间常数 50–200 ms（研究要求的单下持续区间）。
- **放电点位置**：每串新回击在塔身内部重新随机取一个点（离轴 10–45% 半径、约塔高 0.4–0.8 处，物理上对应电荷分离带大致在塔身中上部），世界系水平偏移 + 绝对海拔存进 `uFarD.yzw`，同一串共用、串与串之间才换（避免「总从同一个地方亮」的重复感）。
- **着色器消费**：塔身 / 砧各自的受光公式算完之后，`if (D.x > 1e-4)` 加一段 `FT_FLASH_COLOR * D.x * FT_FLASH_K * exp(-fd / FT_FLASH_R) / (1 + fd² · 0.05)`，`fd` 是当前着色点到放电点的 3D 距离（塔身 `(P.x, h, P.z)`、砧 `(PA.x, am, PA.z)`），和 `clouds.ts` 里近处雷暴照亮云体的公式同一形式（`clouds.ts:822`），砧底用同一份强度单独算一次。
- **截图 / 回归默认关**：`hold`/`heldIntensity` 语义照抄 `weather.ts`；`scripts/dev-browser.mjs` 的 `setFlashDisabled()` 现在会把 `weather.hold` 和 `farTowers.hold` 一起设，`shots` 默认截图因此也默认关远塔闪电，`--allow-flash` 恢复正常泊松。

## 颜色标定（过程记录，供以后调类似效果参考）

`FT_FLASH_COLOR = vec3(0.6, 0.62, 1.25)`（源色冷白偏紫）、`FT_FLASH_K = 0.7`：
- 最初直接把 CPU 侧的强度（0..~1.4，抽象单位）乘一个较大常数加进 `Lc`，量级比夜里满月照度（约 3e-4 klux）亮上千倍，曝光 / 局部适应被冲穿，画面变成一团失色的白斑，色调完全失真（见下面「踩的坑」）。压到 `FT_FLASH_K` 数量级后能看清「这里亮起来了」又不会整窗过曝。
- **远处的紫会被空气透视吃成暖白，这是物理，不是又一个待修的偏色**：塔在 200+ km 外时，从塔到相机这段空气透视本来就会把蓝分量吃掉大半（和 README 坑三、`NIGHT-AP-1` 同一根物理——同样的空气透视让整座塔在远处偏暖偏暗）。把颜色进一步推蓝（甚至试过纯蓝 `(0,0,1)`）在 250 km 外依旧读成暖白、甚至完全看不见，说明不是「颜色没调对」，越贴近 170 km 越看得出偏紫，越远越接近纯白，交给下一波如果要在极远处也保紫色再看要不要专门处理（例如把闪光当 `apL`〔散射进入路径的光〕而不是 `Lt`〔要走完整透射率的表面辐亮度〕来处理，绕开这段吃蓝——本任务没有这样改，交接说明属于细微打磨，未做）。

## 踩的坑（完整调试记录，教训比代码本身花的时间还长）

调试时反复出现「JS 端读 `uniforms.uFarD.value` 是对的、`gl.getUniform()` 直接查 GPU 端也是对的，但截图里就是看不到任何效果」，一度怀疑是 ANGLE/D3D11 对新增的第 4 个 32 长度 `vec4` uniform 数组有编译器 / three.js 绑定 bug，逐一排除了：改名（`uFarD` → `uFlashD` 又改回）、声明顺序（放在 A/B/C 后面 / 放在文件末尾）、数组长度（32 → 4）、类型（`vec4[]` → 独立 `float`/`float[]`/`vec4[]` 对照测试）、着色器里读取方式（缓存的循环局部变量 vs 每次重新 `uFarD[i]` 索引 vs 主函数最外层硬编码 `uFarD[0]`）——所有排除测试都显示同一个现象：**只要用「手工塞一条 `decay: 5`（5 秒衰减）的回击」这种方式测试，等到 `scripts/dev-browser.mjs shots` 真正截图那一刻，强度必定是 0**。

**根因**：`sumFlash()` 里有一行 `FLASH_STROKE_TTL_S = 0.6` 秒的硬编码 TTL（清理早就衰减到看不见的回击，防止 `strokes` 数组无限增长），这个 TTL 和回击自己的衰减时间常数 `decay`（生产用 50–200 ms）没有关系，是一个固定上限——调试时为了「让闪光多留一会方便截图」，手工塞了一条 `decay: 5`（5 秒）的回击，指数衰减本身没问题，但 0.6 s 一到，这条回击就被 TTL 过滤器直接从 `strokes` 数组里删掉，强度归零。而 `scripts/scenarios.mjs` 的 `applyScene()` 在场景的 `js` 跑完之后还有一段 `await new Promise((r) => setTimeout(r, sc.wait ?? 2500))` 的默认等待才真正截图（`js` 里自己的 `await sleep(...)` 只占其中一小段），这段默认等待轻松跨过 0.6 s 的 TTL 坎——`js` 里当场读数（几十到两百毫秒内）显示强度正确，等真正截图时（几秒之后）已经衰减到 0，两次读数「时间点不同」表现成「一个说有一个说没有」，是这次排查绕远路的直接原因。

**以后怎么识别**：远塔 / 近处雷暴这类「按泊松节律触发、真实衰减常数在几十到几百毫秒」的效果，调试时想让它多停留几秒方便截图，**用 `hold` + `heldIntensity`**（`weather.ts` 和 `far-towers.ts` 都有，语义是「钉死、不再衰减也不再触发」），不要手工塞一条超长 `decay` 的回击去凑；任何「按真实节律走的衰减 / TTL 逻辑」，手工数据的生命周期假设都很容易和框架的默认等待（`shots` 的 `sc.wait`、`settle`、其他工具的收敛等待）对不上，读数时间点不同就会得出自相矛盾的结论。

确认根因后用 `hold=true; heldIntensity=X` 重测，一次成功（见下方截图），全部「像 bug」的现象随之消失——A/B/C/D 四个 `vec4[32]` 数组本身一直工作正常。

## 数字（RTX 5090，d3d11，1600×1200，画质 high）

| 项 | 结果 | 说明 |
| --- | --- | --- |
| typecheck / build / 0 字节 | 通过 / 通过 / 0 | |
| check:glsl | 通过 | 场景表同步、sampler 表等全部 OK |
| `shader-parity`（对当前 worktree 自身 `git diff HEAD`） | 只改了 `apps/voyage/src/clouds/far-towers.ts` 一个文件、纯新增 155 行 | 用 `--base` 指向主仓库当时因另一并行任务（TW04）改动 `clouds.glsl.ts` 有 6 个雷暴相关程序differs——与本任务无关，已用 `git diff` 确认本 worktree 除 far-towers.ts 外无改动 |
| 默认截图（`shots` 不带 `--allow-flash`） | `hold=true`，塔强度合计 0.0000 | 与关闪电前逐位一致（D.x 恒 0，公式不产生任何贡献） |
| `--allow-flash` + `flashNow()` 逐帧强度采样（见下方） | 16 ms 到 501 ms 之间清楚看到「触发即接近峰值→指数衰减→第二下回击叠加变亮→继续衰减」 | |
| 控制台 | 全程无 console error / pageerror | |

### 逐帧强度曲线（证明「亮起与衰减」，非静态截图能证明的）

```
16ms:1.082 18ms:1.061 26ms:0.990 34ms:0.924 42ms:0.864 49ms:0.808 57ms:0.753 65ms:0.703 73ms:0.660
93ms:1.373 105ms:1.245 109ms:1.199 112ms:1.164 121ms:1.076 127ms:1.025 135ms:0.955 ...（继续平滑衰减）
...501ms:0.039
```
73ms→93ms 从 0.660 跳到 1.373 是第二下回击叠加（成串 2–4 下的直接证据），此后单调指数衰减到 501ms 只剩 0.039，全过程零跳变噪声。复现脚本见下方。

## 截图（`tmp/screenshot/tw-ltg/`，worktree 内，未提交）

- `final-default/tw-ltg-off.png`：默认（不带 `--allow-flash`）关闪，塔正常，无光晕。
- `final/tw-ltg-lit.png`：`--allow-flash` + `hold=true; heldIntensity=1.3`，塔身内部与砧底同时被点亮，边缘随距离软化。180 km，夜间（太阳高度 −45°，满月）。

## 已知问题 / 给协调者

- **远处闪电色被空气透视吃暖**（见上「颜色标定」）：170 km 附近看得出偏紫，300+ km 基本是暖白。不算 bug，是既有空气透视物理的自然结果，交接给以后想要「无论多远都保持冷色调」时参考（可能要让闪光走 `apL`〔散射进入路径〕而不是 `Lt`〔表面辐亮度〕，绕开这段透射率）。
- **核心过曝**：`hold` 强测截图里塔顶正中心有一小片死白（核心过曝），属可接受范围（近处雷暴的闪电在 `clouds.ts` 也是类似处理），未专门压。
- **没有测试真实天气场驱动的多塔同屏闪烁**（`TW-LTG-accept.json` 用 `continuousJourney` + 真实天气场跑过一次，`远塔 2 座，可打闪 2 座，flashNow=true` 确认了天气场路径也能正常触发，但当时机位塔恰好不在窗内，没截到真实天气场景下的可见截图）；建议以后波次做整窗回归时顺手截一张。
- **没有做飞行中多帧录像式回归**（`ab` 的 `job.live` 逐帧 uniform 统计），只用了自定义脚本采样 `uFarD.value[0].x`。如果以后要判断「是否闪烁得不自然 / 是否有回归」，可以参考 README「相邻像素差 / 死白的统一口径」一节的做法另起 job。

## 复现

```bash
cd apps/voyage
# 默认（关闪）与 hold 强制点亮对照
node scripts/dev-browser.mjs shots --port <端口> --angle d3d11 --scenes-file apps/voyage/handoff/TW-LTG-scenes.json --out tmp/screenshot/tw-ltg/final-default
node scripts/dev-browser.mjs shots --port <端口> --angle d3d11 --allow-flash --scenes-file apps/voyage/handoff/TW-LTG-scenes.json --out tmp/screenshot/tw-ltg/final
# 逐帧强度曲线（证明亮起与衰减）
node scripts/dev-browser.mjs shots --port <端口> --angle d3d11 --allow-flash --scenes-file apps/voyage/handoff/TW-LTG-decay.json --out tmp/screenshot/tw-ltg-decay
# 真实天气场驱动（22:00，连续航程，参照 TW02-accept.json 复现参数）
node scripts/dev-browser.mjs shots --port <端口> --angle d3d11 --query "&voyage=1" --allow-flash --scenes-file apps/voyage/handoff/TW-LTG-accept.json --out tmp/screenshot/tw-ltg/accept
# 静态检查
node scripts/lint-shaders.mjs
npx tsc --noEmit
npx vite build && find dist/assets -type f -size 0
```

调试句柄：`__voyage.farTowers`（新增 `hold` / `heldIntensity` / `flashNow(id?)`，其余同 TW02：`towers` / `active` / `scissor` / `override` / `bench(n)` / `enabled`）。

## 开发体验反馈

- **哪里慢**：绝大部分时间花在一个「假 bug」的排查上（见上「踩的坑」）——从「怀疑 GPU/three.js 有 uniform 数组绑定问题」到「定位到是自己的调试数据撞了硬编码 TTL」，来回换了七八种排除法测试（改名、换位置、缩数组、换类型、换索引方式），每次都要重新起 `shots` 截图 + 读 JSON 诊断，单次约 20–40 秒，合计消耗了这个任务里最多的时间。
- **哪里卡**：
  1. `scripts/dev-browser.mjs shots` 的截图时机（场景 `js` 跑完 + `sc.wait ?? 2500`）离「我在 `js` 里刚设完的调试状态」有 2–3 秒的默认间隔，任何「按真实挂钟节律衰减 / 有 TTL」的手工调试数据都要么用 `hold`，要么显式把 `decay` 设成比这个间隔更长很多（本任务最终确认根因后才想清楚要用 `hold`）。
  2. Chinese console 输出在 Windows Git Bash 里经过 GBK 转码全部乱码（`python -c` 读 JSON 文件本身没问题，是 `node scripts/dev-browser.mjs` 直接打印到终端的部分乱码），排查时只能靠把 JSON 文件读出来用 Python 打印，不能直接看 Bash 工具打印的 stdout。
  3. `gl.getUniformLocation`/`gl.getUniform` 这类原始 WebGL 诊断能确认「uniform 在 GPU 上的值」，但不能替代确认「着色器执行到这行代码时读到的值」——本任务最后是靠「同一段代码，只改 unconditional 加法 vs 加一个 `if` 判断，对照两次结果」才想到会不会是数据本身的时间窗口问题，而不是一直死磕 uniform 绑定。
- **希望有**：一个「不依赖场景默认等待、纯粹在 `js` 内部用 `requestAnimationFrame` 循环采样某个 uniform / 状态随时间变化」的工具化脚本（本任务临时写了 `TW-LTG-decay.json` 一次性用，值得沉淀成 `dev-browser.mjs` 的一个子命令，比如 `sample --field farTowers.mat.uniforms.uFarD.value[0].x --frames 30`，给「验证一个按泊松 / 衰减节律变化的量」这类任务复用）。
