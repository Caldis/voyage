/**
 * 线路烘焙产物的读取（TR02）：`public/data/rail/<id>.json`（元数据）+ `<id>.bin`（小端二进制）。
 * 格式见 `research/RAIL_BAKE_REPORT.md` §2；读法和 `scripts/rail/verify.mjs` 一致：
 * `meta.arrays.<名字> = {type, offset, length}` → `new <Type>Array(buf, offset, length)`。
 *
 * 这里不做任何 DOM / three.js 的事，node 单测（`src/rail/rail.test.mjs`）也能直接用 parseRailData。
 */

export type RailTypedArray = Float32Array | Uint32Array | Int32Array | Uint16Array | Int16Array | Uint8Array | Int8Array;

const CTOR = {
  f32: Float32Array,
  u32: Uint32Array,
  i32: Int32Array,
  u16: Uint16Array,
  i16: Int16Array,
  u8: Uint8Array,
  i8: Int8Array,
} as const;

export interface RailArrayMeta {
  type: keyof typeof CTOR;
  offset: number;
  length: number;
  desc?: string;
}

export interface RailStation {
  name: string;
  /** 营业キロ（km，Wikipedia 駅一覧） */
  km: number;
  /** OSM 车站节点投影到中心线的里程（米） */
  s: number;
  /** 车站节点离中心线的横向偏移（米，+ = 往信濃大町方向的左侧） */
  d: number;
  platforms?: { s0: number; s1: number; dMedian: number }[];
}

export interface RailSpan {
  s0: number;
  s1: number;
  name?: string | null;
}

export interface RailMeta {
  id: string;
  name: string;
  format: {
    bin: string;
    crs: { originLat: number; originLon: number; originName: string };
    centerStepM: number;
    grid: { ds: number; dd: number; s0: number; rows: number; cols: number; d0: number; unit: number; nodata: number };
    flags: Record<string, number>;
  };
  arrays: Record<string, RailArrayMeta>;
  stations: RailStation[];
  levelCrossings: { s: number; d: number }[];
  bridges: RailSpan[];
  tunnels: RailSpan[];
  sources?: unknown;
}

export interface RailData {
  meta: RailMeta;
  /** 所有数组（后续任务按名字取，例如 buildings.*、masts.*） */
  arrays: Record<string, RailTypedArray>;
  /** 中心线：等间距（centerStepM = 2 m）的采样 */
  center: {
    n: number;
    s0: number;
    ds: number;
    x: Float32Array;
    y: Float32Array;
    s: Float32Array;
    zRail: Float32Array;
    zGround: Float32Array;
    grade: Float32Array;
    heading: Float32Array;
    curvature: Float32Array;
    flags: Uint16Array;
    tracks: Uint8Array;
  };
}

export function parseRailData(meta: RailMeta, buf: ArrayBuffer): RailData {
  const arrays: Record<string, RailTypedArray> = {};
  for (const [name, a] of Object.entries(meta.arrays)) {
    const C = CTOR[a.type];
    if (!C) throw new Error(`线路数据：未知的数组类型 ${a.type}（${name}）`);
    if (a.offset % C.BYTES_PER_ELEMENT !== 0 || a.offset + a.length * C.BYTES_PER_ELEMENT > buf.byteLength) {
      throw new Error(`线路数据：数组 ${name} 未对齐或越界`);
    }
    arrays[name] = new C(buf, a.offset, a.length);
  }
  const f = (k: string) => arrays[k] as Float32Array;
  const s = f("center.s");
  const n = s.length;
  // 中心线按 2 m 等间距烘焙（verify.mjs 的自检只保证单调）：这里再核一次间距，后面按下标直接插值
  const ds = (s[n - 1] - s[0]) / (n - 1);
  for (let i = 1; i < n; i += 97) {
    if (Math.abs(s[i] - s[0] - i * ds) > 0.05) throw new Error(`线路数据：中心线采样不是等间距（i = ${i}）`);
  }
  return {
    meta,
    arrays,
    center: {
      n,
      s0: s[0],
      ds,
      x: f("center.x"),
      y: f("center.y"),
      s,
      zRail: f("center.zRail"),
      zGround: f("center.zGround"),
      grade: f("center.grade"),
      heading: f("center.heading"),
      curvature: f("center.curvature"),
      flags: arrays["center.flags"] as Uint16Array,
      tracks: arrays["center.tracks"] as Uint8Array,
    },
  };
}

/** 浏览器里按相对路径拉取（和 sky-assets.ts 的 `data/bsc5.json` 同一口径，都基于 BASE_URL，兼容 GitHub Pages 子路径部署） */
export async function loadRailData(
  id: string,
  base = `${import.meta.env.BASE_URL}data/rail/`,
): Promise<RailData> {
  const metaResp = await fetch(`${base}${id}.json`);
  if (!metaResp.ok) throw new Error(`线路元数据加载失败：HTTP ${metaResp.status}`);
  const meta = (await metaResp.json()) as RailMeta;
  const binResp = await fetch(`${base}${meta.format.bin}`);
  if (!binResp.ok) throw new Error(`线路二进制加载失败：HTTP ${binResp.status}`);
  return parseRailData(meta, await binResp.arrayBuffer());
}
