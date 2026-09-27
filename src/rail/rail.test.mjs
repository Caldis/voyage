// 火车模式（TR02）的 node 单测：沿线采样、走廊坐标往返、曲率与超高、姿态（侧倾 / 俯仰 / 眼高）、速度曲线、
// 里程对车站、振动的平滑与幅度。不开浏览器，几秒跑完。
// 用法：node apps/voyage/src/rail/rail.test.mjs   （Node ≥ 23.6，直接跑 .ts；下面的钩子补上省略的 .ts 扩展名）
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith(".") && !spec.endsWith(".ts")) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const D2R = Math.PI / 180;
const here = dirname(fileURLToPath(import.meta.url));
const { parseRailData } = await import("./data.ts");
const { Corridor, CANT_MAX_MM, GAUGE_MM, CANT_DESIGN_SPEED_KMH, RAIL_CENTER_SPACING_MM, CANT_GRADIENT_MM_PER_M } = await import("./corridor.ts");
const { Train, EYE_HEIGHT_M, EYE_LATERAL_M, LAT_ACC_LIMIT, CRUISE_KMH, BOGIE_SPACING_M } = await import("./train.ts");
const { EnuFrame } = await import("./geodesy.ts");
// ground/geo.ts 用了参数属性，node 的纯剥离模式跑不了；这里照抄 LocalFrame.toLocal 的公式（改了那边要同步）
const LocalFrame = class { constructor(lat0, lon0) { this.lat0 = lat0; this.lon0 = lon0; } toLocal(lat, lon) { return [(lon - this.lon0) * 111.32 * Math.cos(lat * D2R), -(lat - this.lat0) * 110.574]; } };

const dataDir = join(here, "..", "..", "public", "data", "rail");
const meta = JSON.parse(readFileSync(join(dataDir, "oito-matsumoto-shinanoomachi.json"), "utf8"));
const file = readFileSync(join(dataDir, meta.format.bin));
const data = parseRailData(meta, file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
const cor = new Corridor(data);

let fails = 0, passes = 0;
function check(ok, msg, detail = "") {
  if (ok) passes++;
  else {
    fails++;
    console.error(`✗ ${msg}${detail ? `：${detail}` : ""}`);
  }
}
const fmt = (x, n = 3) => Number(x).toFixed(n);

// ---------- 1. 数据与沿线采样 ----------
const c = data.center;
check(Math.abs(c.ds - 2) < 1e-3, "中心线是 2 m 等间距", `ds = ${c.ds}`);
check(cor.stations.length === 20, "20 个车站");
let maxStationErr = 0;
for (const st of cor.stations) maxStationErr = Math.max(maxStationErr, Math.abs(st.s / 1000 - st.km));
check(maxStationErr <= 0.1, "车站里程与营业キロ相差 ≤ 0.1 km", `最大 ${fmt(maxStationErr)} km`);
// 采样点上插值 = 原值；两个采样点中间是线性的
{
  let e = 0, eh = 0;
  for (let i = 100; i < c.n - 100; i += 331) {
    const p = cor.position(c.s[i]);
    e = Math.max(e, Math.abs(p[2] - c.zRail[i]));
    eh = Math.max(eh, Math.hypot(p[0] - c.x[i], p[1] - c.y[i]));
  }
  check(e < 0.01, "position(s) 的高程在采样点上等于烘焙的 zRail", `最大偏差 ${fmt(e, 4)} m`);
  check(eh < 1.0, "平滑后的平面位置离烘焙折线 < 1 m（σ = 15 m 高斯平滑）", `最大 ${fmt(eh, 3)} m`);
}
// 走廊坐标往返：toEnu(s, d) → project → (s, d)
{
  let es = 0, ed = 0;
  for (let k = 0; k < 400; k++) {
    const s = 200 + ((k * 7919) % 34600);
    const d = ((k * 37) % 61) - 30;
    const [x, y] = cor.toEnu(s, d);
    const r = cor.project(x, y, s + 15, 60);
    es = Math.max(es, Math.abs(r.s - s));
    ed = Math.max(ed, Math.abs(r.d - d));
  }
  // 弯道上 toEnu 的法线（±2 m 差分）和逐段投影的法线略有张角：离中心线 30 m 时往返误差按 d·Δθ 量级，留 0.8 m
  check(es < 0.8 && ed < 0.05, "走廊坐标往返 (s, d) → ENU → (s, d)", `|Δs| ≤ ${fmt(es)} m，|Δd| ≤ ${fmt(ed)} m`);
}
// d 的符号：+ 在往信濃大町方向左侧（线路大体向北，左侧是西 → x 更小）
{
  const [x0] = cor.toEnu(15000, 0);
  const [xl] = cor.toEnu(15000, 10);
  const [tx, ty] = cor.tangent(15000);
  check(ty > 0.5 && xl < x0, "d > 0 在行进方向左侧（北行时是西侧）", `切向 (${fmt(tx)}, ${fmt(ty)})`);
}

// ---------- 2. 曲率、超高 ----------
{
  // curvatureAvg 与切向角的变化率一致（符号：+ = 左转 = 逆时针）
  let worst = 0, cnt = 0;
  for (let s = 500; s < 34500; s += 97) {
    const k = cor.curvatureAvg(s, 30);
    if (Math.abs(k) < 1 / 1500) continue;
    const [ax, ay] = cor.tangent(s - 30), [bx, by] = cor.tangent(s + 30);
    const dth = Math.atan2(ax * by - ay * bx, ax * bx + ay * by) / 60;
    worst = Math.max(worst, Math.abs(dth - k) / Math.abs(k));
    cnt++;
  }
  check(cnt > 20 && worst < 0.35, "平均曲率与切向角变化率一致（含符号）", `${cnt} 个弯道点，最大相对偏差 ${fmt(worst * 100, 1)}%`);
  // 超高：直线 0；弯道按 C = G·V²/(127R) 并夹到 G²/(6H)
  let maxC = 0, straightMax = 0, formulaErr = 0, overFormula = 0, maxGrad = 0;
  // 在采样点上比（两个采样点之间 cantMm 是线性插值，公式值不是）
  for (let s = c.s0 + 4; s < 35000; s += c.ds) {
    const C = cor.cantMm(s);
    const Cf = cor.cantFormulaMm(s);
    // 反向曲线（S 弯）中间，一侧的渐变会伸进另一侧公式值很小的地方，符号只在公式值明显时要求一致
    if ((Math.sign(C) === Math.sign(Cf) && Math.abs(C) > Math.abs(Cf) + 0.01) || (Math.abs(Cf) > 20 && Math.sign(C) !== Math.sign(Cf))) overFormula++;
    maxGrad = Math.max(maxGrad, Math.abs(cor.cantMm(s + 1) - C));
    maxC = Math.max(maxC, Math.abs(C));
    const k = cor.curvatureAvg(s);
    if (Math.abs(k) < 1 / 12000) straightMax = Math.max(straightMax, Math.abs(C));
    if (Math.abs(k) > 1 / 2000) {
      const expect = Math.min((GAUGE_MM * CANT_DESIGN_SPEED_KMH ** 2 * Math.abs(k)) / 127, CANT_MAX_MM);
      formulaErr = Math.max(formulaErr, Math.abs(Math.abs(Cf) - expect));
      if (Math.sign(Cf) !== Math.sign(k)) formulaErr = Infinity;
    }
  }
  check(straightMax < 0.5, "直线段（R > 12 km）超高为 0", `最大 ${fmt(straightMax, 2)} mm`);
  check(maxC <= CANT_MAX_MM + 1e-6 && maxC > 100, "超高不超过 G²/(6H) 上限，最急的弯到上限附近", `最大 ${fmt(maxC, 1)} mm，上限 ${fmt(CANT_MAX_MM, 1)} mm`);
  check(formulaErr < 0.5, "弯道超高（公式值）= 规范公式（符号跟随曲率）", `最大偏差 ${fmt(formulaErr, 2)} mm`);
  check(overFormula === 0, "限制变化率后的超高不超过公式值、符号一致", `${overFormula} 处`);
  check(maxGrad <= CANT_GRADIENT_MM_PER_M + 0.01, "超高沿线变化率不超过上限", `最大 ${fmt(maxGrad, 2)} mm/m，上限 ${fmt(CANT_GRADIENT_MM_PER_M, 2)}`);
  console.log(`  超高上限（估）${fmt(CANT_MAX_MM, 1)} mm = ${fmt(Math.asin(CANT_MAX_MM / RAIL_CENTER_SPACING_MM) / D2R, 2)}°；R = 600 m 时 ${fmt(Math.min(1067 * 8100 / (127 * 600), CANT_MAX_MM), 1)} mm`);
}

// ---------- 3. 姿态：眼高、横向、侧倾、俯仰 ----------
function findCurve(sign, minK) {
  for (let s = 1000; s < 34000; s += 4) {
    const k = cor.curvatureAvg(s);
    if (Math.sign(k) === sign && Math.abs(k) > minK && Math.abs(cor.curvatureAvg(s - 20)) > minK && Math.abs(cor.curvatureAvg(s + 20)) > minK) return s;
  }
  return null;
}
{
  const sL = findCurve(1, 1 / 700), sR = findCurve(-1, 1 / 700);
  check(sL !== null && sR !== null, "线路上找得到左、右两种弯道（R < 700 m）");
  for (const [sc, name] of [[sL, "左转"], [sR, "右转"]]) {
    if (sc === null) continue;
    const t = new Train(cor, { s: sc, dir: 1 });
    t.teleport(sc, 1, 60 / 3.6);
    const p = t.pose("left");
    const k = cor.curvatureAvg(sc);
    // 左转：内侧（左）低 → 滚转 < 0（右侧下沉为正）
    check(Math.sign(p.rollCant) === -Math.sign(k), `${name}弯道：超高侧倾向内侧`, `roll(超高) = ${fmt(p.rollCant / D2R, 2)}°，超高 ${fmt(p.cantMm, 0)} mm`);
    // 车速低于平衡速度 → 过超高 → 悬挂的外倾为负（向内）
    const vEq = Math.sqrt((9.80665 * Math.abs(p.cantMm) / RAIL_CENTER_SPACING_MM) / Math.abs(k));
    console.log(`  ${name} s = ${fmt(sc / 1000, 2)} km，R ≈ ${Math.round(1 / Math.abs(k))} m，超高 ${fmt(Math.abs(p.cantMm), 0)} mm（${fmt(Math.abs(p.rollCant) / D2R, 2)}°），平衡速度 ${fmt(vEq * 3.6, 0)} km/h，60 km/h 时悬挂外倾 ${fmt(p.rollSuspension / D2R, 3)}°`);
    // 同一处反方向行驶：侧倾方向不变（轨道本身的倾斜），行驶方向的左右互换
    const t2 = new Train(cor, { s: sc, dir: -1 });
    t2.teleport(sc, -1, 60 / 3.6);
    const p2 = t2.pose("left");
    const upEast1 = p.up[0], upEast2 = p2.up[0], upNorth1 = p.up[1], upNorth2 = p2.up[1];
    check(Math.hypot(upEast1 - upEast2, upNorth1 - upNorth2) < 0.01, `${name}弯道：往返两个方向车体 up 在世界里是同一个倾斜（轨道平面）`, `(${fmt(upEast1)}, ${fmt(upNorth1)}) vs (${fmt(upEast2)}, ${fmt(upNorth2)})`);
  }
  // 眼高与横向：直线段、左座往信濃大町 → d ≈ +EYE_LATERAL（左侧）、h ≈ 2.5 m
  let sStraight = null;
  for (let s = 13000; s < 20000; s += 10) if (Math.abs(cor.curvatureAvg(s, 60)) < 1 / 20000) { sStraight = s; break; }
  const t = new Train(cor, { s: sStraight, dir: 1 });
  t.teleport(sStraight, 1, 0.001);
  const pl = t.pose("left"), pr = t.pose("right");
  check(Math.abs(pl.eyeCorridor.d - EYE_LATERAL_M) < 0.05 && Math.abs(pr.eyeCorridor.d + EYE_LATERAL_M) < 0.05, "直线段：左座眼睛在 d ≈ +0.95 m，右座在 −0.95 m", `左 ${fmt(pl.eyeCorridor.d)}、右 ${fmt(pr.eyeCorridor.d)}`);
  check(Math.abs(pl.eyeCorridor.h - EYE_HEIGHT_M) < 0.05, "眼睛离轨面约 2.5 m", `${fmt(pl.eyeCorridor.h)} m`);
  const t3 = new Train(cor, { s: sStraight, dir: -1 });
  t3.teleport(sStraight, -1, 0.001);
  check(Math.abs(t3.pose("left").eyeCorridor.d + EYE_LATERAL_M) < 0.05, "往松本方向时左座在 d ≈ −0.95 m（走廊坐标的 d 不随行驶方向翻转）");
  // 坡度俯仰：在一段稳定的坡上，俯仰 ≈ atan(grade)，往回走时符号相反
  let sSlope = null;
  for (let s = 28000; s < 34000; s += 10) if (Math.abs(c.grade[Math.round((s - c.s0) / 2)]) > 15) { sSlope = s; break; }
  const g = cor.sample(sSlope).grade;
  const tu = new Train(cor, { s: sSlope, dir: 1 });
  tu.teleport(sSlope, 1, 0.001);
  const td = new Train(cor, { s: sSlope, dir: -1 });
  td.teleport(sSlope, -1, 0.001);
  const pu = tu.pose("left").pitch, pd = td.pose("left").pitch;
  check(Math.abs(pu - Math.atan(g / 1000)) < 0.002 && Math.abs(pd + Math.atan(g / 1000)) < 0.002, "坡度俯仰 ≈ atan(坡度)，反向时相反", `坡度 ${fmt(g, 1)}‰ → ${fmt(pu / D2R, 3)}° / ${fmt(pd / D2R, 3)}°`);
}

// ---------- 4. 速度曲线：从松本出发跑完全程、终点停车、折返 ----------
{
  const t = new Train(cor, { s: cor.stopPoint(cor.stations[0]) + 1, dir: 1, speed: 0 });
  const dt = 1 / 60;
  let time = 0, maxV = 0, maxLat = 0, maxAcc = 0, prevV = 0, reversedAt = -1, arrivedAt = -1, backward = 0;
  let prevS = t.s, prevRoll = t.pose("left").roll, maxDRoll = 0, prevYaw = t.pose("left").yaw, maxDYaw = 0, prevDy = null, maxDDYaw = 0;
  const passTimes = [];
  let nextIdx = 1;
  while (time < 3600 && reversedAt < 0) {
    t.update(dt);
    time += dt;
    const p = t.pose("left");
    maxV = Math.max(maxV, t.speed);
    const k = t.dir * cor.curvatureAvg(t.s);
    const aU = Math.abs(t.speed ** 2 * k - 9.80665 * p.cantMm / RAIL_CENTER_SPACING_MM);
    if (t.speed > 5) maxLat = Math.max(maxLat, aU);
    // 停稳的那一帧（最后 5 cm 直接落到 0）不计入
    if (t.speed > 0.5 && prevV > 0.5) maxAcc = Math.max(maxAcc, Math.abs(t.speed - prevV) / dt);
    prevV = t.speed;
    if (t.dir === 1 && t.s < prevS - 1e-6) backward++;
    // 折返那一帧行驶方向反过来，滚转 / 偏航按定义跳变，不计入
    if (t.dir === 1 && t.speed > 0.5) {
      maxDRoll = Math.max(maxDRoll, Math.abs(p.roll - prevRoll));
      let dy = p.yaw - prevYaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      maxDYaw = Math.max(maxDYaw, Math.abs(dy));
      if (prevDy !== null) maxDDYaw = Math.max(maxDDYaw, Math.abs(dy - prevDy));
      prevDy = dy;
    }
    prevRoll = p.roll;
    prevYaw = p.yaw;
    prevS = t.s;
    while (nextIdx < cor.stations.length && t.s >= cor.stations[nextIdx].s) passTimes.push([cor.stations[nextIdx++].name, time]);
    if (arrivedAt < 0 && t.dwell > 0) arrivedAt = time;
    if (arrivedAt >= 0 && t.dir === -1) reversedAt = time;
  }
  check(maxV <= CRUISE_KMH / 3.6 + 1e-6, "车速不超过巡航 90 km/h", `最高 ${fmt(maxV * 3.6, 1)} km/h`);
  check(maxLat <= LAT_ACC_LIMIT + 0.08, "弯道未平衡横加速度不超过限值（车长范围内限速）", `最大 ${fmt(maxLat, 2)} m/s²，限值 ${LAT_ACC_LIMIT}`);
  check(maxAcc <= 1.06 + 1e-6, "加减速不超过 1.05 m/s²（制动 1.5 × 0.7）", `最大 ${fmt(maxAcc, 2)} m/s²`);
  check(backward === 0, "往信濃大町行驶时里程单调增加");
  check(arrivedAt > 0 && Math.abs(t.s - cor.stopPoint(cor.stations[19])) < 0.1, "在信濃大町停车", `到站 ${fmt(arrivedAt / 60, 1)} 分钟，停在 s = ${fmt(t.s, 1)}`);
  check(reversedAt > arrivedAt + 39, "停站约 40 s 后折返往松本");
  check(passTimes.length === 18, "依次通过 18 个中间站（不停站）", `${passTimes.length}`);
  // 平均速度（通过北松本 → 通过南大町）：巡航 90、个别弯道限速，应在 80–90 之间
  const tA = passTimes[0][1], tB = passTimes[passTimes.length - 1][1];
  const vAvg = (cor.stations[18].s - cor.stations[1].s) / (tB - tA) * 3.6;
  check(vAvg > 78 && vAvg < 90, "中间区段平均速度 78–90 km/h", `${fmt(vAvg, 1)} km/h，全程 ${fmt(arrivedAt / 60, 1)} 分钟`);
  // 平滑：60 Hz 一帧里滚转 / 偏航的最大变化（地平线一帧不跳过 1 px 的量级：1 px ≈ 0.042°）
  // 滚转：进出缓和曲线时超高按 ≤ 1.67 mm/m 变化，90 km/h 时约 2°/s ≈ 0.035°/帧（60 Hz）；再加一点振动
  check(maxDRoll / D2R < 0.07, "滚转每帧变化 < 0.07°（超高渐变约 0.035° + 振动，不跳）", `最大 ${fmt(maxDRoll / D2R, 4)}°/帧`);
  // 偏航：正常转向本身可以到 0.1°/帧（R ≈ 250 m、80 km/h），要看的是转向速度是否连续（没有折线折角带来的「一顿一顿」）
  check(maxDYaw / D2R < 0.15, "偏航每帧变化 < 0.15°（急弯正常转向的量级）", `最大 ${fmt(maxDYaw / D2R, 4)}°/帧`);
  // 线性插值 + 未平滑的折线时是 0.013（每过一个 2 m 采样点跳一下）；平滑 + Catmull-Rom 后只剩急弯入口本身的角加速度（约 0.004）
  check(maxDDYaw / D2R < 0.005, "偏航角速度连续（每帧变化 < 0.005°/帧，没有折角造成的顿挫）", `最大 ${fmt(maxDDYaw / D2R, 5)}°/帧²`);
  console.log(`  松本 → 信濃大町：${fmt(arrivedAt / 60, 1)} 分钟（不停中间站），最高 ${fmt(maxV * 3.6, 0)} km/h，弯道最大未平衡横加速度 ${fmt(maxLat, 2)} m/s²`);
  console.log(`  通过时刻（分）：${passTimes.map(([n, tt]) => `${n} ${fmt(tt / 60, 1)}`).join("、")}`);
}

// ---------- 5. 振动：幅度与平滑 ----------
{
  const t = new Train(cor, { s: 13000, dir: 1 });
  const dt = 1 / 60;
  const acc = { heave: [], roll: [], pitch: [], yaw: [] };
  let maxJerkRoll = 0, prevRollV = null, prevRoll = null;
  for (let i = 0; i < 60 * 120; i++) {
    t.update(dt);
    const v = t.pose("left").vibration;
    for (const k of Object.keys(acc)) acc[k].push(v[k]);
    if (prevRoll !== null) {
      const rv = (v.roll - prevRoll) / dt;
      if (prevRollV !== null) maxJerkRoll = Math.max(maxJerkRoll, Math.abs(rv - prevRollV) / dt);
      prevRollV = rv;
    }
    prevRoll = v.roll;
  }
  const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  const r = { heave: rms(acc.heave) * 1000, roll: rms(acc.roll) / D2R, pitch: rms(acc.pitch) / D2R, yaw: rms(acc.yaw) / D2R };
  console.log(`  90 km/h 振动均方根：上下 ${fmt(r.heave, 2)} mm，侧滚 ${fmt(r.roll, 3)}°，点头 ${fmt(r.pitch, 3)}°，摇头 ${fmt(r.yaw, 3)}°；侧滚角加速度最大 ${fmt(maxJerkRoll / D2R, 2)}°/s²`);
  check(r.heave > 0.8 && r.heave < 5, "上下振动均方根 0.8–5 mm");
  check(r.roll > 0.04 && r.roll < 0.25, "侧滚振动均方根 0.04–0.25°");
  check(r.pitch > 0.01 && r.pitch < 0.08, "点头振动均方根 0.01–0.08°");
  check(r.yaw > 0.01 && r.yaw < 0.08, "摇头振动均方根 0.01–0.08°");
  check(maxJerkRoll / D2R < 30, "侧滚是平滑的（角加速度有界，不是逐帧随机）");
  // 停车时振动衰减到静止
  const ts = new Train(cor, { s: 20000, dir: 1, speed: 0 });
  ts.cruise = 0;
  for (let i = 0; i < 600; i++) ts.update(dt);
  const before = ts.pose("left").vibration.roll;
  for (let i = 0; i < 60; i++) ts.update(dt);
  check(Math.abs(ts.pose("left").vibration.roll - before) < 1e-7, "停着时车体不晃");
  // 同一段线路每次经过都一样（振动是里程的函数 + 确定性滤波）
  const a = new Train(cor, { s: 15000, dir: 1 }), b = new Train(cor, { s: 15000, dir: 1 });
  for (let i = 0; i < 300; i++) { a.update(dt); b.update(dt); }
  check(a.pose("left").vibration.roll === b.pose("left").vibration.roll, "振动是确定性的（同一初值、同一路段逐位相同）");
}

// ---------- 6. 坐标换算：ENU ↔ 经纬度 ↔ voyage 本地公里 ----------
{
  const enu = new EnuFrame(meta.format.crs.originLat, meta.format.crs.originLon);
  let e = 0;
  for (let k = 0; k < 50; k++) {
    const x = ((k * 3911) % 30000) - 8000, y = (k * 7717) % 36000;
    const [la, lo] = enu.inv(x, y);
    const [x2, y2] = enu.fwd(la, lo);
    e = Math.max(e, Math.hypot(x2 - x, y2 - y));
  }
  check(e < 0.001, "ENU → 经纬度 → ENU 往返误差 < 1 mm", `${fmt(e * 1000, 3)} mm`);
  // 信濃大町站：ENU 距离 vs LocalFrame 公里距离（LocalFrame 纬向按 110.574 km/度，比真实短约 0.35%）
  const st = cor.stations[19];
  const [sx, sy] = cor.toEnu(st.s, 0);
  const [la, lo] = enu.inv(sx, sy);
  const lf = new LocalFrame(meta.format.crs.originLat, meta.format.crs.originLon);
  const [lx, lz] = lf.toLocal(la, lo);
  const ratio = Math.hypot(lx, lz) * 1000 / Math.hypot(sx, sy);
  console.log(`  信濃大町站：ENU 距松本 ${fmt(Math.hypot(sx, sy) / 1000, 3)} km，LocalFrame 里 ${fmt(Math.hypot(lx, lz), 3)} km（比例 ${fmt(ratio, 4)}）`);
  check(Math.abs(ratio - 1) < 0.006, "LocalFrame 与真实距离的比例偏差 < 0.6%（已知的纬向常数差）");
  check(BOGIE_SPACING_M === 13.8, "台车中心距取 13.8 m");
}

// ---------- 7. 终点附近跳转（审查 B1）：停站中 / 进站前 / 放到终点外 ----------
{
  const { BRAKE } = await import("./train.ts");
  const dt = 1 / 60;
  const run = (t, sec, fn) => { for (let i = 0; i < sec * 60; i++) { t.update(dt); fn?.(t); } };
  const [tA, tB] = new Train(cor).terminalS;
  for (const [name, s, dir] of [["信濃大町停车位上（往大町）", tB, 1], ["越过信濃大町、线路末端", cor.sMax - 2, 1], ["松本停车位之外（往松本）", cor.sMin + 2, -1]]) {
    const t = new Train(cor, { s: 20000 });
    t.teleport(s, dir);
    const startedDwell = t.dwell > 0;
    let reversedAt = -1, time = 0;
    run(t, 60, (tt) => { time += dt; if (reversedAt < 0 && tt.dir === -dir) reversedAt = time; });
    const moved = (t.s - (dir > 0 ? tB : tA)) * -dir;
    check(startedDwell && reversedAt > 0 && reversedAt < 45 && moved > 10, `终点跳转：${name} → 立刻停站、40 s 后折返开走`, `停站 ${startedDwell}，折返于 ${fmt(reversedAt, 1)} s，已离开终点 ${fmt(moved, 1)} m`);
  }
  // 进站前 200 m 放下去（要求 90 km/h）：初速不超过制动曲线，之后平稳减速停在停车位上
  const t = new Train(cor, { s: 20000 });
  t.teleport(tB - 200, 1, 90 / 3.6);
  const v0 = t.speed;
  let maxDec = 0, prev = t.speed;
  run(t, 60, (tt) => { if (tt.speed > 0.5 && prev > 0.5) maxDec = Math.max(maxDec, (prev - tt.speed) / dt); prev = tt.speed; });
  check(v0 <= Math.sqrt(2 * BRAKE * 200) + 1e-6, "进站前跳转：初速不超过到停车位的制动曲线", `${fmt(v0 * 3.6, 1)} km/h`);
  check(maxDec <= 1.06 && (Math.abs(t.s - tB) < 0.1 || t.dir === -1), "进站前跳转：减速 ≤ 1.05 m/s² 并停在信濃大町", `最大减速 ${fmt(maxDec, 2)} m/s²，s = ${fmt(t.s, 1)}`);
}

// ---------- 8. mode.ts：进入 / 退出的换算与状态恢复（假的 ground / host，不用浏览器） ----------
{
  const THREE = await import("three");
  const { RailMode } = await import("./mode.ts");
  const makeGround = (lat0, lon0) => ({ localFrame: new LocalFrame(lat0, lon0), resets: 0, reset(la, lo) { this.localFrame = new LocalFrame(la, lo); this.resets++; }, heightAt: () => null });
  LocalFrame.prototype.toGeo = function (x, z) { const lat = this.lat0 - z / 110.574; return [lat, this.lon0 + x / (111.32 * Math.cos(lat * D2R))]; };
  const ground = makeGround(30, 139.8);
  const plane = { id: "wpac", name: "西太平洋", lat: 30, lon: 139.8, heading: 180, tz: 9, islands: 0.12 };
  const state = { preset: plane, seat: "right", altitudeKm: 10.7, targetAltKm: 10.7, heading: 180, pitchDeg: 2.5, bankDeg: 0.3, rollDeg: 0.1, groundOn: true, floor: { km: 0.5, known: true, groundKm: 0, reason: "sea" } };
  const offset = new THREE.Vector2(12, -34);
  let afterExit = 0;
  const rail = new RailMode({ state, ground, cloudOffset: offset, snapAll() {}, syncTimeUi() {}, setSeat(s) { state.seat = s; }, afterExit() { afterExit++; } });
  rail.useData(data);
  await rail.enter();
  const p = rail.pose;
  const [tx, ty] = cor.tangent(p.s);
  const bearing = ((Math.atan2(tx, ty) / D2R) + 360) % 360;
  const dh = Math.abs(((state.heading - bearing + 540) % 360) - 180);
  check(rail.active && state.preset.id === "rail-oito" && Math.abs(ground.localFrame.lat0 - meta.format.crs.originLat) < 1e-9, "进入火车：地点换成线路预设、clipmap 原点换到松本站");
  check(state.seat === "left", "第一次进入：座位在北阿尔卑斯一侧（往信濃大町是左座）");
  check(Math.abs(state.altitudeKm * 1000 - (cor.position(p.s)[2] + 2.5)) < 0.3, "高度 = 轨面 + 2.5 m", `${fmt(state.altitudeKm * 1000, 2)} m`);
  check(dh < 0.5, "航向与线路切向的方位一致（经 LocalFrame 换算）", `航向 ${fmt(state.heading, 2)}°，线路 ${fmt(bearing, 2)}°`);
  const o0 = offset.clone();
  let mx = 0, mz = 0;
  for (let i = 0; i < 60; i++) { const r = rail.step(1 / 60); mx += r.motion.x; mz += r.motion.z; }
  const moved = Math.hypot(offset.x - o0.x, offset.y - o0.y);
  check(Math.abs(moved - 0.025) < 0.002 && Math.hypot(mx - (offset.x - o0.x), mz - (offset.y - o0.y)) < 1e-9, "1 s 走约 25 m（90 km/h），motion 累加 = uCloudOffset 位移", `${fmt(moved * 1000, 2)} m`);
  const sBefore = rail.train.s, dirBefore = rail.train.dir;
  rail.exit();
  check(!rail.active && state.preset === plane && offset.x === 12 && offset.y === -34 && Math.abs(ground.localFrame.lat0 - 30) < 1e-12, "退出：地点、clipmap 原点、uCloudOffset 恢复");
  check(state.altitudeKm === 10.7 && state.targetAltKm === 10.7 && state.heading === 180 && state.pitchDeg === 2.5 && state.bankDeg === 0.3 && state.rollDeg === 0.1 && state.seat === "right", "退出：高度 / 航向 / 俯仰 / 坡度 / 滚转 / 座位恢复");
  check(state.floor.known === false && afterExit === 1, "退出：高度下限按地点重估，通知 main（导演重新接入航线网）");
  state.seat = "right";
  await rail.enter();
  check(rail.train.s === sBefore && rail.train.dir === dirBefore && state.seat === "left", "再次进入（不给参数）：列车原样继续，座位沿用上次在火车里的");
  // 终点停站中切回飞机、再切回来：停站继续、按时折返
  rail.teleport(rail.train.terminalS[1] - 30, 1);
  for (let i = 0; i < 60 * 20 && rail.train.dwell === 0; i++) rail.step(1 / 60);
  const dwell0 = rail.train.dwell;
  rail.exit();
  await rail.enter();
  check(dwell0 > 0 && rail.train.dwell === dwell0 && rail.train.dir === 1, "终点停站中切换：停站剩余时间和方向保持", `剩 ${fmt(dwell0, 1)} s`);
  for (let i = 0; i < 60 * 60; i++) rail.step(1 / 60);
  check(rail.train.dir === -1 && rail.train.s < rail.train.terminalS[1] - 20, "终点停站中切换后：照常折返开往松本", `s = ${fmt(rail.train.s, 1)}`);
  // 加载中取消
  const rail2 = new RailMode({ state, ground, cloudOffset: offset, snapAll() {}, syncTimeUi() {}, setSeat(s) { state.seat = s; } });
  rail2.useData(data);
  rail.exit();
  const pEnter = rail2.setVehicle("train");
  await rail2.setVehicle("plane");
  await pEnter;
  check(!rail2.active, "切到火车后马上切回飞机：不会在加载完成后进入火车");
}
console.log(`${fails ? "✗" : "✓"} ${passes} 项通过，${fails} 项失败`);
if (fails) process.exit(1);
