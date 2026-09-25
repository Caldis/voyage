import * as THREE from "three";
import { directionFromAzAlt, localToEquatorialColumns, magnitudeToKlux, moonState, sunPosition } from "./astro";
import { buildStarMap, loadMoonTexture } from "./sky-assets";
import { Traffic } from "./traffic";
import { WEATHER_PRESETS, WeatherSystem } from "./weather";
import { Atmosphere } from "./atmosphere/luts";
import { CLOUD_PRESETS, Clouds, createCloudUniforms } from "./clouds/clouds";
import { generateCloudNoise } from "./clouds/noise";
import { Bloom } from "./render/bloom";
import { Exposure } from "./render/exposure";
import { FullscreenPass } from "./render/pass";
import { createSceneMaterial } from "./render/scene";
import { GroundClipmap } from "./ground/clipmap";

interface Preset {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** 航向，度，从正北顺时针 */
  heading: number;
  /** 显示当地时间用的时区（UTC 偏移，小时） */
  tz: number;
  /** 程序生成岛屿的密度（每 30 km 格子出现的概率）；岛屿是示例，不对应真实地理 */
  islands: number;
  /** 航线终点（纬度, 经度）：有的话沿大圆航线飞过去，航向随位置变化；没有就沿固定航向直飞 */
  dest?: [number, number];
}

// 预设都放在海上；下面出现的岛屿是程序生成的示例，不对应真实地理（真实地形见路线图 P5）
const PRESETS: Preset[] = [
  { id: "wpac", name: "西太平洋上空 · 东京以南约 600 km · 向南飞", lat: 30.0, lon: 139.8, heading: 180, tz: 9, islands: 0.12 },
  { id: "ecs", name: "东海上空 · 上海以东约 400 km · 向东飞", lat: 31.2, lon: 126.0, heading: 80, tz: 8, islands: 0.05 },
  { id: "scs", name: "南海上空 · 向西南飞", lat: 18.0, lon: 115.0, heading: 225, tz: 8, islands: 0.35 },
  // 陆地：需要开「真实地理数据」
  { id: "yangtze", name: "长江中下游 · 鄱阳湖以北 · 向东北飞", lat: 29.55, lon: 115.9, heading: 70, tz: 8, islands: 0 },
  { id: "fuji", name: "骏河湾上空 · 向西飞（富士山从右前方出现）", lat: 35.0, lon: 138.95, heading: 270, tz: 9, islands: 0 },
  // 真实航线（大圆航线，从爬升结束、进入巡航的位置开始）：需要开「真实地理数据」
  { id: "hnd-cts", name: "航线：东京羽田 → 札幌新千岁（北上，经东北地方）", lat: 36.2, lon: 140.3, heading: 10, tz: 9, islands: 0, dest: [42.78, 141.69] },
  { id: "hnd-itm", name: "航线：东京羽田 → 大阪伊丹（西行，经富士山）", lat: 35.35, lon: 139.35, heading: 260, tz: 9, islands: 0, dest: [34.78, 135.44] },
  { id: "pvg-pek", name: "航线：上海浦东 → 北京首都（北上，过长江、黄河）", lat: 31.9, lon: 121.2, heading: 330, tz: 8, islands: 0, dest: [40.08, 116.58] },
];

const SUN_ILLUMINANCE_KLUX = 120; // 大气层外约 128 klux，这里取整；颜色暂按白光
const CRUISE_PITCH_DEG = 2.5; // 巡航时机头略微抬起，侧窗里的地平线因此微微倾斜
/** 真实爬升 / 下降率约 10–15 m/s；飞行阶段按钮按 10 倍加速，免得等十几分钟 */
const ALT_RATE_KMS = 0.012 * 10;

/** 地速随高度变化：巡航约 900 km/h，进近约 250 km/h */
function speedAt(altKm: number) {
  return 0.07 + (0.25 - 0.07) * THREE.MathUtils.smoothstep(altKm, 0.5, 9);
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const D2R = Math.PI / 180;
/** 大圆航线的初始方位角（度，从正北顺时针） */
function greatCircleBearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D2R) + 360) % 360;
}
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dl / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

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
const pass = new FullscreenPass(renderer);
const atmosphere = new Atmosphere(pass);
renderer.getContext().finish();
tick("大气 LUT");
const cloudUniforms = createCloudUniforms(generateCloudNoise(renderer, pass));
tick("云噪声");
const ground = new GroundClipmap(PRESETS[0].lat, PRESETS[0].lon);
const sceneMat = createSceneMaterial(atmosphere, cloudUniforms, ground);
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

const state = {
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
  cloudPreset: CLOUD_PRESETS[0],
  /** 翼根前缘在机头方向上相对窗口的距离（米）：座位在机翼前方时为负 */
  wingRootLE: 8,
  /** 真实地理数据（联网拉取卫星影像、地形、水体） */
  groundOn: true,
};

// ---------- 时间：按预设时区显示当地日期与时刻 ----------
function localParts(ms: number, tz: number) {
  const d = new Date(ms + tz * 3600e3);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60,
  };
}

function fromLocal(date: string, minutes: number, tz: number) {
  return Date.parse(`${date}T00:00:00Z`) - tz * 3600e3 + minutes * 60e3;
}

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

window.addEventListener("pointermove", (e) => {
  if ((e.target as HTMLElement).closest("#panel")) return;
  const px = (e.clientX / window.innerWidth) * 2 - 1;
  const py = (e.clientY / window.innerHeight) * 2 - 1;
  // 鼠标往右，头往屏幕右侧挪；屏幕右侧对应座舱坐标 -x
  head.tx = -px * 0.14;
  head.ty = 0.02 - py * 0.1;
});
window.addEventListener(
  "wheel",
  (e) => {
    if ((e.target as HTMLElement).closest("#panel")) return;
    head.tz = THREE.MathUtils.clamp(head.tz + e.deltaY * 0.0004, -0.75, -0.2);
  },
  { passive: true },
);

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

// ---------- 面板 ----------
const presetSel = $<HTMLSelectElement>("preset");
const dateInput = $<HTMLInputElement>("date");
const timeInput = $<HTMLInputElement>("time");
const timeLabel = $("time-label");
const info = $("info");

presetSel.innerHTML = PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");

function syncTimeUi() {
  const { date, minutes } = localParts(state.simTime, state.preset.tz);
  dateInput.value = date;
  timeInput.value = String(Math.floor(minutes));
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(Math.floor(minutes % 60)).padStart(2, "0");
  const sign = state.preset.tz >= 0 ? "+" : "−";
  timeLabel.textContent = `${hh}:${mm}（UTC${sign}${Math.abs(state.preset.tz)}）`;
}

/** 画面跳变（换地点、拖时间、换座位）：眼睛直接适应，云的时间累积也清空 */
function snapAll() {
  exposure.snap();
  clouds.snap();
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
  syncTimeUi();
}

presetSel.addEventListener("change", () => setPreset(presetSel.value));
dateInput.addEventListener("change", () => {
  if (!dateInput.value) return;
  state.simTime = fromLocal(dateInput.value, Number(timeInput.value), state.preset.tz);
  snapAll();
  syncTimeUi();
});
timeInput.addEventListener("input", () => {
  state.simTime = fromLocal(dateInput.value, Number(timeInput.value), state.preset.tz);
  snapAll();
  syncTimeUi();
});
$("now").addEventListener("click", () => {
  state.simTime = Date.now();
  snapAll();
  syncTimeUi();
});
document.querySelectorAll<HTMLButtonElement>("[data-rate]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.playRate = Number(btn.dataset.rate);
    document.querySelectorAll("[data-rate]").forEach((b) => b.classList.toggle("on", b === btn));
  });
});
$<HTMLInputElement>("ground-on").addEventListener("change", (e) => {
  state.groundOn = (e.target as HTMLInputElement).checked;
  snapAll();
});
$<HTMLSelectElement>("wing-pos").addEventListener("change", (e) => {
  state.wingRootLE = Number((e.target as HTMLSelectElement).value);
  snapAll();
});
$<HTMLSelectElement>("seat").addEventListener("change", (e) => {
  state.seat = (e.target as HTMLSelectElement).value as "right" | "left";
  snapAll();
});

function bindRange(id: string, apply: (v: number) => string) {
  const input = $<HTMLInputElement>(id);
  const out = $(`${id}-out`);
  const update = () => (out.textContent = apply(Number(input.value)));
  input.addEventListener("input", update);
  update();
}
const altInput = $<HTMLInputElement>("altitude");
bindRange("altitude", (v) => {
  state.altitudeKm = v;
  state.targetAltKm = v;
  snapAll();
  return `${v.toFixed(1)} km`;
});
bindRange("shade", (v) => {
  state.shade = v;
  return v === 0 ? "全开" : `拉下 ${Math.round(v * 100)}%`;
});
bindRange("wind", (v) => {
  state.wind = v;
  return `${v} m/s`;
});
bindRange("ev-comp", (v) => {
  exposure.finalMat.uniforms.uEvComp.value = v;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} EV`;
});
bindRange("manual-ev", (v) => {
  exposure.finalMat.uniforms.uManualEv.value = v;
  return `EV ${v.toFixed(1)}`;
});
const autoBox = $<HTMLInputElement>("auto-exposure");
const syncAuto = () => {
  exposure.finalMat.uniforms.uAuto.value = autoBox.checked;
  $("manual-row").hidden = autoBox.checked;
};
autoBox.addEventListener("change", syncAuto);
syncAuto();
document.querySelectorAll<HTMLButtonElement>("[data-alt]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.targetAltKm = Number(btn.dataset.alt);
  });
});

const cloudSel = $<HTMLSelectElement>("cloud-preset");
cloudSel.innerHTML = CLOUD_PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
cloudSel.addEventListener("change", () => {
  state.cloudPreset = CLOUD_PRESETS.find((p) => p.id === cloudSel.value) ?? CLOUD_PRESETS[0];
  clouds.applyPreset(state.cloudPreset);
  weather.updateShell();
  for (const [id, v] of [["coverage", state.cloudPreset.coverage], ["cloud-base", state.cloudPreset.bottom], ["cloud-thick", state.cloudPreset.top - state.cloudPreset.bottom]] as const) {
    const el = $<HTMLInputElement>(id);
    el.value = String(v);
    el.dispatchEvent(new Event("input"));
  }
});
bindRange("coverage", (v) => {
  cloudUniforms.uCoverage.value = v;
  return `${Math.round(v * 100)}%`;
});
bindRange("cloud-base", (v) => {
  const thick = cloudUniforms.uCloudTop.value - cloudUniforms.uCloudBottom.value;
  cloudUniforms.uCloudBottom.value = v;
  cloudUniforms.uCloudTop.value = v + thick;
  weather.updateShell();
  clouds.snap();
  return `${v.toFixed(1)} km`;
});
bindRange("cloud-thick", (v) => {
  cloudUniforms.uCloudTop.value = cloudUniforms.uCloudBottom.value + v;
  weather.updateShell();
  clouds.snap();
  return `${v.toFixed(1)} km`;
});
clouds.applyPreset(state.cloudPreset);
weather.updateShell();

// 天气：雷暴、台风摆在飞机附近（窗外这一侧）
const weatherSel = $<HTMLSelectElement>("weather");
weatherSel.innerHTML = WEATHER_PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
function applyWeather() {
  const h = THREE.MathUtils.degToRad(state.heading);
  const fwd = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
  const out = new THREE.Vector3(Math.cos(h), 0, Math.sin(h)).multiplyScalar(state.seat === "right" ? 1 : -1);
  weather.apply(weatherSel.value, cloudUniforms.uCloudOffset.value, fwd, out);
  clouds.snap();
}
weatherSel.addEventListener("change", applyWeather);
$<HTMLInputElement>("cabin-light").addEventListener("change", (e) => {
  state.cabinLight = (e.target as HTMLInputElement).checked;
});
window.addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H") $("panel").classList.toggle("hidden");
});

// ---------- 尺寸 ----------
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  hdr.setSize(size.x, size.y);
  clouds.setSize(size.x, size.y);
  bloom.setSize(size.x, size.y);
  sceneMat.uniforms.uResolution.value.copy(size);
}
window.addEventListener("resize", resize);
resize();
$<HTMLSelectElement>("quality").addEventListener("change", (e) => {
  clouds.resolutionScale = Number((e.target as HTMLSelectElement).value);
  resize();
});

// ---------- 主循环 ----------
const COMPASS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

setPreset(state.preset.id);
let last = performance.now();
let frameCount = 0;
const ownDirW = (headingDeg: number) => {
  const hh = THREE.MathUtils.degToRad(headingDeg);
  return new THREE.Vector3(Math.sin(hh), 0, -Math.cos(hh));
};
let lastInfo = 0;

function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (state.playRate > 0) {
    state.simTime += dt * 1000 * state.playRate;
    syncTimeUi();
  }

  const { preset } = state;
  // 飞机当前的经纬度：起点 + 累计位移
  const [curLat, curLon] = ground.localFrame.toGeo(cloudUniforms.uCloudOffset.value.x, cloudUniforms.uCloudOffset.value.y);
  const sun = sunPosition(new Date(state.simTime), curLat, curLon, state.altitudeKm * 1000);
  const sunDir = directionFromAzAlt(sun.azimuth, sun.altitude);
  const camR = 6360 + state.altitudeKm;

  // 头部平滑跟随鼠标，像人慢慢挪动身体
  // ---- 颠簸与窗上的水 ----
  if (frameCount++ % 4 === 0) clouds.probe(renderer, ownDirW(state.heading));
  const inCloud = clouds.cameraDensity;
  let turbTarget = 0.03 + Math.min(inCloud * 3, 1) * 0.4;
  const off0 = cloudUniforms.uCloudOffset.value;
  for (const s of weather.storms) {
    const dist = Math.hypot(s.x - off0.x, s.z - off0.y);
    if (state.altitudeKm < s.top + 1) turbTarget = Math.max(turbTarget, 1 - THREE.MathUtils.smoothstep(dist, s.radius * 1.2, s.radius * 6));
  }
  state.turbulence += (turbTarget - state.turbulence) * (1 - Math.exp(-dt * 1.5));
  // 在云里变湿（~3 秒湿透），出来后被气流吹干（~20 秒）
  const wetRate = inCloud > 0.03 ? 0.35 : -0.05;
  state.wetness = THREE.MathUtils.clamp(state.wetness + wetRate * dt, 0, 1);
  const tb = state.turbulence;
  const tt = now / 1000;
  // 几个不成比例的频率叠起来，像不规则的气流冲击
  const shake = (a: number) => Math.sin(tt * 7.3 + a) * 0.5 + Math.sin(tt * 13.1 + a * 2) * 0.3 + Math.sin(tt * 2.9 + a * 3) * 0.6;
  state.rollDeg = tb * 1.2 * shake(0.7);
  const bump = tb * 0.012 * shake(2.1);

  const k = 1 - Math.exp(-dt * 6);
  head.x += (head.tx - head.x) * k;
  head.y += (head.ty - head.y) * k;
  head.z += (head.tz - head.z) * k;

  const moon = moonState(new Date(state.simTime), curLat, curLon, state.altitudeKm * 1000);
  const moonDir = directionFromAzAlt(moon.azimuth, moon.altitude);
  atmosphere.updateSkyView(camR, sunDir[1], moonDir[1]);
  atmosphere.updateAerialPerspective(camR, sunDir[1]);

  // 沿大圆航线飞：航向转向「当前位置到终点」的大圆方位角。客机转弯坡度一般不超过 25°，
  // 对应的转弯角速度 ω = g·tanφ / v（巡航时约 1°/s）；坡度随转弯角速度平滑变化，转弯时窗外的地平线会倾斜
  const vKms = speedAt(state.altitudeKm);
  if (preset.dest) {
    const target = greatCircleBearing(curLat, curLon, preset.dest[0], preset.dest[1]);
    const diff = ((target - state.heading + 540) % 360) - 180;
    const maxRate = THREE.MathUtils.radToDeg((9.81 * Math.tan(THREE.MathUtils.degToRad(25))) / (vKms * 1000));
    const rate = THREE.MathUtils.clamp(diff * 0.3, -maxRate, maxRate); // 接近目标航向时柔和改平
    state.heading = (state.heading + rate * dt + 360) % 360;
    const bankTarget = THREE.MathUtils.radToDeg(Math.atan((vKms * 1000 * THREE.MathUtils.degToRad(rate)) / 9.81));
    state.bankDeg += (bankTarget - state.bankDeg) * (1 - Math.exp(-dt * 0.7));
    // 到达终点附近：回到起点重新飞
    if (haversineKm(curLat, curLon, preset.dest[0], preset.dest[1]) < 40) setPreset(preset.id);
  } else {
    state.bankDeg *= Math.exp(-dt);
  }

  // 飞机向前飞：云场按航向平移
  const h = THREE.MathUtils.degToRad(state.heading);
  // 飞行阶段：朝目标高度爬升或下降，俯仰角跟着变（爬升抬头约 8°，下降约 0°，巡航 2.5°）
  const dAlt = state.targetAltKm - state.altitudeKm;
  const climbing = Math.abs(dAlt) > 0.005;
  if (climbing) {
    state.altitudeKm += Math.sign(dAlt) * Math.min(Math.abs(dAlt), ALT_RATE_KMS * dt);
    altInput.value = state.altitudeKm.toFixed(1);
    $("altitude-out").textContent = `${state.altitudeKm.toFixed(1)} km → ${state.targetAltKm.toFixed(1)} km`;
  }
  const lowAndSlow = state.altitudeKm < 2 ? 3.5 : CRUISE_PITCH_DEG; // 低空低速时迎角更大，机头更高
  const pitchTarget = climbing ? (dAlt > 0 ? 8 : 0) : lowAndSlow;
  state.pitchDeg += (pitchTarget - state.pitchDeg) * (1 - Math.exp(-dt * 0.8));
  const speedKms = speedAt(state.altitudeKm);
  const step = speedKms * dt;
  cloudUniforms.uCloudOffset.value.x += Math.sin(h) * step;
  cloudUniforms.uCloudOffset.value.y += -Math.cos(h) * step;
  const motion = new THREE.Vector3(Math.sin(h) * step, 0, -Math.cos(h) * step);
  const ownDir = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
  const outwardW = new THREE.Vector3(Math.cos(h), 0, Math.sin(h)).multiplyScalar(state.seat === "right" ? 1 : -1);
  traffic.update(dt, ownDir, speedKms, outwardW);
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
  u.uIslandDensity.value = state.groundOn ? 0 : preset.islands;
  u.uGroundOn.value = state.groundOn ? 1 : 0;
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
  u.uStrobe.value = ph < 0.05 || (ph > 0.14 && ph < 0.19) ? 1 : 0;
  // 舱灯开：约 200 lux；关：只剩地板灯带和零星阅读灯，约 1 lux
  u.uCabinLight.value = state.cabinLight ? 0.2 : 0.001;
  clouds.render(motion, camBasis, c2w);
  u.uClouds.value = clouds.texture;
  pass.render(sceneMat, hdr);
  exposure.render(hdr.texture, bloom.render(hdr), dt);

  if (now - lastInfo > 250) {
    lastInfo = now;
    const outward = state.heading + (state.seat === "right" ? 90 : -90);
    info.textContent =
      `太阳高度角 ${sun.altitude.toFixed(1)}°，方位 ${sun.azimuth.toFixed(0)}°（${compass(sun.azimuth)}）\n` +
      `月亮高度角 ${moon.altitude.toFixed(1)}°，方位 ${moon.azimuth.toFixed(0)}°，照亮 ${Math.round(moon.phaseFraction * 100)}%
` +
      `航向 ${state.heading.toFixed(0)}°${Math.abs(state.bankDeg) > 2 ? `（坡度 ${state.bankDeg.toFixed(0)}°）` : ""}，窗外朝${compass(outward)}，高度 ${state.altitudeKm.toFixed(1)} km` +
      (preset.dest ? `，距终点 ${haversineKm(curLat, curLon, preset.dest[0], preset.dest[1]).toFixed(0)} km` : "") + "\n" +
      `位置 ${curLat.toFixed(3)}°N ${curLon.toFixed(3)}°E` + (state.groundOn && ground.pending > 0 ? `，地面瓦片加载中（${ground.pending}）` : "");
  }
  requestAnimationFrame(frame);
}
// 先让浏览器把加载遮罩画出来，再画第一帧：第一帧要编译所有着色器，首次打开时会阻塞很久
requestAnimationFrame(() =>
  setTimeout(() => {
    tick("首帧之前的初始化");
    frame(performance.now());
    renderer.getContext().finish();
    tick("首帧（含着色器编译）");
    (window as unknown as { __voyageStartup: unknown }).__voyageStartup = startup;
    $("loading").classList.add("done");
  }, 50),
);

// 调试句柄：浏览器控制台里可以看 / 改状态，自动化截图也靠它
(window as unknown as { __voyage: unknown }).__voyage = { state, head, cloudUniforms, snapAll, clouds, resize, sceneMat, exposure, traffic, ground, weather };
