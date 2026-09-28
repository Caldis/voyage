// VOY-HKG：航线网数据 / 首段接力逻辑的离线断言（不开浏览器）。
//
// 背景：TW02 报告南海预设（scs）连续航程的首段是「HKG → HKG」——起终点是同一个机场，自动驾驶因此要转一个
// 极大的弯（离目标航向 100°+），一直压着接近最大坡度，好几十秒都回不平，窗外只有海看不到东西。根因见
// src/routes.ts 的 airportAhead：接入航线网时挑「机头前方的机场」，如果航线网在那个方向根本没有覆盖（例如
// 南海预设朝西南飞出东亚航线网范围），它会退化成跟 nearestAirport 选到同一个机场——变成一段起点终点相同、
// 距离却按当前位置算出非零值的自相矛盾航段。修法：airportAhead 现在接受 excludeCode，director.ts 的
// joinNetwork() 用当前位置最近的机场当排除项，保证前后绝不是同一个机场。
//
// 这个脚本把 joinNetwork() 挑首段用的同一套函数（nearestAirport / airportAhead）搬出来，对 src/flight.ts
// 里的每一个预设跑一遍，断言：
//   1. ROUTES 表里没有自环（一条航线两端是同一个机场代码）；
//   2. 航线预设（preset.dest）解出来的 from / to 机场不是同一个；
//   3. 非航线预设（连续航程接入航线网）解出来的 here / to 机场不是同一个——这正是 VOY-HKG 的问题类。
// 以后新增预设或改 airportAhead 的评分逻辑，这个脚本能在不开浏览器的情况下当场抓到「首段起终点相同」的回归。
//
// 用法（在 apps/voyage 目录下）：
//   pnpm check-routes
//   node --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings scripts/check-routes.mts
// 需要 --import ts-resolve.mjs：routes.ts 内部 `import { greatCircleBearing, haversineKm } from "./flight"`、
// flight.ts 内部 `import { CRUISE_PITCH_DEG } from "./state"` 都是不带扩展名的值导入（不是纯类型导入，不会被
// 类型剥离擦掉），node 原生类型剥离不会像 vite/tsc 那样自动补 .ts，需要这个 hook 兜底（同 T49 的离线单测）。
import { AIRPORTS, ROUTES, airportAhead, nearestAirport } from "../src/routes.ts";
import { PRESETS, greatCircleBearing, haversineKm } from "../src/flight.ts";

let failed = 0;
const fail = (msg: string) => {
  failed++;
  console.error(`[FAIL] ${msg}`);
};
const okLine = (msg: string) => console.log(`[OK]   ${msg}`);

// 1. ROUTES 表本身没有自环，且两端都是真实登记过的机场
for (const [a, b] of ROUTES) {
  if (a === b) fail(`ROUTES 里有自环：["${a}", "${b}"]`);
  if (!AIRPORTS[a]) fail(`ROUTES 引用了未登记的机场代码：${a}`);
  if (!AIRPORTS[b]) fail(`ROUTES 引用了未登记的机场代码：${b}`);
}
if (failed === 0) okLine(`ROUTES 表：${ROUTES.length} 条航线，没有自环`);

// 2 / 3：每个预设的「首段」——航线预设按 id 解 from/to；其余预设复现 joinNetwork() 的 here/to 选取
console.log("\n预设 id            首段 from -> to           距离      方位      离场景航向的转角");
for (const p of PRESETS) {
  if (p.dest) {
    const [c0, c1] = p.id.toUpperCase().split("-");
    const from = AIRPORTS[c0] ?? nearestAirport(p.lat, p.lon).airport;
    const to = AIRPORTS[c1] ?? nearestAirport(p.dest[0], p.dest[1]).airport;
    const distKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
    const brg = greatCircleBearing(from.lat, from.lon, to.lat, to.lon);
    console.log(`${p.id.padEnd(18)} ${from.code} -> ${to.code}（航线预设，起讫固定）  ${distKm.toFixed(0).padStart(5)} km  ${brg.toFixed(0).padStart(3)}°`);
    if (from.code === to.code) fail(`[${p.id}] 航线预设 from === to（${from.code}）：id 里的两个代码解出了同一个机场`);
  } else {
    // 复现 director.ts joinNetwork()：先按当前位置定最近机场当占位起点，再排除它选「机头前方」的机场
    const here = nearestAirport(p.lat, p.lon).airport;
    const to = airportAhead(p.lat, p.lon, p.heading, here.code);
    const distKm = haversineKm(p.lat, p.lon, to.lat, to.lon);
    const brg = greatCircleBearing(p.lat, p.lon, to.lat, to.lon);
    const turn = Math.abs(((brg - p.heading + 540) % 360) - 180);
    console.log(`${p.id.padEnd(18)} ${here.code} -> ${to.code}（当前位置接入航线网）  ${distKm.toFixed(0).padStart(5)} km  ${brg.toFixed(0).padStart(3)}°       ${turn.toFixed(0)}°`);
    if (here.code === to.code) fail(`[${p.id}] 接入航线网时 here === to（都是 ${here.code}）：航线网在场景航向 ${p.heading}° 方向上没有覆盖，见 VOY-HKG`);
    if (distKm < 150) fail(`[${p.id}] 接入航线网选到的机场只有 ${distKm.toFixed(0)} km，太近（不像「起飞去下一个地方」）`);
  }
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
