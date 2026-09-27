/**
 * 奇观注册表（W01）：每个奇观声明自己的外观、尺度、放置、出现条件和编排时长。
 * 系统（system.ts）只按这里的字段挑选、摆放、驱动 reveal；着色在 render/wonder-*.glsl.ts。
 * 设计依据：research/WONDERS.md §5（系统设计）、§6.1（天梯 / 建木）。
 *
 * 命名约定（研究文档 §2.1）：面板名写成「名字（致敬《作品》）」或注明典籍出处；id 用描述性英文。
 */

import { FLOATCITY_KIND, FOGCITY_KIND, W00_PROBE_KIND, WONDER_CLOUD_KINDS } from "./wonder-cloud.glsl";

/** 奇观所在的层：sky = 天幕层（在所有云之外，云的遮挡是现成的）；cloud = 云间层（插进云的步进，W00，见 wonder-cloud.glsl.ts） */
export type WonderLayer = "sky" | "cloud";

/** 挑选奇观时看的外部条件（WonderSystem.update 每帧由 main.ts 给出） */
export interface WonderContext {
  lat: number;
  lon: number;
  /** 航向（度，从正北顺时针） */
  heading: number;
  seat: "right" | "left";
  /** 飞机处的太阳高度角（度） */
  sunAltDeg: number;
  altitudeKm: number;
  /** 飞机所在处的云密度（clouds.cameraDensity）：> 0.3 大致是在云里、窗外全白 */
  inCloud: number;
  /** 云量 0..1 */
  coverage: number;
  /** 这一趟航程的标识（同一趟不重复出现同一个奇观）：航线 id + 当地日期 */
  flightKey: string;
}

export interface WonderDef {
  id: string;
  /** 面板上显示的名字（致敬类写明「致敬 ××」） */
  name: string;
  layer: WonderLayer;
  /** 离飞机的地面距离范围（km） */
  distanceKm: [number, number];
  /** 相对「窗口正对的方向」往机头偏多少度（自动出现时的范围；正 = 偏向机头，随飞行慢慢转到窗口中间、再往后退） */
  forwardOffsetDeg: [number, number];
  /** 最低飞行高度（km）：飞机不低飞，低处有霾 */
  minAltitudeKm: number;
  /** 按太阳高度角给的权重（0 = 不出现） */
  sunWeight: (sunAltDeg: number) => number;
  /** 按窗口朝向（窗口正对的方位角，度）给的权重，省略 = 1 */
  facingWeight?: (outwardDeg: number) => number;
  /** 编排：浮现（真实秒）、停留（模拟秒）、退场（真实秒） */
  riseS: number;
  holdSimS: [number, number];
  fadeS: number;
  /** 云间层奇观（layer = "cloud"）的体：插进云步进的种类与包围盒（W00，见 wonder-cloud.glsl.ts、handoff/W00.md） */
  volume?: WonderVolume;
  /** 天幕层细线类奇观的外观（天梯 / 建木共用一段着色器）；云间层奇观不用 */
  look?: {
    /** 底部半径（km） */
    radiusKm: number;
    /** 表面反照率 */
    albedo: [number, number, number];
    /** 着色器皮肤编号：0 天梯、1 建木 */
    skin: number;
    /** 天梯的附属结构：中继站、舱体、系留平台、航标灯（建木没有） */
    beacons: boolean;
  };
}

/**
 * 云间层奇观的体（W00）。坐标都是奇观局部坐标（km）：原点在锚点（地面经纬度）正下方的海平面再抬高 baseKm，
 * x 东、y 天顶、z 南。表面、介质都必须在包围盒 box 以内（盒外的部分不画）。
 */
export interface WonderVolume {
  /** 着色器种类编号：wonder-cloud.glsl.ts 的 WONDER_CLOUD_KINDS 里的 id */
  kind: number;
  /** 局部坐标原点离海平面的高度（km），通常 0 */
  baseKm: number;
  /** 局部坐标的包围盒 [最小角, 最大角]（km）；越紧越省（盒外的视线一步都不多走） */
  box: [[number, number, number], [number, number, number]];
  /** 有没有解析表面（sdf + shade）、有没有介质（medium） */
  surface: boolean;
  medium: boolean;
  /** 介质里的最大步长（km）；包围盒另外保证至少分 48 步 */
  stepKm: number;
  /** 投影椭球（挡住云受到的直射光）：中心、三个半轴（km，局部坐标） */
  caster?: { center: [number, number, number]; radii: [number, number, number] };
  /** 给着色器的自定义参数（uWonderParams.w = params[0]；uWonderParams.z 是每次出现的随机种子，W02 起） */
  params?: [number];
}

/** 暮色（太阳在 −12°..+6°）是这类「上段仍被阳光照亮」的奇观最美的时候 */
const dusk = (a: number) => a > -12 && a < 6;

export const WONDERS: WonderDef[] = [
  {
    id: "tether",
    name: "天梯（致敬《流浪地球 2》太空电梯）",
    layer: "sky",
    distanceKm: [330, 410],
    forwardOffsetDeg: [8, 30],
    minAltitudeKm: 6,
    // 黄昏与夜里最美（上段还在阳光里、或只剩航标灯）；白天是一条很淡的线，也可以出现，权重低
    sunWeight: (a) => (dusk(a) ? 3 : a <= -12 ? 1.5 : 1),
    // 真实的轨道电梯在赤道上，从北半球看在南方：窗口朝南（方位 90°–270°）时更常出现
    facingWeight: (o) => {
      const d = ((o % 360) + 360) % 360;
      return d > 90 && d < 270 ? 2 : 0.7;
    },
    riseS: 90,
    holdSimS: [420, 720],
    fadeS: 90,
    // 很暗的缆索（反照率约 3.5%）：正午只是一道很淡的细线（天空的亮度大多来自它前面的空气）；
    // 暮色里被阳光照到的那段像月亮一样亮（暮色的天空比阳光暗 4–5 个数量级），反照率再高就会晕成一道粗光柱，
    // 再低（< 2%）正午就完全看不见了。取值见 handoff/W01.md 的对照（待用户确认，W01b 保留）。
    // W01b：缆上挂着中继站、上下行的舱体、斜拉的稳定缆、海上系留平台、节律航标灯与面板闪光——白天被注意到的是这些
    // 比天空亮的东西（线本身在正午几乎看不见），见 render/wonder-sky.glsl.ts
    look: { radiusKm: 0.28, albedo: [0.034, 0.035, 0.037], skin: 0, beacons: true },
  },
  {
    id: "jianmu",
    // 建木出自《淮南子·地形训》（公有领域典籍），不是致敬某部作品
    name: "建木（《淮南子·地形训》：众帝所自上下）",
    layer: "sky",
    distanceKm: [340, 410],
    forwardOffsetDeg: [8, 30],
    minAltitudeKm: 6,
    // 「日中无景」：白天与黄昏；深夜它就隐没了，几乎不出现
    sunWeight: (a) => (dusk(a) ? 2.5 : a > 6 ? 1.5 : 0.3),
    riseS: 120,
    holdSimS: [420, 720],
    fadeS: 120,
    // 深色的木质、偏暖：树干白天几乎看不见，黄昏上段被染成暗金（比天梯稍粗、稍亮）。
    // W01b：高处九根弯枝（九欘）、12–30 km 缠着树干的云气（白天最先被注意到的就是它）、树冠一带的萤光，见 render/wonder-sky.glsl.ts
    look: { radiusKm: 0.34, albedo: [0.05, 0.035, 0.022], skin: 1, beacons: false },
  },
  {
    id: "fogcity",
    // 致敬《银翼杀手》（1982）开场的「地狱城」：原创造型（阶梯金字塔、火炬、光束、车流都是程序生成），不用任何官方资产
    name: "雾海灯城（致敬《银翼杀手》）",
    layer: "cloud",
    // 城区半径约 27 km：锚点在 70–130 km 外，近边 40 km 以外（10.7 km 高处俯角 5–14°，窗里的下半截）
    distanceKm: [70, 130],
    forwardOffsetDeg: [5, 25],
    minAltitudeKm: 5,
    // 只在夜里（研究文档 C6：太阳 < −12°）；民用暮光末段（−12°..−6°）灯刚亮、雾还带蓝灰，偶尔也出现；白天不自动出现
    // （白天只剩一团偏黄褐的霾和巨塔的淡灰剪影，没有「灯城」，手动召唤时才看得到）
    sunWeight: (a) => (a <= -12 ? 3 : a <= -6 ? 1 : 0),
    riseS: 120,
    holdSimS: [480, 900],
    fadeS: 120,
    // 包围盒：城区 ±36 km（城区椭圆外缘 ≈ 32 km）、高 7 km（光束渐隐到 6.8 km；雾只在 2.2 km 以下，介质另外收窄）
    volume: { kind: FOGCITY_KIND, baseKm: 0, box: [[-36, 0, -36], [36, 7, 36]], surface: true, medium: true, stepKm: 0.3 },
  },
  {
    id: "floatcity",
    // 致敬宫崎骏《天空之城》（1986）：原创造型（巨树树冠、层层台地、倒扣的岩石底座与垂根、化雾的瀑布都是程序生成），不用任何官方资产
    name: "浮空古城（致敬《天空之城》）",
    layer: "cloud",
    // 直径约 6 km、连根须高约 8 km：80 km 处宽约 4.3°（约 100 像素），远而朦胧，剪影仍认得出
    distanceKm: [75, 130],
    forwardOffsetDeg: [5, 25],
    minAltitudeKm: 6,
    // 白天到黄昏（研究文档 A1：太阳 5–25° 的侧逆光最好）；太阳落下后只剩剪影，入夜（< −5°）不自动出现
    sunWeight: (a) => (a < -5 ? 0 : a < 5 ? 2 : a <= 25 ? 3 : 1.5),
    // 浮现 90 s：先是一团「形状不太对劲的云」，雾散开后城显出来；停留约 5–8 模拟分钟；退场再被雾吞没
    riseS: 90,
    holdSimS: [300, 480],
    fadeS: 90,
    // 局部原点 = 台地底面（岩石半球上沿），海拔 7.5 km：根须尖约 3.3 km，树冠顶约 11.7 km，底下是云海（层积云顶 2.2 km）。
    // 包围盒装下雾罩椭球（半径 6.2 / 5.6 km，浮现时那团「云」要把整座城裹住）；投影椭球近似整座城（挡住下方云海的阳光）
    volume: {
      kind: FLOATCITY_KIND,
      baseKm: 7.5,
      box: [[-6.25, -5.7, -6.25], [6.25, 5.5, 6.25]],
      surface: true,
      medium: true,
      stepKm: 0.12,
      caster: { center: [0, 0.5, 0], radii: [3.0, 3.0, 3.0] },
    },
  },
];

/**
 * 调试用的奇观：不参与随机挑选、不进面板下拉，只能用 __voyage.wonders.trigger(id) 召唤。
 * W00 测试体只在 URL 带 ?w00probe 时编进奇观 pass（见 wonder-cloud.glsl.ts），没编进去时召唤了也看不见。
 */
export const DEBUG_WONDERS: WonderDef[] = [
  {
    id: "w00-probe",
    name: "W00 测试体（倒锥浮岩 + 雾环，接口验证用，示例）",
    layer: "cloud",
    distanceKm: [60, 120],
    forwardOffsetDeg: [0, 0],
    minAltitudeKm: 0,
    sunWeight: () => 0,
    riseS: 10,
    holdSimS: [3600, 3600],
    fadeS: 10,
    volume: {
      kind: W00_PROBE_KIND,
      baseKm: 0,
      box: [[-4.2, 2.3, -4.2], [4.2, 6.95, 4.2]],
      surface: true,
      medium: true,
      stepKm: 0.2,
      caster: { center: [0, 4.6, 0], radii: [2.8, 1.9, 2.8] },
    },
  },
];

export function wonderById(id: string): WonderDef | undefined {
  return WONDERS.find((w) => w.id === id) ?? DEBUG_WONDERS.find((w) => w.id === id);
}

/** 云间层奇观的种类有没有编进奇观 pass（没编进去的不能出现） */
export function wonderVolumeCompiled(def: WonderDef) {
  return def.layer !== "cloud" || (!!def.volume && WONDER_CLOUD_KINDS.some((k) => k.id === def.volume!.kind));
}
