# REFLECT-OFF · 舷窗上的舱内倒影默认关闭

用户原话：「另外机舱反光过强了，也请弱化甚至默认关闭」。按「关」为默认，保留可调强度。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `src/render/cabin-reflect.glsl.ts` | 新 uniform `uReflStrength`（声明在 `CABIN_REFLECT_COMMON` 头部）；导出共享 uniform 对象 `CABIN_REFLECT_STRENGTH = { value: 0 }` |
| `src/render/scene.ts` | 倒影分支入口加 `uReflStrength > 0.0`（调试 31 / 33 例外）；叠加改成 `view += uReflStrength * reflAdd`（乘在软限幅之后）；材质 uniforms 挂 `uReflStrength: CABIN_REFLECT_STRENGTH` |
| `index.html` | 「舱内灯光」下面加一行 `窗上倒影 <output id="cabin-reflect-out"> <input id="cabin-reflect" type="range" 0–1 step 0.05 value 0>` |
| `src/ui.ts` | `setupReflectUi()`：URL `?reflect=` > `voyage.pref.view.reflect`（`{ v: 1, ... }`，保留其他字段）> 0；只在 `isTrusted` 的 change / 双击复位时写；显示「关」/「NN%」+ `aria-valuetext` |

exposure.ts 没改（⑦⑧ 的倒影增益 / 上限仍按原样算，关时只是不用）；wing / clouds / ocean / atmosphere 没碰。

## 面板位置与理由（PANEL_UX_GUIDE）

- 分区：**观景**，紧挨「舱内灯光」。它回答的是「我怎么看」，效果一眼可见、普通用户会想调（嫌玻璃反光），属 `user` 层；不放开发者区。
- 控件：滑条（连续量、拖动时能看到画面变化，§4.1）；0 显示「关」，一个控件同时表达开关与强度，不另设开关（§4.1「一种意图，一种控件」）。
- 文案：标签「窗上倒影」（4 字，无括号）；说明放 `title`（§3.1）。
- 记忆：属观看偏好（§7.1 `voyage.pref.view`），只记亲手操作；URL 强制的初值不写（§7.3）。双击复位到默认（关）。
- 本仓库还没有 `<details>` 分区与「恢复默认」按钮，等 UX 框架迁移时把它挪进声明式描述即可（id `cabin-reflect` 不变）。
- 与 FOCUS-ZOOM 的冲突面：我只在「舱内灯光」label 后插一行、在 ui.ts 的 cabin-light 监听后加一行调用 + 一个独立函数段，不碰开发者区。

## 验收

同页冻结 A/B（`dev-browser.mjs ab`，d3d11 / RTX 5090 硬件渲染，1600×1200，噪声底全部 0）：

| 场景 | 默认 vs 强度 0 | 强度 1 vs master 着色器 | 默认 vs 强度 1（mean / max / >8 像素） |
| --- | --- | --- | --- |
| 夜 · 开灯 · 商务（scs 左座 22:30） | 逐位 0 | 逐位 0 | 10.9 / 156 / 42.2 万 |
| 夜 · 开灯 · 经济 | 逐位 0 | —（经济变体不能换 base 着色器，强度 1 与默认的差和商务同量级） | 11.5 / 153 / 42.9 万 |
| 夜 · 睡眠档 | — | 逐位 0 | 0.37 / 5 / 0 |
| night-city-on（4 km 夜城） | 逐位 0 | 逐位 0 | 13.0 / 155 / 50.9 万 |
| noon-cumulus（白天） | — | 逐位 0 | 0.09 / 4.3 / 0 |
| economy-ahead（白天经济舱） | — | — | 0.007 / 2 / 0 |

- **非倒影像素**：舱内合成 + 机翼之后的 HDR（`hdrWing`）只在窗板区不同（night-city-on 不同像素数 109 万 ≈ 显示图上窗板面积）；显示图上窗框以外（x < 300 或 > 1300）只有 21–163 个像素差 1 个灰阶的 1/3（最大 0.33），来源是辉光 pass 读到窗内少了的那点光。冻结下曝光不动；实时运行时窗内测光少了倒影，窗外曝光会有相应的小变化（T30 ④' 的开灯档上限照旧兜住）。
- **T47 交界 / TM02 机翼 / T48c**：强度 1 与 master 逐位相同，默认只是交界重混合前少加了一份倒影；`logExpOC`（T47 重混合用的曝光比）在分支外照算，未变；机翼 pass、曝光 pass 未改。
- **URL / 记忆**：`?reflect=1` 页面显示「100%」、uniform = 1；脚本 `dispatchEvent` 设 0.5 后 `localStorage` 仍为 null（不记）。
- **GPU**（`gpu-ab --time scene`，带 A/A）：夜间开灯商务 off 0.831 ms，A/A ×0.990，on ×1.067、master ×1.046（均显著）→ 关掉省舱内合成约 4–6%（≈0.04–0.05 ms）；正午 12 轮 on ×1.044 [0.93, 1.20]、master ×1.004，在噪声内（机器负载 CPU 30–85%，权威值留给波次收尾复测）。
- typecheck、build、check:glsl 全过；`dev-browser check` 与各次 shots 控制台零 error。

## 截图（worktree 的 `tmp/screenshot/REFLECT-OFF/`）

- 前后对比（同页冻结）：`ab/night-sea-on-biz/{s1,cur,s05}.png`、`ab/night-sea-on-eco/{s1,cur}.png`、`ab/night-city-on/{master,cur}.png`、`ab/noon-cumulus/{master,cur}.png`；差异热图 `ab/*/heat-cur-vs-s1.png`
- 实时默认 vs `?reflect=1`：`live-default/`、`live-url1/`（夜开灯商务、黄昏开灯）；面板截图 `live-default/panel.png`

## 复现

```
node scripts/dev-browser.mjs ab --port <端口> --base <master 端口> --jobs tmp/reflect-jobs.json
```
jobs 里的变体：`{"uniforms": {"sceneMat.uniforms.uReflStrength.value": 1}}`；master 用 `{"materials": {"sceneMat": "base"}}`。

## 注意 / 遗留

- 回归场景、美术总监截图从此默认看不到倒影；要评审倒影本身，场景 `p` 里加 `"cabin-reflect": 1`（面板 id 契约，走 input 事件）或 `--query reflect=1`。
- 端口：简报给的 5269 被别的进程占着（不是本任务的服务器），改用 5279，对照 master 用 5359。
