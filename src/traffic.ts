import * as THREE from "three";

/**
 * 远处路过的飞机：相对我们做匀速直线运动，飞出 90 km 就在前方重新生成一架。
 * 高度差按 RVSM 垂直间隔取 ±300 / ±600 m（1000 / 2000 ft），航向随机（对飞、交叉、同向超越都有）。
 * 位置、速度都在窗外坐标（km，x 东、y 上、z 南）里，相对我们这架飞机。
 */

interface Plane {
  pos: THREE.Vector3; // 相对位置（km）
  dir: THREE.Vector3; // 航向单位向量
  speed: number; // km/s
  active: boolean;
  respawnIn: number; // 秒
}

const SEPARATIONS = [-0.6, -0.3, 0.3, 0.6];

export class Traffic {
  readonly planes: Plane[] = [0, 1].map((i) => ({
    pos: new THREE.Vector3(),
    dir: new THREE.Vector3(1, 0, 0),
    speed: 0.23,
    active: false,
    respawnIn: 5 + i * 40,
  }));

  /** 立即在视野附近生成一架（调试 / 截图用） */
  spawnNear(ownDir: THREE.Vector3, outward: THREE.Vector3, index = 0) {
    const p = this.planes[index];
    // 在窗外 25 km 处，从前往后横穿
    p.pos.copy(outward).multiplyScalar(25).addScaledVector(ownDir, 30);
    p.pos.y = SEPARATIONS[Math.floor(Math.random() * SEPARATIONS.length)];
    p.dir.copy(ownDir).negate().addScaledVector(outward, 0.3).normalize();
    p.speed = 0.22 + Math.random() * 0.03;
    p.active = true;
  }

  update(dt: number, ownDir: THREE.Vector3, ownSpeed: number, outward: THREE.Vector3) {
    for (const p of this.planes) {
      if (!p.active) {
        p.respawnIn -= dt;
        if (p.respawnIn <= 0) this.spawn(p, ownDir, outward);
        continue;
      }
      // 相对速度 = 它的速度 − 我们的速度
      p.pos.addScaledVector(p.dir, p.speed * dt).addScaledVector(ownDir, -ownSpeed * dt);
      const horiz = Math.hypot(p.pos.x, p.pos.z);
      if (horiz > 90) {
        p.active = false;
        p.respawnIn = 60 + Math.random() * 180;
      }
    }
  }

  private spawn(p: Plane, ownDir: THREE.Vector3, outward: THREE.Vector3) {
    // 在窗户这一侧的前方远处出现，保证会从窗前经过
    const ahead = 40 + Math.random() * 30;
    const side = 8 + Math.random() * 40;
    p.pos.copy(ownDir).multiplyScalar(ahead).addScaledVector(outward, side);
    p.pos.y = SEPARATIONS[Math.floor(Math.random() * SEPARATIONS.length)];
    const ang = (Math.random() - 0.5) * 1.2;
    // 大多是对飞（航向和我们相反，稍有交叉角）
    p.dir.copy(ownDir).negate().applyAxisAngle(new THREE.Vector3(0, 1, 0), ang).normalize();
    p.speed = 0.21 + Math.random() * 0.05;
    p.active = true;
  }
}
