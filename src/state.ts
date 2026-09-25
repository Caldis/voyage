import type { CloudPreset } from "./clouds/clouds";

/**
 * 共享的状态类型与常量：main.ts（创建并持有 `state`）、flight.ts（读写飞行相关字段）、
 * ui.ts（面板绑定读写）都要用到，放在这里避免互相依赖。从 main.ts 拆出（T01 纯重构，未改动任何取值）。
 */

/** 一个可选地点，或一条真实航线的起点 */
export interface Preset {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** 航向，度，从正北顺时针 */
  heading: number;
  /** 显示当地时间用的时区（UTC 偏移，小时） */
  tz: number;
  /** 程序生成岛屿的密度（每 30 km 格子出现的概率）；岛屿是示例，不对应真实地理 */
  islands: number;
  /** 航线终点（纬度, 经度）：有的话沿大圆航线飞过去，航向随位置变化；没有就沿固定航向直飞 */
  dest?: [number, number];
}

/** 巡航时机头略微抬起，侧窗里的地平线因此微微倾斜（main.ts 初始化 state 时、flight.ts 每帧算俯仰目标时都要用） */
export const CRUISE_PITCH_DEG = 2.5;

/** 全局模拟状态：main.ts 创建并持有这个对象，flight.ts / ui.ts 按需读写其中字段 */
export interface VoyageState {
  preset: Preset;
  simTime: number;
  playRate: number;
  seat: "right" | "left";
  altitudeKm: number;
  /** 飞行阶段按钮设的目标高度；滑块直接改当前高度 */
  targetAltKm: number;
  /** 当前航向（度）：沿航线飞时随位置变化 */
  heading: number;
  /** 转弯坡度（度），右转为正 */
  bankDeg: number;
  /** 当前俯仰角（度），随爬升 / 下降平滑变化 */
  pitchDeg: number;
  /** 颠簸造成的滚转（度） */
  rollDeg: number;
  /** 颠簸强度 0..1：晴空 ~0.03，普通云里 ~0.4，雷暴附近到 1 */
  turbulence: number;
  /** 窗板外侧的湿度 0..1：在云里、雨里变湿，出来后被气流吹干 */
  wetness: number;
  shade: number; // 0 = 全开，1 = 全关
  wind: number;
  cabinLight: boolean;
  cloudPreset: CloudPreset;
  /** 翼根前缘在机头方向上相对窗口的距离（米）：座位在机翼前方时为负 */
  wingRootLE: number;
  /** 真实地理数据（联网拉取卫星影像、地形、水体） */
  groundOn: boolean;
}

/** 按 id 取 DOM 元素：main.ts（渲染器挂载点、加载遮罩）和 ui.ts（面板控件）共用的小工具 */
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
