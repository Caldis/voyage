# SC-3 · 海面着色只内联一次：交接

- 分支：`worktree-agent-ac0277e45a30d69cf`（基于 master `2e26aea`）；开发服务器 5233（在 apps/voyage 下 `npx vite --port 5233 --strictPort --host 127.0.0.1`）
- 状态：**已交付**，等审查。改了 `src/render/terrain-shading.glsl.ts`、`src/render/scene.ts`（只改 `outsideRadiance`）、`src/render/ocean.glsl.ts`（`oceanRadiance` 签名）。main.ts、src/clouds/* 没动，不需要接入代码。

## 改了什么
- `groundRadiance` 拆成三步：`groundHit`（求交、影像、水体遮罩、空气透视，结果放进 `struct GroundHit`）→ `groundLand`（陆地）→ `groundFinish`（水面加闪光、碎浪、天空反射并与陆地合成）。
- `outsideRadiance` 统一在命中点（真实地面或海平面球）算一次：`cloudShadow`、水面的 `keyLight` / `skyIrradiance`、`flashIlluminance`，然后**只有一个** `oceanRadiance` 调用点（真实地面的海洋与开阔海面共用），内陆水面仍走 `inlandWaterRadiance`，反射方向的 `skyRadiance` 也只有一处。
- `oceanRadiance` 多了 `eSun`、`eSky` 两个参数（原来函数内部自己调 `keyLight(BOTTOM, n) · cloudShadow(P)` 与 `skyIrradiance(BOTTOM, n)`，表达式与调用处完全相同，所以数值等价）。

## 调用点数量（场景程序，按内联份数计）
| 函数 | master | 本分支 |
| --- | --- | --- |
| `oceanRadiance` | 2 | **1** |
| `cloudShadow` | 3（地面 1 + 两份 oceanRadiance 内各 1） | **1** |
| `flashIlluminance` | 2 | **1** |
| `skyRadiance`（窗外） | 3 | **2**（天空 1 + 反射 1） |
| `keyLight` | 8 | 6（main 里 2 处同参调用、traffic 2 处不归本任务） |
| `sampleGround` / `terrainHit` / `terrainShadow` / `marchFunnel` | 不变 | 不变 |

## 数字（d3d11，RTX 5090，本机 GPU 有其他代理争用）
- 真冷启动（`dev-browser.mjs cold`）：场景着色器后台编译 **master 71.1 s → 分支 19.4 s**；总耗时 83.9 s → 29.0 s。
- 低空细节变体（GROUND_DETAIL）在同一页面内单独 `compileAsync`：master 70.4 s → 分支 29.2 s。
- 逐像素：同一页面、同一帧的 uniform 与纹理，分别用 master 与分支的场景着色器画 HDR（32F）比较：
  low-sea-glint 逐位一致；fuji-day / route-hnd-cts / suruga-low（fuji，1.5 km，细节变体）最大相对差 ≤ 2.6e-7（浮点舍入）；night-city 最大相对差 2e-5（出现在 1e-5 量级的暗像素上，绝对差 1e-10），没有任何像素超过 1e-4。每个场景隔 3 s 重复比较 2 次，结果相同。
- 帧时间（`bench --baseline 5181`）：low-sea-glint +1.2%、fuji-day +0.4%、night-city −1.4%、route-hnd-cts −3.4%，都在噪声内。

## 怎么复现
- 对比工具没有提交，放在 worktree 的 `tmp/sc3-tools/`：`_m_*.ts` 是 master 版三个文件的拷贝（`_m_scene.ts` 导出 `SCENE_FRAG`），`_sc3_compare.ts` 在页面里编译两份材质并逐像素比较，`_sc3-compare.mjs` 是驱动。用法：把前四个放回 `src/render/`、驱动放回 `scripts/`，然后 `node scripts/_sc3-compare.mjs --port 5233 [--only a,b] [--repeat N] [--split 1] [--dbg 9,8]`。
- 截图：`tmp/screenshot/sc3/*.png`（本分支的画面）。

## 坑
- 对比时偶发「应用场景后的第一次比较」出现约 1e-4 的相对差（大部分海面像素、个别闪烁点翻转），同一页面紧接着再比就逐位一致，之后多次重复也一致；master↔master 在同一次里始终逐位一致。没查清根因（怀疑是切场景后某个输入在两次绘制之间被 GPU 异步更新，或 ANGLE 在首次绘制时用了另一版可执行文件）。以后做类似的逐像素对比：**每个场景至少比两次，以稳定后的结果为准**。

## 已知问题 / 可继续做（不在本任务归属内）
- `main()` 里 `keyLight(uCamR, upW)` 同参调用两次（第 174、177 行附近），可以合成一个变量。
- `main()` 里调试 3 的 `windowIrradiance` 多一份内联（只为调试视图）。
- `terrainShadow` 的循环上界是常量 16，里面是 `groundHeightAt → sampleGround`（带逐级查找循环），FXC 会展开 16 份；`terrainHit` 的二分也是常量 6 次。可以按 `uTerrainSteps` 的写法改成 uniform 上界，在 ground.glsl.ts 里。
- `oceanRadiance` 里程序岛屿的 `islandField` 调了 3 次（3×3 常量循环 + fbm），只在关掉真实地面时有用。
