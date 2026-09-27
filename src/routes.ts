/**
 * 东亚航线网（T19a）：机场坐标 + 航线连接，给连续航程接力用。
 *
 * 数据来源与可信度：
 * - 机场坐标：各机场维基百科条目信息框里的机场基准点（ARP，源自日本 / 韩国 / 中国 / 台湾 / 香港各自的航行资料汇编 AIP），
 *   取到 0.001°（约 100 m）。由实现代理按条目记录，未逐一与 AIP 原文核对；本项目只用它定航线起讫点，百米级误差不影响画面。
 * - 航线：都是现实中存在的定期航线（国内干线、日韩中台港之间的国际线），按常识列出，是「示例性质」的网络——
 *   没有核对当季时刻表，也不代表全部航线。
 * - 距离、方位角：大圆公式现算（flight.ts 的 haversineKm / greatCircleBearing）。
 */

import { greatCircleBearing, haversineKm } from "./flight";

export type Region = "jp-north" | "jp-east" | "jp-west" | "jp-south" | "kr" | "cn-north" | "cn-east" | "cn-south" | "tw" | "hk";

export interface Airport {
  /** IATA 代码 */
  code: string;
  name: string;
  lat: number;
  lon: number;
  /** 当地时区（UTC 偏移，小时），信息栏显示当地时刻用 */
  tz: number;
  /** 大致地区：挑下一段航线时「尽量飞没看过的地区」按它计数 */
  region: Region;
  /** 地区霾浓度倍数（同 Preset.haze，T18）：中国大陆华北 / 华东 / 华南平原取 2.5，其余 1 */
  haze: number;
}

const A = (code: string, name: string, lat: number, lon: number, tz: number, region: Region, haze = 1): Airport => ({ code, name, lat, lon, tz, region, haze });

export const AIRPORTS: Record<string, Airport> = Object.fromEntries(
  [
    A("HND", "东京羽田", 35.553, 139.781, 9, "jp-east"),
    A("NRT", "东京成田", 35.765, 140.386, 9, "jp-east"),
    A("ITM", "大阪伊丹", 34.785, 135.438, 9, "jp-west"),
    A("KIX", "大阪关西", 34.427, 135.230, 9, "jp-west"),
    A("CTS", "札幌新千岁", 42.775, 141.692, 9, "jp-north"),
    A("FUK", "福冈", 33.586, 130.452, 9, "jp-west"),
    A("OKA", "那霸", 26.196, 127.646, 9, "jp-south"),
    A("ICN", "首尔仁川", 37.463, 126.440, 9, "kr"),
    A("PVG", "上海浦东", 31.143, 121.805, 8, "cn-east", 2.5),
    A("SHA", "上海虹桥", 31.198, 121.336, 8, "cn-east", 2.5),
    A("PEK", "北京首都", 40.080, 116.598, 8, "cn-north", 2.5),
    A("PKX", "北京大兴", 39.509, 116.411, 8, "cn-north", 2.5),
    A("CAN", "广州白云", 23.393, 113.299, 8, "cn-south", 2.5),
    A("TPE", "台北桃园", 25.076, 121.224, 8, "tw"),
    A("HKG", "香港", 22.309, 113.914, 8, "hk"),
  ].map((a) => [a.code, a]),
);

/** 航线（无向）：现实中有定期航班的城市对（示例性质的网络，见文件头） */
export const ROUTES: ReadonlyArray<readonly [string, string]> = [
  // 日本国内干线
  ["HND", "CTS"], ["HND", "ITM"], ["HND", "FUK"], ["HND", "OKA"], ["HND", "KIX"],
  ["NRT", "CTS"], ["NRT", "FUK"], ["NRT", "OKA"],
  ["ITM", "CTS"], ["ITM", "OKA"], ["KIX", "CTS"], ["KIX", "OKA"],
  ["CTS", "FUK"], ["CTS", "OKA"], ["FUK", "OKA"],
  // 日本 ↔ 韩国 / 中国 / 台湾 / 香港
  ["HND", "PEK"], ["HND", "SHA"], ["HND", "HKG"],
  ["NRT", "ICN"], ["NRT", "PVG"], ["NRT", "TPE"], ["NRT", "HKG"], ["NRT", "CAN"], ["NRT", "PEK"],
  ["KIX", "ICN"], ["KIX", "PVG"], ["KIX", "TPE"], ["KIX", "HKG"],
  ["CTS", "ICN"], ["CTS", "TPE"],
  ["FUK", "ICN"], ["FUK", "PVG"], ["FUK", "TPE"], ["FUK", "HKG"],
  ["OKA", "TPE"], ["OKA", "ICN"], ["OKA", "HKG"], ["OKA", "PVG"],
  // 韩国 ↔ 中国 / 台湾 / 香港
  ["ICN", "PEK"], ["ICN", "PKX"], ["ICN", "PVG"], ["ICN", "TPE"], ["ICN", "HKG"], ["ICN", "CAN"],
  // 中国大陆国内干线与两岸三地
  ["PVG", "PEK"], ["SHA", "PEK"], ["SHA", "PKX"], ["PVG", "CAN"], ["PEK", "CAN"], ["PKX", "CAN"],
  ["PVG", "HKG"], ["PVG", "TPE"], ["PEK", "HKG"], ["PEK", "TPE"], ["TPE", "HKG"],
];

/** 一段航程：起讫机场 + 大圆距离与起始方位 */
export interface Leg {
  from: Airport;
  to: Airport;
  distKm: number;
  /** 起点处的大圆方位角（度，从正北顺时针） */
  bearing: number;
  /** 巡航高度（km）：短程飞不高 */
  cruiseKm: number;
}

export function neighbors(code: string): Airport[] {
  const out: Airport[] = [];
  for (const [a, b] of ROUTES) {
    if (a === code) out.push(AIRPORTS[b]);
    else if (b === code) out.push(AIRPORTS[a]);
  }
  return out;
}

/** 巡航高度按航程选（真实客机：几百公里的短程约 7–9 km，千公里以上 10–12 km）；同一航段内固定 */
function cruiseFor(distKm: number, rnd: number) {
  if (distKm < 450) return 7.6;
  if (distKm < 900) return 9.4 + rnd * 0.6;
  return [10.1, 10.4, 10.7, 11.3][Math.floor(rnd * 4) % 4];
}

export function makeLeg(from: Airport, to: Airport, rnd = Math.random()): Leg {
  const distKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
  return { from, to, distKm, bearing: greatCircleBearing(from.lat, from.lon, to.lat, to.lon), cruiseKm: cruiseFor(distKm, rnd) };
}

/** 离某点最近的机场（km） */
export function nearestAirport(lat: number, lon: number): { airport: Airport; distKm: number } {
  let best = AIRPORTS.HND;
  let bestD = Infinity;
  for (const a of Object.values(AIRPORTS)) {
    const d = haversineKm(lat, lon, a.lat, a.lon);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return { airport: best, distKm: bestD };
}

/** 从任意位置接入航线网：挑一个「大致在机头前方、又不太远」的机场当第一个目的地（非航线预设开启连续航程时用） */
export function airportAhead(lat: number, lon: number, headingDeg: number): Airport {
  let best = AIRPORTS.HND;
  let bestScore = Infinity;
  for (const a of Object.values(AIRPORTS)) {
    const d = haversineKm(lat, lon, a.lat, a.lon);
    if (d < 150) continue; // 太近：还没飞起来就到了
    const turn = Math.abs(((greatCircleBearing(lat, lon, a.lat, a.lon) - headingDeg + 540) % 360) - 180);
    const score = d * (1 + turn / 45);
    if (score < bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

/**
 * 挑下一段：从 current 出发的所有航线里，按「这个地区 / 这个机场去过几次」降权，再乘随机数。
 * 不立刻折返上一段的起点（除非没有别的选择）。visits 由调用方维护（键是地区和机场代码）。
 */
export function pickNextLeg(current: Airport, prevFrom: Airport | null, visits: Map<string, number>, rnd: () => number = Math.random): Leg {
  let cands = neighbors(current.code);
  if (prevFrom && cands.length > 1) cands = cands.filter((a) => a.code !== prevFrom.code);
  let best = cands[0];
  let bestScore = -Infinity;
  for (const a of cands) {
    const seen = (visits.get(a.region) ?? 0) * 2 + (visits.get(a.code) ?? 0);
    const score = rnd() / (1 + seen);
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return makeLeg(current, best, rnd());
}
