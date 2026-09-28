# W-EDGE 独立审查（B′ 定稿，分支 worktree-agent-a628011fd52a5863f @ b4ae9f7）

> 写到一半的草稿：结论待复测后定。复核 worktree `tmp/wedgerev`（master 6a7a2b8 + merge --no-commit），开发 5270，对照 5181（master）。

## 结论（暂定，读 diff 后）

- 代码读下来没有硬 bug；与 STROBE-FLASH（afec713）merge-tree 无冲突（STROBE-FLASH 只动灯光函数与 wingLights，W-EDGE 动 wingView 末尾与 wingTrace）。
- 待复测：飞行中爬行三场景（含后缘与整流罩区按覆盖率掩码复核）、亮像素判据的新切换、冷编译安静复测、真冷启动。

## 读 diff 的疑点（待测）

1. 亮像素判据 `lum(col) > 3·refL` 本身是一个**无迟滞的逐像素估计器开关**（单样本 ↔ 5 样本 + 去亮点），正是本任务修掉的那类问题；门限附近的像素颜色会跳（单样本 ≈3·refL，走超采样后被 lCap = max(2·lMin, 0.7·refL) 压下）。覆盖率不跳（covA），颜色跳乘以覆盖率。
2. 亮像素路径用于**外侧（中心没打中）**像素时，`colC` 是空中最近点的着色，仍以权重 1 计入平均；wingView 注释「中心射线能进到这里一定是打中了」已不成立。子样本全没打中时 lMin = lC，不压亮点（原样单样本）。
3. 夜里 refL 很小：翼面被灯照亮的边缘像素几乎全部走超采样（性能、与频闪帧的切换）。
