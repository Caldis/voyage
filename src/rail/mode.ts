import * as THREE from "three";
import type { GroundClipmap } from "../ground/clipmap";
import { resetAltitudeFloor, type AdvanceFlightResult } from "../flight";
import type { AltitudeFloor, Preset, VoyageState } from "../state";
import { Corridor } from "./corridor";
import { loadRailData, type RailData } from "./data";
import { EnuFrame } from "./geodesy";
import { CRUISE_KMH, Train, type Seat, type TrainPose } from "./train";

/**
 * 火车模式（TR02）：把 Train 的姿态接到 voyage 现有的相机、时间、天气系统上。
 *
 * - 位置：眼睛的 ENU → 真实经纬度（geodesy.ts）→ 地面 clipmap 的 LocalFrame 本地公里坐标，写进 uCloudOffset（和飞机一样）。
 *   进入火车模式时 clipmap 的原点换到松本站（线路 ENU 的切点），退出时恢复飞机当时的原点和位置。
 * - 高度：state.altitudeKm = 眼睛的标高（国土地理院 DEM 推出的轨面 + 2.5 m）。窗外程序只认 clipmap 的地形（AWS Terrain），
 *   两套高程有米级差异；眼睛如果落到 clipmap 地形以下，窗外会整片是地面，所以按 clipmap 的地形抬到至少离地 MIN_CLEARANCE_M（抬了多少写在信息栏）。
 * - 朝向：航向 / 俯仰 / 滚转直接写进 state.heading / pitchDeg / rollDeg，main.ts 的 cabinToWorld 照常用（bankDeg 置 0）。
 * - 机翼：不改着色器，把 uWingRootLE 设成身后 10 km（RAIL_WING_ROOT_LE），机翼和翼尖灯都在视野外。
 * - 舱内仍是飞机舷窗（TR06 才做车厢）；近景 / 中景还没有（TR04 / TR05），窗外只有现有窗外程序在贴地相机下的效果。
 */

export const RAIL_LINE_ID = "oito-matsumoto-shinanoomachi";
/** 火车模式下机翼挪到身后 10 km（米）：不改任何着色器就把机翼、翼尖灯移出视野 */
export const RAIL_WING_ROOT_LE = -1e4;
/** 眼睛离 clipmap 地形的最小高度（米）：低于它就抬（见文件头） */
const MIN_CLEARANCE_M = 1.5;
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
  floor?: AltitudeFloor;
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
  /** 眼睛为了不落到 clipmap 地形以下被抬高了多少（米） */
  groundLiftM = 0;
  private readonly host: RailHost;
  private snapshot: PlaneSnapshot | null = null;
  private loadPromise: Promise<void> | null = null;
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
      this.loadPromise = loadRailData(RAIL_LINE_ID).then(
        (data) => {
          this.data = data;
          this.corridor = new Corridor(data);
          this.enu = new EnuFrame(data.meta.format.crs.originLat, data.meta.format.crs.originLon);
          this.train = new Train(this.corridor, { s: DEFAULT_START_S, dir: 1 });
          this.preset.lat = data.meta.format.crs.originLat;
          this.preset.lon = data.meta.format.crs.originLon;
          this.loading = false;
          this.status = "";
        },
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

  /** 面板「交通工具」切换 */
  async setVehicle(v: "plane" | "train") {
    if (v === "train") await this.enter().catch(() => undefined);
    else this.exit();
  }

  /** 进入火车模式：记下飞机的状态，clipmap 原点换到松本站，列车从 startS 起步（默认已在巡航） */
  async enter(startS?: number, dir: 1 | -1 = 1) {
    await this.ensureLoaded();
    if (this.active) return;
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
      floor: state.floor,
      altRateKms: state.altRateKms,
    };
    this.active = true;
    state.preset = this.preset;
    state.bankDeg = 0;
    ground.reset(this.preset.lat, this.preset.lon);
    // 默认坐在北阿尔卑斯一侧：往信濃大町（北）走时是左侧
    this.host.setSeat(dir > 0 ? "left" : "right");
    this.teleport(startS ?? this.train!.s, dir);
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
    ground.reset(snap.lat0, snap.lon0);
    cloudOffset.copy(snap.offset);
    state.altitudeKm = snap.altitudeKm;
    state.targetAltKm = snap.targetAltKm;
    state.heading = snap.heading;
    state.pitchDeg = snap.pitchDeg;
    state.bankDeg = snap.bankDeg;
    state.rollDeg = snap.rollDeg;
    state.altRateKms = snap.altRateKms;
    state.floor = snap.floor;
    // 地面数据按旧原点重建：下限先按预设估计，数据到了再按实际地形（和换预设同一套逻辑）
    resetAltitudeFloor(state);
    this.host.setSeat(snap.seat);
    this.headBump = 0;
    this.snapshot = null;
    this.host.snapAll();
    this.host.syncTimeUi();
    this.changed();
  }

  /** 调试 / 截图：把列车放到里程 s（米）、方向 dir，按该处允许的速度行驶 */
  teleport(s: number, dir: 1 | -1 = 1, speedKmh?: number) {
    if (!this.train) return;
    this.train.teleport(s, dir, speedKmh === undefined ? undefined : speedKmh / 3.6);
    this.groundLiftM = 0;
    this.applyPose(true);
    this.host.snapAll();
  }

  /** 每帧（代替 stepFlight）：推进列车 simDt 模拟秒，把姿态写进 state / uCloudOffset，返回和 stepFlight 同形的结果 */
  step(simDt: number): AdvanceFlightResult {
    this.train!.update(simDt);
    const moved = this.applyPose(false);
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
  private applyPose(snap: boolean): THREE.Vector2 {
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
    // 高度：眼睛标高；落到 clipmap 地形以下时抬起来（立刻抬，慢慢放下，免得地形级别切换时上下跳）
    const gKm = state.groundOn ? ground.heightAt(lx, lz) : null;
    const need = gKm === null ? 0 : Math.max(0, gKm * 1000 + MIN_CLEARANCE_M - pose.eye[2]);
    this.groundLiftM = need > this.groundLiftM ? need : this.groundLiftM + (need - this.groundLiftM) * 0.02;
    state.altitudeKm = (pose.eye[2] + this.groundLiftM) / 1000;
    state.targetAltKm = state.altitudeKm;
    this.headBump = pose.vibration.heave * HEAD_BUMP_RATIO;
    const moved = snap ? new THREE.Vector2() : new THREE.Vector2(lx - this.prevLocal.x, lz - this.prevLocal.y);
    this.prevLocal.set(lx, lz);
    cloudOffset.set(lx, lz);
    return moved;
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
    if (this.groundLiftM > 0.1) parts.push(`眼高按地面瓦片抬了 ${this.groundLiftM.toFixed(1)} m`);
    return parts.join("，");
  }
}
