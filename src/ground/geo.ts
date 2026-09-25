/**
 * 经纬度 ↔ 本地公里坐标（x 东、z 南，原点是预设起点），以及 Web 墨卡托瓦片编号。
 * 本地坐标按「每个纬度用自己的 cos(lat)」换算经度（正弦投影的思路）：
 * 几百公里范围内局部比例都对，影像、地形、水体三层用同一套换算，所以彼此严格对齐。
 */

const D2R = Math.PI / 180;
export const KM_PER_DEG_LAT = 110.574;
export const KM_PER_DEG_LON_EQ = 111.32;
export const EARTH_CIRCUMFERENCE_KM = 40075.016;

export class LocalFrame {
  constructor(
    readonly lat0: number,
    readonly lon0: number,
  ) {}

  toLocal(lat: number, lon: number): [number, number] {
    return [(lon - this.lon0) * KM_PER_DEG_LON_EQ * Math.cos(lat * D2R), -(lat - this.lat0) * KM_PER_DEG_LAT];
  }

  toGeo(x: number, z: number): [number, number] {
    const lat = this.lat0 - z / KM_PER_DEG_LAT;
    return [lat, this.lon0 + x / (KM_PER_DEG_LON_EQ * Math.cos(lat * D2R))];
  }
}

export const lonToTileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;

export function latToTileY(lat: number, z: number) {
  const r = lat * D2R;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;

export function tileYToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** 让瓦片像素尺寸接近 targetKm 的缩放级别 */
export function zoomForResolution(targetKmPerPx: number, lat: number, maxZoom: number) {
  const z = Math.log2((EARTH_CIRCUMFERENCE_KM * Math.cos(lat * D2R)) / (256 * targetKmPerPx));
  return Math.max(1, Math.min(maxZoom, Math.round(z)));
}
