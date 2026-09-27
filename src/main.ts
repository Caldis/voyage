import * as THREE from "three";
import { directionFromAzAlt, localToEquatorialColumns, magnitudeToKlux, moonState, sunPosition } from "./astro";
import { buildStarMap, loadMoonTexture } from "./sky-assets";
import { Traffic } from "./traffic";
import { WeatherSystem } from "./weather";
import { Atmosphere } from "./atmosphere/luts";
import { HazeModel } from "./atmosphere/haze";
import { CLOUD_PRESETS, Clouds, createCloudUniforms } from "./clouds/clouds";
import { generateCloudNoise } from "./clouds/noise";
import { Bloom } from "./render/bloom";
import { Exposure } from "./render/exposure";
import { FullscreenPass } from "./render/pass";
import { CabinClassVariant, createSceneMaterial } from "./render/scene";
import { GroundDetailVariant, createOutsideMaterial, createOutsideTarget } from "./render/outside-pass";
import { createWingMaterial } from "./render/wing-pass";
import { GroundClipmap } from "./ground/clipmap";
import { OceanWaves } from "./ocean/waves";
import { advanceFlight, greatCircleBearing, ownDirW, PRESETS, updateAltitudeFloor, updateHighLift, updateTurbulence } from "./flight";
import { $, CRUISE_PITCH_DEG, type CabinClass, type Preset, type VoyageState } from "./state";
import { fromLocal, localParts, setupUi, syncAltitudeUi, syncTimeUi, updateInfo } from "./ui";
import { applyViewPreset, setupViewControls, VIEW_PRESETS } from "./view-presets";
import { BootProgress } from "./boot/progress";
import { Director } from "./director";
import { WonderSystem } from "./wonders/system";

const SUN_ILLUMINANCE_KLUX = 120; // 大气层外约 128 klux，这里取整；颜色暂按白光

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.toneMapping = THREE.AgXToneMapping;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
$("app").appendChild(renderer.domElement);

// 启动计时（调试用，结果放在 window.__voyageStartup）
const startup: Record<string, number> = { 模块开始执行时离导航: Math.round(performance.now()) };
const tick = (() => {
  let t = performance.now();
  return (label: string) => {
    const now = performance.now();
    startup[label] = Math.round(now - t);
    t = now;
  };
})();
tick("模块加载到这里");
/** 等浏览器画完当前这一帧再继续：两次 rAF 保证真的过了一次绘制，不只是排上队（启动阶段之间用它让加载遮罩的更新先上屏） */
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
// 加载遮罩的分阶段清单 + 总进度条（真正驱动进度的是下面各阶段实际完成的时刻，见 boot.finish 调用）
const boot = new BootProgress();
const pass = new FullscreenPass(renderer);
const atmosphere = new Atmosphere(pass);
renderer.getContext().finish();
tick("大气 LUT");
boot.finish("atmosphere");
const cloudUniforms = createCloudUniforms(generateCloudNoise(renderer, pass));
tick("云噪声");
boot.finish("cloudNoise");
const ground = new GroundClipmap(PRESETS[0].lat, PRESETS[0].lon);
const sceneMat = createSceneMaterial(atmosphere, cloudUniforms, ground);
// 低空障眼法（T18）：边界层霾进大气 LUT，谷地雾的 uniform 进场景 / 窗外共用的 uniforms（只有窗外程序用到）
const haze = new HazeModel(atmosphere);
Object.assign(sceneMat.uniforms, haze.sceneUniforms);
// 奇观（W01，wonders/system.ts）：天幕层奇观的 uniform 进场景 / 窗外共用的 uniforms（只有窗外程序用到）
const wonders = new WonderSystem();
Object.assign(sceneMat.uniforms, wonders.uniforms);
// 机翼增升装置的 uniform（声明在 wing.glsl.ts）。在首次渲染前加进材质即可生效；以后可以挪进 createSceneMaterial
// uWingSteps / uWingShadowSteps 是机翼光线步进和自阴影的最大步数：用 uniform 而不是常量，FXC 就不会把循环展开，冷编译不会翻倍
Object.assign(sceneMat.uniforms, {
  uFlap: { value: 0 },
  uSlat: { value: 0 },
  uSpoiler: { value: 0 },
  uWingSteps: { value: 128 },
  uWingShadowSteps: { value: 24 },
  uWingEdgeAA: { value: 1 },
  uWingDebug: { value: 0 },
});
// 窗外 pass（SC-5，outside-pass.ts）：天空、云、地面、海面、交通、闪电画到 hdrOutside，舱内合成（sceneMat）再读回。
// 两个材质共用同一个 uniforms 对象（之后 Object.assign 进 sceneMat.uniforms 的也都能看到）
const outsideMat = createOutsideMaterial(sceneMat.uniforms);
const hdrOutside = createOutsideTarget(renderer);
sceneMat.uniforms.uOutside.value = hdrOutside.texture;
// 低空地面细节（T02）：海拔 4 km 以下后台编译窗外程序的 GROUND_DETAIL 变体，编好才切换
const groundDetail = new GroundDetailVariant(outsideMat, hdrOutside);
// 海浪：GPU FFT 三级级联（T14），每帧在场景 pass 之前更新
const ocean = new OceanWaves(renderer);
Object.assign(sceneMat.uniforms, ocean.uniforms);
const clouds = new Clouds(pass, atmosphere, cloudUniforms, sceneMat.uniforms);
const exposure = new Exposure(pass);
const traffic = new Traffic();
const weather = new WeatherSystem(cloudUniforms);
sceneMat.uniforms.uMoonTexture.value = loadMoonTexture();
buildStarMap().then((tex) => (sceneMat.uniforms.uStarMap.value = tex));
// 能线性过滤 32 位浮点纹理时，HDR 用 FloatType：太阳的辐亮度远超半精度上限，截断后眩光就没有能量了
const floatHdr = renderer.extensions.has("OES_texture_float_linear");
const hdrType = floatHdr ? THREE.FloatType : THREE.HalfFloatType;
const bloom = new Bloom(pass, hdrType);
sceneMat.uniforms.uHdrMax.value = floatHdr ? 1e20 : 6e4;
const hdr = new THREE.WebGLRenderTarget(1, 1, {
  type: hdrType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
});
// 舱等（T25）：舱内合成的着色器变体。默认商务舱（sceneMat 本身，首帧的后台编译批次里就是它），选经济舱时才后台编译
const cabinClass = new CabinClassVariant(sceneMat, hdr);
// 各舱等侧壁 / 窗罩饰面的平均反照率（和 cabin-shading.glsl.ts 的 LINING_ALBEDO 一致）：曝光的舱内色适应按它把饰面本色
// 从「舱内平均色」里除掉，剩下的才是光源色（T28，exposure.ts 的 uCabinRefAlbedo）。换舱等时跟着换，否则浅灰塑料会被当成冷光抵掉
const CABIN_REF_ALBEDO: Record<CabinClass, THREE.Vector3> = {
  business: new THREE.Vector3(0.75, 0.72, 0.665),
  economy: new THREE.Vector3(0.71, 0.71, 0.69),
};
let cabinClassUi = "";
// 机翼 pass（wing-pass.ts）：读场景的 hdr，把机翼合成上去写到 hdrWing；后面的眩光、曝光都读 hdrWing。
// 必须在所有 Object.assign(sceneMat.uniforms, …) 之后创建：它复用的是创建那一刻场景材质里的 uniform 对象
const wingMat = createWingMaterial(sceneMat.uniforms);
const hdrWing = new THREE.WebGLRenderTarget(1, 1, {
  type: hdrType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
});

const state: VoyageState = {
  preset: PRESETS[0],
  simTime: Date.now(),
  playRate: 0,
  seat: "right" as "right" | "left",
  altitudeKm: 10.7,
  /** 飞行阶段按钮设的目标高度；滑块直接改当前高度 */
  targetAltKm: 10.7,
  /** 当前航向（度）：沿航线飞时随位置变化 */
  heading: 180,
  /** 转弯坡度（度），右转为正 */
  bankDeg: 0,
  /** 当前俯仰角（度），随爬升 / 下降平滑变化 */
  pitchDeg: CRUISE_PITCH_DEG,
  /** 颠簸造成的滚转（度） */
  rollDeg: 0,
  /** 颠簸强度 0..1：晴空 ~0.03，普通云里 ~0.4，雷暴附近到 1 */
  turbulence: 0.03,
  /** 窗板外侧的湿度 0..1：在云里、雨里变湿，出来后被气流吹干 */
  wetness: 0,
  shade: 0, // 0 = 全开，1 = 全关
  wind: 7,
  cabinLight: true,
  moodLight: true,
  cabinClass: "business",
  cloudPreset: CLOUD_PRESETS[0],
  /** 翼根前缘在机头方向上相对窗口的距离（米）：座位在机翼前方时为负 */
  wingRootLE: 8,
  /** 真实地理数据（联网拉取卫星影像、地形、水体） */
  groundOn: true,
  highLift: "auto",
  slatDeg: 0,
  flapDeg: 0,
  spoilerDeg: 0,
};

/** 机翼调试：strobe 设成数字时频闪固定在这个亮度（截「闪亮瞬间」用，例如 1），null 按正常节奏闪 */
const wingDebug: { strobe: number | null } = { strobe: null };

/** 默认时刻：当天下午太阳高度角降到 8° 的时候，日落前的光最好看 */
function defaultTime(preset: Preset) {
  const { date } = localParts(Date.now(), preset.tz);
  for (let m = 12 * 60; m < 24 * 60; m += 2) {
    const t = fromLocal(date, m, preset.tz);
    if (sunPosition(new Date(t), preset.lat, preset.lon, state.altitudeKm * 1000).altitude < 8) return t;
  }
  return fromLocal(date, 17 * 60, preset.tz);
}

// ---------- 头部与视线 ----------
const head = { x: 0, y: 0.02, z: -0.42, tx: 0, ty: 0.02, tz: -0.42 };

/** 当前视角预设：面板「视角」下拉切换，双击画布回到它；换座位时按新座位重新换算 */
let viewPreset = VIEW_PRESETS[0];
function setView(id: string) {
  viewPreset = VIEW_PRESETS.find((v) => v.id === id) ?? VIEW_PRESETS[0];
  applyViewPreset(head, viewPreset, state.seat, state.wingRootLE); // 只改目标位置，头会平滑挪过去
}
// 按住拖动才转视角（面板上的操作不会带动画面）；滚轮前后挪头；双击回到当前预设
setupViewControls(renderer.domElement, head, () => setView(viewPreset.id));

function cabinToWorld(): THREE.Matrix3 {
  const h = THREE.MathUtils.degToRad(state.heading);
  const p = THREE.MathUtils.degToRad(state.pitchDeg);
  const fwdFlat = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3(Math.cos(h), 0, Math.sin(h));
  const fwd = fwdFlat.clone().multiplyScalar(Math.cos(p)).addScaledVector(worldUp, Math.sin(p));
  const up0 = worldUp.clone().multiplyScalar(Math.cos(p)).addScaledVector(fwdFlat, -Math.sin(p));
  // 转弯坡度 + 颠簸带来的滚转：绕机身纵轴转
  const r = THREE.MathUtils.degToRad(state.rollDeg + state.bankDeg);
  const up = up0.clone().multiplyScalar(Math.cos(r)).addScaledVector(right, Math.sin(r));
  right.multiplyScalar(Math.cos(r)).addScaledVector(up0, -Math.sin(r));
  // 左侧座位把 x 轴翻到机尾方向，保持座舱坐标系右手，屏幕右侧就是机头
  const m4 =
    state.seat === "right"
      ? new THREE.Matrix4().makeBasis(fwd, up, right)
      : new THREE.Matrix4().makeBasis(fwd.negate(), up, right.negate());
  return new THREE.Matrix3().setFromMatrix4(m4);
}

function cameraBasis(): THREE.Matrix3 {
  const eye = new THREE.Vector3(head.x, head.y, head.z);
  const target = new THREE.Vector3(0, -0.01, 0.075); // 看向窗板中心
  const back = eye.clone().sub(target).normalize();
  const right = new THREE.Vector3(0, 1, 0).cross(back).normalize();
  const up = back.clone().cross(right);
  return new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeBasis(right, up, back));
}

/** 画面跳变（换地点、拖时间、换座位）：眼睛直接适应，云的时间累积也清空 */
function snapAll() {
  exposure.snap();
  clouds.snap();
  updateHighLift(state, 0, true);
}

function setPreset(id: string) {
  state.preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
  state.heading = state.preset.dest
    ? greatCircleBearing(state.preset.lat, state.preset.lon, state.preset.dest[0], state.preset.dest[1])
    : state.preset.heading;
  state.bankDeg = 0;
  state.simTime = defaultTime(state.preset);
  // 回到预设起点：飞机位移清零，地面数据按新起点重建
  cloudUniforms.uCloudOffset.value.set(0, 0);
  ground.reset(state.preset.lat, state.preset.lon);
  snapAll();
  syncTimeUi(state);
  director.onPresetChanged();
}

// ---------- 导演：连续航程 / 背景板模式（T19a，director.ts） ----------
let lastSunAlt = 0;
let groundMinLevel = 0;
const director = new Director({
  state,
  geo: () => ground.localFrame.toGeo(cloudUniforms.uCloudOffset.value.x, cloudUniforms.uCloudOffset.value.y),
  offsetKm: () => cloudUniforms.uCloudOffset.value.length(),
  cloudDensity: () => clouds.cameraDensity,
  sunAltDeg: () => lastSunAlt,
  rebase: rebaseFrame,
  setCabinLight: (mode) => {
    const sel = $<HTMLSelectElement>("cabin-light");
    sel.value = mode;
    sel.dispatchEvent(new Event("change"));
  },
  // 天气（T19b）
  weather,
  cloudParams: () => clouds.params(),
  setCloudParams: (p, gradual) => {
    clouds.setParams(p, gradual);
    weather.updateShell();
  },
  toLocal: (lat, lon) => ground.localFrame.toLocal(lat, lon),
  localPos: () => [cloudUniforms.uCloudOffset.value.x, cloudUniforms.uCloudOffset.value.y],
  landBelow: () => (state.floor?.known ? state.floor.reason === "land" : null),
});
// 奇观之门演示开关（T19b）：URL 带 ?gateDemo 时，连续航程每 2 模拟小时在航线前方放一道云墙
if (new URLSearchParams(location.search).has("gateDemo")) director.weather.gateDemo = true;

/** 本地坐标换原点（导演借穿云 / 深夜调用）：原点挪到飞机正下方，位置（经纬度）、高度、航向都不变。
 *  地面 clipmap 按新原点重建；云场、海浪的噪声原点跟着 uCloudOffset 跳一下（所以要借遮挡）；雷暴、台风、闪电通道平移到新坐标 */
function rebaseFrame() {
  const off = cloudUniforms.uCloudOffset.value;
  const [lat, lon] = ground.localFrame.toGeo(off.x, off.y);
  weather.translate(off.x, off.y);
  off.set(0, 0);
  ground.reset(lat, lon);
  clouds.snap();
}

// ---------- 尺寸 ----------
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  hdr.setSize(size.x, size.y);
  hdrOutside.setSize(size.x, size.y);
  hdrWing.setSize(size.x, size.y);
  clouds.setSize(size.x, size.y);
  bloom.setSize(size.x, size.y);
  sceneMat.uniforms.uResolution.value.copy(size);
}
window.addEventListener("resize", resize);
resize();

setupUi({ state, setPreset, snapAll, resize, exposure, clouds, weather, cloudUniforms, setView, currentView: () => viewPreset.id, director, wonders });
// 奇观之门（W01 预留、T19b 接入）：遮挡开始时通知奇观系统；只有 wonders.preferGate = true 时才会借遮挡出现
director.onCover((kind) => wonders.onCover(kind));

// ---------- 主循环 ----------
setPreset(state.preset.id);
let last = performance.now();
let frameCount = 0;

function frame(now: number) {
  renderFrame(now);
  requestAnimationFrame(frame);
}

/** 一帧的全部工作（更新 + 所有渲染 pass），不含调度下一帧；benchFrame 也用它 */
function renderFrame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  // 连续航程（T19a）：时间与飞行一起按航程流速走；否则沿用「时间流速」按钮（只推太阳月亮，飞行按真实时间）
  const simDt = director.simDt(dt);
  if (director.active) {
    state.simTime += simDt * 1000;
    syncTimeUi(state);
  } else if (state.playRate > 0) {
    state.simTime += dt * 1000 * state.playRate;
    syncTimeUi(state);
  }

  // 飞机当前的经纬度：起点 + 累计位移
  const [curLat, curLon] = ground.localFrame.toGeo(cloudUniforms.uCloudOffset.value.x, cloudUniforms.uCloudOffset.value.y);
  const sun = sunPosition(new Date(state.simTime), curLat, curLon, state.altitudeKm * 1000);
  lastSunAlt = sun.altitude;
  const sunDir = directionFromAzAlt(sun.azimuth, sun.altitude);
  const camR = 6360 + state.altitudeKm;

  // 头部平滑跟随鼠标，像人慢慢挪动身体
  // ---- 颠簸与窗上的水 ----
  if (frameCount++ % 4 === 0) clouds.probe(renderer, ownDirW(state.heading));
  const inCloud = clouds.cameraDensity;
  const bump = updateTurbulence(state, { dt, now, inCloud, storms: weather.storms, cloudOffset: cloudUniforms.uCloudOffset.value });

  const k = 1 - Math.exp(-dt * 6);
  head.x += (head.tx - head.x) * k;
  head.y += (head.ty - head.y) * k;
  head.z += (head.tz - head.z) * k;

  // 高度下限与霾（T18）：都要在大气 LUT 更新之前
  const offT18 = cloudUniforms.uCloudOffset.value;
  updateAltitudeFloor(state, ground, offT18.x, offT18.y);
  haze.update({ state, ground, x: offT18.x, z: offT18.y, lon: curLon, sunAltDeg: sun.altitude, coverage: cloudUniforms.uCoverage.value, dt });

  const moon = moonState(new Date(state.simTime), curLat, curLon, state.altitudeKm * 1000);
  const moonDir = directionFromAzAlt(moon.azimuth, moon.altitude);
  atmosphere.updateSkyView(camR, sunDir[1], moonDir[1]);
  atmosphere.updateAerialPerspective(camR, sunDir[1]);

  // 加速时拆成不超过 0.5 模拟秒的小步：航向控制器（按角度差的 0.3 倍转）步长太大会来回过冲
  const flightResult = stepFlight(simDt, curLat, curLon);
  director.update(dt, simDt, flightResult.speedKms);
  if (flightResult.climbing) syncAltitudeUi(state);
  // 奇观（W01）：触发、编排、摆放（固定在地面的经纬度上），写 uWonder*；奇观模式关时只把 uWonderOn 置 0
  wonders.update(dt, simDt, {
    lat: curLat,
    lon: curLon,
    heading: state.heading,
    seat: state.seat,
    sunAltDeg: sun.altitude,
    altitudeKm: state.altitudeKm,
    inCloud,
    coverage: cloudUniforms.uCoverage.value,
    flightKey: `${state.preset.id}|${localParts(state.simTime, state.preset.tz).date}`,
  });
  updateHighLift(state, simDt);
  traffic.update(simDt, flightResult.ownDir, flightResult.speedKms, flightResult.outwardW);
  weather.update(dt);
  const off = cloudUniforms.uCloudOffset.value;
  for (let i = 0; i < 16; i++) {
    const b = weather.bolt[i];
    sceneMat.uniforms.uBolt.value[i].set(b.x - off.x, 6360 + b.y, b.z - off.y);
  }
  sceneMat.uniforms.uBoltIntensity.value = weather.boltIntensity;
  traffic.planes.forEach((p, i) => {
    sceneMat.uniforms.uTrafficPos.value[i].copy(p.pos);
    sceneMat.uniforms.uTrafficDir.value[i].copy(p.dir);
    sceneMat.uniforms.uTrafficSpeed.value[i] = p.speed;
    sceneMat.uniforms.uTrafficActive.value[i] = p.active ? 1 : 0;
  });

  const u = sceneMat.uniforms;
  u.uSunDir.value.set(...sunDir);
  u.uSunIlluminance.value.setScalar(SUN_ILLUMINANCE_KLUX);
  // 月光：由视星等换算；月面反射让月光比日光略偏暖
  const moonKlux = magnitudeToKlux(moon.mag);
  u.uMoonDir.value.set(...moonDir);
  u.uMoonIlluminance.value.set(moonKlux * 1.04, moonKlux, moonKlux * 0.9);
  u.uMoonAngularRadius.value = moon.angularRadius;
  u.uMoonPhaseFraction.value = moon.phaseFraction;
  u.uSunFromMoon.value.set(...sunDir);
  // 直射主光源：太阳低于 −4° 后换成月亮（巡航高度上太阳 −3.3° 才完全落下）
  if (sun.altitude > -4) {
    u.uKeyDir.value.set(...sunDir);
    u.uKeyIlluminance.value.setScalar(SUN_ILLUMINANCE_KLUX);
  } else {
    u.uKeyDir.value.set(...moonDir);
    u.uKeyIlluminance.value.copy(u.uMoonIlluminance.value);
  }
  const [ce, cu, cs] = localToEquatorialColumns(new Date(state.simTime), curLat, curLon, state.altitudeKm * 1000);
  u.uLocalToEquatorial.value.set(ce[0], cu[0], cs[0], ce[1], cu[1], cs[1], ce[2], cu[2], cs[2]);
  u.uCamR.value = camR;
  u.uHead.value.set(head.x, head.y + bump, head.z);
  u.uWetness.value = state.wetness;
  u.uCameraFog.value = clouds.cameraDensity * 60; // 与云着色器的 CLOUD_EXTINCTION 一致
  const camBasis = cameraBasis();
  const c2w = cabinToWorld();
  u.uCamBasis.value = camBasis;
  u.uCabinToWorld.value = c2w;
  // 遮光板下沿从窗洞顶（0.21 m）往下拉到底（-0.21 m）
  u.uShadeBottom.value = 0.21 - state.shade * 0.42;
  u.uWind.value = state.wind;
  u.uTime.value = now / 1000;
  u.uSeatSign.value = state.seat === "right" ? 1 : -1;
  // 真实地理数据开着时，程序生成的岛屿关掉（真实海岸线里自有岛屿）
  u.uIslandDensity.value = state.groundOn ? 0 : state.preset.islands;
  u.uGroundOn.value = state.groundOn ? 1 : 0;
  // 加速播放（T19a）：最细的地面级别停用，免得瓦片请求随流速暴涨被影像服务器限流（见 ground/clipmap.ts setMinLevel）。
  // 请求量约 ∝ 流速 × 2^(1−最细级)：10× 停 1 级、30× 以上停 3 级（最细 64 km 级，约 60 m/像素，巡航高度侧看够用）
  const minLevel = !director.active || director.rate < 10 ? 0 : director.rate < 30 ? 1 : 3;
  if (minLevel !== groundMinLevel) {
    groundMinLevel = minLevel;
    ground.setMinLevel(minLevel);
  }
  if (state.groundOn) ground.update(cloudUniforms.uCloudOffset.value.x, cloudUniforms.uCloudOffset.value.y);
  u.uTerrainMax.value = ground.maxHeightKm;
  u.uWingRootLE.value = state.wingRootLE;
  // 巡航时翼尖静弯约 0.5 m，湍流里再叠几厘米的颤动
  const ts = now / 1000;
  // 颠簸越强，翼尖上下颤得越厉害（强颠簸时可达十几厘米）
  const flexAmp = 1 + state.turbulence * 6;
  u.uWingFlex.value = 0.5 + flexAmp * (0.03 * Math.sin(ts * 2.3) + 0.02 * Math.sin(ts * 5.1 + 1.3)) + 0.015 * Math.sin(ts * 0.7);
  // 翼尖频闪：每秒双闪
  const ph = ts % 1.1;
  u.uStrobe.value = wingDebug.strobe ?? (ph < 0.05 || (ph > 0.14 && ph < 0.19) ? 1 : 0);
  u.uSlat.value = THREE.MathUtils.degToRad(state.slatDeg);
  u.uFlap.value = THREE.MathUtils.degToRad(state.flapDeg);
  u.uSpoiler.value = THREE.MathUtils.degToRad(state.spoilerDeg);
  // 舱灯开：约 200 lux；关：只剩地板灯带和零星阅读灯，约 1 lux
  u.uCabinLight.value = state.cabinLight ? 0.2 : 0.001;
  u.uMoodLight.value = state.moodLight ? 1 : 0;
  clouds.render(flightResult.motion, camBasis, c2w);
  u.uClouds.value = clouds.texture;
  ocean.update(now / 1000, state.wind, cloudUniforms.uCloudOffset.value);
  // 窗外（或低空地面细节的变体材质，共用 sceneMat.uniforms）先画到 hdrOutside，舱内合成读它画到 hdr，
  // 机翼 pass 再读实际画出来的 hdr 合成
  pass.render(state.groundOn ? groundDetail.pick(renderer, state.altitudeKm) : outsideMat, hdrOutside);
  const cabinMat = cabinClass.pick(renderer, state.cabinClass);
  exposure.finalMat.uniforms.uCabinRefAlbedo.value.copy(CABIN_REF_ALBEDO[cabinClass.shown]);
  pass.render(cabinMat, hdr);
  // 面板上的舱等状态：变体后台编译时提示一下（编好之前画面保持原来的舱等）
  const st = cabinClass.status(state.cabinClass);
  const ui = st === "compiling" ? "（准备中…）" : st === "failed" ? "（编译失败，保持原舱等）" : "";
  if (ui !== cabinClassUi) $("cabin-class-status").textContent = cabinClassUi = ui;
  wingMat.uniforms.uScene.value = hdr.texture;
  pass.render(wingMat, hdrWing);
  exposure.render(hdrWing.texture, bloom.render(hdrWing), dt);

  updateInfo(now, sun, moon, state, curLat, curLon, ground.pending, director.describe());
}

/** 推进飞行 simDt 模拟秒（按 0.5 s 拆步）；到达终点上空交给导演接下一段航线（T19a：不再瞬移回起点） */
function stepFlight(simDt: number, lat0: number, lon0: number) {
  const n = Math.max(1, Math.ceil(simDt / 0.5));
  const off = cloudUniforms.uCloudOffset.value;
  let lat = lat0, lon = lon0;
  let climbing = false;
  const motion = new THREE.Vector3();
  let r: ReturnType<typeof advanceFlight> | null = null;
  for (let i = 0; i < n; i++) {
    if (i > 0) [lat, lon] = ground.localFrame.toGeo(off.x, off.y);
    r = advanceFlight(state, { dt: simDt / n, curLat: lat, curLon: lon, cloudOffset: off, onReachDest: () => director.relay() });
    climbing ||= r.climbing;
    motion.add(r.motion);
  }
  return { ...r!, climbing, motion };
}
// 先让浏览器把加载遮罩画出来，再画第一帧：第一帧要编译所有着色器，首次打开时会阻塞很久
requestAnimationFrame(() =>
  setTimeout(async () => {
    tick("首帧之前的初始化");
    // 场景着色器很大（Windows 上 ANGLE → FXC 冷编译约一分钟）。先用 KHR_parallel_shader_compile 在后台编译、轮询完成，
    // 不在首帧里同步编译：同步编译太久时 Chrome 会认为 GPU 卡死，报 VALIDATE_STATUS false 并丢失 WebGL 上下文
    // （上下文恢复后 LUT、噪声纹理都没了，画面错乱）。渲染目标要和真正渲染时一致（hdr），程序缓存才能命中
    //
    // 云光线步进 / resolve / 占据网格 / 云影图四个程序由 clouds.compileTargets() 给出（连同真正画进去的目标），
    // 和窗外、舱内、机翼并进同一批 compileAsync 后台编译（SC-4、PERF-1）。
    try {
      // 几何体、相机和 FullscreenPass 的一致（只有 position + uv 的全屏三角形），程序缓存的键才相同
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
      // 窗外、舱内合成（场景）、机翼、云光线步进、云 resolve 五个程序各自绑定自己真正要画进去的目标再发起编译
      // （compileAsync 调用时就同步提交链接，之后只是轮询）：Windows 上 ANGLE 的 D3D 后端按「链接时绑定的帧缓冲」
      // 生成像素着色器的输出布局，绑错会在首帧按新布局同步重编。注意：MRT 程序在 ANGLE / D3D11 上并行编译后
      // 第一次 draw 仍会同步重编整个像素着色器，与绑哪个目标无关（PERF-1）——所以云步进改成了单输出（深度走 gl_FragDepth），新程序尽量单输出。
      // SC-5：原来的场景程序拆成了窗外 + 舱内合成两个，它们也在这一批里并行编译（最慢的是窗外，决定这一批的墙钟）
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const jobs: Promise<unknown>[] = [];
      const batch: ReadonlyArray<readonly [THREE.ShaderMaterial, THREE.WebGLRenderTarget]> = [
        [outsideMat, hdrOutside],
        [sceneMat, hdr],
        [wingMat, hdrWing],
        ...clouds.compileTargets(),
      ];
      for (const [mat, target] of batch) {
        const probe = new THREE.Scene();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        probe.add(mesh);
        renderer.setRenderTarget(target);
        jobs.push(renderer.compileAsync(probe, cam));
      }
      await Promise.all(jobs);
      renderer.setRenderTarget(null);
    } catch (err) {
      console.warn("场景 / 云着色器后台编译失败，改为首帧同步编译", err);
    }
    tick("窗外 / 舱内 / 机翼 / 云着色器编译（后台）");
    boot.finish("shaders");
    await nextPaint();

    ocean.update(0, state.wind, cloudUniforms.uCloudOffset.value);
    tick("海面 FFT 程序编译");
    boot.finish("oceanFft");
    await nextPaint();

    {
      const bloomTex = bloom.render(hdrWing);
      exposure.render(hdrWing.texture, bloomTex, 0);
      exposure.snap();
    }
    tick("曝光与眩光程序编译");
    boot.finish("post");
    await nextPaint();

    frame(performance.now());
    renderer.getContext().finish();
    tick("首帧渲染");
    boot.finish("firstFrame");
    boot.complete();
    // 场景材质名下编译过几个程序：1 说明后台编译的程序被首帧直接用上了；2 说明键不一致、首帧又同步编译了一遍
    const programs = (mat: THREE.Material) => (renderer.properties.get(mat) as { programs?: Map<string, unknown> }).programs?.size ?? -1;
    startup["窗外材质的程序数"] = programs(outsideMat);
    startup["场景材质的程序数"] = programs(sceneMat);
    startup["机翼材质的程序数"] = programs(wingMat);
    const [[marchMat], [resolveMat]] = clouds.compileTargets();
    startup["云光线步进材质的程序数"] = programs(marchMat);
    startup["云 resolve 材质的程序数"] = programs(resolveMat);
    (window as unknown as { __voyageStartup: unknown }).__voyageStartup = startup;
    $("loading").classList.add("done");
  }, 50),
);

/** 调试：把机翼 pass 连续渲染 n 次并等 GPU 做完，返回每次的毫秒数 */
function benchWing(n = 20) {
  const px = new Float32Array(4);
  const sync = () => renderer.readRenderTargetPixels(hdrWing, 0, 0, 1, 1, px);
  pass.render(wingMat, hdrWing);
  sync();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) pass.render(wingMat, hdrWing);
  sync();
  return (performance.now() - t0) / n;
}

/** 调试：把场景 pass（窗外 + 舱内合成）连续渲染 n 次并等 GPU 做完，返回每次的毫秒数。比较着色器开销用（不受刷新率上限影响）。
 *  which：both（默认，和 SC-5 之前的「场景 pass」可比）、outside、cabin */
function benchScene(n = 20, which: "both" | "outside" | "cabin" = "both") {
  // gl.finish() 在 Chrome（ANGLE）里不等 GPU，读回一个像素才会真正同步
  const px = new Float32Array(4);
  const sync = () => renderer.readRenderTargetPixels(hdr, 0, 0, 1, 1, px);
  const once = () => {
    if (which !== "cabin") pass.render(state.groundOn ? groundDetail.pick(renderer, state.altitudeKm) : outsideMat, hdrOutside);
    if (which !== "outside") pass.render(cabinClass.pick(renderer, state.cabinClass), hdr);
  };
  once();
  sync();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) once();
  sync();
  return (performance.now() - t0) / n;
}

/** 调试：连续做 n 帧的全部渲染并等 GPU 做完，返回每帧的毫秒数（不受刷新率上限影响；时间按 16 ms 一帧推进） */
function benchFrame(n = 10) {
  const px = new Float32Array(4);
  const sync = () => renderer.readRenderTargetPixels(hdr, 0, 0, 1, 1, px);
  sync();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) renderFrame(last + 16);
  sync();
  return (performance.now() - t0) / n;
}

// 调试句柄：浏览器控制台里可以看 / 改状态，自动化截图也靠它
(window as unknown as { __voyage: unknown }).__voyage = { state, head, cloudUniforms, snapAll, clouds, resize, sceneMat, cabinClass, outsideMat, hdrOutside, exposure, traffic, ground, weather, ocean, groundDetail, haze, wingDebug, wingMat, benchScene, benchWing, benchFrame, boot, director, setPreset, wonders };
