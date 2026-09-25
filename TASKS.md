# 航行伴侣 · 任务看板

协调者维护（见 `DEV_SOP.md`）。子代理不改本文件。
状态：待办 → 进行中（写分支名）→ 待审查 → 返工 / 通过 → 已合并（写日期）。
「热点」一栏标出会碰 `src/main.ts` / `src/render/scene.ts` 的任务：同一波里每个热点文件只能分给一个任务。

## 进行中

| 编号 | 波次 | 端口 | 分支 | 实现 | 审查 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| T02 | 第 2 波 | 5192 | `worktree-agent-a611f3799d938f8bb`（842eb24） | Opus（已交付） | Opus 审查中（5182） | 待审查 |
| T03 | 第 2 波 | 5193 | worktree（交付时回填） | Opus | 待派 | 进行中 |
| T05 | 第 2 波 | 5195 | worktree（交付时回填） | Opus | 待派 | 进行中 |
| T14 | 第 2 波（追加） | 5194 | `worktree-agent-afbefe1914f657874`（9b80b7b） | Opus（已交付，需接入 main.ts 4 行） | Opus 审查中（5183） | 待审查 |
| T06 | 第 2 波（追加） | 5197 | worktree（交付时回填） | Opus | 待派 | 进行中 |

第 2 波文件归属：T02 独占 `scene.ts`、`ground.glsl.ts`、`terrain-shading.glsl.ts`、`src/ground/*`；T03 独占 `src/clouds/*`、`weather.ts`、`lightning.glsl.ts`；T05 独占 `main.ts`、`flight.ts`、`ui.ts`、`state.ts`、`wing.glsl.ts`、`wing-shading.glsl.ts`、`lights.glsl.ts`、`index.html`；T14 独占 `ocean.glsl.ts` 与新建的 `src/ocean/*`（scene.ts / main.ts 的接入以代码片段交付）。

T06 · 舱内质感（用户 2026-09-25 反馈：「舷窗以外挺唬人，舷窗以内确实好假」）：侧壁弧面与材质脏污、窗框厚度与高光、遮光板、前后排座椅与织物纹理（布料 BRDF）。归属 cabin / view 与新建 cabin-*.glsl.ts；**试行例外**：可改 scene.ts main() 里的舱内合成段并追加 uniform（T02 只动地面部分），冲突由协调者合并时解决——请开发体验官在本波后评估这种「按段归属」是否比「接入片段」更顺手。端口 5197（5196 被 T05 的对照服务器占用）。

T14 · 海面去重复（用户 2026-09-25 截图反馈：低空海面是规则的平行横条纹）：根因是斜率场只有 12 个等比波长的正弦波；改为 GPU FFT（JONSWAP + 方向扩展）多级联、LEAN 过滤、风斑大尺度调制。

## 待办（按建议顺序）

| 编号 | 任务 | 优先级 | 归属文件（可改） | 热点 | 验收场景 / 标准 |
| --- | --- | --- | --- | --- | --- |
| T16 | **着色器编译进度条**（用户 2026-09-25：「纯等也有点干」）：用 `KHR_parallel_shader_compile`（three.js `compileAsync` / 轮询 `COMPLETION_STATUS_KHR`）把各个程序异步编译，加载遮罩显示分阶段清单（大气 LUT / 云噪声 / 云 / 场景 / 后期，逐项打勾）+ 总进度条 + 已用时间；单个程序编译期间驱动不给进度，条内按上次记录的各阶段耗时（localStorage）估算并标明「约」；命中缓存时一闪而过。编译期间页面保持响应（进度条能动） | **第 3 波第一个** | `src/main.ts`（启动段）、`index.html`（遮罩）、`src/style.css`、新建 `src/boot/*` | main（第 2 波 T05 占用，故排第 3 波） | 冷启动（清着色器缓存：换 ANGLE 后端或改一行着色器）看到逐项推进、不冻结；热启动 < 1 秒遮罩消失；`window.__voyageStartup` 继续有效 |
| T02 | 低空近景地面细节：影像只有约 15 m/像素，低空（< 3 km）时加程序化细节（田垄、树冠起伏、建筑高度感），随距离淡出 | 高 | `src/render/ground.glsl.ts`、地面着色模块（T01 之后） | 否（T01 后） | 新增回归场景：骏河湾 1.5 km、长江 1.5 km；远处不闪烁 |
| T03 | 雷暴打磨：塔身细节仍偏规则、乳状云、雨幡与云底；雨带里能见度下降；夜间雷暴整体观感；云地闪通道在近距离时的形态 | 高 | `src/clouds/clouds.glsl.ts`（雷暴部分）、`src/weather.ts` | 否（闪电通道在 T01 后的独立模块） | storm-day、夜间雷暴（新增场景）、飑线；对照真实积雨云照片 |
| T04 | 台风：外围螺旋雨带、从高空俯视的整体螺旋结构、卷云盖从下方看的样子 | 中 | `src/clouds/clouds.glsl.ts`（台风部分）、`src/weather.ts` | 否 | typhoon-eye、typhoon-bands（新增场景） |
| T05 | 机翼动态：频闪闪亮时照亮翼尖附近的机翼和云；进近（< 2 km）时襟翼 / 扰流板展开；坐在机翼前方时能看到的发动机短舱 | 中 | `src/render/wing.glsl.ts`、机翼着色模块（T01 之后） | 否（T01 后） | sunset-wing、night-city、进近场景（新增） |
| T06 | 舱内真实几何：侧壁弧面、行李架下沿、座椅靠背边缘进入视野；舱内材质 | 中 | `src/render/cabin.glsl.ts`、`src/render/view.glsl.ts`、舱内着色部分（T01 后） | 否（T01 后） | noon-cumulus、night-city（舱灯开 / 关） |
| T07 | 光学细节：太阳附近的眼睛衍射星芒；窗板边缘色散；高空低温时内层窗板透气孔周围的冰晶 | 中 | `src/render/bloom.ts`、`src/render/exposure.ts`、`src/render/cabin.glsl.ts`（窗板部分） | 否 | sunset-wing、noon-cumulus |
| T08 | 道路灯带：OSM transportation 图层，夜里的主干道与高速公路成为连续的灯带 | 中 | `src/ground/tiles.ts`、`src/ground/clipmap.ts`、地面着色模块 | 否（T01 后） | night-city、route-hnd-cts 夜间版（新增） |
| T09 | 银河：先调研许可合适的全天星空图（优先公有领域），再接入 | 低 | `src/sky-assets.ts`、`src/render/stars.glsl.ts`、`public/data/` | 否 | 夜间无月、关舱灯的场景（新增） |
| T10 | 天气自然变化：飞行途中天气场随位置变化（晴空 → 积云 → 雷暴区），不必手动选预设 | 低 | `src/weather.ts`、`src/clouds/clouds.glsl.ts`（天气场部分） | 否 | 沿航线飞 10 分钟（600× 时间流速之外另做加速）观察 |
| T11 | 音效（P7）：舱内噪声实时合成（宽带噪声 + 发动机低频），随高度、速度、颠簸变化；雷声（闪电后按距离延迟） | 低 | 新建 `src/audio.ts`，面板加开关（交付接入代码） | 需要接入 main（交付接入代码） | 主观听感；默认静音，用户点击后开启（浏览器自动播放限制） |
| T12 | 云的打磨：卷云仍偏团状；强逆光下的银边；云底的絮状细节 | 低 | `src/clouds/clouds.glsl.ts`（层状云部分）、`src/clouds/clouds.ts` | 否 | sunset-wing、clouds-variety、卷云场景（新增） |
| T13 | 中距离小积云有横向条纹 / 拖影（fuji-day 截图里富士山左侧那排小云，像扫描线；疑似 TAA 重投影或步进在有地面时的问题），先查根因 | 中 | `src/clouds/*` | 否 | fuji-day、route-hnd-cts |

## 已知问题（还没排成任务）

- **场景着色器 sampler 已满**：ANGLE 上 `MAX_TEXTURE_IMAGE_UNITS = 16`，T14 合并后场景着色器活跃 sampler 16/16。再加纹理要先合并进纹理数组 / 图集（T05、T06 已被告知不新增 sampler）。
- 帧时间：带真实地面、窗口较大（约 1880 宽截图）时回归脚本测得中位数约 31.6 ms；窗口较小、无地面时约 6.3 ms。用户要求专注内容，暂不优化；若某个任务让它明显变差，审查时要指出。
- 着色器冷编译约 45 秒（已加加载遮罩，用户决定不优化）。

## 已完成

| 编号 | 任务 | 合并日期 | 备注 |
| --- | --- | --- | --- |
| T01 | 拆分热点文件（main.ts → state / flight / ui；scene.ts → ocean / terrain-shading / wing-shading / lightning） | 2026-09-25 | Sonnet 实现，Opus 审查通过 |

### 此前由协调者直接开发（未走本流程）

P0–P6 的第一版，详见 `WORKLOG.md` 与 `ROADMAP.md`。
