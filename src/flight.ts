import * as THREE from "three";
import type { Preset, VoyageState } from "./state";
import { CRUISE_PITCH_DEG } from "./state";

/**
 * 飞行：预设地点 / 航线、大圆导航公式、以及飞行状态（航向、坡度、高度、俯仰、颠簸、湿度）的每帧更新。
 * 从 main.ts 拆出（T01 纯重构，未改动任何算法或参数，只是把闭包变量换成参数）。
 */

// 预设都放在海上；下面出现的岛屿是程序生成的示例，不对应真实地理（真实地形见路线图 P5）
export const PRESETS: Preset[] = [
  { id: "wpac", name: "西太平洋上空 · 东京以南约 600 km · 向南飞", lat: 30.0, lon: 139.8, heading: 180, tz: 9, islands: 0.12 },
  { id: "ecs", name: "东海上空 · 上海以东约 400 km · 向东飞", lat: 31.2, lon: 126.0, heading: 80, tz: 8, islands: 0.05 },
  { id: "scs", name: "南海上空 · 向西南飞", lat: 18.0, lon: 115.0, heading: 225, tz: 8, islands: 0.35 },
  // 陆地：需要开「真实地理数据」
  { id: "yangtze", name: "长江中下游 · 鄱阳湖以北 · 向东北飞", lat: 29.55, lon: 115.9, heading: 70, tz: 8, islands: 0 },
  { id: "fuji", name: "骏河湾上空 · 向西飞（富士山从右前方出现）", lat: 35.0, lon: 138.95, heading: 270, tz: 9, islands: 0 },
  // 真实航线（大圆航线，从爬升结束、进入巡航的位置开始）：需要开「真实地理数据」
  { id: "hnd-cts", name: "航线：东京羽田 → 札幌新千岁（北上，经东北地方）", lat: 36.2, lon: 140.3, heading: 10, tz: 9, islands: 0, dest: [42.78, 141.69] },
  { id: "hnd-itm", name: "航线：东京羽田 → 大阪伊丹（西行，经富士山）", lat: 35.35, lon: 139.35, heading: 260, tz: 9, islands: 0, dest: [34.78, 135.44] },
  { id: "pvg-pek", name: "航线：上海浦东 → 北京首都（北上，过长江、黄河）", lat: 31.9, lon: 121.2, heading: 330, tz: 8, islands: 0, dest: [40.08, 116.58] },
];

const D2R = Math.PI / 180;
/** 大圆航线的初始方位角（度，从正北顺时针） */
export function greatCircleBearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D2R) + 360) % 360;
}
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dl / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** 真实爬升 / 下降率约 10–15 m/s；飞行阶段按钮按 10 倍加速，免得等十几分钟 */
const ALT_RATE_KMS = 0.012 * 10;

/** 地速随高度变化：巡航约 900 km/h，进近约 250 km/h */
export function speedAt(altKm: number) {
  return 0.07 + (0.25 - 0.07) * THREE.MathUtils.smoothstep(altKm, 0.5, 9);
}

/** 飞机当前航向在世界坐标里的水平方向（x 东、z 南），给云探针这类只关心朝向的调用用 */
export function ownDirW(headingDeg: number) {
  const hh = THREE.MathUtils.degToRad(headingDeg);
  return new THREE.Vector3(Math.sin(hh), 0, -Math.cos(hh));
}

/** 附近雷暴的形状：字段和 weather.ts 里的 Storm 一致（那个 interface 没导出，这里按结构类型接收） */
export interface StormLike {
  x: number;
  z: number;
  radius: number;
  top: number;
}

export interface TurbulenceInput {
  dt: number;
  now: number;
  /** clouds.cameraDensity：飞机当前位置的云密度 */
  inCloud: number;
  storms: StormLike[];
  /** cloudUniforms.uCloudOffset.value：飞机的本地位置（km），只读 */
  cloudOffset: THREE.Vector2;
}

/** 颠簸与窗上的水：按云密度、附近雷暴算颠簸强度，再从颠簸算滚转和上下颤动；顺带更新窗板外侧湿度。
 *  返回值 bump 是这一帧头部要叠加的垂直抖动（米），调用方自己加到 head.y 上。 */
export function updateTurbulence(state: VoyageState, input: TurbulenceInput): number {
  const { dt, now, inCloud, storms, cloudOffset } = input;
  let turbTarget = 0.03 + Math.min(inCloud * 3, 1) * 0.4;
  for (const s of storms) {
    const dist = Math.hypot(s.x - cloudOffset.x, s.z - cloudOffset.y);
    if (state.altitudeKm < s.top + 1) turbTarget = Math.max(turbTarget, 1 - THREE.MathUtils.smoothstep(dist, s.radius * 1.2, s.radius * 6));
  }
  state.turbulence += (turbTarget - state.turbulence) * (1 - Math.exp(-dt * 1.5));
  // 在云里变湿（~3 秒湿透），出来后被气流吹干（~20 秒）
  const wetRate = inCloud > 0.03 ? 0.35 : -0.05;
  state.wetness = THREE.MathUtils.clamp(state.wetness + wetRate * dt, 0, 1);
  const tb = state.turbulence;
  const tt = now / 1000;
  // 几个不成比例的频率叠起来，像不规则的气流冲击
  const shake = (a: number) => Math.sin(tt * 7.3 + a) * 0.5 + Math.sin(tt * 13.1 + a * 2) * 0.3 + Math.sin(tt * 2.9 + a * 3) * 0.6;
  state.rollDeg = tb * 1.2 * shake(0.7);
  const bump = tb * 0.012 * shake(2.1);
  return bump;
}

export interface AdvanceFlightInput {
  dt: number;
  curLat: number;
  curLon: number;
  /** cloudUniforms.uCloudOffset.value：就地累加这一帧的位移，云场、地面 clipmap 都靠它随飞机平移 */
  cloudOffset: THREE.Vector2;
  /** preset.dest 且飞到终点附近时触发（main.ts 里是重新 setPreset 回起点） */
  onReachDest: () => void;
}

export interface AdvanceFlightResult {
  /** 这一帧是否在朝目标高度爬升 / 下降（面板上的高度数字要不要显示「当前 → 目标」） */
  climbing: boolean;
  /** 这一帧的位移（座舱 z 朝窗外的世界坐标，km），给云的时间累积重投影用 */
  motion: THREE.Vector3;
  /** 机头方向单位向量（世界坐标） */
  ownDir: THREE.Vector3;
  /** 窗外方向单位向量（世界坐标，已按左右座翻过） */
  outwardW: THREE.Vector3;
  /** 这一帧的地速（km/s） */
  speedKms: number;
}

/** 沿大圆航线飞：航向转向「当前位置到终点」的大圆方位角。客机转弯坡度一般不超过 25°，
 * 对应的转弯角速度 ω = g·tanφ / v（巡航时约 1°/s）；坡度随转弯角速度平滑变化，转弯时窗外的地平线会倾斜。
 * 同时处理飞行阶段的高度爬升（俯仰角跟着变）和位置推进。 */
export function advanceFlight(state: VoyageState, input: AdvanceFlightInput): AdvanceFlightResult {
  const { dt, curLat, curLon, cloudOffset, onReachDest } = input;
  const preset = state.preset;
  const vKms = speedAt(state.altitudeKm);
  if (preset.dest) {
    const target = greatCircleBearing(curLat, curLon, preset.dest[0], preset.dest[1]);
    const diff = ((target - state.heading + 540) % 360) - 180;
    const maxRate = THREE.MathUtils.radToDeg((9.81 * Math.tan(THREE.MathUtils.degToRad(25))) / (vKms * 1000));
    const rate = THREE.MathUtils.clamp(diff * 0.3, -maxRate, maxRate); // 接近目标航向时柔和改平
    state.heading = (state.heading + rate * dt + 360) % 360;
    const bankTarget = THREE.MathUtils.radToDeg(Math.atan((vKms * 1000 * THREE.MathUtils.degToRad(rate)) / 9.81));
    state.bankDeg += (bankTarget - state.bankDeg) * (1 - Math.exp(-dt * 0.7));
    // 到达终点附近：回到起点重新飞
    if (haversineKm(curLat, curLon, preset.dest[0], preset.dest[1]) < 40) onReachDest();
  } else {
    state.bankDeg *= Math.exp(-dt);
  }

  // 飞机向前飞：云场按航向平移
  const h = THREE.MathUtils.degToRad(state.heading);
  // 飞行阶段：朝目标高度爬升或下降，俯仰角跟着变（爬升抬头约 8°，下降约 0°，巡航 2.5°）
  const dAlt = state.targetAltKm - state.altitudeKm;
  const climbing = Math.abs(dAlt) > 0.005;
  if (climbing) {
    state.altitudeKm += Math.sign(dAlt) * Math.min(Math.abs(dAlt), ALT_RATE_KMS * dt);
  }
  const lowAndSlow = state.altitudeKm < 2 ? 3.5 : CRUISE_PITCH_DEG; // 低空低速时迎角更大，机头更高
  const pitchTarget = climbing ? (dAlt > 0 ? 8 : 0) : lowAndSlow;
  state.pitchDeg += (pitchTarget - state.pitchDeg) * (1 - Math.exp(-dt * 0.8));
  const speedKms = speedAt(state.altitudeKm);
  const step = speedKms * dt;
  cloudOffset.x += Math.sin(h) * step;
  cloudOffset.y += -Math.cos(h) * step;
  const motion = new THREE.Vector3(Math.sin(h) * step, 0, -Math.cos(h) * step);
  const ownDir = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
  const outwardW = new THREE.Vector3(Math.cos(h), 0, Math.sin(h)).multiplyScalar(state.seat === "right" ? 1 : -1);

  return { climbing, motion, ownDir, outwardW, speedKms };
}
