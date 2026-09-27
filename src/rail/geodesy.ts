/**
 * 局部 ENU 平面 ↔ WGS84 经纬度（TR02）。和烘焙脚本 `scripts/rail/common.py` 的 `ENU` 类是同一套公式：
 * WGS84 椭球 → ECEF → 以 (lat0, lon0) 为切点的东 / 北分量，单位米。反算用球面初值 + 迭代，35 km 内误差 < 1 mm。
 *
 * 为什么不直接把 ENU 的 x / y 当成 voyage 的本地公里坐标：voyage 的地面 clipmap 用 `ground/geo.ts` 的 LocalFrame
 * （纬度方向固定 110.574 km/度，在北纬 36° 比真实的 110.96 km/度短约 0.35%），影像、地形都按它摆放。
 * 相机要和影像对齐，就得走「ENU → 真实经纬度 → LocalFrame.toLocal」这条路，而不是按米直接换算。
 */

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const D2R = Math.PI / 180;
const R_SPHERE = 6371000.0;

function ecef(lat: number, lon: number): [number, number, number] {
  const la = lat * D2R, lo = lon * D2R;
  const n = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
  return [n * Math.cos(la) * Math.cos(lo), n * Math.cos(la) * Math.sin(lo), n * (1 - E2) * Math.sin(la)];
}

export class EnuFrame {
  readonly lat0: number;
  readonly lon0: number;
  private readonly o: [number, number, number];
  private readonly e: [number, number, number];
  private readonly n: [number, number, number];

  constructor(lat0: number, lon0: number) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.o = ecef(lat0, lon0);
    const la = lat0 * D2R, lo = lon0 * D2R;
    this.e = [-Math.sin(lo), Math.cos(lo), 0];
    this.n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  }

  /** 经纬度 → ENU 平面 (x 东, y 北)，米 */
  fwd(lat: number, lon: number): [number, number] {
    const p = ecef(lat, lon);
    const d0 = p[0] - this.o[0], d1 = p[1] - this.o[1], d2 = p[2] - this.o[2];
    return [d0 * this.e[0] + d1 * this.e[1] + d2 * this.e[2], d0 * this.n[0] + d1 * this.n[1] + d2 * this.n[2]];
  }

  /** ENU 平面 (x 东, y 北) → 经纬度（度） */
  inv(x: number, y: number): [number, number] {
    let lat = this.lat0 + (y / R_SPHERE) / D2R;
    let lon = this.lon0 + (x / (R_SPHERE * Math.cos(this.lat0 * D2R))) / D2R;
    for (let i = 0; i < 4; i++) {
      const [fx, fy] = this.fwd(lat, lon);
      lat += ((y - fy) / R_SPHERE) / D2R;
      lon += ((x - fx) / (R_SPHERE * Math.cos(lat * D2R))) / D2R;
    }
    return [lat, lon];
  }
}
