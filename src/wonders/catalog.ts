/**
 * 奇观注册表（W01）：每个奇观声明自己的外观、尺度、放置、出现条件和编排时长。
 * 系统（system.ts）只按这里的字段挑选、摆放、驱动 reveal；着色在 render/wonder-*.glsl.ts。
 * 设计依据：research/WONDERS.md §5（系统设计）、§6.1（天梯 / 建木）。
 *
 * 命名约定（研究文档 §2.1）：面板名写成「名字（致敬《作品》）」或注明典籍出处；id 用描述性英文。
 */

/** 奇观所在的层：sky = 天幕层（在所有云之外，云的遮挡是现成的）；cloud = 云间层（要插进云的步进，W00 之后才有） */
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
  /** 天幕层细线类奇观的外观（天梯 / 建木共用一段着色器） */
  look: {
    /** 底部半径（km） */
    radiusKm: number;
    /** 表面反照率 */
    albedo: [number, number, number];
    /** 着色器皮肤编号：0 天梯、1 建木 */
    skin: number;
    /** 夜里高处的航标灯与上升的轿厢 */
    beacons: boolean;
  };
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
    // 再低（< 2%）正午就完全看不见了。取值见 handoff/W01.md 的对照
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
    // 深色的木质、偏暖：白天是一道比天空暗的细线，黄昏上段被染成暗金（比天梯稍粗、稍亮）
    look: { radiusKm: 0.34, albedo: [0.05, 0.035, 0.022], skin: 1, beacons: false },
  },
];

export function wonderById(id: string): WonderDef | undefined {
  return WONDERS.find((w) => w.id === id);
}
