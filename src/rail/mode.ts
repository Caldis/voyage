import * as THREE from "three";
import type { GroundClipmap } from "../ground/clipmap";
import { resetAltitudeFloor, type AdvanceFlightResult } from "../flight";
import type { Preset, VoyageState } from "../state";
import { Corridor } from "./corridor";
import { loadRailData, type RailData } from "./data";
import { EnuFrame } from "./geodesy";
import { railFarUniforms } from "./far-view";
import { CRUISE_KMH, Train, type Seat, type TrainPose } from "./train";

/**
 * 火车模式（TR02）：把 Train 的姿态接到 voyage 现有的相机、时间、天气系统上。
 *
 * - 位置：眼睛的 ENU → 真实经纬度（geodesy.ts）→ 地面 clipmap 的 LocalFrame 本地公里坐标，写进 uCloudOffset（和飞机一样）。
 *   进入火车模式时 clipmap 的原点换到松本站（线路 ENU 的切点），退出时恢复飞机当时的原点和位置。
 * - 高度：state.altitudeKm = 眼睛的标高（国土地理院 DEM 推出的轨面 + 2.5 m），不再按 clipmap 地形（AWS Terrain）抬高（TR03）：
 *   窗外程序的火车变体（rail/far-view.glsl.ts）在近处用国土地理院标高的平面、往外才渐变到 clipmap 地形，并把 clipmap 地形平移到国土地理院的基准，
 *   两套高程的米级差异不会再让视线从地形里面出发。这里每帧写那几个 uniform（railFarUniforms：相机海拔的精确值、近处地面标高、基准差）。
 * - 朝向：航向 / 俯仰 / 滚转直接写进 state.heading / pitchDeg / rollDeg，main.ts 的 cabinToWorld 照常用（bankDeg 置 0）。
 * - 机翼：不改着色器，把 uWingRootLE 设成身后 10 km（RAIL_WING_ROOT_LE），机翼和翼尖灯都在视野外。
 * - 舱内仍是飞机舷窗（TR06 才做车厢）；近景 / 中景还没有（TR04 / TR05），窗外只有现有窗外程序在贴地相机下的效果。
 */

export const RAIL_LINE_ID = "oito-matsumoto-shinanoomachi";
/** 火车模式下机翼挪到身后 10 km（米）：不改任何着色器就把机翼、翼尖灯移出视野 */
export const RAIL_WING_ROOT_LE = -1e4;
/** 火车模式下河道折线的最大画宽（米，估）：宽河有水面多边形，折线只补细河道（见 GroundClipmap.waterwayMaxM） */
const RAIL_WATERWAY_MAX_M = 12;
/** 近处地面至少比眼睛低这么多（米）：国土地理院网格 10 m 一格，路堑、站台边上取到的格子可能比轨面还高 */
const NEAR_GROUND_BELOW_EYE_M = 1.2;
/** 近处地面标高的取样：窗侧离中心线 15–80 m、前后 ±20 m 的国土地理院网格点（米） */
const NEAR_GROUND_D = [15, 30, 50, 80];
const NEAR_GROUND_S = [-20, 0, 20];
/** 基准差（国土地理院 − clipmap 地形）的取样：两侧 120 / 300 m、前后 ±150 m（米）；取中位数，按 2 s 的时间常数跟上 */
const OFFSET_D = [-300, -120, 120, 300];
const OFFSET_S = [-150, 0, 150];
/** 基准差的上限（米）：AWS 地形在河岸台地、城区偶有几十米的偏差，再大就不信它（按 0 处理） */
const OFFSET_MAX_M = 60;
/** 默认起点：豊科（11.4 km）过后的平原段，往信濃大町方向；左侧（西）是北阿尔卑斯 */
export const DEFAULT_START_S = 12500;
/** 舱内头部相对窗框的上下晃动 = 车体上下振动 × 这个比例（估：人坐在车里随车体一起动，只有一小部分相对运动） */
const HEAD_BUMP_RATIO = 0.3;

export interface RailHost {
  state: VoyageState;
  ground: GroundClipmap;
  /** cloudUniforms.uCloudOffset.value：相机的本地公里坐标（x 东、z 南） */
  cloudOffset: THREE.Vector2;
  snapAll(): void;
  syncTimeUi(): void;
  /** 换座位（走面板的 change 事件，面板与视角预设一起同步） */
  setSeat(seat: Seat): void;
  /** 回到飞机之后（状态已恢复）：main.ts 在这里让导演按恢复后的位置重新接入航线网（连续航程开着时） */
  afterExit?(): void;
}

interface PlaneSnapshot {
  preset: Preset;
  lat0: number;
  lon0: number;
  offset: THREE.Vector2;
  altitudeKm: number;
  targetAltKm: number;
  heading: number;
  pitchDeg: number;
  bankDeg: number;
  rollDeg: number;
  seat: Seat;
  altRateKms?: number;
}

export class RailMode {
  active = false;
  loading = false;
  /** 面板上「交通工具」旁边的状态文字（加载中 / 失败原因） */
  status = "";
  /** 状态变了（进入 / 退出 / 加载完成 / 失败）时回调，ui.ts 用来同步面板 */
  onChange: (() => void) | null = null;
  data: RailData | null = null;
  corridor: Corridor | null = null;
  train: Train | null = null;
  enu: EnuFrame | null = null;
  /** 最近一帧的姿态（调试、后续任务读） */
  pose: TrainPose | null = null;
  /** 舱内头部这一帧的上下晃动（米），main.ts 加到 uHead.y 上（代替飞机的颠簸） */
  headBump = 0;
  /** 近处地面标高（米，国土地理院）与基准差（国土地理院 − clipmap 地形，米）：火车远景用（TR03），信息栏也显示 */
  nearGroundM = NaN;
  terrainOffsetM = 0;
  private readonly host: RailHost;
  private snapshot: PlaneSnapshot | null = null;
  private loadPromise: Promise<void> | null = null;
  /** 加载线路数据的过程中用户又切回了飞机：加载完不进入火车 */
  private cancelled = false;
  /** 上一次在火车里坐的座位（再次进入时沿用）；null = 还没进过，按北阿尔卑斯一侧 */
  private trainSeat: Seat | null = null;
  private readonly prevLocal = new THREE.Vector2();
  private readonly preset: Preset = {
    id: "rail-oito",
    name: "火车：JR 大糸线 松本 → 信濃大町（示例）",
    lat: 36.2307,
    lon: 137.9644,
    heading: 0,
    tz: 9,
    islands: 0,
    land: true,
    haze: 1,
  };

  constructor(host: RailHost) {
    this.host = host;
  }

  private changed() {
    this.onChange?.();
  }

  /** 第一次切到火车时才拉线路数据（约 2.7 MB） */
  ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loading = true;
      this.status = "（加载线路数据…）";
      this.changed();
      // 构造 Corridor / Train 也放进同一条 Promise 链：数据能下载、但格式不对时也走失败分支（面板显示原因），不会一直「加载中」
      this.loadPromise = loadRailData(RAIL_LINE_ID).then(
        (data) => {
          this.useData(data);
          this.loading = false;
          this.status = "";
        },
      ).catch(
        (err: unknown) => {
          this.loading = false;
          this.loadPromise = null; // 下次切换再试
          this.status = `（线路数据加载失败：${err instanceof Error ? err.message : String(err)}）`;
          console.warn("火车线路数据加载失败", err);
          this.changed();
          throw err;
        },
      );
    }
    return this.loadPromise;
  }

  /** 用已经解析好的线路数据初始化（loadRailData 之后调用；node 单测直接调它，不走 fetch） */
  useData(data: RailData) {
    const corridor = new Corridor(data);
    this.data = data;
    this.corridor = corridor;
    this.enu = new EnuFrame(data.meta.format.crs.originLat, data.meta.format.crs.originLon);
    this.train = new Train(corridor, { s: DEFAULT_START_S, dir: 1 });
    this.preset.lat = data.meta.format.crs.originLat;
    this.preset.lon = data.meta.format.crs.originLon;
    this.loadPromise ??= Promise.resolve();
  }

  /** 面板「交通工具」切换 */
  async setVehicle(v: "plane" | "train") {
    if (v === "train") {
      this.cancelled = false;
      await this.enter().catch(() => undefined);
    } else {
      this.cancelled = true; // 还在加载时切回飞机：加载完也不进入
      this.exit();
    }
  }

  /**
   * 进入火车模式：记下飞机的状态，clipmap 原点换到松本站。
   * 不给 startS：列车从上次离开时的状态继续（位置、方向、车速、停站剩余时间都不变，座位沿用上次在火车里的）；
   * 给 startS：放到那里（dir 默认往信濃大町），座位换到北阿尔卑斯一侧。
   */
  async enter(startS?: number, dir?: 1 | -1) {
    await this.ensureLoaded();
    if (this.active || this.cancelled) {
      this.cancelled = false;
      this.changed();
      return;
    }
    const { state, ground, cloudOffset } = this.host;
    this.snapshot = {
      preset: state.preset,
      lat0: ground.localFrame.lat0,
      lon0: ground.localFrame.lon0,
      offset: cloudOffset.clone(),
      altitudeKm: state.altitudeKm,
      targetAltKm: state.targetAltKm,
      heading: state.heading,
      pitchDeg: state.pitchDeg,
      bankDeg: state.bankDeg,
      rollDeg: state.rollDeg,
      seat: state.seat,
      altRateKms: state.altRateKms,
    };
    this.active = true;
    state.preset = this.preset;
    state.bankDeg = 0;
    // 高度下限是飞机的概念（main.ts 在火车模式下不再更新它）：清掉，免得信息栏按旧地点的地形算「离地」
    state.floor = undefined;
    ground.waterwayMaxM = RAIL_WATERWAY_MAX_M;
    ground.reset(this.preset.lat, this.preset.lon);
    const train = this.train!;
    // 北阿尔卑斯在线路西侧：往信濃大町（北）走时是左座，往松本走时是右座
    const alpsSide = (d: 1 | -1): Seat => (d > 0 ? "left" : "right");
    if (startS !== undefined) {
      this.host.setSeat(alpsSide(dir ?? 1));
      this.teleport(startS, dir ?? 1);
    } else {
      this.host.setSeat(this.trainSeat ?? alpsSide(train.dir));
      this.applyPose(true, 0);
      this.host.snapAll();
    }
    this.host.syncTimeUi();
    this.changed();
  }

  /** 回到飞机：恢复进入火车模式前的地点、位置、高度、姿态、座位 */
  exit() {
    if (!this.active) return;
    this.active = false;
    const snap = this.snapshot!;
    const { state, ground, cloudOffset } = this.host;
    state.preset = snap.preset;
    ground.waterwayMaxM = Infinity;
    ground.reset(snap.lat0, snap.lon0);
    cloudOffset.copy(snap.offset);
    state.altitudeKm = snap.altitudeKm;
    state.targetAltKm = snap.targetAltKm;
    state.heading = snap.heading;
    state.pitchDeg = snap.pitchDeg;
    state.bankDeg = snap.bankDeg;
    state.rollDeg = snap.rollDeg;
    state.altRateKms = snap.altRateKms;
    // 地面数据按旧原点重建：下限先按预设估计，数据到了再按实际地形（和换预设同一套逻辑）
    resetAltitudeFloor(state);
    this.trainSeat = state.seat;
    this.host.setSeat(snap.seat);
    this.headBump = 0;
    this.snapshot = null;
    this.host.snapAll();
    this.host.syncTimeUi();
    this.host.afterExit?.();
    this.changed();
  }

  /** 调试 / 截图：把列车放到里程 s（米）、方向 dir，按该处允许的速度行驶 */
  teleport(s: number, dir: 1 | -1 = 1, speedKmh?: number) {
    if (!this.train) return;
    this.train.teleport(s, dir, speedKmh === undefined ? undefined : speedKmh / 3.6);
    this.applyPose(true, 0);
    this.host.snapAll();
  }

  /** 每帧（代替 stepFlight）：推进列车 simDt 模拟秒，把姿态写进 state / uCloudOffset，返回和 stepFlight 同形的结果 */
  step(simDt: number): AdvanceFlightResult {
    this.train!.update(simDt);
    // 导演在火车模式下不接管，但背景板模式（B 键）会顺手打开连续航程、把地点换成航段预设：这里改回线路预设
    if (this.host.state.preset !== this.preset) this.host.state.preset = this.preset;
    const moved = this.applyPose(false, simDt);
    const h = THREE.MathUtils.degToRad(this.host.state.heading);
    const seatSign = this.host.state.seat === "right" ? 1 : -1;
    return {
      climbing: false,
      motion: new THREE.Vector3(moved.x, 0, moved.y),
      ownDir: new THREE.Vector3(Math.sin(h), 0, -Math.cos(h)),
      outwardW: new THREE.Vector3(Math.cos(h), 0, Math.sin(h)).multiplyScalar(seatSign),
      speedKms: this.train!.speed / 1000,
    };
  }

  /** 姿态 → state / uCloudOffset。返回这一帧在本地坐标里的水平位移（km） */
  private applyPose(snap: boolean, dt: number): THREE.Vector2 {
    const { state, ground, cloudOffset } = this.host;
    const pose = this.train!.pose(state.seat);
    this.pose = pose;
    const enu = this.enu!;
    const frame = ground.localFrame;
    const [lat, lon] = enu.inv(pose.eye[0], pose.eye[1]);
    const [lx, lz] = frame.toLocal(lat, lon);
    // 航向在 clipmap 的本地坐标里量（和影像对齐）：眼睛前方 20 m 的点换算过去再求方位
    const [aLat, aLon] = enu.inv(pose.eye[0] + pose.forward[0] * 20, pose.eye[1] + pose.forward[1] * 20);
    const [ax, az] = frame.toLocal(aLat, aLon);
    state.heading = ((THREE.MathUtils.radToDeg(Math.atan2(ax - lx, -(az - lz))) % 360) + 360) % 360;
    state.pitchDeg = THREE.MathUtils.radToDeg(pose.pitch);
    state.rollDeg = THREE.MathUtils.radToDeg(pose.roll);
    state.bankDeg = 0;
    // 高度：眼睛标高（国土地理院轨面 + 眼高），不按 clipmap 地形抬（TR03，见文件头）
    state.altitudeKm = pose.eye[2] / 1000;
    state.targetAltKm = state.altitudeKm;
    this.updateFarView(pose, snap, dt);
    this.headBump = pose.vibration.heave * HEAD_BUMP_RATIO;
    const moved = snap ? new THREE.Vector2() : new THREE.Vector2(lx - this.prevLocal.x, lz - this.prevLocal.y);
    this.prevLocal.set(lx, lz);
    cloudOffset.set(lx, lz);
    return moved;
  }

  /**
   * 火车远景（TR03）的 uniform：相机海拔（精确值，着色器里不再用 6360 + 海拔 的 float32）、近处地面标高、基准差。
   * 近处地面按窗侧取（看出去的那一侧），前后 ±20 m 平均，按 0.5 s 的时间常数跟上（网格 10 m 一格，免得一格一跳）。
   */
  private updateFarView(pose: TrainPose, snap: boolean, dt: number) {
    const c = this.corridor!;
    const { s, d } = pose.eyeCorridor;
    const side = d >= 0 ? 1 : -1;
    const eyeM = pose.eye[2];
    let sum = 0, n = 0;
    for (const ds of NEAR_GROUND_S) {
      for (const dd of NEAR_GROUND_D) {
        const z = c.groundZ(s + ds, side * dd);
        if (z !== null) {
          sum += z;
          n++;
        }
      }
    }
    const railZ = c.position(s)[2];
    const near = Math.min(n > 0 ? sum / n : railZ, eyeM - NEAR_GROUND_BELOW_EYE_M);
    if (snap || !Number.isFinite(this.nearGroundM)) this.nearGroundM = near;
    else this.nearGroundM = Math.min(this.nearGroundM + (near - this.nearGroundM) * (1 - Math.exp(-dt / 0.5)), eyeM - NEAR_GROUND_BELOW_EYE_M);
    // 基准差：国土地理院网格 − clipmap 地形（CPU 侧的 heightAt 是最细可用一级的双线性，和着色器近处用的同一级）
    const { ground } = this.host;
    const enu = this.enu!;
    const frame = ground.localFrame;
    const diffs: number[] = [];
    if (this.host.state.groundOn) {
      for (const ds of OFFSET_S) {
        for (const dd of OFFSET_D) {
          const zG = c.groundZ(s + ds, dd);
          if (zG === null) continue;
          const [x, y] = c.toEnu(s + ds, dd);
          const [lat, lon] = enu.inv(x, y);
          const [lx, lz] = frame.toLocal(lat, lon);
          const hKm = ground.heightAt(lx, lz);
          if (hKm !== null) diffs.push(zG - hKm * 1000);
        }
      }
    }
    if (diffs.length >= 4) {
      diffs.sort((a, b) => a - b);
      const mid = diffs.length >> 1;
      let off = diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
      if (Math.abs(off) > OFFSET_MAX_M) off = 0;
      this.terrainOffsetM += (off - this.terrainOffsetM) * (snap ? 1 : 1 - Math.exp(-dt / 2));
    }
    railFarUniforms.uRailCamAltKm.value = eyeM / 1000;
    railFarUniforms.uRailNearGroundKm.value = this.nearGroundM / 1000;
    railFarUniforms.uRailTerrOffsetKm.value = this.terrainOffsetM / 1000;
  }

  /** 信息栏的一行 */
  describe(): string {
    const p = this.pose, t = this.train, c = this.corridor;
    if (!this.active || !p || !t || !c) return "";
    const next = c.nextStation(p.s, p.dir);
    const k = c.curvatureAvg(p.s);
    const grade = c.sample(p.s).grade * p.dir;
    const parts = [
      `火车：JR 大糸线（示例）${p.dir > 0 ? "往信濃大町" : "往松本"}`,
      `里程 ${(p.s / 1000).toFixed(2)} km`,
      p.dwell > 0 ? `停站 ${Math.ceil(p.dwell)} s` : `${(p.speed * 3.6).toFixed(0)} km/h（巡航 ${CRUISE_KMH}）`,
      next ? `前方 ${next.name} ${(Math.abs(next.s - p.s) / 1000).toFixed(1)} km` : "终点",
      `坡度 ${grade >= 0 ? "+" : ""}${grade.toFixed(1)}‰`,
      Math.abs(k) > 1 / 4000 ? `半径约 ${Math.round(1 / Math.abs(k))} m，超高 ${Math.abs(p.cantMm).toFixed(0)} mm（估）` : "直线",
    ];
    if (Math.abs(this.terrainOffsetM) > 0.5) parts.push(`远景地形按国土地理院校正 ${this.terrainOffsetM > 0 ? "+" : ""}${this.terrainOffsetM.toFixed(1)} m`);
    return parts.join("，");
  }
}
