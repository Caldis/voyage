# BIS-8 · 回归对照：月夜雷暴塔身黑白相间硬边横带

- 对象：`research/ART_REVIEW_wave8.md` 第 5 条「月夜的积雨云是『斑马塔』」。只调查，没有改 `src/`。
- 怀疑对象：C10c（进浓云首段受光 od 按「样本比表面深」减量，6 步 / 8 步受光分支同改）。合并提交 `4f1bf20`（`4f1bf20^1` = `07683b6`「看板：C10c 小返工（天气程序 8 步分支）」，是 C10c 合并前主线的 tip，只改了 `TASKS.md` / `handoff/C10c-review.md`，不碰 `src`）。
- 场景：从 `tmp/screenshot/art-wave8/f/f-storm-night-2.json` 的 `panel` 还原（`f-storm-night.json` 同一天同一时刻只是 `wing-pos` 不同，两张原图里的塔都有横带，选 `-2` 是因为它没有「地面瓦片加载中」的提示，机位更干净）：`wpac`、`2026-09-28 21:30` 本地、雷暴天气、10.7 km 巡航、月亮高度角 40.8°、方位 96°、照亮 96%（月亮在观众身后偏右）、太阳在地平线下 50°。场景文件：`tmp/bis8-scene.json`（未提交，仓库已忽略 `tmp/`）。

## 结论先行：**不是 C10c 的回归**

- 用同一份 `--scene` JSON、`--freeze`（钉住位置 / 航向 / 头部 / 模拟时间 / 曝光适应 / 闪电 / 频闪相位，逐像素可比）分别在 **C10c 合并前**（临时 worktree `tmp/bis8-pre` 指向 `07683b6`，端口 5253）和**当前主线**（含 C10c，端口 5181）拍同一机位，两边渲染器都是 `ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 …, D3D11)`。**塔身的黑白硬边斑块两边逐像素基本一致**：整幅图平均绝对差 1.18/255（未冻结时因随机相位的翼尖灯光晕、云步进抖动相位不同，差到 9.79/255，见下「未冻结对照」），超过阈值 8 的像素只占 3.90%，且集中在星空闪烁、机翼细边缘、远处云毯的抗锯齿边界，不在两座塔的斑块内部；把塔身裁剪区整体排除后，超阈值像素比例只从 3.90% 降到 2.86%，塔身贡献的差异份额很小，且是边缘级的。**两张放大裁剪图肉眼对比不出差异**——同样的黑块 / 白块形状、同样的位置、同样的硬边界。
- 代码层面也支持这个结论：C10c 新增的 `odCut` 减量只在 `stormW < 0.5 && fine == 0`（层状云受光、不在雷暴表面细化模式）时生效，塔身进入 `fine = 8`（表面细化）分支后这一路径**被显式排掉**，C10c 自己的交付文档（`handoff/C10c.md`）也写明「odCut 本身带 stormW / fine 门控，塔身不动」。`git diff --stat 07683b6 HEAD -- apps/voyage/src/` 确认从 C10c 合并前到当前主线，`src/` 下唯一变化就是 `clouds.ts` 这一段 odCut 逻辑（46 行插入），没有其它渲染代码改动，所以这次 pre/post 对照是干净的、没有被同期其它任务污染。
- 按任务说明的分支：**pre 也有横带 → 不是回归**，因此没有再做「把 odCut 减量置 0」的 `ab` 确认（那一步是留给「回归」分支的，塔身在代码上本来就不吃 odCut，pre/post 截图已经直接证明）。

## 证据

| 截图 | 说明 |
| --- | --- |
| `tmp/screenshot/bis8/post/storm-night.png`、`.json` | 未冻结，端口 5181（当前主线，含 C10c），`renderer` 已核对 NVIDIA D3D11、`quality.level = high` |
| `tmp/screenshot/bis8/pre/storm-night.png`、`.json` | 未冻结，端口 5253（`07683b6`，C10c 合并前），同一 `--scene` JSON |
| `tmp/screenshot/bis8/tower-post.png`、`tower-pre.png` | 未冻结裁剪放大（`--crop 640,540,460,320 --zoom 3`），两塔都是黑白硬边斑块 |
| `tmp/screenshot/bis8/diff-heatmap.png` | 未冻结 pre/post 差异热图：最大的一块红色是翼尖航行灯的光晕 bloom（两次独立起页面时闪灯相位 / bloom 累积状态不同，与云无关），塔身区域也有一圈黄绿色边缘差异，但看不出整体结构变化 |
| `tmp/screenshot/bis8/post-frozen/storm-night.png`、`pre-frozen/storm-night.png` | **冻结**（`--freeze`）后同机位重拍，消除随机闪灯相位与云步进时间累积相位的干扰 |
| `tmp/screenshot/bis8/tower-post-frozen.png`、`tower-pre-frozen.png` | 冻结版裁剪放大，两塔逐斑块位置基本重合，肉眼对比不出差异 |
| `tmp/screenshot/bis8/diff-heatmap-frozen.png` | 冻结版差异热图：亮点集中在星空、机翼细边缘、远处云毯抗锯齿边界；两座塔内部大片是黑色（无差异），只有斑块交界处有稀疏的细边差异 |

冻结版量化（`compare.mjs --diff --threshold 8`，1600×1200 全图）：

| 口径 | 平均绝对差 | p99 | 超阈值像素占比 |
| --- | --- | --- | --- |
| 未冻结（pre vs post） | 9.79/255 | 116.33 | 24.27%（大头是翼尖灯 bloom，见热图） |
| 冻结（pre vs post） | 1.18/255 | 23.33 | 3.90% |
| 冻结、排除塔身裁剪区 640,540,460,320 | 0.92/255 | 19.33 | 2.86%（说明塔身区域只贡献约 1 个百分点的差异，且是裁剪图上看不出的边缘级） |

## 机制猜测（未在本任务内验证，仅供后续任务参考）

塔身黑白硬边斑块本身不是新问题，`ART_REVIEW_wave7` 第 6 条已经记过「塔身上的水平光带」，wave8 追踪里写「已消失，塔身现在是连续的暗褐色」——**那是白天 / 黄昏场景**。这次月夜（雷暴 8 步受光分支、`cloudDensityLite` 朝月亮方向做 8 小步光学厚度、`msDecay` / `tailK` 给多次散射的尾项）是第一次在这个光照条件下拍到。结合 wave8 报告自己的假设 2 与 `handoff/T46.md` 的既有结论，最可能的来源：

1. **夜里能补足暗部的环境光太少**：T46 已经把「无月纯黑」修好（半精度下溢 + 补夜天光），但那套补偿是按 `nightglow`（星光 / 黄道光量级，~1e-6 klux）估的，比这次月亮 96% 满、40.8° 高度的直射月光小好几个数量级。白天云的暗面能被天空的漫射光和多次散射「填」得比较柔和；月夜时能填暗面的散射光本身就弱，塔身一旦有局部自遮挡（表面细化 `fine=8` 抓到的是逐样本的真实几何，凹凸感比 6 步分支更细），直接朝月亮通路被挡住的格点，受光步进的 8 步光学厚度会陡增，亮度跌到接近纯黑；没被挡住的格点直接吃满月光，色调映射后顶到高光clip，两者之间缺一个「弱环境光」的过渡层，才读成黑白硬边而不是渐变阴影。
2. 8 步受光分支只有 8 个离散采样点、没有对阴影做柔化（不像 C10c 减量分支那样有 `smoothstep` 渐隐），塔身的表面细化把命中样本收得很贴近真实密度面，二者叠加，遮挡状态在相邻像素间可能整段翻转，缺一个模糊估计。

以上两条都是**没有做开关对照的假设**，不构成结论；如果要继续查，建议按 wave8 报告的路子另开任务（报告建议单独立 `C-STORM-SAUCER`，或者一个新的「夜间雷暴受光」任务），用 `dev-browser ab` 在这个 `storm-night` 机位上分别调高夜间环境光系数、调粗 8 步受光的采样间隔看斑块会不会变柔和。

## 复现

```bash
# 主仓库根
node apps/voyage/scripts/dev-browser.mjs shots --port 5181 --angle d3d11 --respect-lock \
  --scenes-file tmp/bis8-scene.json --out tmp/screenshot/bis8/post --freeze
# 临时 worktree 指向 C10c 合并前
git worktree add tmp/bis8-pre 07683b6 && cd tmp/bis8-pre && pnpm install && cd ../..
# （在该 worktree 目录下）pnpm --filter voyage exec vite --host 127.0.0.1 --port 5253
node apps/voyage/scripts/dev-browser.mjs shots --port 5253 --angle d3d11 --respect-lock \
  --scenes-file tmp/bis8-scene.json --out tmp/screenshot/bis8/pre --freeze
node apps/voyage/scripts/compare.mjs --diff tmp/screenshot/bis8/post-frozen/storm-night.png \
  --threshold 8 --heatmap tmp/screenshot/bis8/diff-heatmap-frozen.png tmp/screenshot/bis8/pre-frozen/storm-night.png
```

`tmp/bis8-scene.json`：

```json
[
  {
    "name": "storm-night",
    "p": {
      "preset": "wpac", "seat": "right", "date": "2026-09-28", "time": 1290,
      "weather": "storm", "cloud-preset": "cumulus", "cabin-light": false,
      "cabin-class": "business", "altitude": 10.7, "shade": 0, "wind": 7, "wing-pos": "8"
    },
    "head": [0, 0.02, -0.3],
    "wait": 3000
  }
]
```

## 归属建议

- `research/ART_REVIEW_wave8.md` 第 5 条「月夜黑白横带」应从「疑似 C10c 回归」改记为「非回归，机制待查」；`TASKS.md` 的 BIS-8 一行同步更正。
- 实际修复不在本任务范围内，按上面「机制猜测」交给后续的夜间雷暴受光 / `C-STORM-SAUCER` 任务，需要先做开关对照才能定根因。

## 清理

- 临时 worktree `tmp/bis8-pre`（指向 `07683b6`）与其上的 vite（5253）已在任务结束时关闭 / 删除（`git worktree remove --force` + `Remove-Item -Recurse -Force` + `git worktree prune`），主分支 5181 全程没有关闭。
