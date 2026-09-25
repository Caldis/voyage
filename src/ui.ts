import * as THREE from "three";
import type { SunPosition, MoonState } from "./astro";
import { CLOUD_PRESETS, type Clouds, type CloudUniforms } from "./clouds/clouds";
import { PRESETS, haversineKm } from "./flight";
import type { Exposure } from "./render/exposure";
import { $, type VoyageState } from "./state";
import { WEATHER_PRESETS, type WeatherSystem } from "./weather";

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

/** 飞行阶段爬升 / 下降时，高度数字显示「当前 → 目标」；advanceFlight 返回 climbing = true 时调用 */
export function syncAltitudeUi(state: VoyageState) {
  altInput.value = state.altitudeKm.toFixed(1);
  $("altitude-out").textContent = `${state.altitudeKm.toFixed(1)} km → ${state.targetAltKm.toFixed(1)} km`;
}

let lastInfo = 0;
/** 信息栏文字：太阳 / 月亮方位、航向、位置，每 250 ms 刷新一次 */
export function updateInfo(now: number, sun: SunPosition, moon: MoonState, state: VoyageState, curLat: number, curLon: number, groundPending: number) {
  if (now - lastInfo <= 250) return;
  lastInfo = now;
  const preset = state.preset;
  const outward = state.heading + (state.seat === "right" ? 90 : -90);
  info.textContent =
    `太阳高度角 ${sun.altitude.toFixed(1)}°，方位 ${sun.azimuth.toFixed(0)}°（${compass(sun.azimuth)}）\n` +
    `月亮高度角 ${moon.altitude.toFixed(1)}°，方位 ${moon.azimuth.toFixed(0)}°，照亮 ${Math.round(moon.phaseFraction * 100)}%
` +
    `航向 ${state.heading.toFixed(0)}°${Math.abs(state.bankDeg) > 2 ? `（坡度 ${state.bankDeg.toFixed(0)}°）` : ""}，窗外朝${compass(outward)}，高度 ${state.altitudeKm.toFixed(1)} km` +
    (preset.dest ? `，距终点 ${haversineKm(curLat, curLon, preset.dest[0], preset.dest[1]).toFixed(0)} km` : "") + "\n" +
    `位置 ${curLat.toFixed(3)}°N ${curLon.toFixed(3)}°E` + (state.groundOn && groundPending > 0 ? `，地面瓦片加载中（${groundPending}）` : "");
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
}

/** 绑定面板上的所有控件。调用一次，顺序和原来 main.ts 里一致。 */
export function setupUi(deps: UiDeps) {
  const { state, setPreset, snapAll, resize, exposure, clouds, weather, cloudUniforms } = deps;

  const presetSel = $<HTMLSelectElement>("preset");
  presetSel.innerHTML = PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");

  presetSel.addEventListener("change", () => setPreset(presetSel.value));
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

  $<HTMLSelectElement>("quality").addEventListener("change", (e) => {
    clouds.resolutionScale = Number((e.target as HTMLSelectElement).value);
    resize();
  });
}
