import * as THREE from "three";
import type { SunPosition, MoonState } from "./astro";
import { CLOUD_PRESETS, type Clouds, type CloudUniforms } from "./clouds/clouds";
import { effectiveTargetKm, resetAltitudeFloor, FLOOR_LAND_AGL_KM, FLOOR_SEA_KM, PRESETS, haversineKm } from "./flight";
import type { Exposure } from "./render/exposure";
import { $, type HighLiftSetting, type VoyageState } from "./state";
import { WEATHER_PRESETS, type WeatherSystem } from "./weather";
import { VIEW_PRESETS } from "./view-presets";
import type { Director } from "./director";
import { WONDERS } from "./wonders/catalog";
import { RARITY_LEVELS, type WonderSystem } from "./wonders/system";

/**
 * 面板：DOM 绑定、信息栏文字、方位文字（COMPASS）。从 main.ts 拆出（T01 纯重构，未改动任何取值或绑定顺序）。
 */

export const COMPASS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

// ---------- 时间：按预设时区显示当地日期与时刻 ----------
export function localParts(ms: number, tz: number) {
  const d = new Date(ms + tz * 3600e3);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60,
  };
}

export function fromLocal(date: string, minutes: number, tz: number) {
  return Date.parse(`${date}T00:00:00Z`) - tz * 3600e3 + minutes * 60e3;
}

const dateInput = $<HTMLInputElement>("date");
const timeInput = $<HTMLInputElement>("time");
const timeLabel = $("time-label");
const info = $("info");
const altInput = $<HTMLInputElement>("altitude");

export function syncTimeUi(state: VoyageState) {
  const { date, minutes } = localParts(state.simTime, state.preset.tz);
  dateInput.value = date;
  timeInput.value = String(Math.floor(minutes));
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(Math.floor(minutes % 60)).padStart(2, "0");
  const sign = state.preset.tz >= 0 ? "+" : "−";
  timeLabel.textContent = `${hh}:${mm}（UTC${sign}${Math.abs(state.preset.tz)}）`;
}

/** 飞行阶段爬升 / 下降时，高度数字显示「当前 → 目标」；advanceFlight 返回 climbing = true 时调用。
 *  目标按高度下限抬过的话（T18），显示的是实际要去的高度 */
export function syncAltitudeUi(state: VoyageState) {
  altInput.value = state.altitudeKm.toFixed(1);
  $("altitude-out").textContent = `${state.altitudeKm.toFixed(1)} km → ${effectiveTargetKm(state).toFixed(1)} km`;
}

let lastFloorText = "";
/** 高度滑块的可达范围与下限提示（T18）：滑块的最小值跟着下限走，下面一行说明下限从哪来 */
function syncFloorUi(state: VoyageState) {
  const f = state.floor;
  if (!f) return;
  // 向上取到滑块步长 0.1，免得滑块最小值比下限还低一点
  const min = Math.ceil(f.km * 10 - 1e-6) / 10;
  if (altInput.min !== min.toFixed(1)) altInput.min = min.toFixed(1);
  const text =
    f.reason === "estimate"
      ? `下限 ${min.toFixed(1)} km（地形数据加载中，按陆地离地 ${FLOOR_LAND_AGL_KM} km 估计）`
      : f.reason === "land"
        ? `下限 ${min.toFixed(1)} km：陆地上方离地 ≥ ${FLOOR_LAND_AGL_KM} km（近处地景经不起更低处细看）`
        : `下限 ${min.toFixed(1)} km：海面上方`;
  if (text !== lastFloorText) {
    lastFloorText = text;
    $("altitude-floor").textContent = text;
  }
}

let lastInfo = 0;
/** 信息栏文字：太阳 / 月亮方位、航向、位置，每 250 ms 刷新一次 */
export function updateInfo(now: number, sun: SunPosition, moon: MoonState, state: VoyageState, curLat: number, curLon: number, groundPending: number, legLine = "") {
  if (now - lastInfo <= 250) return;
  lastInfo = now;
  syncFloorUi(state);
  const preset = state.preset;
  const outward = state.heading + (state.seat === "right" ? 90 : -90);
  info.textContent =
    `太阳高度角 ${sun.altitude.toFixed(1)}°，方位 ${sun.azimuth.toFixed(0)}°（${compass(sun.azimuth)}）\n` +
    `月亮高度角 ${moon.altitude.toFixed(1)}°，方位 ${moon.azimuth.toFixed(0)}°，照亮 ${Math.round(moon.phaseFraction * 100)}%
` +
    `航向 ${state.heading.toFixed(0)}°${Math.abs(state.bankDeg) > 2 ? `（坡度 ${state.bankDeg.toFixed(0)}°）` : ""}，窗外朝${compass(outward)}，高度 ${state.altitudeKm.toFixed(1)} km` +
    (state.floor?.known && state.floor.groundKm > 0.02 ? `（离地 ${(state.altitudeKm - state.floor.groundKm).toFixed(1)} km）` : "") +
    (preset.dest ? `，距终点 ${haversineKm(curLat, curLon, preset.dest[0], preset.dest[1]).toFixed(0)} km` : "") +
    (state.slatDeg > 0.5 || state.flapDeg > 0.5 ? `，缝翼 ${state.slatDeg.toFixed(0)}° / 襟翼 ${state.flapDeg.toFixed(0)}°` : "") +
    (state.spoilerDeg > 0.5 ? `，减速板 ${state.spoilerDeg.toFixed(0)}°` : "") + "\n" +
    `位置 ${curLat.toFixed(3)}°N ${curLon.toFixed(3)}°E` + (state.groundOn && groundPending > 0 ? `，地面瓦片加载中（${groundPending}）` : "") +
    (legLine ? `
${legLine}` : "");
}

export interface UiDeps {
  state: VoyageState;
  /** 换地点 / 航线：main.ts 里定义（要用到 ground.reset、cloudUniforms 等渲染系统） */
  setPreset: (id: string) => void;
  /** 画面跳变：眼睛直接适应，云的时间累积也清空 */
  snapAll: () => void;
  /** 画布尺寸变化（画质档位也走这个） */
  resize: () => void;
  exposure: Exposure;
  clouds: Clouds;
  weather: WeatherSystem;
  cloudUniforms: CloudUniforms;
  /** 切换视角预设（头平滑挪过去） */
  setView: (id: string) => void;
  /** 当前视角预设的 id */
  currentView: () => string;
  /** 导演（T19a）：连续航程 / 背景板模式 */
  director: Director;
  /** 奇观系统（W01） */
  wonders: WonderSystem;
}

/** 绑定面板上的所有控件。调用一次，顺序和原来 main.ts 里一致。 */
export function setupUi(deps: UiDeps) {
  const { state, setPreset, snapAll, resize, exposure, clouds, weather, cloudUniforms, setView, currentView, director } = deps;

  const presetSel = $<HTMLSelectElement>("preset");
  presetSel.innerHTML = PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");

  presetSel.addEventListener("change", () => {
    setPreset(presetSel.value);
    // 高度下限按新地点重估（T18），滑块的最小值立刻跟上：紧接着设高度时不会被上一个地点的下限夹住
    resetAltitudeFloor(state);
    syncFloorUi(state);
  });
  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    state.simTime = fromLocal(dateInput.value, Number(timeInput.value), state.preset.tz);
    snapAll();
    syncTimeUi(state);
  });
  timeInput.addEventListener("input", () => {
    state.simTime = fromLocal(dateInput.value, Number(timeInput.value), state.preset.tz);
    snapAll();
    syncTimeUi(state);
  });
  $("now").addEventListener("click", () => {
    state.simTime = Date.now();
    snapAll();
    syncTimeUi(state);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-rate]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.playRate = Number(btn.dataset.rate);
      document.querySelectorAll("[data-rate]").forEach((b) => b.classList.toggle("on", b === btn));
    });
  });
  $<HTMLInputElement>("ground-on").addEventListener("change", (e) => {
    state.groundOn = (e.target as HTMLInputElement).checked;
    resetAltitudeFloor(state);
    syncFloorUi(state);
    snapAll();
  });
  $<HTMLSelectElement>("wing-pos").addEventListener("change", (e) => {
    state.wingRootLE = Number((e.target as HTMLSelectElement).value);
    if (currentView() === "wing") setView("wing"); // 「看机翼」的朝向跟着机翼在前还是在后
    snapAll();
  });
  $<HTMLSelectElement>("high-lift").addEventListener("change", (e) => {
    state.highLift = (e.target as HTMLSelectElement).value as HighLiftSetting;
  });
  $<HTMLSelectElement>("seat").addEventListener("change", (e) => {
    state.seat = (e.target as HTMLSelectElement).value as "right" | "left";
    setView(currentView()); // 预设里的「朝机头 / 朝机尾」换到新座位的坐标
    snapAll();
  });
  const viewSel = $<HTMLSelectElement>("view-preset");
  viewSel.innerHTML = VIEW_PRESETS.map((v) => `<option value="${v.id}">${v.name}</option>`).join("");
  viewSel.addEventListener("change", () => setView(viewSel.value));

  function bindRange(id: string, apply: (v: number) => string) {
    const input = $<HTMLInputElement>(id);
    const out = $(`${id}-out`);
    const update = () => (out.textContent = apply(Number(input.value)));
    input.addEventListener("input", update);
    update();
  }
  bindRange("altitude", (v) => {
    // 不低于高度下限（T18）：滑块的 min 已经跟着下限走，这里再保底一次（下限刚变、滑块还没同步的那一帧）
    v = Math.max(v, state.floor?.km ?? FLOOR_SEA_KM);
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
  // 舱灯三档：开 / 睡眠（主灯关、氛围灯开）/ 全关（只剩阅读灯）
  $<HTMLSelectElement>("cabin-light").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    state.cabinLight = v === "true";
    state.moodLight = v !== "off";
  });
  // 舱等（T25）：只改状态，main.ts 每帧按它挑舱内合成的着色器变体（没编过的先后台编译，编好才切）
  $<HTMLSelectElement>("cabin-class").addEventListener("change", (e) => {
    state.cabinClass = (e.target as HTMLSelectElement).value === "economy" ? "economy" : "business";
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "h" || e.key === "H") $("panel").classList.toggle("hidden");
  });
  setupVoyageUi(director);
  setupWonderUi(deps.wonders);

  $<HTMLSelectElement>("quality").addEventListener("change", (e) => {
    clouds.resolutionScale = Number((e.target as HTMLSelectElement).value);
    resize();
  });
}

// ---------- 连续航程 / 背景板模式（T19a） ----------

/** 背景板模式下鼠标静止多久后隐藏光标与提示（毫秒） */
const BACKDROP_IDLE_MS = 2500;

function setupVoyageUi(director: Director) {
  const voyageBox = $<HTMLInputElement>("voyage-on");
  const rateBtns = document.querySelectorAll<HTMLButtonElement>("[data-voyage-rate]");
  const timeRateBtns = document.querySelectorAll<HTMLButtonElement>("[data-rate]");
  const hint = $("backdrop-hint");
  const body = document.body;

  /** 面板控件与导演状态对齐：连续航程开着时，「时间流速」按钮让位给航程流速（两者都推时间，避免叠加） */
  function sync() {
    voyageBox.checked = director.active;
    rateBtns.forEach((b) => b.classList.toggle("on", director.active && Number(b.dataset.voyageRate) === director.rate));
    timeRateBtns.forEach((b) => (b.disabled = director.active));
    $("voyage-rates").hidden = !director.active;
    body.classList.toggle("backdrop", director.backdrop);
    if (!director.backdrop) body.classList.remove("backdrop-idle");
  }

  voyageBox.addEventListener("change", () => {
    director.setActive(voyageBox.checked);
    sync();
  });
  rateBtns.forEach((b) =>
    b.addEventListener("click", () => {
      director.rate = Number(b.dataset.voyageRate);
      sync();
    }),
  );

  let idleTimer = 0;
  const wake = () => {
    if (!director.backdrop) return;
    body.classList.remove("backdrop-idle");
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => body.classList.add("backdrop-idle"), BACKDROP_IDLE_MS);
  };
  function setBackdrop(on: boolean) {
    if (on && !director.active) director.setActive(true);
    director.backdrop = on;
    $("panel").classList.toggle("hidden", on);
    sync();
    if (on) {
      wake();
    } else window.clearTimeout(idleTimer);
  }
  $("backdrop-on").addEventListener("click", () => setBackdrop(true));
  $("backdrop-exit").addEventListener("click", () => setBackdrop(false));
  window.addEventListener("mousemove", wake);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && director.backdrop) setBackdrop(false);
    if ((e.key === "b" || e.key === "B") && !(e.target instanceof HTMLInputElement)) setBackdrop(!director.backdrop);
  });
  hint.hidden = false;
  sync();
  // 调试 / 测试脚本用
  (window as unknown as { __voyageUi?: unknown }).__voyageUi = { setBackdrop, sync };
}

// ---------- 奇观模式（W01） ----------

function setupWonderUi(wonders: WonderSystem) {
  const box = $<HTMLInputElement>("wonders-on");
  const controls = $("wonder-controls");
  const pick = $<HTMLSelectElement>("wonder-pick");
  const status = $("wonder-status");
  pick.innerHTML = `<option value="">按此刻的条件挑一个</option>` + WONDERS.map((w) => `<option value="${w.id}">${w.name}</option>`).join("");
  const sync = () => {
    box.checked = wonders.enabled;
    controls.hidden = !wonders.enabled;
  };
  box.addEventListener("change", () => {
    wonders.enabled = box.checked;
    if (!box.checked) wonders.clear();
    sync();
  });
  const rarity = $<HTMLInputElement>("wonder-rarity");
  const rarityOut = $("wonder-rarity-out");
  const applyRarity = () => {
    const lv = RARITY_LEVELS[Math.round(Number(rarity.value))] ?? RARITY_LEVELS[1];
    wonders.rarityPerHour = lv.perHour;
    rarityOut.textContent = `${lv.name}（每小时约 ${lv.perHour} 次）`;
  };
  rarity.addEventListener("input", applyRarity);
  applyRarity();
  // 立即召唤：放在窗外略偏机头处，用 20 秒浮现（自动出现时是 1.5–2 分钟）
  $("wonder-summon").addEventListener("click", () => {
    wonders.enabled = true;
    wonders.clear();
    wonders.trigger(pick.value || undefined, { riseS: 20, forwardOffsetDeg: 6 });
    sync();
  });
  $("wonder-dismiss").addEventListener("click", () => wonders.dismiss());
  let last = "";
  window.setInterval(() => {
    const t = wonders.describe();
    if (t !== last) status.textContent = last = t;
  }, 500);
  sync();
}
