import * as THREE from "three";

/**
 * 远处路过的飞机：相对我们做匀速直线运动，飞出 90 km 就在前方重新生成一架。
 * 高度差按 RVSM 垂直间隔取 ±300 / ±600 m（1000 / 2000 ft）。
 *
 * T40（用户反馈插单）：机体是预算限制下的一个简化实心球（见 traffic.glsl.ts 的 `trafficRadiance`），
 * 一旦飞得足够近、角尺寸变大，「其实是个球」的破绽就藏不住了；旧版航向带 ±0.6 rad（约 ±34°）的随机
 * 交叉角，横向距离下限只有 8 km，经常斜穿我们的航迹、在近处横过窗前，两架飞机的航迹也可能互相交叉。
 *
 * 现在按下面两条原则重新设计航线（另见 traffic.glsl.ts 里对应的像素尺寸兜底）：
 *
 * 1) 最小距离推算：1600×1200、默认视场（render/scene.ts 的 `uTanHalfFov = tan(25°)`，即垂直半视场 25°）下，
 *    一个像素的张角 pixelAngle = 2·tan(25°) / 1200 ≈ 7.77e-4 rad。机体按约 40 m 机长建模
 *    （traffic.glsl.ts 的 `size = 0.02 / dist`，0.02 km 是半径），角直径(px) = (0.04/dist) / pixelAngle
 *    ≈ 51.5 / dist(km)。要求机体角直径全程 ≤ 约 3 px（用户建议的上限区间 2–3 px），
 *    需要 dist ≥ 51.5/3 ≈ 17.2 km；取整加一点余量，MIN_DIST_KM = 18 km（对应约 2.9 px）。
 * 2) 航线设计：来往飞机与我们走近似平行的航路——对飞时只给 ≤3° 的交叉角（MAX_CROSS_ANGLE），
 *    同向慢慢超越时干脆不给交叉角（原因见下）。出生时的横向距离（沿 outward 方向）不是随便选的：
 *    交叉角最多让飞机在出生距离以内（AHEAD_RANGE 的上限）积累 AHEAD_RANGE[1]·sin(MAX_CROSS_ANGLE)
 *    的最坏侧向漂移，所以横向距离下限 = MIN_DIST_KM + 这段漂移量，全程（含它拖出的航迹云——航迹云
 *    就在同一条直线上）离我们的最近距离依然 ≥ MIN_DIST_KM。
 *    同向超越的交叉角强制为 0：这类相遇的相对速度本来就很小（慢慢超越），哪怕给一点点交叉角，
 *    经过的时间也长得多，侧向漂移会失控地累积，所以直接不给交叉角（横向距离恒定，最安全）。
 * 3) 两机不交叉：把横向距离分成两条不重叠的「车道」（LANES），车道之间留了 ≥ 2×最坏漂移的间隙，
 *    保证两条车道的可能范围全程不重叠；spawn() 里两架飞机不会分到同一条车道（sibling 在飞就取补集）。
 *
 * 用 scripts/traffic-sample.mjs（离线，不开浏览器）抽样 1 万次 spawn() 全程模拟验证过这套设计
 * （结果见 apps/voyage/handoff/T40.md）。
 */

interface Plane {
  pos: THREE.Vector3; // 相对位置（km）
  dir: THREE.Vector3; // 航向单位向量
  speed: number; // km/s
  active: boolean;
  respawnIn: number; // 秒
  lane: number; // 当前占用的车道下标（0/1），未激活时为 -1；只在 spawn() 里用来避免两架飞机分到同一车道
}

const SEPARATIONS = [-0.6, -0.3, 0.3, 0.6];
const UP = new THREE.Vector3(0, 1, 0);

/** 见文件头「最小距离推算」：1600×1200、默认视场下机体角直径 ≤ 约 3 px 对应的最小距离（km）。 */
const MIN_DIST_KM = 18;
/** 对飞时允许的最大交叉角（同向超越强制为 0，见文件头）。 */
const MAX_CROSS_ANGLE = THREE.MathUtils.degToRad(3);
/** 出生时沿 ownDir 方向的距离范围（km，取绝对值；同向超越出生在后方，即取负号）。 */
const AHEAD_RANGE: [number, number] = [30, 65];
/** 交叉角造成的最坏侧向漂移（沿全程最长的出生距离算，km）。 */
const MAX_DRIFT_KM = AHEAD_RANGE[1] * Math.sin(MAX_CROSS_ANGLE);
/** 与 update() 的失效半径一致：出生时也要留在这个半径以内，否则一生成就被判出局，白白浪费一次生成。 */
const VISIBLE_RADIUS_KM = 90;

/**
 * 两条车道的横向距离范围（km）。
 * 车道 0 的下限 = MIN_DIST_KM + 最坏漂移（+0.5 兜底浮点误差）；
 * 车道 1 的下限比「车道 0 的出生上限 + 最坏漂移」再留 2×最坏漂移 + 8 km 的间隙，
 * 保证两条车道全程（含交叉角造成的漂移）不重叠，也就不会交叉；
 * 车道 1 的上限按 VISIBLE_RADIUS_KM 和 AHEAD_RANGE 的最大值反推，保证出生时仍在可见半径内。
 */
const LANES: { min: number; max: number }[] = (() => {
  const lane0Min = MIN_DIST_KM + MAX_DRIFT_KM + 0.5;
  const lane0Max = lane0Min + 12;
  const gap = 2 * MAX_DRIFT_KM + 8;
  const lane1Min = lane0Max + gap;
  const lane1MaxVisible = Math.sqrt(VISIBLE_RADIUS_KM ** 2 - AHEAD_RANGE[1] ** 2) - 1;
  const lane1Max = Math.max(lane1Min + 4, lane1MaxVisible);
  return [
    { min: lane0Min, max: lane0Max },
    { min: lane1Min, max: lane1Max },
  ];
})();

export class Traffic {
  readonly planes: Plane[] = [0, 1].map((i) => ({
    pos: new THREE.Vector3(),
    dir: new THREE.Vector3(1, 0, 0),
    speed: 0.23,
    active: false,
    respawnIn: 5 + i * 40,
    lane: -1,
  }));

  /**
   * 立即在视野附近生成一架（调试 / 截图用）。默认按 MIN_DIST_KM 贴着「这个出生距离下允许的
   * 最小横向距离」放置，方便截图验证最近点时刻的观感，遵守和 spawn() 一样的最小距离。
   * `opts.sideKm` 显式传入更小的值可以刻意压近做压力测试（验证着色器按像素尺寸淡出的兜底），
   * 仅供调试用，正常游戏内的 spawn() 不会产生这么近的情况。
   */
  spawnNear(ownDir: THREE.Vector3, outward: THREE.Vector3, index = 0, opts?: { aheadKm?: number; sideKm?: number }) {
    const p = this.planes[index];
    const aheadAbs = opts?.aheadKm ?? 18;
    const minSide = MIN_DIST_KM + aheadAbs * Math.sin(MAX_CROSS_ANGLE);
    const side = opts?.sideKm ?? minSide;
    p.pos.copy(outward).multiplyScalar(side).addScaledVector(ownDir, aheadAbs);
    p.pos.y = SEPARATIONS[Math.floor(Math.random() * SEPARATIONS.length)];
    const ang = (Math.random() * 2 - 1) * MAX_CROSS_ANGLE;
    p.dir.copy(ownDir).negate().applyAxisAngle(UP, ang).normalize();
    p.speed = 0.22 + Math.random() * 0.03;
    p.lane = -1; // 调试生成不参与「两机不同车道」的簿记
    p.active = true;
  }

  update(dt: number, ownDir: THREE.Vector3, ownSpeed: number, outward: THREE.Vector3) {
    for (let i = 0; i < this.planes.length; i++) {
      const p = this.planes[i];
      if (!p.active) {
        p.respawnIn -= dt;
        if (p.respawnIn <= 0) this.spawn(p, this.planes[1 - i], ownDir, ownSpeed, outward);
        continue;
      }
      // 相对速度 = 它的速度 − 我们的速度
      p.pos.addScaledVector(p.dir, p.speed * dt).addScaledVector(ownDir, -ownSpeed * dt);
      const horiz = Math.hypot(p.pos.x, p.pos.z);
      if (horiz > VISIBLE_RADIUS_KM) {
        p.active = false;
        p.lane = -1;
        p.respawnIn = 60 + Math.random() * 180;
      }
    }
  }

  private spawn(p: Plane, sibling: Plane, ownDir: THREE.Vector3, ownSpeed: number, outward: THREE.Vector3) {
    // 两架飞机不分到同一车道：另一架在飞就取补集车道，否则随机挑一条（车道之间留了间隙，见文件头）。
    const laneIdx = sibling.active ? 1 - sibling.lane : Math.random() < 0.5 ? 0 : 1;
    const lane = LANES[laneIdx];
    const side = lane.min + Math.random() * (lane.max - lane.min);

    const overtake = Math.random() < 0.22; // 偶尔同向慢慢超越
    const aheadAbs = AHEAD_RANGE[0] + Math.random() * (AHEAD_RANGE[1] - AHEAD_RANGE[0]);
    const ahead = overtake ? -aheadAbs : aheadAbs; // 超越：出生在后方，靠速度差慢慢追上来

    p.pos.copy(ownDir).multiplyScalar(ahead).addScaledVector(outward, side);
    p.pos.y = SEPARATIONS[Math.floor(Math.random() * SEPARATIONS.length)];

    if (overtake) {
      // 同向：完全不给交叉角（原因见文件头），横向距离恒定 = side，全程 ≥ lane.min ≥ MIN_DIST_KM。
      p.dir.copy(ownDir);
      p.speed = Math.max(0.06, ownSpeed + 0.01 + Math.random() * 0.03);
    } else {
      // 对飞：≤3° 的交叉角，出生距离已经按 AHEAD_RANGE[1] 的最坏情况扣掉了漂移量。
      const ang = (Math.random() * 2 - 1) * MAX_CROSS_ANGLE;
      p.dir.copy(ownDir).negate().applyAxisAngle(UP, ang).normalize();
      p.speed = 0.21 + Math.random() * 0.05;
    }
    p.lane = laneIdx;
    p.active = true;
  }
}
