import * as THREE from "three";
import type { Atmosphere } from "./luts";
import type { GroundClipmap } from "../ground/clipmap";
import type { VoyageState } from "../state";

/**
 * 低空的真实遮挡（T18）：边界层霾 + 清晨谷地辐射雾。
 *
 * 边界层霾（进大气 LUT，见 common.glsl.ts 的 hazeExtinction）：
 *   白天地面受热，对流把地面附近的气溶胶（尘、硫酸盐、海盐、水汽凝结核）均匀地搅进「混合层」，
 *   混合层顶有逆温层压着，气溶胶上不去——从高处看，霾顶是一条清楚的「霾线」，线以上的天空明显更蓝更透。
 *   - 混合层顶（离地）：陆地上夜里 / 清晨留着前一天的残留层约 1.1 km，上午 9 点起随地面加热长高，午后约 1.8 km，
 *     入夜后慢慢塌回去（Stull 1988《An Introduction to Boundary Layer Meteorology》的日变化示意）；
 *     海面上是海洋边界层，约 0.7 km，没有明显日变化。
 *   - 消光：地面能见度 V 与 550 nm 消光系数 β 的关系 β = 3.912 / V（Koschmieder）。日本晴天 V 约 30–40 km → β ≈ 0.1 /km；
 *     华东平原 V 约 10–15 km；海上 V 约 60–90 km → β ≈ 0.05 /km。清晨湿度大，吸湿增长让霾更浓（×1.5）。
 *     混合层里气溶胶混得较匀，只随高度缓降（标高 2.5 km），到霾顶在约 ±80 m 的过渡层内消失。
 *   - 光谱：Ångström 指数 α（陆地约 1.2，海盐约 0.5），β(λ) ∝ λ^−α；单次散射反照率陆地 0.93、海上 0.98，陆地按通道略倾斜
 *     （黑碳 / 棕碳在短波吸收多，霾偏棕灰，浑浊地区更明显）；相函数 Cornette-Shanks g = 0.7（比背景米氏的 0.8 侧向散射多，侧光下霾是亮灰白）。
 *   - 每天的浓淡按日期随机（×0.7–1.4），今天和明天不一样（随机性造就真实）。
 *   注意：LUT 以相机为中心、球对称，霾只随海拔变化，不随地点变化；陆地 / 海面的参数按飞机周围 40 km 的陆地比例插值。
 *
 * 清晨谷地辐射雾（进场景着色器，见 render/haze.glsl.ts 的 hazeValleyFog）：晴朗无风的夜里地面辐射降温，冷空气沿坡流进谷底，
 * 到清晨谷里积满雾、山脊露在外面；日出后几小时随地面加热从边缘消散。强度按「上午、太阳高度 < 约 20°、陆地、云量不大、这天有雾」给。
 */

/** 霾与雾的当前参数（调试 / 截图时可以用 override 覆盖） */
export interface HazeParams {
  /** 霾底处 550 nm 消光系数（1/km） */
  beta: number;
  /** 霾顶海拔（km） */
  topKm: number;
  /** 霾底海拔（km）：地区陆地平均高度 */
  baseKm: number;
  /** 霾内标高（km） */
  scaleKm: number;
  /** 霾顶过渡层半厚（km） */
  edgeKm: number;
  /** 单次散射反照率 */
  ssa: number;
  /** Ångström 指数 */
  alpha: number;
  /** 单次散射反照率的波长倾斜（红 +、蓝 −；吸收型气溶胶让霾偏棕黄） */
  absTilt: number;
  /** 谷地雾强度 0..1 */
  valleyFog: number;
}

export interface HazeInput {
  state: VoyageState;
  ground: GroundClipmap;
  /** 飞机的本地坐标（km，uCloudOffset） */
  x: number;
  z: number;
  /** 当前经度（算地方太阳时） */
  lon: number;
  /** 太阳高度角（度） */
  sunAltDeg: number;
  /** 层状云云量 0..1（cloudUniforms.uCoverage） */
  coverage: number;
  dt: number;
}

const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export class HazeModel {
  /** 场景着色器要的 uniform（render/haze.glsl.ts 声明）：Object.assign 进场景材质 */
  readonly sceneUniforms = {
    // x 强度 0..1，y 谷底下沉量（km，越小雾积得越高），z 平原雾块的强度，w 保留
    uValleyFog: { value: new THREE.Vector4(0, 0.3, 0, 0) },
  };
  /** 调试 / 截图：设了的字段直接覆盖模型给的值（例如 { valleyFog: 1 }、{ beta: 0 } 关掉霾） */
  override: Partial<HazeParams> = {};
  /** 最近一次的参数（给面板 / 调试看） */
  current: HazeParams = { beta: 0, topKm: 1.5, baseKm: 0, scaleKm: 2.5, edgeKm: 0.08, ssa: 0.95, alpha: 1, absTilt: 0, valleyFog: 0 };
  /** 地区陆地比例、陆地平均高度：按时间平滑（飞过海岸线、数据刚到时不跳） */
  private land = -1;
  private landHeight = 0;
  private readonly haze = new THREE.Vector4();
  private readonly shape = new THREE.Vector4();

  constructor(private readonly atmosphere: Atmosphere) {}

  update(inp: HazeInput) {
    const { state, ground } = inp;
    // ---- 地区：40 km 内的陆地比例与陆地平均高度 ----
    let landNow = state.preset.land ? 1 : 0;
    let hNow = 0;
    if (state.groundOn) {
      const r = ground.regionStats(inp.x, inp.z, 40);
      if (r.known) {
        landNow = r.land;
        hNow = r.meanLandKm;
      }
    } else landNow = 0; // 关掉真实地理：只有海和示例岛屿
    if (this.land < 0) {
      this.land = landNow;
      this.landHeight = hNow;
    }
    const k = 1 - Math.exp(-inp.dt / 2);
    this.land += (landNow - this.land) * k;
    this.landHeight += (hNow - this.landHeight) * k;
    const landW = THREE.MathUtils.smoothstep(this.land, 0.1, 0.6);

    // ---- 时段：地方太阳时（不含时差方程，误差十几分钟以内） ----
    const utcH = ((state.simTime / 3.6e6) % 24 + 24) % 24;
    const hr = (((utcH + inp.lon / 15) % 24) + 24) % 24;
    // 混合层顶（离地，km）：残留层 1.1 → 午后 1.8 → 入夜塌回
    const hr4 = hr < 4 ? hr + 24 : hr; // 4 点前算作前一天的深夜
    const grow = THREE.MathUtils.smoothstep(hr4, 9, 15) * (1 - THREE.MathUtils.smoothstep(hr4, 19, 27));
    const topLand = 1.1 + 0.7 * grow;
    // 清晨湿度大：日出前后到上午 10 点霾更浓
    const morning = hr < 12 ? 1 - THREE.MathUtils.smoothstep(hr, 7, 11) : 0;
    // 每天不一样：按当地日期取随机数
    const day = Math.floor((state.simTime / 3.6e6 + inp.lon / 15) / 24);
    const dayK = 0.7 + 0.7 * hash(day);
    const region = state.preset.haze ?? 1;

    const betaLand = 0.13 * region * (1 + 0.5 * morning) * dayK;
    const betaSea = 0.045 * (0.8 + 0.4 * hash(day + 17));
    const baseKm = this.landHeight * 0.8 * landW;
    const p: HazeParams = {
      beta: THREE.MathUtils.lerp(betaSea, betaLand, landW),
      topKm: baseKm + THREE.MathUtils.lerp(0.7, topLand, landW),
      baseKm,
      scaleKm: THREE.MathUtils.lerp(1.5, 2.5, landW),
      edgeKm: THREE.MathUtils.lerp(0.06, 0.08 + 0.04 * grow, landW),
      ssa: THREE.MathUtils.lerp(0.98, 0.93, landW),
      alpha: THREE.MathUtils.lerp(0.5, 1.2, landW),
      // 陆地霾里有黑碳 / 棕碳，短波吸收多一点；浑浊地区（华东）更明显
      absTilt: landW * 0.02 * Math.min(region, 3),
      valleyFog: 0,
    };

    // ---- 谷地辐射雾：上午、太阳还低、陆地、夜里晴（云量小）、这天有雾（约七成的日子） ----
    const fogDay = hash(day + 5.3) < 0.7 ? 0.6 + 0.4 * hash(day + 9.1) : 0;
    const fogTime = hr < 12 && inp.sunAltDeg < 30 ? 1 - THREE.MathUtils.smoothstep(inp.sunAltDeg, 6, 24) : 0;
    const clear = 1 - THREE.MathUtils.smoothstep(inp.coverage, 0.5, 0.85);
    p.valleyFog = fogDay * fogTime * clear * (state.groundOn ? 1 : 0);

    Object.assign(p, this.override);
    this.current = p;
    this.haze.set(Math.max(p.beta, 0), p.topKm, p.scaleKm, p.edgeKm);
    this.shape.set(p.baseKm, p.ssa, p.alpha, p.absTilt);
    this.atmosphere.setHaze(this.haze, this.shape);
    // 谷底下沉量：雾越强，积得越高（下沉量越小）；平原上的雾块只在雾强时出现
    const v = this.sceneUniforms.uValleyFog.value;
    v.set(p.valleyFog, THREE.MathUtils.lerp(0.3, 0.03, p.valleyFog), THREE.MathUtils.smoothstep(p.valleyFog, 0.4, 1), 0);
  }
}
