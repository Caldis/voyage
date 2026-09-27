/**
 * 火车远景（TR03）的 uniform：窗外程序的 RAIL 变体读（`rail/far-view.glsl.ts`），火车模式每帧由 `RailMode` 写。
 *
 * 模块级单例：`createOutsideMaterial` 把它们并进场景 / 窗外共用的 uniforms 对象（飞机的默认程序不声明它们，只是多几个不用的键），
 * `RailMode.applyPose` 直接改 `.value`，main.ts 不需要接线。这里不 import three（node 单测也会加载 mode.ts）。
 */
export const railFarUniforms = {
  /** 相机（眼睛）的海拔（km）。uCamR = 6360 + 海拔 在 float32 里只有约 0.5 m 分辨率，火车远景的地形求交改用这个小数 */
  uRailCamAltKm: { value: 0 },
  /** 近处地面的标高（km）：国土地理院 DEM（线路走廊网格），窗侧 15–80 m 的平均，眼睛以下至少 1.2 m */
  uRailNearGroundKm: { value: 0 },
  /** 国土地理院 − clipmap 地形（AWS Terrain）在相机周围的差（km）：近处（1–4 km 内渐隐）把 clipmap 地形平移到国土地理院的基准 */
  uRailTerrOffsetKm: { value: 0 },
  /** 火车远景地形求交的最多步数（uniform：常量上限会被 FXC 展开） */
  uRailSteps: { value: 128 },
};
