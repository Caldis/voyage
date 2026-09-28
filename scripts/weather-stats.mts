// 天气场气候态统计 + 断言（WX10，收编自 research/METEOROLOGY.md 附录 A 的 meteo-stats / meteo-ty）
//
// 不开浏览器、不占 GPU。对 WeatherField 在「月份 × 地区 × 时段」上取样，统计云型频率、15 时雷暴、
// 锋面带位置与活跃度、台风年频数 / 月份分布，并对照目标区间做断言：任何一条不满足，退出码非 0。
//
// 用法（在 apps/voyage 下）：
//   node --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings scripts/weather-stats.mts --multi        ← 门禁（6 个种子全部通过才算过，约 2.5 分钟）
//   node --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings scripts/weather-stats.mts                ← 只跑默认种子，打印完整统计表
//   可选：--seed N | --seeds a,b,c | --multi；--years 2023,2024,2025,2026（区域 / 锋面统计的年份）；
//         --ty-years 100（台风统计的年数，截止 2026 年）；--only region,front,ty,wind,towering（WX11a 风场：--only wind 单种子约 5 s；TW01 高耸对流云：--only towering 单种子约 15 s）；--json 输出.json；--quiet（只打印断言）
//   node 跑 .mts 要加 --import ./scripts/lib/ts-resolve.mjs（TW01 起脚本导入 src/weather-director.ts，它的 import 不带扩展名）
//
// 取样口径（与附录 A 相同）：每个地区 3 个点；每月 1–28 日 × UTC 每 3 小时；当地时 ≈ UTC + 经度 / 15。
// 雷暴：当地 15 时，150 km 内 stormsNear 非空的比例。锋面：每天 UTC 0 / 12 时、110–145°E 每 5°，扫 10–50°N 找 front().strength 最大处，
// 最大值 ≥ 0.5 记「活跃」。台风：每 6 小时列一次 activeTyphoons，按 id 在整段时间里去重（跨年的只算在首次出现的那年那月），
// 默认 100 年样本——4 年样本的泊松噪声足以让「8 月最多」随种子翻转（WX10 审查：20 个种子里 7 个失败）。
//
// 为什么要多种子：每条断言都要对种子稳健。只按一个种子调通的门限，换种子就可能贴线翻转（审查实测：长江 10 月、2 月 − 7 月）。
//
// 目标区间的出处写在每条断言的 src 里：
//   [JMA台风] 气象厅台风平年值（1991–2020）https://www.data.jma.go.jp/typhoon/statistics/average/average.html
//   [JMA梅雨] 气象厅梅雨入り・明け平年值（1991–2020）https://www.data.jma.go.jp/cpd/baiu/sokuhou_baiu.html
//   [CMA梅雨] 国家气候中心：长江中下游常年 6 月 14 日入梅、7 月 16 日前后出梅（中国气象局 2024-06-20 新闻稿）
//   [CMA七下八上] 华北雨季集中在 7 月下旬到 8 月上旬（中国气象局科普口径）
//   [K&H93] Klein & Hartmann (1993) J. Climate 6:1587 摘要：中国东部是唯一在陆上的层云区，层云最多的季节 = 低层静力稳定度最大的季节（冷季）。
//           「2 月、10 月双峰」是研究报告对检索摘要的转述，摘要未载、全文未核，本脚本不拿它做断言
//   [上海日照] 上海徐家汇月日照时数 1 月 114.3 h、2 月 119.9 h、8 月 185.7 h、10 月 161.4 h（中国气象局 1981–2010，经维基百科「Shanghai」气候表转引）
//   [Zhang06] Zhang et al. 2006, GRL 33, L11708：东亚西风急流 1 月轴 32°N、> 70 m/s，4 月位置相近而减弱，7 月北移到 40°N 以北
//             https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2006GL026377
//   [Kot58] Koteswaram 1958, Tellus 10：热带东风急流核心 150 hPa、约 15°N、35–40 m/s https://onlinelibrary.wiley.com/doi/abs/10.1111/j.2153-3490.1958.tb01984.x
//   [JMA平年] 气象厅 1991–2020 平年值·月平均风速（八丈島 7 月 4.3、南大東島 4.5、父島 2.7、石廊崎 4.3、銚子 5.3 m/s）
//             https://www.data.jma.go.jp/stats/etrn/view/nml_sfc_ym.php （prec_no / block_no：44/47678、91/47945、44/47971、50/47666、45/47648）
//   [HKO] 香港天文台 1991–2020 平年值，横澜岛月平均风速（1 月 25.1、7 月 21.3 km/h）https://www.hko.gov.hk/en/cis/normal/1991_2020/normals.htm
//   [Mon06] Monahan 2006, J. Climate 19:497：海面风速近似两参数韦布尔分布 https://journals.ametsoc.org/view/journals/clim/19/4/jcli3640.1.xml
//   [DD99] Dai & Deser 1999, JGR 104(D24)：地面风日变化陆上午后最大、海上很弱（按记忆转述，振幅未核对原文）
//   [教科书] Stull 1988、Holton、Wallace & Hobbs 的共识内容（按记忆转述，未逐页核对）
//   [Johnson99] Johnson et al. 1999, J. Climate 12:2397：热带对流三峰（信风积云 / 浓积云 / 积雨云），COARE（西太暖池）里浓积云占降水性对流云一半以上；对流层顶约 16 km
//   [HKO雷暴] [JMA那霸] 雷暴日平年值，见 THUNDER_STATIONS
//   [估算] 按气候常识定的量级区间，不是测量
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { CloudRegime, WindProfile } from "../src/weather.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
// --src <目录>（TW01，对照改前版本用）：从这个目录导入 weather.ts / weather-director.ts，默认 ../src。
// 例：git show master:apps/voyage/src/weather.ts > <目录>/weather.ts（weather-director.ts 同样，其中的 "./flight" 等要能解析到——放在 src/ 下的子目录并把 "./" 改成 "../"）
const srcDir = opt("--src") ? pathToFileURL(resolve(opt("--src")!) + "/").href : new URL("../src/", import.meta.url).href;
const W: typeof import("../src/weather.ts") = await import(new URL("weather.ts", srcDir).href);
const WD: typeof import("../src/weather-director.ts") = await import(new URL("weather-director.ts", srcDir).href);
const MULTI_SEEDS = [20260927, 1, 5, 6, 777, 12345];
const seeds = args.includes("--multi") ? MULTI_SEEDS : opt("--seeds") ? opt("--seeds")!.split(",").map(Number) : [opt("--seed") ? Number(opt("--seed")) : 20260927];
const years = (opt("--years") ?? "2023,2024,2025,2026").split(",").map(Number);
const tyYears = Number(opt("--ty-years") ?? 100);
const only = new Set((opt("--only") ?? "region,front,ty,wind,towering").split(","));
const quiet = args.includes("--quiet") || seeds.length > 1;
const H = 3.6e6;

// ---------- 地区（每个 3 点，(纬度, 经度)） ----------
const REGIONS: Record<string, [number, number][]> = {
  日本海: [[39, 134], [40.5, 136.5], [38, 132]],
  北海道西: [[43.1, 141.4], [43.8, 141.7], [43.5, 141.9]],
  关东: [[35.8, 139.6], [36.1, 140.1], [35.5, 139.3]],
  长江: [[30.6, 114.3], [31.5, 117.3], [30.9, 119.8]],
  华北: [[36.5, 115.5], [38.5, 116], [35.5, 117]],
  华南: [[23.1, 113.3], [24.3, 110.3], [24, 114.5]],
  冲绳东: [[25.5, 128.5], [24.5, 127.5], [26.5, 130]],
  副高: [[28.5, 138], [29.5, 142], [27.5, 145]],
};
const MONTHS = [1, 2, 4, 5, 6, 7, 8, 10];
/** WX11a-b：海面风统计用的预设坐标（src/flight.ts 的 PRESETS；日本海没有预设，取「日本海」地区的第一个点；hnd-cts 取航线上 5 个点） */
const SEA_PRESETS: Record<string, [number, number][]> = {
  "fuji 骏河湾": [[35.0, 138.95]],
  "ecs 东海": [[31.2, 126.0]],
  日本海: [[39, 134]],
  "wpac 西太": [[30.0, 139.8]],
  "scs 南海": [[18.0, 115.0]],
  "hnd-cts 沿途": [[36.2, 140.3], [37.8, 140.7], [39.5, 141.0], [41.1, 141.3], [42.78, 141.69]],
};

/**
 * TW01：高耸对流云（浓积云 / 积雨云）统计的取样点。前 7 个与 research/TOWERING.md 表 1.3 同点（长江取武汉），
 * 后面是 src/flight.ts 的海上 / 沿海预设坐标（「各预设夏季午后」断言用）
 */
const TW_POINTS: Record<string, [number, number]> = {
  华南沿海: [22.3, 115],
  华南内陆: [24.8, 113.6],
  南海中部: [15, 115],
  东海: [29, 125],
  冲绳: [26.2, 127.7],
  长江: [30.6, 114.3],
  关东: [35.8, 139.6],
  "scs 预设": [18.0, 115.0],
  "wpac 预设": [30.0, 139.8],
  "ecs 预设": [31.2, 126.0],
  "yangtze 预设": [29.55, 115.9],
};
/** TW01 的「午后」：当地 11 / 13 / 15 / 17 时（与 TOWERING 表 1.3 同口径） */
const TW_HOURS = [11, 13, 15, 17];
/**
 * 雷暴日对照的测站：香港天文台总部、那霸。雷暴日平年值（1991–2020，日 / 月）：
 *   [HKO雷暴] 香港 1 月 0.23、7 月 7.97、8 月 8.90（年 42.27）https://www.hko.gov.hk/en/cis/normal/1991_2020/normals.htm
 *   [JMA那霸] 那霸 1 月 0.3、7 月 2.7、8 月 3.5（年 20.4）https://www.data.jma.go.jp/stats/etrn/view/nml_sfc_ym.php?prec_no=91&block_no=47936
 */
const THUNDER_STATIONS: Record<string, { at: [number, number]; jan: number; julAug: number }> = {
  香港: { at: [22.3, 114.17], jan: 0.23, julAug: 7.97 + 8.9 },
  那霸: { at: [26.21, 127.68], jan: 0.3, julAug: 2.7 + 3.5 },
};
/** 「听到雷」的距离：离单体边缘 20 km 内。[教科书] 雷声一般能传 15–25 km，取中间 */
const THUNDER_HEAR_KM = 20;

type Tally = { n: number; reg: Record<CloudRegime, number>; storm: number; stormN: number };
const empty = (): Tally => ({ n: 0, reg: { clear: 0, cumulus: 0, towering: 0, stratocumulus: 0, altocumulus: 0, cirrus: 0 }, storm: 0, stormN: 0 });
const pct = (a: number, n: number) => (n ? (100 * a) / n : 0);
const cuFam = (t: Tally) => pct(t.reg.cumulus + t.reg.towering, t.n);
function gc(a1: number, o1: number, a2: number, o2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((a2 - a1) * r) / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(((o2 - o1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

type Check = { name: string; value: number; ok: boolean; target: string; src: string };

function runSeed(seed: number) {
  const field = new W.WeatherField(seed);

  /** 一个地区在某月 [d0, d1] 日的云型频率与 15 时雷暴 */
  function regionStats(name: string, month: number, d0 = 1, d1 = 28): Tally {
    const tl = empty();
    for (const y of years)
      for (let d = d0; d <= d1; d++) {
        const day0 = Date.UTC(y, month - 1, d);
        for (const [lat, lon] of REGIONS[name]) {
          for (let h = 0; h < 24; h += 3) {
            const s = field.sample(lat, lon, day0 + h * H);
            tl.n++;
            tl.reg[s.regime]++;
          }
          const t15 = day0 + (15 - lon / 15) * H;
          tl.stormN++;
          if (field.stormsNear(lat, lon, t15, 150).length) tl.storm++;
        }
      }
    return tl;
  }

  /** 锋面：某月 [d0, d1] 日的活跃比例、活跃时的平均中心纬度、指定纬带（默认 30–34°N）的活跃比例；lon 范围可选 */
  function frontStats(month: number, d0 = 1, d1 = 28, band: [number, number] = [30, 34], lons: [number, number] = [110, 145]) {
    let n = 0, act = 0, latSum = 0, inBand = 0;
    for (const y of years)
      for (let d = d0; d <= d1; d++)
        for (const h of [0, 12]) {
          const t = Date.UTC(y, month - 1, d) + h * H;
          for (let lon = lons[0]; lon <= lons[1]; lon += 5) {
            let m = 0, mLat = 0, mBand = 0;
            for (let lat = 10; lat <= 50; lat += 0.25) {
              const s = field.front(lat, lon, t).strength;
              if (s > m) (m = s), (mLat = lat);
              if (lat >= band[0] && lat <= band[1]) mBand = Math.max(mBand, s);
            }
            n++;
            if (m >= 0.5) act++, (latSum += mLat);
            if (mBand >= 0.5) inBand++;
          }
        }
    return { active: pct(act, n), center: act ? latSum / act : NaN, band: pct(inBand, n) };
  }

  /** 台风：tyYears 年样本，按 id 在整段时间里去重，月份按首次出现 */
  function typhoonStats() {
    const lastYear = 2026, firstYear = lastYear - tyYears + 1;
    const perMonth = new Array(12).fill(0);
    const perYear = new Map<number, number>();
    const cities: Record<string, [number, number]> = { 台北: [25.03, 121.5], 冲绳: [26.2, 127.7], 香港: [22.3, 114.2], 浦东: [31.15, 121.8], 羽田: [35.55, 139.78], 马尼拉: [14.6, 121] };
    const near: Record<string, number> = Object.fromEntries(Object.keys(cities).map((c) => [c, 0]));
    let nearN = 0;
    const seen = new Set<string>();
    const t0 = Date.UTC(firstYear, 0, 1), t1 = Date.UTC(lastYear + 1, 0, 1);
    // 从前一年 11 月开始扫，先把跨进第一年的台风登记为「已见」，不计数
    for (let t = Date.UTC(firstYear - 1, 10, 1); t < t1; t += 6 * H) {
      const list = field.activeTyphoons(t);
      const d = new Date(t);
      for (const ty of list) {
        if (seen.has(ty.id)) continue;
        seen.add(ty.id);
        if (t < t0) continue;
        perMonth[d.getUTCMonth()]++;
        perYear.set(d.getUTCFullYear(), (perYear.get(d.getUTCFullYear()) ?? 0) + 1);
      }
      const mon = d.getUTCMonth();
      if (t >= t0 && mon >= 6 && mon <= 8) {
        nearN++;
        for (const [c, [la, lo]] of Object.entries(cities)) if (list.some((ty) => gc(la, lo, ty.lat, ty.lon) < 600)) near[c]++;
      }
    }
    const counts = Array.from({ length: tyYears }, (_, i) => perYear.get(firstYear + i) ?? 0);
    return {
      years: tyYears,
      mean: counts.reduce((a, b) => a + b, 0) / tyYears,
      min: Math.min(...counts),
      max: Math.max(...counts),
      perMonth: perMonth.map((v) => v / tyYears),
      near: Object.fromEntries(Object.entries(near).map(([c, v]) => [c, pct(v, nearN)])),
    };
  }

  /**
   * TW01：高耸对流云。每个点、给定月份的 1–28 日 × years × 当地 hours 时：
   *   tower = 头顶云型为浓积云（sample().regime === "towering"）的比例；cb150 / cb280 / cb400 = 该半径内有活跃雷暴系统的比例；
   *   sys / cells = 400 km 内系统数、单体数的均值（cellsMax 最大）；tops = 400 km 内单体砧顶（km）的全部样本
   */
  function toweringPoint(lat: number, lon: number, months: number[], hours = TW_HOURS) {
    let n = 0, tower = 0, cb150 = 0, cb280 = 0, cb400 = 0, sys = 0, cells = 0, cellsMax = 0;
    const tops: number[] = [];
    /** 飑线：按系统 id 去重，记单体数与相邻单体间距（km） */
    const squalls = new Map<string, { n: number; gaps: number[] }>();
    for (const y of years)
      for (const m of months)
        for (let d = 1; d <= 28; d++)
          for (const h of hours) {
            const t = Date.UTC(y, m - 1, d) + (h - lon / 15) * H;
            n++;
            if (field.sample(lat, lon, t).regime === "towering") tower++;
            const near = field.stormsNear(lat, lon, t, 400);
            if (near.length) cb400++;
            let c = 0, in280 = false, in150 = false;
            for (const s of near) {
              const dd = gc(lat, lon, s.lat, s.lon);
              if (dd <= 280) in280 = true;
              if (dd <= 150) in150 = true;
              c += s.cells.length;
              for (const cell of s.cells) tops.push(cell.top);
              if (s.kind === "squall" && !squalls.has(s.id)) squalls.set(s.id, { n: s.cells.length, gaps: s.cells.slice(1).map((c, i) => gc(c.lat, c.lon, s.cells[i].lat, s.cells[i].lon)) });
            }
            if (in280) cb280++;
            if (in150) cb150++;
            sys += near.length;
            cells += c;
            cellsMax = Math.max(cellsMax, c);
          }
    tops.sort((a, b) => a - b);
    const q = (p: number) => (tops.length ? tops[Math.min(tops.length - 1, Math.floor(p * tops.length))] : NaN);
    return {
      n, tower: pct(tower, n), cb150: pct(cb150, n), cb280: pct(cb280, n), cb400: pct(cb400, n),
      sys: sys / n, cells: cells / n, cellsMax, top50: q(0.5), top10: q(0.1), top90: q(0.9), squalls: [...squalls.values()],
    };
  }
  /**
   * 模型里的「雷暴日」：某月 1–28 日里，当地 0–23 时逐时检查，只要有一个单体离测站 ≤ 单体半径 + THUNDER_HEAR_KM 就算这一天「听到雷」。
   * 用来和测站的雷暴日平年值（单站、目视 / 听觉口径）直接对照。返回每天的比例（%）
   */
  function thunderDayPct(lat: number, lon: number, months: number[]) {
    let n = 0, hit = 0;
    for (const y of years)
      for (const m of months)
        for (let d = 1; d <= 28; d++) {
          n++;
          const day0 = Date.UTC(y, m - 1, d) - (lon / 15) * H;
          let heard = false;
          for (let h = 0; h < 24 && !heard; h++)
            for (const s of field.stormsNear(lat, lon, day0 + h * H, 80)) {
              if (s.cells.some((c) => gc(lat, lon, c.lat, c.lon) <= c.radius + THUNDER_HEAR_KM)) {
                heard = true;
                break;
              }
            }
          if (heard) hit++;
        }
    return pct(hit, n);
  }
  /**
   * 名额挑选（TW01，weather-director.ts 的 pickStormSystems）：在 (lat, lon) 以航向 heading 飞、右座，7–8 月午后，
   * 280 km 内的活跃系统里按新 / 旧规则挑 MAX_STORMS 个单体，统计挑中的单体里「看得见」（挪位后在窗户这一侧、且没有飞过去）的比例，
   * 以及挑中的单体数。旧规则 = 改前的 planStorms：按离飞机的距离从近到远，放得下就挑
   */
  function pickerStats(lat: number, lon: number, heading: number) {
    const fwd: [number, number] = [Math.sin((heading * Math.PI) / 180), -Math.cos((heading * Math.PI) / 180)];
    const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
    const visible = (c: { x: number; z: number }) => {
      const along = c.x * fwd[0] + c.z * fwd[1];
      let cross = c.x * -fwd[1] + c.z * fwd[0];
      if (along >= 60 && Math.abs(cross) <= 200) cross = 40 + (50 * Math.abs(cross)) / 200;
      return along >= -40 && cross > 0;
    };
    let nNew = 0, visNew = 0, nOld = 0, visOld = 0;
    for (const y of years)
      for (const m of [7, 8])
        for (let d = 1; d <= 28; d++)
          for (const h of TW_HOURS) {
            const t = Date.UTC(y, m - 1, d) + (h - lon / 15) * H;
            const cands = field
              .stormsNear(lat, lon, t, 280)
              .map((s) => ({ id: s.id, cells: s.cells.length, x: (s.lon - lon) * kx, z: -(s.lat - lat) * 110.57, d: gc(lat, lon, s.lat, s.lon) }));
            const byId = new Map(cands.map((c) => [c.id, c]));
            // 改前的导演没有 pickStormSystems：新规则按旧规则算（「改前必须失败」用同一个脚本验）
            const pick = (WD as { pickStormSystems?: typeof WD.pickStormSystems }).pickStormSystems ?? ((cs: typeof cands) => [...cs].sort((a, b) => a.d - b.d).reduce<{ free: number; ids: string[] }>((acc, c) => (c.cells <= acc.free ? { free: acc.free - c.cells, ids: [...acc.ids, c.id] } : acc), { free: W.WeatherSystem.MAX_STORMS, ids: [] }).ids);
            for (const id of pick(cands, W.WeatherSystem.MAX_STORMS, fwd, 1)) {
              const c = byId.get(id)!;
              nNew += c.cells;
              if (visible(c)) visNew += c.cells;
            }
            let free = W.WeatherSystem.MAX_STORMS;
            for (const c of [...cands].sort((a, b) => a.d - b.d)) {
              if (c.cells > free) continue;
              free -= c.cells;
              nOld += c.cells;
              if (visible(c)) visOld += c.cells;
            }
          }
    const samples = years.length * 2 * 28 * TW_HOURS.length;
    return { visNew: pct(visNew, nNew), visOld: pct(visOld, nOld), cellsNew: nNew / samples, visCellsNew: visNew / samples, visCellsOld: visOld / samples };
  }
  function toweringStats() {
    const summer: Record<string, ReturnType<typeof toweringPoint>> = {};
    const at15: Record<string, ReturnType<typeof toweringPoint>> = {};
    for (const [name, [la, lo]] of Object.entries(TW_POINTS)) {
      summer[name] = toweringPoint(la, lo, [7, 8]);
      at15[name] = toweringPoint(la, lo, [7, 8], [15]);
    }
    const jan: Record<string, ReturnType<typeof toweringPoint>> = {};
    for (const name of ["冲绳", "南海中部", "华南沿海"]) jan[name] = toweringPoint(TW_POINTS[name][0], TW_POINTS[name][1], [1]);
    // 日变化：华南内陆 7–8 月，当地 5 时与 15 时的浓积云比例（陆上对流午后强、清晨弱）
    const [la, lo] = TW_POINTS["华南内陆"];
    const inland5 = toweringPoint(la, lo, [7, 8], [5]);
    const coast5 = toweringPoint(TW_POINTS["华南沿海"][0], TW_POINTS["华南沿海"][1], [7, 8], [5]);
    const thunder: Record<string, { jan: number; julAug: number }> = {};
    for (const [name, st] of Object.entries(THUNDER_STATIONS)) thunder[name] = { jan: thunderDayPct(st.at[0], st.at[1], [1]), julAug: thunderDayPct(st.at[0], st.at[1], [7, 8]) };
    // 名额挑选：南海预设（向西南飞）、华南沿海（向西飞）
    const picker = { scs: pickerStats(18, 115, 225), coast: pickerStats(22.3, 115, 250) };
    return { summer, at15, jan, inland5, coast5, thunder, picker };
  }

  // ---------- 统计 ----------
  const t0 = performance.now();
  const table: Record<string, Record<number, Tally>> = {};
  let hbRainyClear = NaN;
  if (only.has("region")) {
    for (const r of Object.keys(REGIONS)) {
      table[r] = {};
      for (const m of MONTHS) table[r][m] = regionStats(r, m);
    }
    const a = regionStats("华北", 7, 16, 31), b = regionStats("华北", 8, 1, 10);
    hbRainyClear = pct(a.reg.clear + b.reg.clear, a.n + b.n);
  }
  const frontM: Record<string, ReturnType<typeof frontStats>> = {};
  let hbFront = NaN;
  if (only.has("front")) {
    for (const m of [1, 3, 4, 5, 6, 7, 8, 9, 10, 11]) frontM[`${m}月`] = frontStats(m);
    frontM["6月15-28日"] = frontStats(6, 15, 28);
    frontM["7月1-14日"] = frontStats(7, 1, 14);
    frontM["7月20-31日"] = frontStats(7, 20, 31);
    frontM["8月1-10日"] = frontStats(8, 1, 10);
    // 华北雨季：7/20–8/10、110–125°E，锋面落在 36–41°N 的比例
    const a = frontStats(7, 20, 31, [36, 41], [110, 125]), b = frontStats(8, 1, 10, [36, 41], [110, 125]);
    hbFront = (a.band * 12 + b.band * 10) / 22;
  }
  const ty = only.has("ty") ? typhoonStats() : null;
  const tw = only.has("towering") ? toweringStats() : null;
  // 改前的 weather.ts 没有风场：记一条失败的断言（而不是崩溃），这样「改前必须失败」可以直接用同一个脚本验
  const hasWind = typeof (field as { wind?: unknown }).wind === "function";
  const wind = only.has("wind") && hasWind ? windStats() : null;
  const elapsed = (performance.now() - t0) / 1000;

  /**
   * 风场（WX11a）。取样口径：years 年份 × 每月 1–28 日 × UTC 0/6/12/18 时；地区用方框内 3×3 个点。
   * 纬向风 u > 0 为西风；风向是气象惯例的来向（270 = 西风、315 = 西北风）
   */
  function windStats() {
    const times = (month: number, d0 = 1, d1 = 28) => {
      const out: number[] = [];
      for (const y of years) for (let d = d0; d <= d1; d++) for (const h of [0, 6, 12, 18]) out.push(Date.UTC(y, month - 1, d) + h * H);
      return out;
    };
    const box = (la0: number, la1: number, lo0: number, lo1: number) => {
      const pts: [number, number][] = [];
      for (let a = 0; a < 3; a++) for (let o = 0; o < 3; o++) pts.push([la0 + ((la1 - la0) * a) / 2, lo0 + ((lo1 - lo0) * o) / 2]);
      return pts;
    };
    const collect = (month: number, pts: [number, number][], f: (p: WindProfile) => number) => {
      const out: number[] = [];
      for (const t of times(month)) for (const [la, lo] of pts) out.push(f(field.wind(la, lo, t)));
      return out;
    };
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const quant = (a: number[], q: number) => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(q * s.length))];
    };
    const frac = (a: number[], ok: (v: number) => boolean) => pct(a.filter(ok).length, a.length);
    const pearson = (x: number[], y: number[]) => {
      const mx = mean(x), my = mean(y);
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < x.length; i++) (sxy += (x[i] - mx) * (y[i] - my)), (sxx += (x[i] - mx) ** 2), (syy += (y[i] - my) ** 2);
      return sxy / Math.sqrt(sxx * syy);
    };
    /** 月均 250 hPa 纬向风的经向剖面（135/140/145°E 平均）：最大值与所在纬度 */
    const jetProfile = (month: number, lons = [135, 140, 145], la0 = 20, la1 = 55) => {
      const ts = times(month).filter((_, i) => i % 2 === 0); // 每天两次，够了
      let best = -Infinity, bestLat = NaN;
      for (let la = la0; la <= la1; la += 0.5) {
        let s = 0, n = 0;
        for (const t of ts) for (const lo of lons) (s += field.wind(la, lo, t).p250.u), n++;
        if (s / n > best) (best = s / n), (bestLat = la);
      }
      return { core: best, axis: bestLat };
    };
    const jan = jetProfile(1), apr = jetProfile(4), jul = jetProfile(7, [120, 130, 140]);
    const jpJan = mean(collect(1, box(32, 36, 135, 145), (p) => p.p250.u));
    const scBox = box(18, 24, 110, 118);
    const scJul250 = mean(collect(7, scBox, (p) => p.p250.u));
    const scJan250 = mean(collect(1, scBox, (p) => p.p250.u));
    const scJulSW = frac(collect(7, scBox, (p) => W.windFromDeg(p.p850)), (d) => d >= 180 && d <= 270);
    const jsDir = collect(1, box(38, 42, 133, 138), (p) => W.windFromDeg(p.p850));
    const jsSpd = collect(1, box(38, 42, 133, 138), (p) => W.windSpeed(p.p850));
    const tradeBox = box(20, 26, 130, 150);
    const tradeJan = frac(collect(1, tradeBox, (p) => p.p850.u), (u) => u < 0);
    const tradeJul = frac(collect(7, tradeBox, (p) => p.p850.u), (u) => u < 0);
    // 梅雨低空急流：6/15–7/15，110–130°E，锋面活跃（锋轴处 strength ≥ 0.5）时锋轴以南 2.5° 的 850 hPa 风速
    const llj: number[] = [];
    for (const [m, d0, d1] of [[6, 15, 30], [7, 1, 15]] as const)
      for (const t of times(m, d0, d1))
        for (let lo = 110; lo <= 130; lo += 5) {
          const ax = field.frontAxis(lo, t);
          if (field.front(ax.lat, lo, t).strength < 0.5) continue;
          llj.push(W.windSpeed(field.wind(ax.lat - 2.5, lo, t).p850));
        }
    // 埃克曼转向与对数廓线：地面风相对 850 hPa 的逆时针偏角、风速比。海上 / 陆上各一组点，1、4、7、10 月
    const ekman = (pts: [number, number][]) => {
      const ang: number[] = [], ratio: number[] = [];
      for (const m of [1, 4, 7, 10])
        for (const t of times(m).filter((_, i) => i % 4 === 0))
          for (const [la, lo] of pts) {
            const p = field.wind(la, lo, t);
            if (W.windSpeed(p.p850) < 3) continue;
            let d = W.windFromDeg(p.p850) - W.windFromDeg(p.sfc); // 来向减小 = 后退（逆时针）
            d = ((d + 540) % 360) - 180;
            ang.push(d);
            ratio.push(W.windSpeed(p.sfc) / W.windSpeed(p.p850));
          }
      return { ang: quant(ang, 0.5), ratio: quant(ratio, 0.5) };
    };
    const ekSea = ekman([[39, 134], [30, 140], [28, 128], [20, 135], [35, 150]]);
    const ekLand = ekman([[34.5, 113.5], [30.6, 114.3], [38, 116], [28, 105], [45, 125]]);
    // 雷暴系统漂移 vs 此刻所在处的 500 hPa 风：4–9 月与 1 月，每月 1/11/21 日 UTC 6 时（东亚午后，雷暴多），15–45°N、105–150°E 每 7.5° 搜 400 km，按 id 去重
    const seen = new Set<string>();
    const dAng: number[] = [], dAngS: number[] = [];
    const spdD: number[] = [], spdW: number[] = []; // 漂移速度（km/h）与 500 hPa 风速（m/s），算相关系数
    for (const y of years)
      for (const m of [1, 4, 5, 6, 7, 8, 9])
        for (const d of [1, 11, 21])
          for (const h of [6]) {
            const t = Date.UTC(y, m - 1, d) + h * H;
            for (let la = 15; la <= 45; la += 7.5)
              for (let lo = 105; lo <= 150; lo += 7.5)
                for (const s of field.stormsNear(la, lo, t, 400)) {
                  if (seen.has(s.id)) continue;
                  seen.add(s.id);
                  const w = field.wind(s.lat, s.lon, t).p500;
                  if (W.windSpeed(w) < 2) continue; // 500 hPa 几乎无风时方向没有意义
                  const a = Math.abs(((Math.atan2(s.drift.vn, s.drift.ve) - Math.atan2(w.v, w.u)) / (Math.PI / 180) + 540) % 360 - 180);
                  dAng.push(a);
                  if (s.lat < 25) dAngS.push(a);
                  spdD.push(Math.hypot(s.drift.ve, s.drift.vn));
                  spdW.push(W.windSpeed(w));
                }
          }
    // 连续性：随机取点（确定性的线性同余序列），相邻 1 小时、相邻 25 km 的风矢量差 / max(|风|, 5 m/s)
    let rs = 12345;
    const rnd = () => ((rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) / 4294967296);
    const lv = ["sfc", "p850", "p500", "p250"] as const;
    const dT: Record<string, number[]> = { sfc: [], p850: [], p500: [], p250: [] };
    const dX: Record<string, number[]> = { sfc: [], p850: [], p500: [], p250: [] };
    const tA = Date.UTC(years[0], 0, 1), tB = Date.UTC(years[years.length - 1] + 1, 0, 1);
    for (let n = 0; n < 4000; n++) {
      const la = 12 + 38 * rnd(), lo = 100 + 50 * rnd(), t = tA + (tB - tA) * rnd(), az = 2 * Math.PI * rnd();
      const a = field.wind(la, lo, t), b = field.wind(la, lo, t + H);
      const c = field.wind(la + (25 * Math.cos(az)) / 110.57, lo + (25 * Math.sin(az)) / (111.32 * Math.cos(la * (Math.PI / 180))), t);
      for (const k of lv) {
        const s = Math.max(W.windSpeed(a[k]), 5);
        dT[k].push(Math.hypot(b[k].u - a[k].u, b[k].v - a[k].v) / s);
        dX[k].push(Math.hypot(c[k].u - a[k].u, c[k].v - a[k].v) / s);
      }
    }
    const cont = Object.fromEntries(lv.map((k) => [k, { t99: 100 * quant(dT[k], 0.99), x99: 100 * quant(dX[k], 0.99), tMax: 100 * Math.max(...dT[k]), xMax: 100 * Math.max(...dX[k]) }]));
    // WX11a-b：各预设按季节的海面风（导演写给海面的就是 windSpeed(profile.sfc)，WX11g）。口径同上：years × 每月 1–28 日 × UTC 0/6/12/18 时，预设坐标
    const sea: Record<string, Record<number, { med: number; p10: number; p90: number; mean: number; calm: number }>> = {};
    for (const [name, pts] of Object.entries(SEA_PRESETS)) {
      sea[name] = {};
      for (const m of [1, 4, 7, 10]) {
        const s = collect(m, pts, (p) => W.windSpeed(p.sfc));
        sea[name][m] = { med: quant(s, 0.5), p10: quant(s, 0.1), p90: quant(s, 0.9), mean: mean(s), calm: frac(s, (v) => v < 2) };
      }
    }
    // 日变化：同一批点在当地 14 时与 02 时的地面风中位之比（4、7、10 月）
    const diurnalRatio = (pts: [number, number][]) => {
      const a: number[] = [], b: number[] = [];
      for (const y of years)
        for (const m of [4, 7, 10])
          for (let d = 1; d <= 28; d++)
            for (const [la, lo] of pts) {
              const day0 = Date.UTC(y, m - 1, d);
              a.push(W.windSpeed(field.wind(la, lo, day0 + (14 - lo / 15) * H).sfc));
              b.push(W.windSpeed(field.wind(la, lo, day0 + (26 - lo / 15) * H).sfc));
            }
      return quant(a, 0.5) / quant(b, 0.5);
    };
    const diurLand = diurnalRatio([[34.5, 113.5], [30.6, 114.3], [38, 116], [28, 105], [45, 125]]);
    const diurSea = diurnalRatio([[30, 140], [28, 128], [20, 135], [35, 150], [18, 115]]);
    return {
      sea, diurLand, diurSea,
      jan, apr, jul, jpJan, scJul250, scJan250, scJulSW, jsNW: frac(jsDir, (d) => d >= 270 && d <= 360), jsMed: quant(jsSpd, 0.5),
      tradeJan, tradeJul, lljN: llj.length, llj12: frac(llj, (v) => v >= 12), lljMed: quant(llj, 0.5), ekSea, ekLand,
      stormN: dAng.length, stormMed: quant(dAng, 0.5), stormP90: quant(dAng, 0.9), stormSN: dAngS.length, stormMedS: quant(dAngS, 0.5), stormP90S: quant(dAngS, 0.9),
      stormIn45: frac(dAng, (a) => a <= 45), stormSpdR: pearson(spdD, spdW), cont,
    };
  }

  // ---------- 输出 ----------
  const f0 = (v: number) => v.toFixed(0);
  if (!quiet) {
    console.log(`# 天气场气候态统计（seed ${seed}，区域 / 锋面年份 ${years.join("/")}，台风 ${tyYears} 年，${elapsed.toFixed(1)} s）\n`);
    if (only.has("region")) {
      console.log("## 云型频率 %（晴 / 积云族 / 层积 / 高积 / 卷云 · 15 时雷暴）\n");
      console.log(`| 地区 | ${MONTHS.map((m) => `${m} 月`).join(" | ")} |`);
      console.log(`| --- | ${MONTHS.map(() => "---").join(" | ")} |`);
      for (const r of Object.keys(REGIONS)) {
        const cells = MONTHS.map((m) => {
          const t = table[r][m];
          return `${f0(pct(t.reg.clear, t.n))}/${f0(cuFam(t))}/${f0(pct(t.reg.stratocumulus, t.n))}/${f0(pct(t.reg.altocumulus, t.n))}/${f0(pct(t.reg.cirrus, t.n))}·${f0(pct(t.storm, t.stormN))}`;
        });
        console.log(`| ${r} | ${cells.join(" | ")} |`);
      }
      console.log(`\n华北 7/16–8/10（七下八上）晴空 ${hbRainyClear.toFixed(0)}%\n`);
    }
    if (only.has("front")) {
      console.log("## 锋面带（活跃 % / 活跃时中心纬度 / 30–34°N 活跃 %）\n");
      console.log("| 时段 | 活跃 | 中心 | 30–34°N |\n| --- | --- | --- | --- |");
      for (const [k, v] of Object.entries(frontM)) console.log(`| ${k} | ${v.active.toFixed(0)} | ${isNaN(v.center) ? "—" : v.center.toFixed(1)} | ${v.band.toFixed(0)} |`);
      console.log(`\n华北雨季（7/20–8/10、110–125°E）锋面在 36–41°N 的比例：${hbFront.toFixed(0)}%\n`);
    }
    if (ty) {
      console.log(`## 台风（${ty.years} 年）\n\n年均 ${ty.mean.toFixed(1)}（最少 ${ty.min}、最多 ${ty.max}；气象厅平年值 25.1）`);
      console.log(`按月（首次出现，年均）：${ty.perMonth.map((v, i) => `${i + 1}月 ${v.toFixed(2)}`).join("，")}`);
      console.log(`平年值：1–12 月 0.3 0.3 0.3 0.6 1.0 1.7 3.7 5.7 5.0 3.4 2.2 1.0`);
      console.log(`7–9 月 600 km 内有台风的时间比例：${Object.entries(ty.near).map(([c, v]) => `${c} ${v.toFixed(1)}%`).join("，")}\n`);
    }
    if (tw) {
      console.log("## 高耸对流云（TW01）：7–8 月、当地 11 / 13 / 15 / 17 时\n");
      console.log("| 地点 | 头顶浓积云 % | 150 km 内有雷暴 % | 280 km 内 % | 400 km 内 % | 15 时 400 km 内 % | 400 km 内系统数均值 | 400 km 内单体 均值 / 最大 | 砧顶 中位（p10–p90）km |");
      console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const [name, s] of Object.entries(tw.summer))
        console.log(`| ${name} | ${f0(s.tower)} | ${f0(s.cb150)} | ${f0(s.cb280)} | ${f0(s.cb400)} | ${f0(tw.at15[name].cb400)} | ${s.sys.toFixed(2)} | ${s.cells.toFixed(2)} / ${s.cellsMax} | ${s.top50.toFixed(1)}（${s.top10.toFixed(1)}–${s.top90.toFixed(1)}） |`);
      console.log(`\n1 月（同口径）：${Object.entries(tw.jan).map(([k, s]) => `${k} 浓积云 ${f0(s.tower)}%、400 km 内雷暴 ${f0(s.cb400)}%`).join("；")}`);
      console.log(`雷暴日（模型：单体边缘 ${THUNDER_HEAR_KM} km 内，逐时；% 天）：${Object.entries(tw.thunder).map(([k, v]) => `${k} 1 月 ${v.jan.toFixed(1)}（平年 ${((100 * THUNDER_STATIONS[k].jan) / 31).toFixed(1)}）、7–8 月 ${v.julAug.toFixed(1)}（平年 ${((100 * THUNDER_STATIONS[k].julAug) / 62).toFixed(1)}）`).join("；")}`);
      console.log(`名额挑选（挑中的单体里看得见的 %，新 / 旧；平均每刻看得见的单体数 新 / 旧）：${Object.entries(tw.picker).map(([k, p]) => `${k} ${f0(p.visNew)} / ${f0(p.visOld)}，${p.visCellsNew.toFixed(2)} / ${p.visCellsOld.toFixed(2)}`).join("；")}`);
      console.log(`7–8 月 5 时浓积云：华南内陆 ${f0(tw.inland5.tower)}%（午后 ${f0(tw.summer["华南内陆"].tower)}%）、华南沿海 ${f0(tw.coast5.tower)}%（午后 ${f0(tw.summer["华南沿海"].tower)}%）\n`);
    }
    if (wind) {
      const w = wind;
      console.log("## 风场（WX11a）\n");
      console.log(`250 hPa 月均纬向风剖面（135–145°E）：1 月核心 ${w.jan.core.toFixed(1)} m/s @ ${w.jan.axis}°N；4 月 ${w.apr.core.toFixed(1)} @ ${w.apr.axis}°N；7 月（120–140°E）${w.jul.core.toFixed(1)} @ ${w.jul.axis}°N`);
      console.log(`日本上空（32–36°N、135–145°E）1 月 250 hPa 纬向风月均 ${w.jpJan.toFixed(1)}；华南（18–24°N、110–118°E）250 hPa 1 月 ${w.scJan250.toFixed(1)}、7 月 ${w.scJul250.toFixed(1)}；7 月 850 hPa 西南象限 ${w.scJulSW.toFixed(0)}%`);
      console.log(`日本海 1 月 850 hPa：来向 270–360° ${w.jsNW.toFixed(0)}%，风速中位 ${w.jsMed.toFixed(1)} m/s；信风带 850 hPa 东风分量为正：1 月 ${w.tradeJan.toFixed(0)}%、7 月 ${w.tradeJul.toFixed(0)}%`);
      console.log(`梅雨低空急流（锋南 2.5°，${w.lljN} 样本）：850 hPa ≥ 12 m/s ${w.llj12.toFixed(0)}%，中位 ${w.lljMed.toFixed(1)}`);
      console.log(`埃克曼：海上偏角中位 ${w.ekSea.ang.toFixed(1)}°、10 m / 850 风速比 ${w.ekSea.ratio.toFixed(2)}；陆上 ${w.ekLand.ang.toFixed(1)}°、${w.ekLand.ratio.toFixed(2)}`);
      console.log(`雷暴漂移 vs 500 hPa 风向夹角 中位 / p90：全部 ${w.stormMed.toFixed(1)}° / ${w.stormP90.toFixed(1)}°（${w.stormN} 个系统，≤ 45° 的 ${w.stormIn45.toFixed(0)}%），25°N 以南 ${w.stormMedS.toFixed(1)}° / ${w.stormP90S.toFixed(1)}°（${w.stormSN} 个）；漂移速度与 500 hPa 风速相关系数 ${w.stormSpdR.toFixed(2)}`);
      console.log(`连续性（|Δ风| / max(|风|, 5)，%，p99 / 最大）：${Object.entries(w.cont).map(([k, c]) => `${k} 1h ${c.t99.toFixed(1)}/${c.tMax.toFixed(1)}、25km ${c.x99.toFixed(1)}/${c.xMax.toFixed(1)}`).join("；")}\n`);
      console.log("海面风 windSpeed(sfc)，m/s：中位 / p10 / p90 · 平静（< 2 m/s）%（WX11a-b）\n");
      console.log("| 预设 | 1 月 | 4 月 | 7 月 | 10 月 |\n| --- | --- | --- | --- | --- |");
      for (const [name, byM] of Object.entries(w.sea))
        console.log(`| ${name} | ${[1, 4, 7, 10].map((m) => { const s = byM[m]; return `${s.med.toFixed(1)} / ${s.p10.toFixed(1)} / ${s.p90.toFixed(1)} · ${s.calm.toFixed(0)}`; }).join(" | ")} |`);
      console.log("");
    }
  }

  // ---------- 断言 ----------
  const checks: Check[] = [];
  const check = (name: string, value: number, ok: boolean, target: string, src: string) => checks.push({ name, value, ok, target, src });
  if (only.has("region")) {
    const T = (r: string, m: number) => table[r][m];
    const clr = (r: string, m: number) => pct(T(r, m).reg.clear, T(r, m).n);
    const sc = (r: string, m: number) => pct(T(r, m).reg.stratocumulus, T(r, m).n);
    const thu = (r: string, m: number) => pct(T(r, m).storm, T(r, m).stormN);
    check("日本海 1 月晴空 %", clr("日本海", 1), clr("日本海", 1) <= 25, "≤ 25", "W10 目标；冬季风寒潮雪云街 [气象厅解说、教科书]");
    check("日本海 1 月积云族 %", cuFam(T("日本海", 1)), cuFam(T("日本海", 1)) >= 40, "≥ 40", "寒潮开放单体 / 云街是积状云 [教科书；比例为估算]");
    check("北海道西 1 月晴空 %", clr("北海道西", 1), clr("北海道西", 1) <= 35, "≤ 35", "日本海一侧冬季阴雪 [气象厅解说；估算]");
    check("关东 1 月晴空 %", clr("关东", 1), clr("关东", 1) >= 50, "≥ 50", "冬季太平洋一侧晴（焚风）[气象厅解说；估算]");
    check("日本海 7 月晴空 %", clr("日本海", 7), clr("日本海", 7) >= 25, "≥ 25", "夏季比冬季少云 [估算]");
    check("长江 1 月层积云 %", sc("长江", 1), sc("长江", 1) >= 40 && sc("长江", 1) <= 75, "40–75", "[K&H93] 冷季层云；上限：[上海日照] 1 月日照率约三成半，仍有晴天 [估算]");
    // 审查 R2：原「10 月 ≤ 70」「2 月 − 7 月 ≥ 20」是按默认种子贴线定的，没有依据，改成下面两条相对量
    const oct = sc("长江", 10), jan = sc("长江", 1);
    check("长江 10 月层积云 − 1 月（百分点）", oct - jan, oct - jan <= 5, "≤ 5", "[上海日照] 10 月 161 h 比 1 月 114 h 多四成，长江下游 10 月不应比 1 月更阴（留 5 个百分点给抽样噪声）");
    check("长江 层积云 2 月 − 8 月（百分点）", sc("长江", 2) - sc("长江", 8), sc("长江", 2) - sc("长江", 8) >= 30, "≥ 30", "[K&H93] 层云最多在冷季；8 月副高控制、伏旱晴热，[上海日照] 8 月 186 h 比 2 月 120 h 多五成 [门限为估算]");
    check("长江 7 月 15 时雷暴 %", thu("长江", 7), thu("长江", 7) >= 20, "≥ 20", "盛夏午后雷暴 [估算]");
    // 审查 R2：原「七下八上晴空 ≤ 45」改前 41.5 已能过，分不出改前改后；改成锋面带位置 + 相对量（改前两条都失败）
    const hbJun = clr("华北", 6);
    check("华北 6 月晴空 − 七下八上晴空（百分点）", hbJun - hbRainyClear, hbJun - hbRainyClear >= 10, "≥ 10", "[CMA七下八上] 雨季比入汛前明显多云 [门限为估算]");
    check("华北 1 月晴空 %", clr("华北", 1), clr("华北", 1) >= 55, "≥ 55", "冬季干冷晴 [估算]");
    check("华南 7 月 15 时雷暴 %", thu("华南", 7), thu("华南", 7) >= 30, "≥ 30", "华南盛夏午后雷暴 [估算]");
    check("冲绳东 1 月 15 时雷暴 %", thu("冲绳东", 1), thu("冲绳东", 1) <= 3, "≤ 3", "W10 目标；冬季副热带洋面几乎无深对流");
    check("冲绳东 7 月积云族 %", cuFam(T("冲绳东", 7)), cuFam(T("冲绳东", 7)) >= 50, "≥ 50", "副高 + 信风积云 [教科书]");
    const shClearCu = pct(T("副高", 8).reg.clear + T("副高", 8).reg.cumulus, T("副高", 8).n);
    check("副高 8 月 晴空 + 淡积云 %", shClearCu, shClearCu >= 70 && shClearCu <= 95, "70–95", "副高下沉、晴空或信风积云 [教科书]；上限：随机性铁律，一整月不该几乎只有一种天气 [估算]");
    check("副高 8 月 15 时雷暴 %", thu("副高", 8), thu("副高", 8) >= 1 && thu("副高", 8) <= 10, "1–10", "副高下偶有孤立阵雨 / 雷阵雨 [估算]");
  }
  if (only.has("front")) {
    const c = (k: string) => frontM[k].center;
    check("锋面 5 月中心 °N", c("5月"), c("5月") >= 22 && c("5月") <= 28, "22–28", "华南前汛期；沖縄梅雨 5/10–6/21 [JMA梅雨]");
    check("锋面 6/15–28 中心 °N", c("6月15-28日"), c("6月15-28日") >= 29 && c("6月15-28日") <= 35, "29–35", "[CMA梅雨] 6/14–7/16；[JMA梅雨] 本州 6/7–7/19");
    check("锋面 6/15–28 活跃 %", frontM["6月15-28日"].active, frontM["6月15-28日"].active >= 50, "≥ 50", "梅雨盛期 [CMA梅雨][JMA梅雨]；门限为估算");
    check("锋面 7/20–31 中心 °N", c("7月20-31日"), c("7月20-31日") >= 35, "≥ 35", "北跳：梅雨明け 7/19–7/28 [JMA梅雨]；[CMA七下八上]");
    // 审查 R2：原「七下八上晴空 ≤ 45」改前 41.5 已能过；这条和上面的「华北 6 月晴空 − 七下八上晴空」改前都失败
    check("华北雨季 锋面在 36–41°N 的比例 %", hbFront, hbFront >= 40, "≥ 40", "[CMA七下八上] 7 月下旬到 8 月上旬雨带在华北（110–125°E、7/20–8/10）；门限为估算");
    check("锋面 8 月 30–34°N 活跃 %", frontM["8月"].band, frontM["8月"].band <= 20, "≤ 20", "W10 目标；梅雨 7 月中下旬结束");
    check("锋面 9 月中心 °N", c("9月"), c("9月") >= 32 && c("9月") <= 38, "32–38", "秋雨前線（本州）[估算]");
  }
  if (ty) {
    const pm = ty.perMonth;
    check(`台风 年均个数（${ty.years} 年）`, ty.mean, ty.mean >= 22 && ty.mean <= 28, "22–28", "[JMA台风] 25.1");
    const sorted = [...pm].sort((a, b) => b - a);
    const augSepTop = pm[7] >= pm[8] && pm[8] >= sorted[1] - 1e-9;
    check(`台风 8 月最多、9 月第二（${ty.years} 年，1 = 是）`, augSepTop ? 1 : 0, augSepTop, "1", "[JMA台风] 8 月 5.7、9 月 5.0");
    const janApr = pm.slice(0, 4).reduce((a, b) => a + b, 0);
    check("台风 1–4 月合计（年均）", janApr, janApr <= 3, "≤ 3", "[JMA台风] 1.5");
    const julOct = pm.slice(6, 10).reduce((a, b) => a + b, 0);
    check("台风 7–10 月合计（年均）", julOct, julOct >= 14 && julOct <= 21, "14–21", "[JMA台风] 17.8");
  }
  if (tw) {
    // ---- TW01：高耸对流云。口径：7–8 月 1–28 日 × years × 当地 11 / 13 / 15 / 17 时（「15 时」一栏只取 15 时）；改前数值见 handoff/TW01.md ----
    const S = tw.summer, A = tw.at15;
    const band = (v: number, a: number, b: number) => v >= a && v <= b;
    check("TW 华南沿海 7–8 月午后（11–17 时）400 km 内有雷暴 %", S["华南沿海"].cb400, S["华南沿海"].cb400 >= 70, "≥ 70", "TOWERING §1.3 / TW01 目标 [估算]（改前 60–64%；15 时单点改前已 83%，没有区分力，所以取午后四个时次）：[HKO雷暴] 香港 7–8 月每月 8–9 个雷暴日（单站），巡航可见半径约 300 km、面积约 400 倍，盛夏午后视野里有积雨云应接近常态");
    check("TW 南海中部 7–8 月 15 时 400 km 内有雷暴 %", A["南海中部"].cb400, A["南海中部"].cb400 >= 50, "≥ 50", "南海是亚洲夏季风的深对流区 [教科书]；TW01 目标 [估算]");
    check("TW 冲绳 7–8 月 15 时 400 km 内有雷暴 %", A["冲绳"].cb400, A["冲绳"].cb400 >= 35, "≥ 35", "[JMA那霸] 7–8 月每月 2.7–3.5 个雷暴日（香港的约 0.37 倍）；TW01 目标 [估算]");
    check("TW 冲绳 1 月 400 km 内有雷暴 %", tw.jan["冲绳"].cb400, tw.jan["冲绳"].cb400 <= 10, "≤ 10", "[JMA那霸] 1 月 0.3 个雷暴日；冬季副热带洋面几乎无深对流（与 WX10「冲绳东 1 月 ≤ 3」同源）[门限估算]");
    check("TW 南海中部 7–8 月午后头顶浓积云 %", S["南海中部"].tower, band(S["南海中部"].tower, 25, 75), "25–75", "[Johnson99] 西太暖池浓积云占降水性对流云一半以上；上限：季风有中断期，不能天天一样（随机性铁律）[门限估算]");
    check("TW scs 预设 7–8 月午后头顶浓积云 %", S["scs 预设"].tower, band(S["scs 预设"].tower, 25, 75), "25–75", "同上（南海预设 18°N）");
    check("TW 华南沿海 7–8 月午后头顶浓积云 %", S["华南沿海"].tower, S["华南沿海"].tower >= 15, "≥ 15", "TOWERING TW01「海上夏季午后头顶浓积云 ≥ 15%」；22°N 在夏季风槽北缘 [估算]");
    check("TW 冲绳 7–8 月午后头顶浓积云 %", S["冲绳"].tower, band(S["冲绳"].tower, 5, 40), "5–40", "[JMA那霸] 盛夏有雷暴日，浓积云比积雨云常见 [Johnson99 三峰]；副高控制为主，上限 [估算]");
    check("TW wpac 预设（副高）7–8 月午后头顶浓积云 %", S["wpac 预设"].tower, S["wpac 预设"].tower <= 15, "≤ 15", "副高下沉、信风逆温压住对流，以晴空 / 淡积云为主 [教科书]；与 WX10「副高 8 月晴空 + 淡积云 70–95」一致 [门限估算]");
    check("TW 南海中部 1 月 400 km 内有雷暴 %", tw.jan["南海中部"].cb400, tw.jan["南海中部"].cb400 <= 20, "≤ 20", "冬季东北季风下南海北部、中部少深对流，季风槽只在 6–9 月 [教科书；门限估算]（季风槽不随季节时 42%）");
    check("TW 南海中部 1 月午后头顶浓积云 %", tw.jan["南海中部"].tower, tw.jan["南海中部"].tower <= 10, "≤ 10", "冬季南海吹东北季风、干冷，深对流南撤到 10°N 以南 [教科书；门限估算]");
    check("TW 华南内陆 7–8 月 5 时浓积云 / 午后", tw.inland5.tower / Math.max(S["华南内陆"].tower, 1), tw.inland5.tower <= 0.3 * S["华南内陆"].tower, "≤ 0.3", "陆地对流午后 14–17 时最强、清晨最弱 [气候，METEOROLOGY §1.3]");
    const hk = tw.thunder["香港"], nh = tw.thunder["那霸"];
    const hkObs = (100 * THUNDER_STATIONS["香港"].julAug) / 62, nhObs = (100 * THUNDER_STATIONS["那霸"].julAug) / 62;
    check("TW 雷暴日 香港 7–8 月 模型 / 平年", hk.julAug / hkObs, band(hk.julAug / hkObs, 0.4, 1.6), "0.4–1.6", `[HKO雷暴] 7–8 月 ${hkObs.toFixed(1)}% 天；模型口径：单体边缘 ${THUNDER_HEAR_KM} km 内（雷声传 15–25 km [教科书]），换算有不确定度，门限 [估算]。改前 0.13`);
    check("TW 雷暴日 那霸 7–8 月 模型 / 平年", nh.julAug / nhObs, band(nh.julAug / nhObs, 0.4, 1.6), "0.4–1.6", `[JMA那霸] 7–8 月 ${nhObs.toFixed(1)}% 天；同上。改前 0.22`);
    check("TW 雷暴日 那霸 / 香港（7–8 月，模型）", nh.julAug / Math.max(hk.julAug, 0.1), band(nh.julAug / Math.max(hk.julAug, 0.1), 0.15, 0.9), "0.15–0.9", "[JMA那霸] / [HKO雷暴] 平年值之比 0.37；门限 [估算]");
    check("TW 雷暴日 香港 1 月 %", hk.jan, hk.jan <= 3, "≤ 3", "[HKO雷暴] 1 月 0.23 天（0.7%）[门限估算]");
    check("TW 华南内陆 400 km 内单体均值（7–8 月午后）", S["华南内陆"].cells, band(S["华南内陆"].cells, 3, 8), "3–8", "TOWERING 表 1.3 改前 4.2；按 [HKO雷暴] 雷暴日 + 单体扫过面积推算午后 400 km 内约 3–10 个 [估算]");
    check("TW 华南沿海 砧顶中位 km（7–8 月）", S["华南沿海"].top50, band(S["华南沿海"].top50, 13.8, 15.5), "13.8–15.5", "热带对流层顶约 16 km [Johnson99]，砧在其下 1–3 km；TOWERING TW01「华南盛夏 14–16」[估算]");
    check("TW 南海中部 砧顶中位 km（7–8 月）", S["南海中部"].top50, band(S["南海中部"].top50, 13.8, 15.5), "13.8–15.5", "同上");
    check("TW 砧顶 华南沿海 − 关东（7–8 月中位，km）", S["华南沿海"].top50 - S["关东"].top50, S["华南沿海"].top50 - S["关东"].top50 >= 0.5, "≥ 0.5", "对流层顶与对流强度随纬度降低 [教科书]；门限 [估算]");
    // 飑线（各点 7–8 月午后见到的全部飑线，按系统去重）：单体数不能总是 4、间距不能总是 16 km（TOWERING §2.2 第 2 条「等距桌腿」，随机性铁律）
    const sq = Object.values(S).flatMap((s) => s.squalls);
    // 按系统的平均间距（单体各自的错位会在平均里抵消，只剩系统之间的差别）
    const gaps = sq.filter((s) => s.gaps.length).map((s) => s.gaps.reduce((a, b) => a + b, 0) / s.gaps.length).sort((a, b) => a - b);
    const gapSpread = gaps.length ? gaps[Math.floor(0.9 * (gaps.length - 1))] - gaps[Math.floor(0.1 * (gaps.length - 1))] : 0;
    const three = pct(sq.filter((s) => s.n === 3).length, sq.length);
    check("TW 飑线 平均单体间距（按系统）p90 − p10 km", gapSpread, gapSpread >= 6, "≥ 6", "改前每条飑线都是 16 km（± 2 的错位）；随机性铁律 [门限估算]");
    check("TW 飑线 3 个单体的比例 %", three, band(three, 15, 70), "15–70", "改前全是 4 个；飑线单体数本来就不定 [教科书]，名额 4 以内 [门限估算]");
    for (const [k, p] of Object.entries(tw.picker)) {
      check(`TW 名额挑选 ${k}：挑中单体里看得见的 %`, p.visNew, p.visNew >= 90, "≥ 90", "TW01：名额只有 4 个单体，优先给挪位后在窗户这一侧、没飞过去的系统（改前按距离挑，南海 / 华南沿海约 48 / 63%）");
      check(`TW 名额挑选 ${k}：每刻看得见的单体数 新 − 旧`, p.visCellsNew - p.visCellsOld, p.visCellsNew >= p.visCellsOld, "≥ 0", "新规则不能让看得见的单体变少");
    }
  }
  if (only.has("wind") && !hasWind) check("风 WeatherField.wind() 存在（1 = 是）", 0, false, "1", "WX11a 风场接口");
  if (wind) {
    const w = wind;
    const band =(v: number, a: number, b: number) => v >= a && v <= b;
    check("风 日本上空 1 月 250 hPa 纬向风月均 m/s", w.jpJan, w.jpJan >= 50, "≥ 50", "[Zhang06] 1 月急流轴 32°N、> 70 m/s；32–36°N 方框含轴北侧，门限放宽（WX11-DESIGN 验收）");
    check("风 1 月急流核心（月均剖面最大）m/s", w.jan.core, band(w.jan.core, 65, 85), "65–85", "[Zhang06] > 70 m/s（200 hPa）；250 hPa 略弱，下限放宽 5；上限 [估算] 防止做过头");
    check("风 1 月急流轴 °N", w.jan.axis, band(w.jan.axis, 30, 34), "30–34", "[Zhang06] 1 月轴在 32°N");
    check("风 4 月核心占 1 月核心 %", (100 * w.apr.core) / w.jan.core, w.apr.core / w.jan.core <= 0.85, "≤ 85", "[Zhang06] 4 月位置与 1 月相近但明显减弱（门限 [估算]）");
    check("风 4 月急流轴 °N", w.apr.axis, band(w.apr.axis, 30, 35), "30–35", "[Zhang06] 4 月位置与 1 月相近");
    check("风 7 月急流轴 °N", w.jul.axis, w.jul.axis >= 38, "≥ 38", "[Zhang06] 7 月中心北移到 40°N 以北（WX11-DESIGN 验收）");
    check("风 7 月急流核心 m/s", w.jul.core, band(w.jul.core, 25, 45), "25–45", "夏季急流 30–40 m/s [教科书，量级]，两边各放 5");
    check("风 华南 7 月 250 hPa 纬向风月均 m/s", w.scJul250, w.scJul250 < 0, "< 0（东风）", "[Kot58] 夏季热带东风急流；华南 25°N 以南东风 5–20 [估算]（盛夏华南砧往西吹，METEOROLOGY §1.9）");
    check("风 华南 1 月 250 hPa 纬向风月均 m/s", w.scJan250, w.scJan250 > 20, "> 20", "冬季副热带西风伸到 15–20°N [教科书]（WX11-DESIGN 验收）");
    check("风 华南 7 月 850 hPa 来向 180–270° %", w.scJulSW, w.scJulSW >= 60, "≥ 60", "夏季西南季风 [教科书]；门限 [估算]");
    check("风 日本海 1 月 850 hPa 来向 270–360° %", w.jsNW, w.jsNW >= 70, "≥ 70", "冬季风西北风 [教科书]（WX11-DESIGN 验收）");
    check("风 日本海 1 月 850 hPa 风速中位 m/s", w.jsMed, band(w.jsMed, 8, 18), "8–18", "寒潮时 10–20、平时 5–8 [教科书，量级]（WX11-DESIGN 验收）");
    check("风 信风带 1 月 850 hPa 东风 %", w.tradeJan, w.tradeJan >= 70, "≥ 70", "18–28°N 洋面偏东—东北风 [教科书]（WX11-DESIGN 验收）");
    check("风 信风带 7 月 850 hPa 东风 %", w.tradeJul, w.tradeJul >= 70, "≥ 70", "同上；夏季是副高南侧的东风 [教科书]");
    check("风 梅雨低空急流 850 hPa ≥ 12 m/s 的比例 %", w.llj12, w.llj12 >= 50, "≥ 50", "梅雨期 850 hPa 常有 ≥ 12 m/s 的西南低空急流 [教科书]；「常有」取过半 [估算]");
    check("风 梅雨低空急流 风速中位 m/s", w.lljMed, band(w.lljMed, 12, 25), "12–25", "低空急流量级 [教科书]；上限 [估算]");
    check("风 埃克曼偏角 海上（中位）°", w.ekSea.ang, band(w.ekSea.ang, 10, 20), "10–20", "北半球地面风比地转风逆时针偏：海上 10–20° [教科书：Holton / Wallace & Hobbs]");
    check("风 埃克曼偏角 陆上（中位）°", w.ekLand.ang, band(w.ekLand.ang, 25, 45), "25–45", "陆上 25–45° [教科书]");
    check("风 10 m 风速占 850 hPa % 海上（中位）", 100 * w.ekSea.ratio, band(w.ekSea.ratio, 0.6, 0.8), "60–80", "地面风约为地转风的 60–80%（海上）[教科书]；对数律 z₀ 按 Charnock");
    check("风 10 m 风速占 850 hPa % 陆上（中位）", 100 * w.ekLand.ratio, band(w.ekLand.ratio, 0.3, 0.5), "30–50", "陆上 30–50% [教科书]；对数律 z₀ = 0.2 m");
    check("风 雷暴漂移与 500 hPa 风向夹角中位 °", w.stormMed, w.stormMed <= 30, "≤ 30", "雷暴随引导气流（700–500 hPa）移动 [教科书]（WX11-DESIGN 验收）");
    // 上面这条改前的写死常数（25°N 以北往东、以南往西）也能过（16°）：常数本来就是气候平均方向。区分力靠下面三条（改前 69° / 168° / 0.50，都失败）
    check("风 雷暴漂移与 500 hPa 风向夹角 p90 °", w.stormP90, w.stormP90 <= 50, "≤ 50", "系统移动偏离平均风一般在 20–30° 以内（传播、右移，[教科书]）；留出 10% 的尾巴 [估算]。写死方向不跟槽脊 / 季风转，尾巴会到 70° 左右");
    check("风 雷暴漂移夹角 p90（25°N 以南）°", w.stormP90S, w.stormP90S <= 90, "≤ 90", "同上，副热带弱风区：夏季风下的系统往北 / 西北走，「以南一律往西」会有一成逆着风走 [估算]");
    check("风 雷暴漂移速度与 500 hPa 风速相关系数", w.stormSpdR, w.stormSpdR >= 0.7, "≥ 0.7", "系统移速随引导气流强弱变化（约为平均风的 0.7–1 倍，[教科书]）；门限 [估算]");
    for (const k of ["p850", "p500", "p250"] as const) {
      const c = w.cont[k];
      check(`风 连续性 ${k} 相邻 1 小时 p99 %`, c.t99, c.t99 <= 15, "≤ 15", "WX11-DESIGN 验收：防止平流速度抖动；分母 max(|风|, 5 m/s)");
      check(`风 连续性 ${k} 相邻 25 km p99 %`, c.x99, c.x99 <= 15, "≤ 15", "同上");
    }
    check("风 连续性 地面 相邻 1 小时 p99 %", w.cont.sfc.t99, w.cont.sfc.t99 <= 15, "≤ 15", "同上");
    check("风 连续性 地面 相邻 25 km p99 %", w.cont.sfc.x99, w.cont.sfc.x99 <= 25, "≤ 25", "海岸两侧粗糙度 / 埃克曼偏角本来就不同（真实的海岸内边界层），放宽 [估算]；云层高度（≥ 1 km）不受影响");
    // ---- WX11a-b：海面风（windSpeed(sfc)，预设坐标）。改前（乘性扰动造不出副高脊线附近的风）西太 7 月中位 1.5–1.8、平静 57–63%，南海 7 月平静 0% ----
    // 换算约定：韦布尔形状 k ≈ 2–3（[Mon06] 海面风近似韦布尔），中位 / 平均 = (ln 2)^(1/k) / Γ(1 + 1/k) ≈ 0.94–0.98；
    // 平静比例 P(U < 2) = 1 − exp(−(2/λ)^k)，λ = 平均 / Γ(1 + 1/k)。岛屿测站受地形遮挡，一般低于开阔海面，作下限依据用
    const sea = w.sea;
    const wpJ = sea["wpac 西太"][7], scJ = sea["scs 南海"][7];
    check("风 海面 西太 7 月中位 m/s", wpJ.med, band(wpJ.med, 3.0, 6.5), "3.0–6.5",
      "[JMA平年] 八丈島 7 月平均 4.3、南大东岛 4.5 → 中位约 4.0–4.2；预设在 30°N，比八丈島（33°N）更靠近副高脊线，父島（27°N、港内）只有 2.7，下限取测站中位的约 75% [门限估算]；上限：最开阔的銚子 7 月 5.3 × 1.2");
    check("风 海面 西太 7 月平静（< 2 m/s）%", wpJ.calm, band(wpJ.calm, 3, 30), "3–30",
      "平均 4.3–5.5、k = 2–3 的韦布尔给出 3–16%；上限放宽到 30 给脊线附近更弱的风 [估算]；下限：随机性铁律，偶有镜面海");
    check("风 海面 南海 7 月中位 m/s", scJ.med, scJ.med >= 3.9, "≥ 3.9",
      "[HKO] 横澜岛 7 月平均 21.3 km/h = 5.9 m/s（风速计离海面约 80 m [按记忆]，海面对数律折到 10 m ÷ 1.19 ≈ 4.9）→ 中位约 4.6，留 15% [门限估算]");
    check("风 海面 南海 7 月平静（< 2 m/s）%", scJ.calm, band(scJ.calm, 1, 25), "1–25",
      "平均约 4.9、k = 2–3.5 的韦布尔给出 3–12%；下限 1%：夏季风也有间歇（季风中断），不能一整月都是同一片海况（随机性铁律）");
    for (const name of ["日本海", "ecs 东海"]) {
      const s = sea[name][1];
      check(`风 海面 ${name} 1 月中位 m/s`, s.med, s.med >= 7, "≥ 7", "冬季风：850 hPa 寒潮 10–20、平时 5–8（WX11-DESIGN，[教科书]）、海上 10 m / 850 = 0.6–0.8 [教科书] → 开阔海面 1 月中位 ≥ 7 [估算]；对照 [HKO] 横澜岛 1 月 7.0（折到 10 m 约 5.9，更南、更弱的东北季风）");
      check(`风 海面 ${name} 1 月平静（< 2 m/s）%`, s.calm, s.calm <= 5, "≤ 5", "平均 ≥ 8、k = 2 的韦布尔给出 ≤ 4.8%");
    }
    check("风 地面风日变化 陆上 14 时 / 02 时（中位之比）", w.diurLand, band(w.diurLand, 1.15, 2.0), "1.15–2.0",
      "[DD99] 陆上地面风午后最大、夜里最小（白天对流混合把上层动量带下来）；比值门限 [估算]（夜间稳定边界层里地面风常减半，上限 2）");
    check("风 地面风日变化 海上 14 时 / 02 时（中位之比）", w.diurSea, band(w.diurSea, 0.85, 1.2), "0.85–1.2", "[DD99] 海上日变化很弱（模型 ±3%，比值约 1.06；门限留抽样噪声 [估算]）");
    const fj = sea["fuji 骏河湾"][7], hc = sea["hnd-cts 沿途"][7];
    check("风 海面 骏河湾 7 月中位 m/s", fj.med, fj.med >= 2.0, "≥ 2.0", "[JMA平年] 石廊崎（伊豆半岛南端、开阔岬角）7 月 4.3；预设点按陆地粗糙度（陆地比例高），取一半作下限 [估算]");
    check("风 海面 hnd-cts 沿途 7 月中位 m/s", hc.med, hc.med >= 2.0, "≥ 2.0", "[JMA平年] 銚子 7 月 5.3（开阔海岸）；航线大半在陆上（z₀ 大），取测站的四成作下限 [估算]");
  }
  return { seed, checks, elapsed, table, frontM, ty, wind, tw };
}

// ---------- 与种子无关的确定性断言 ----------
const detChecks: Check[] = [];
{
  const g: number[] = (W as { TY_GENESIS_PER_MONTH?: number[] }).TY_GENESIS_PER_MONTH ?? []; // 老版本 weather.ts 没有导出这张表（对照改前时）
  const sum = g.reduce((a: number, b: number) => a + b, 0);
  detChecks.push({ name: "生成率表合计（个 / 年）", value: sum, ok: Math.abs(sum - 25.1) <= 0.15, target: "25.1 ± 0.15", src: "[JMA台风] 年 25.1（逐月值是四舍五入到 0.1 的，合计 25.2）" });
  const argmax = g.indexOf(Math.max(...g));
  detChecks.push({ name: "生成率表最大月", value: argmax + 1, ok: argmax === 7, target: "8", src: "[JMA台风] 8 月 5.7 最多" });
}

// ---------- 跑 ----------
const results = seeds.map((s) => {
  const r = runSeed(s);
  if (seeds.length > 1) console.error(`[weather-stats] seed ${s}：${r.checks.filter((c) => c.ok).length} / ${r.checks.length}（${r.elapsed.toFixed(1)} s）`);
  return r;
});

console.log("## 断言\n");
if (seeds.length === 1) {
  console.log("| 项 | 值 | 目标 | 结果 | 依据 |\n| --- | --- | --- | --- | --- |");
  for (const c of [...detChecks, ...results[0].checks]) console.log(`| ${c.name} | ${c.value.toFixed(1)} | ${c.target} | ${c.ok ? "通过" : "**失败**"} | ${c.src} |`);
} else {
  console.log(`| 项 | ${seeds.map((s) => `seed ${s}`).join(" | ")} | 目标 | 依据 |`);
  console.log(`| --- | ${seeds.map(() => "---").join(" | ")} | --- | --- |`);
  for (const c of detChecks) console.log(`| ${c.name} | ${seeds.map(() => (c.ok ? "" : "**") + c.value.toFixed(1) + (c.ok ? "" : "**")).join(" | ")} | ${c.target} | ${c.src} |`);
  results[0].checks.forEach((c0, i) => {
    const vals = results.map((r) => {
      const c = r.checks[i];
      return c.ok ? c.value.toFixed(1) : `**${c.value.toFixed(1)} 失败**`;
    });
    console.log(`| ${c0.name} | ${vals.join(" | ")} | ${c0.target} | ${c0.src} |`);
  });
}
const all = [...detChecks, ...results.flatMap((r) => r.checks)];
const failed = all.filter((c) => !c.ok);
console.log(`\n${all.length - failed.length} / ${all.length} 通过（${seeds.length} 个种子${seeds.length > 1 ? "，门禁要求全部通过" : ""}）`);

const jsonOut = opt("--json");
if (jsonOut) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonOut, JSON.stringify({ seeds, years, tyYears, detChecks, results }, null, 1));
}
process.exit(failed.length ? 1 : 0);
