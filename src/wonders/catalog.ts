/**
 * 奇观注册表（W01）：每个奇观声明自己的外观、尺度、放置、出现条件和编排时长。
 * 系统（system.ts）只按这里的字段挑选、摆放、驱动 reveal；着色在 render/wonder-*.glsl.ts。
 * 设计依据：research/WONDERS.md §5（系统设计）、§6.1（天梯 / 建木）。
 *
 * 命名约定（研究文档 §2.1）：面板名写成「名字（致敬《作品》）」或注明典籍出处；id 用描述性英文。
 */

import { FLOATCITY_KIND, FOGCITY_KIND, W00_PROBE_KIND, WONDER_CLOUD_KINDS } from "./wonder-cloud.glsl";
import { RING_SKIN } from "./ring-shape";

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
    /** 着色器皮肤编号：0 天梯、1 建木、2 巨柱群（WS07）、3 天环（WS08，wonders/ring.glsl.ts，RING_SKIN） */
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
  caster?: { center: [number, number, number]; radii: [number, number, number]; strength?: number };
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
    // WS01：从 330–410 km 拉近到 200–260 km（基座在地平线以内、落在海上，锚塔整块体量留在窗里）
    distanceKm: [200, 260],
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
    // WS01 巨构化：缆束半径 1 km（直径 2 km，220 km 外约 12 像素宽），底下是 30–40 km 高的锚塔、天上是 3–5 个环形站
    // （尺寸按每次出现的种子随机，见 wonders/tether-shape.ts）
    look: { radiusKm: 1.0, albedo: [0.034, 0.035, 0.037], skin: 0, beacons: true },
  },
  {
    id: "jianmu",
    // 建木出自《淮南子·地形训》（公有领域典籍），不是致敬某部作品
    name: "建木（《淮南子·地形训》：众帝所自上下）",
    layer: "sky",
    // WS05 巨构化：从 340–410 km 拉近到 200–260 km（树脚在地平线以内，埋在它自己的云海里）
    distanceKm: [200, 260],
    forwardOffsetDeg: [8, 30],
    minAltitudeKm: 6,
    // 「日中无景」：白天与黄昏；深夜它就隐没了，几乎不出现
    sunWeight: (a) => (dusk(a) ? 2.5 : a > 6 ? 1.5 : 0.3),
    riseS: 120,
    holdSimS: [420, 720],
    fadeS: 120,
    // WS05：一座山那样粗的树——底部直径 5–8 km、往上收成笔直的柱（百仞无枝），九片板根（九枸）斜入脚下的云海，
    // 48 km 以上九根巨枝（九欘）伸出 38–88 km、挂着稀疏的青色叶簇；8–24 km 缠着三圈云气。尺寸按每次出现的种子取
    // （着色器从 uWonderShape.w 读种子，radiusKm 在建木上不用）。albedo 是树皮（「紫茎」：偏紫的灰褐，真实树皮 0.1 上下），
    // 见 render/wonder-sky.glsl.ts
    look: { radiusKm: 3.2, albedo: [0.15, 0.125, 0.125], skin: 1, beacons: false },
  },
  {
    id: "pillars",
    // 原创造型（参考图「垂直荒原」一类的巨构插画的视觉语言：极简混凝土柱、大气把上半截冲淡），不致敬具体作品
    name: "巨柱群（贯穿云海的混凝土巨柱）",
    layer: "sky",
    // WS07：锚点（群中心附近）在 180–280 km 外；行往远处退，最近一根约 140–240 km、最远的柱脚沉到地平线以下只剩柱顶
    distanceKm: [180, 280],
    forwardOffsetDeg: [8, 30],
    minAltitudeKm: 6,
    // 白天到黄昏最好（柱顶还亮着、柱脚已入夜的那段最美）；夜里只剩一排同步慢闪的红灯，也出现，权重低
    sunWeight: (a) => (a > -3 && a < 8 ? 3 : a >= 8 ? 1.5 : a > -12 ? 1.5 : 0.6),
    riseS: 120,
    holdSimS: [420, 720],
    fadeS: 120,
    // 尺寸、根数、摆放全按每次出现的种子（wonders/pillar-shape.ts）；radiusKm 不用。albedo 不用（着色器用 WONDER_CONCRETE 按柱微调）
    look: { radiusKm: 2, albedo: [0.3, 0.3, 0.3], skin: 2, beacons: false },
  },
  {
    id: "fogcity",
    // 致敬《银翼杀手》（1982）开场的「地狱城」：原创造型（阶梯金字塔、火炬、光束、车流都是程序生成），不用任何官方资产
    name: "雾海灯城（致敬《银翼杀手》）",
    layer: "cloud",
    // WS02 巨构化：城区半径约 33 km（雾与光穹在 43.5 km 内渐隐）；锚点在 90–140 km 外，近边 45 km 以外。
    // 110 km 处金字塔（14–16 km）顶在地平线上方约 5°、尖塔（20–24 km）约 8–9°，从巡航高度要仰视（research/WONDER_SCALE.md §3.2）
    distanceKm: [90, 140],
    forwardOffsetDeg: [5, 25],
    minAltitudeKm: 5,
    // 只在夜里（研究文档 C6：太阳 < −12°）；民用暮光末段（−12°..−6°）灯刚亮、雾还带蓝灰，偶尔也出现；白天不自动出现
    // （白天只剩一团偏黄褐的霾和巨塔的淡灰剪影，没有「灯城」，手动召唤时才看得到）
    sunWeight: (a) => (a <= -12 ? 3 : a <= -6 ? 1 : 0),
    riseS: 120,
    holdSimS: [480, 900],
    fadeS: 120,
    // 包围盒：±46 km（雾裙与光穹在 43.5 km 内衰减到 0，盒边不切出硬边）、高 25 km（尖塔最高 24 km + 顶灯；
    // 雾只在 2.4 km 以下、烟柱 5.6 km 以下，介质另外收窄；表面按每座塔的包围球早退）
    volume: { kind: FOGCITY_KIND, baseKm: 0, box: [[-46, 0, -46], [46, 25, 46]], surface: true, medium: true, stepKm: 0.3 },
  },
  {
    id: "floatcity",
    // 致敬宫崎骏《天空之城》（1986）：原创造型（巨树树冠、层层台地、倒扣的岩石底座与垂根、化雾的瀑布都是程序生成），不用任何官方资产
    name: "浮空古城（致敬《天空之城》）",
    layer: "cloud",
    // WS04 巨构化（research/WONDER_SCALE.md §3.4）：直径 25–35 km（按种子），台地底 12–16 km、冠顶 25–32 km，
    // 粗根垂进下方的云海（根尖 1.4–3 km）。110 km 处宽约 15°（约 350 像素），冠顶在地平线上方约 11–13°，要仰视
    distanceKm: [90, 140],
    forwardOffsetDeg: [5, 25],
    minAltitudeKm: 6,
    // 白天到黄昏（研究文档 A1：太阳 5–25° 的侧逆光最好）；太阳落下后只剩剪影，入夜（< −5°）不自动出现
    sunWeight: (a) => (a < -5 ? 0 : a < 5 ? 2 : a <= 25 ? 3 : 1.5),
    // 浮现 90 s：先是一团「形状不太对劲的云」，雾散开后城显出来；停留约 5–8 模拟分钟；退场再被雾吞没
    riseS: 90,
    holdSimS: [300, 480],
    fadeS: 90,
    // 局部原点海拔 14 km（= 着色器的 FLC_BIG_BASE），台地底面按种子在 ±2 km 里挪。包围盒：城本身水平最大半径约 17.4 km、
    // 顺风吹偏的瀑布雾约 22 km、浮现时那团「云」约 23 km；水平放到 ±45 km 是给尺度参照的航迹云（离城轴 34–44 km 淡出）。
    // 竖直从海平面（根尖、瀑布雾、根尖云涡）到冠顶 + 浮现的那团云（约 21 km）。
    // 介质区间由着色器收窄（显形后只走台地底面以下、离城轴 3.05·Kh + 5.5 km 的圆柱），步长 0.5 km（96 步封顶）
    volume: {
      kind: FLOATCITY_KIND,
      baseKm: 14,
      box: [[-45, -14.5, -45], [45, 22, 45]],
      surface: true,
      medium: true,
      stepKm: 0.5,
      params: [1],
      // 投影：约 28 km 宽的椭球（研究文档：影子投在云海上约 30 km 宽），浓度 0.75（树冠有缝、根须透光，不投实心的坑）
      caster: { center: [0, 3, 0], radii: [14, 6, 14], strength: 0.75 },
    },
  },
  {
    // WS04：W03 原尺寸的小岛，保留下来低概率出现（权重是巨构版的四分之一，约两成）；着色器同一段，params[0] = 0 走原来的路径
    id: "floatcity-small",
    name: "浮空古城·小岛（致敬《天空之城》）",
    layer: "cloud",
    // 直径约 6 km、连根须高约 8 km：80 km 处宽约 4.3°（约 100 像素），远而朦胧，剪影仍认得出
    distanceKm: [75, 130],
    forwardOffsetDeg: [5, 25],
    minAltitudeKm: 6,
    sunWeight: (a) => 0.25 * (a < -5 ? 0 : a < 5 ? 2 : a <= 25 ? 3 : 1.5),
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
      // 影子浓度 0.6：椭球只是整座城的粗近似（树冠有缝、根须透光），不该投出一个实心的坑
      caster: { center: [0, 0.5, 0], radii: [3.0, 3.0, 3.0], strength: 0.6 },
    },
  },
  {
    id: "orbital-ring",
    // 设定出自 Paul Birch 的「轨道环」构想（Orbital Ring Systems and Jacob's Ladders, JBIS 1982），不是致敬某部作品；
    // 造型（箱形环体、转子护套、缆塔、灯带）都是程序生成
    name: "天环（轨道环：Paul Birch 1982 年的设想）",
    layer: "sky",
    // 环本身的位置按种子定（wonders/ring-shape.ts：高 500–1400 km、在窗口方向仰角 7–18° 处横贯 / 斜贯天空），
    // 这里的距离只是挂给系统的锚点（环在窗口方向上的星下点，最远收到 1200 km）
    distanceKm: [900, 1200],
    forwardOffsetDeg: [0, 20],
    minAltitudeKm: 6,
    // 黄昏最美（一段在阳光里、一段在地影里，交界发红）；夜里是城市般的灯带；白天是一道淡白的弧
    sunWeight: (a) => (dusk(a) ? 3 : a <= -12 ? 2 : 1.2),
    riseS: 60,
    holdSimS: [600, 900],
    fadeS: 60,
    // skin 3（RING_SKIN）：着色在 wonders/ring.glsl.ts（自己的 uRingOn，不走天梯 / 建木 / 巨柱群那段）；radiusKm / albedo 不用
    look: { radiusKm: 0, albedo: [0.3, 0.3, 0.3], skin: RING_SKIN, beacons: true },
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
