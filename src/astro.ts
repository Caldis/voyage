import { Body, Equator, Horizon, Illumination, MakeTime, Observer, RotateVector, Rotation_HOR_EQJ, Vector } from "astronomy-engine";

export interface SunPosition {
  /** 方位角，度，从正北顺时针 */
  azimuth: number;
  /** 几何高度角，度（不含大气折射：渲染里的大气本身不弯曲光线，两者要一致） */
  altitude: number;
}

export function sunPosition(date: Date, lat: number, lon: number, heightMeters: number): SunPosition {
  const observer = new Observer(lat, lon, heightMeters);
  const eq = Equator(Body.Sun, date, observer, true, true);
  const hor = Horizon(date, observer, eq.ra, eq.dec);
  return { azimuth: hor.azimuth, altitude: hor.altitude };
}

/** 局部坐标系（x 东、y 上、z 南）里的单位方向 */
export function directionFromAzAlt(azimuthDeg: number, altitudeDeg: number): [number, number, number] {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (altitudeDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

export interface MoonState extends SunPosition {
  /** 视星等（含相位），换算月光照度用 */
  mag: number;
  /** 被照亮的面积比例 0..1 */
  phaseFraction: number;
  /** 角半径（弧度） */
  angularRadius: number;
}

const MOON_RADIUS_KM = 1737.4;
const AU_KM = 1.495978707e8;

export function moonState(date: Date, lat: number, lon: number, heightMeters: number): MoonState {
  const observer = new Observer(lat, lon, heightMeters);
  const eq = Equator(Body.Moon, date, observer, true, true);
  const hor = Horizon(date, observer, eq.ra, eq.dec);
  const ill = Illumination(Body.Moon, date);
  return {
    azimuth: hor.azimuth,
    altitude: hor.altitude,
    mag: ill.mag,
    phaseFraction: ill.phase_fraction,
    angularRadius: MOON_RADIUS_KM / (eq.dist * AU_KM),
  };
}

/** 视星等 → 大气层外的照度（klux）：E = 10^(−0.4(m + 13.98)) lux */
export function magnitudeToKlux(mag: number) {
  return Math.pow(10, -0.4 * (mag + 13.98)) * 1e-3;
}

/**
 * 当地坐标（x 东、y 上、z 南）→ J2000 赤道直角坐标的旋转矩阵，按列给出（three 的 Matrix3.set 是行主序，调用方自己转）。
 * astronomy-engine 的地平坐标是 x 北、y 西、z 天顶（已在 d.ts 与数值上核对）。
 */
export function localToEquatorialColumns(date: Date, lat: number, lon: number, heightMeters: number) {
  const observer = new Observer(lat, lon, heightMeters);
  const rot = Rotation_HOR_EQJ(date, observer);
  const col = (n: number, w: number, z: number) => {
    const v = RotateVector(rot, new Vector(n, w, z, MakeTime(date)));
    return [v.x, v.y, v.z] as const;
  };
  // 东 = −西，上 = 天顶，南 = −北
  return [col(0, -1, 0), col(0, 0, 1), col(-1, 0, 0)] as const;
}
