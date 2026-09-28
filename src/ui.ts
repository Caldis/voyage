import * as THREE from "three";
import type { SunPosition, MoonState } from "./astro";
import { CLOUD_PRESETS, type Clouds, type CloudUniforms } from "./clouds/clouds";
import { effectiveTargetKm, resetAltitudeFloor, FLOOR_LAND_AGL_KM, FLOOR_SEA_KM, PRESETS, haversineKm } from "./flight";
import type { Exposure } from "./render/exposure";
import { CABIN_REFLECT_STRENGTH } from "./render/cabin-reflect.glsl";
import { $, type HighLiftSetting, type VoyageState } from "./state";
import { REGIME_NAMES, WEATHER_PRESETS, type WeatherSystem } from "./weather";
import { VIEW_PRESETS } from "./view-presets";
import type { Director } from "./director";
import { AIRPORTS } from "./routes";
import { WONDERS } from "./wonders/catalog";
import { RARITY_LEVELS, type WonderSystem } from "./wonders/system";
import { describeGroundRes, groundResPref, isHeavyWeather, setGroundResPref, type GroundResPref, type QualityController, type QualityTier } from "./quality";
import type { CabinAudio } from "./audio";
import type { RailSoundSource } from "./rail/audio-rail";
import type { DebugMinimap } from "./debug/minimap";
import { FOCUS_MAG, FOCUS_MS, FOCUS_VIGNETTE, type FocusZoom } from "./focus-zoom";

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

// ---------- 快捷键守卫与分段按钮状态（UX-1a，PANEL_UX_GUIDE §8） ----------

/** 不接收字母输入的 input 类型：焦点停在这些控件上时，单字母快捷键照常生效（点完复选框 / 滑条再按 M、H 不该失灵） */
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/** 焦点是否在「会吃掉字母键」的控件里：文字类输入框（含日期框）、下拉（打字母跳选项）、文本框、可编辑区 */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(t.type);
}

/** 单字母快捷键（H / B / M / N）统一判断：键对上、不带 Ctrl / Alt / Meta、焦点不在会吃字母的控件里 */
function isLetterShortcut(e: KeyboardEvent, letter: string): boolean {
  return e.key.toLowerCase() === letter && !e.ctrlKey && !e.altKey && !e.metaKey && !isTypingTarget(e.target);
}

/** 方向键归焦点控件所有：任何 input（滑条用方向键调值）、下拉、文本框、可编辑区 */
function ownsArrowKeys(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}

/** 分段按钮的选中态：`.on` 类管外观，`aria-pressed` 给读屏器 */
function setPressed(btn: HTMLButtonElement, on: boolean) {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
}

/** 火车模式下飞机专用控件的禁用原因（写进 title；面板上「交通工具」下方另有一行说明） */
const TRAIN_DISABLED_REASON = "火车模式下不可用（飞机专用）；把「交通工具」切回「飞机」即可使用";

const dateInput = $<HTMLInputElement>("date");
const timeInput = $<HTMLInputElement>("time");
const timeLabel = $("time-label");
const info = $("info");
const altInput = $<HTMLInputElement>("altitude");
// 「此刻」摘要（UX-3，PANEL_UX_GUIDE §2.1）：常驻的 1–2 行，普通区；完整信息留在开发者区的 #info（见 updateInfo）
const nowLine1 = $("now-line1");
const nowLine2 = $("now-line2");

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
/**
 * 信息栏文字：太阳 / 月亮方位、航向、位置，每 250 ms 刷新一次。
 * UX-3（PANEL_UX_GUIDE §2.1）：同时写两份——完整版留在开发者区的 `#info`（原样不变，dev-browser 截图 JSON 读它的
 * textContent，见 scripts/scenarios.mjs）；普通区的「此刻」摘要（`#now-line1` / `#now-line2`）只挑用户关心的几件事：
 * 航段 / 导航一句、当地时刻、窗外朝向、天气一句，不放太阳 / 月亮高度角、经纬度小数点后三位这类开发者数字。
 */
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

  // 摘要第一行：连续航程 / 导航一句（有的话）；没有就退回高度（窗外朝向已经在第二行，不重复）
  const navLine = legLine.split("\n")[0] ?? "";
  nowLine1.textContent = navLine || `高度 ${state.altitudeKm.toFixed(1)} km`;
  // 摘要第二行：当地时刻 · 窗外朝向 · 天气一句。只用云型 + 云量（读已渲染好的下拉文字 / 输出文字，不重复一份天气
  // 描述逻辑）——天气系统名称较长（如「无特殊天气（只有云层）」），完整名称在展开「天气」区可见，不进摘要行
  const cloudSelEl = document.getElementById("cloud-preset") as HTMLSelectElement | null;
  const coverageOutEl = document.getElementById("coverage-out");
  const cloudName = cloudSelEl?.selectedOptions[0]?.textContent ?? "";
  const coverageText = coverageOutEl?.textContent ?? "";
  nowLine2.textContent = `${timeLabel.textContent ?? ""} · 窗外朝${compass(outward)} · ${cloudName} ${coverageText}`.replace(/\s+/g, " ").trim();
}

export interface UiDeps {
  state: VoyageState;
  /** 换地点 / 航线：main.ts 里定义（要用到 ground.reset、cloudUniforms 等渲染系统） */
  setPreset: (id: string) => void;
  /** 画面跳变：眼睛直接适应，云的时间累积也清空 */
  snapAll: () => void;
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
  /** 画质档位（PERF-5）：自动 / 高 / 中 / 低 */
  quality: QualityController;
  /** 声音（T11） */
  audio: CabinAudio;
  /** 调试小地图（DX-06） */
  minimap: DebugMinimap;
  /** 交通工具（TR02）：飞机 / 火车切换（rail/mode.ts 的 RailMode） */
  vehicle: VehicleControl;
  /** 聚焦观察（FOCUS-ZOOM）：开发者区的倍率 / 过渡 / 暗角，按住 Z 聚焦 */
  focus: FocusZoom;
}

/** 面板需要的火车模式接口（rail/mode.ts 的 RailMode 满足它；这里只声明用到的部分，免得 ui.ts 引入 rail 模块） */
export interface VehicleControl extends RailSoundSource {
  readonly active: boolean;
  readonly loading: boolean;
  readonly status: string;
  onChange: (() => void) | null;
  setVehicle(v: "plane" | "train"): Promise<void>;
}

/** 绑定面板上的所有控件。调用一次，顺序和原来 main.ts 里一致。 */
export function setupUi(deps: UiDeps) {
  const { state, setPreset, snapAll, exposure, clouds, weather, cloudUniforms, setView, currentView, director, quality } = deps;

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
  const timeRateBtns = document.querySelectorAll<HTMLButtonElement>("[data-rate]");
  timeRateBtns.forEach((btn) => {
    setPressed(btn, btn.classList.contains("on")); // 初始选中项沿用 index.html 的 class="on"
    btn.addEventListener("click", () => {
      state.playRate = Number(btn.dataset.rate);
      timeRateBtns.forEach((b) => setPressed(b, b === btn));
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
    // PERF-5：雷暴 / 台风一上来就重，别等自适应的持续时间判断才反应，先发制人退一档
    quality.hintHeavyScene(isHeavyWeather(weatherSel.value));
  }
  weatherSel.addEventListener("change", applyWeather);
  // 舱灯三档：开 / 睡眠（主灯关、氛围灯开）/ 全关（只剩阅读灯）
  $<HTMLSelectElement>("cabin-light").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    state.cabinLight = v === "true";
    state.moodLight = v !== "off";
  });
  setupReflectUi();
  // 舱等（T25）：只改状态，main.ts 每帧按它挑舱内合成的着色器变体（没编过的先后台编译，编好才切）
  $<HTMLSelectElement>("cabin-class").addEventListener("change", (e) => {
    state.cabinClass = (e.target as HTMLSelectElement).value === "economy" ? "economy" : "business";
  });
  window.addEventListener("keydown", (e) => {
    if (isLetterShortcut(e, "h")) $("panel").classList.toggle("hidden");
  });
  setupVoyageUi(director);
  setupWeatherAutoSync(deps);
  setupNavUi(director, deps.vehicle, state);
  setupWonderUi(deps.wonders);
  setupSoundUi(deps.audio);
  deps.audio.attachRail(deps.vehicle); // TR07：火车模式下声音换成火车的声场（只读列车状态）
  setupMinimapUi(deps.minimap);
  setupVehicleUi(deps.vehicle);
  setupDevSection();
  setupPanelFoldUi();
  setupQualitySummary(quality);
  setupFocusUi(deps.focus);

  // 画质（PERF-5）：面板只负责挑档位（自动 / 高 / 中 / 低），具体分辨率 / DPR 上限与自适应逻辑都在 quality.ts
  const qualitySel = $<HTMLSelectElement>("quality");
  qualitySel.value = quality.tier; // 每次载入都是 "auto"（PERF-5，不跨载入记忆），这里只是兜底
  qualitySel.addEventListener("change", () => {
    quality.setTier(qualitySel.value as QualityTier);
  });

  // 地面精度（G07b）：与画质档解耦；手动选择跨载入记忆，这次载入不变，状态行提示下次载入用多大
  const groundResSel = $<HTMLSelectElement>("ground-res");
  const groundResStatus = $("ground-res-status");
  groundResSel.value = groundResPref();
  groundResStatus.textContent = describeGroundRes();
  groundResSel.addEventListener("change", () => {
    setGroundResPref(groundResSel.value as GroundResPref);
    groundResStatus.textContent = describeGroundRes();
  });

  // 下拉选完把焦点还给画面（§4.3）：否则焦点留在下拉上，接着按 ← / → 改的是下拉的值而不是转向、按 H / M 也不灵。
  // 只在用鼠标 / 触摸选的时候还：键盘用户用方向键在下拉里挑选项时，每按一下都会触发 change，那时不能把焦点抢走
  document.querySelectorAll<HTMLSelectElement>("#panel select").forEach((sel) => {
    let viaPointer = false;
    sel.addEventListener("pointerdown", () => (viaPointer = true));
    sel.addEventListener("keydown", () => (viaPointer = false));
    sel.addEventListener("blur", () => (viaPointer = false));
    sel.addEventListener("change", () => {
      if (viaPointer) sel.blur();
      viaPointer = false;
    });
  });
}

// ---------- 窗上倒影强度（REFLECT-OFF） ----------

/** 观看偏好（PANEL_UX_GUIDE §7.1 的 `voyage.pref.view`，结构 { v: 1, ... }）；这里只读写其中的 reflect 字段，其余字段原样保留 */
const VIEW_PREF_KEY = "voyage.pref.view";
/** 默认关：用户 2026-09-29「机舱反光过强了，也请弱化甚至默认关闭」 */
const REFLECT_DEFAULT = 0;

function readViewPref(): Record<string, unknown> {
  try {
    const o = JSON.parse(globalThis.localStorage?.getItem(VIEW_PREF_KEY) ?? "null");
    return o && typeof o === "object" && o.v === 1 ? o : {}; // 不认识的版本当没记过
  } catch {
    return {};
  }
}

/** 页面载入时的倒影强度：URL `?reflect=0..1`（也认 on / off；多个以最后一个为准）> 用户上次亲手拖的值 > 默认 0（关） */
function initialReflect(): number {
  const all = new URLSearchParams(globalThis.location?.search ?? "").getAll("reflect");
  const q = all.length ? all[all.length - 1].toLowerCase() : "";
  const n = q === "on" || q === "true" ? 1 : q === "off" || q === "false" ? 0 : q === "" ? NaN : Number(q);
  if (Number.isFinite(n)) return THREE.MathUtils.clamp(n, 0, 1);
  const saved = readViewPref().reflect;
  if (typeof saved === "number" && Number.isFinite(saved)) return THREE.MathUtils.clamp(saved, 0, 1);
  return REFLECT_DEFAULT;
}

function setupReflectUi() {
  const input = $<HTMLInputElement>("cabin-reflect");
  const out = $("cabin-reflect-out");
  input.value = String(initialReflect());
  const update = () => {
    const v = Number(input.value);
    CABIN_REFLECT_STRENGTH.value = v;
    out.textContent = v === 0 ? "关" : `${Math.round(v * 100)}%`;
    input.setAttribute("aria-valuetext", out.textContent);
  };
  const save = (e: Event) => {
    // 只记用户亲手的操作（isTrusted）：回归 / 测量脚本派发的事件不写；URL 给的初值本身也从不写
    if (!e.isTrusted) return;
    try {
      globalThis.localStorage?.setItem(VIEW_PREF_KEY, JSON.stringify({ ...readViewPref(), v: 1, reflect: Number(input.value) }));
    } catch {
      // 隐私模式等拿不到 localStorage：不记
    }
  };
  input.addEventListener("input", update);
  input.addEventListener("change", save); // 松手时写一次
  // 双击复位到默认（关），PANEL_UX_GUIDE §4.2
  input.addEventListener("dblclick", (e) => {
    input.value = String(REFLECT_DEFAULT);
    update();
    save(e);
  });
  update();
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
    rateBtns.forEach((b) => setPressed(b, director.active && Number(b.dataset.voyageRate) === director.rate));
    timeRateBtns.forEach((b) => {
      b.disabled = director.active;
      // 禁用要说明原因（§5.3 规则四）
      b.title = director.active ? "连续航程开着时，时间按下面的「航程流速」走；取消勾选「连续航程」后可用" : "";
    });
    $("voyage-rates").hidden = !director.active;
    body.classList.toggle("backdrop", director.backdrop);
    if (!director.backdrop) body.classList.remove("backdrop-idle");
  }

  voyageBox.addEventListener("change", (e) => {
    director.setActive(voyageBox.checked);
    // 只记用户亲手点的（isTrusted）：回归 / 测量脚本 dispatchEvent 出来的切换不写，免得共享浏览器里把用户的选择改掉
    if (e.isTrusted) saveVoyagePref(voyageBox.checked);
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
    if (isLetterShortcut(e, "b")) setBackdrop(!director.backdrop);
  });
  hint.hidden = false;
  // 250 ms 兜底同步（UX-2，修复审计 P9）：脚本直接改 director.active / director.rate（不经过面板）时，
  // 面板此前只在用户点击等事件里才刷新，会停在旧值；轮询只读系统状态写回显示，不派发事件
  window.setInterval(sync, 250);
  sync();
  voyageSync = sync;
  // 调试 / 测试脚本用
  (window as unknown as { __voyageUi?: unknown }).__voyageUi = { setBackdrop, sync };
}

// ---------- 连续航程默认开启（VOY-DEFAULT） ----------

/** 用户上次手动开 / 关连续航程的选择（"1" / "0"）；没选过就按默认开启 */
const VOYAGE_PREF_KEY = "voyage.continuousJourney";
let voyageSync: (() => void) | null = null;

function saveVoyagePref(on: boolean) {
  try {
    globalThis.localStorage?.setItem(VOYAGE_PREF_KEY, on ? "1" : "0");
  } catch {
    // 隐私模式等拿不到 localStorage：不记，下次载入按默认开启
  }
}

/**
 * 页面载入时连续航程开不开：URL `?voyage=1 / 0`（也认 on / off、true / false；同名参数给了多个时以最后一个为准，
 * 测量工具默认带 voyage=0、`--query "&voyage=1"` 可以覆盖）> 用户上次手动的选择（localStorage）> 默认开启。
 * URL 强制的这一次不写 localStorage。
 */
export function initialVoyageOn(): boolean {
  const all = new URLSearchParams(globalThis.location?.search ?? "").getAll("voyage");
  const q = all.length ? all[all.length - 1].toLowerCase() : "";
  if (["1", "on", "true"].includes(q)) return true;
  if (["0", "off", "false"].includes(q)) return false;
  try {
    if (globalThis.localStorage?.getItem(VOYAGE_PREF_KEY) === "0") return false;
  } catch {
    // 拿不到 localStorage：按默认开启
  }
  return true;
}

/** main.ts 在首次 setPreset 之后调用：按 initialVoyageOn() 开启连续航程（天气直接对齐天气场），面板开关跟上 */
export function startVoyageByDefault(director: Director) {
  if (!initialVoyageOn()) return;
  director.setActive(true, true);
  voyageSync?.();
}

// ---------- 航向控制（T49） ----------

/** 左右转按钮：点一下转 15°；按住 0.5 秒后每 0.2 秒再转 5°（像拧航向旋钮）。方向键 ← / → 每次 5°，Shift + 方向键 15° */
const TURN_CLICK_DEG = 15;
const TURN_REPEAT_DEG = 5;

function setupNavUi(director: Director, vehicle: VehicleControl, s0: VoyageState) {
  const modeBtns = document.querySelectorAll<HTMLButtonElement>("[data-nav]");
  const hdg = $<HTMLInputElement>("hdg");
  const hdgOut = $("hdg-out");
  const dest = $<HTMLSelectElement>("nav-dest");
  const status = $("nav-status");
  const arriveBtn = $<HTMLButtonElement>("debug-arrive");
  const state = () => s0;
  dest.innerHTML =
    `<option value="">选择机场…</option>` +
    Object.values(AIRPORTS)
      .map((a) => `<option value="${a.code}">${a.name}（${a.code}）</option>`)
      .join("");

  let dragging = false;
  let lastStatus = "";
  function sync() {
    const ap = director.ap;
    const s = state();
    // 直飞时三个按钮都不亮（状态行与「直飞机场」下拉显示直飞）
    modeBtns.forEach((b) => setPressed(b, b.dataset.nav === ap.mode));
    // 调试「到达」：手动航向 / 盘旋时没有终点可到（relay 不做事），变灰并说明；火车模式下也不可用
    const manual = ap.mode === "heading" || ap.mode === "hold";
    arriveBtn.disabled = manual || vehicle.active;
    arriveBtn.title = vehicle.active
      ? TRAIN_DISABLED_REASON
      : manual
        ? "手动航向 / 盘旋时没有终点，先点「自动航线」或选一个直飞机场"
        : "不等飞到终点，立即走一次到达：自动航线接下一段，直飞转入盘旋";
    // 手动航向时滑块停在选定航向；其他方式跟着实际航向走（拖动中不去抢）
    const shown = ap.mode === "heading" ? ap.selHeading : s.heading;
    if (!dragging) hdg.value = String(Math.round(shown) % 360);
    hdgOut.textContent = `${String(Math.round(shown) % 360).padStart(3, "0")}°（${compass(shown)}）`;
    const want = ap.mode === "direct" ? (director.leg?.to.code ?? "") : "";
    if (dest.value !== want && document.activeElement !== dest) dest.value = want;
    // 方向键转向的说明已经在左右转按钮的 title 里（UX-3：这里缩短成一句，避免默认状态就占两行）
    const text = director.describeNav() || (s.preset.dest ? "沿航线飞：到达终点上空后自动接下一段" : "保持航向直飞");
    if (text !== lastStatus) status.textContent = lastStatus = text;
  }

  modeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      const m = b.dataset.nav;
      if (m === "route") director.resumeRoute();
      else if (m === "hold") director.hold();
      else director.setHeading(state().heading);
      sync();
    }),
  );
  hdg.addEventListener("input", () => {
    dragging = true;
    director.setHeading(Number(hdg.value));
    sync();
  });
  hdg.addEventListener("change", () => (dragging = false));
  dest.addEventListener("change", () => {
    if (dest.value) director.directTo(dest.value);
    dest.blur(); // 焦点留在下拉框上会吃掉方向键
    sync();
  });

  // 按住连续转
  for (const [id, sign] of [["turn-left", -1], ["turn-right", 1]] as const) {
    const btn = $<HTMLButtonElement>(id);
    let delay = 0, repeat = 0;
    const stop = () => {
      window.clearTimeout(delay);
      window.clearInterval(repeat);
    };
    btn.addEventListener("pointerdown", (e) => {
      if (btn.disabled || e.button !== 0) return;
      director.turnBy(sign * TURN_CLICK_DEG);
      sync();
      stop();
      delay = window.setTimeout(() => {
        repeat = window.setInterval(() => {
          director.turnBy(sign * TURN_REPEAT_DEG);
          sync();
        }, 200);
      }, 500);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, stop);
    // 键盘操作按钮（Tab 到按钮上按回车 / 空格）：pointerdown 不会触发，走 click；鼠标点击的 click 的 detail > 0，已由 pointerdown 处理
    btn.addEventListener("click", (e) => {
      if (e.detail === 0) {
        director.turnBy(sign * TURN_CLICK_DEG);
        sync();
      }
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // 焦点在输入框 / 下拉框 / 文本框里时方向键归它们（滑块、下拉的原生操作）；火车模式下没有航向可控
    // 带 Ctrl / Alt / Meta 的组合键留给浏览器（Alt + ← 是后退）
    if (ownsArrowKeys(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
    if (vehicle.active) return;
    e.preventDefault();
    director.turnBy((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? TURN_CLICK_DEG : TURN_REPEAT_DEG));
    sync();
  });

  $("debug-arrive").addEventListener("click", () => {
    director.forceArrive();
    sync();
  });
  window.setInterval(sync, 250);
  sync();
}

// ---------- 天气 / 云 / 海面风的接管显示（UX-2，PANEL_UX_GUIDE §5.3） ----------

/** 天气 / 云型被锁定（override: "lock"）时统一的原因文案：接管期间禁用，hint / title 写原因与解除办法 */
const WEATHER_LOCK_REASON = "连续航程开着时由天气场决定；关掉连续航程可手动选";

/** 控件旁的「自动」标记：`owned` 时显示；`adjusted` = 用户在本航段内拖动过（nudge 语义升级为「自动（已手动调整）」） */
function setAutoBadge(id: string, owned: boolean, adjusted = false) {
  const el = $(id);
  el.hidden = !owned;
  if (owned) el.textContent = adjusted ? "自动（已手动调整）" : "自动";
}

/**
 * 连续航程接管时，面板显示的值要跟实际一致（UX-2，修复 PANEL_UX_AUDIT_1 的 P1 / P9：云量显示 42% 实际 34%、
 * 海面风速显示 7 m/s 实际 1.0、地点停在旧位置）。三类控件三种语义（PANEL_UX_GUIDE §5.3 规则三，理由见 handoff/UX-2.md）：
 *
 * - 云量 / 云底 / 云厚 / 海面风速：`nudge`。每 250 ms 从 `cloudUniforms` / `state.wind` 回写 value 与 output 文字，
 *   只写显示、不派发事件；拖动中（`input` 到 `change` 之间）的控件不抢。用户亲手拖过（`isTrusted`）后，在当前航段内
 *   标「自动（已手动调整）」——系统本就从新值接着走、慢慢拉回天气场（weather-director.ts 的 stepParams / stepSeaWind，
 *   已有行为，这里只是如实显示，没有新增控制逻辑）；到下一个航段（`director.leg` 换成新对象）自动清空标记，回到「自动」。
 * - 天气系统 / 云型：`lock`。连续航程 + 天气场驱动开着时禁用下拉、`title` 写原因。云型的选项 id 与 `CloudRegime` 同名，
 *   额外把 value 同步成 `director.weather.regime`，不展开下拉也能看出当前云型；天气系统下拉不改 value——天气场此刻
 *   可能同时摆着好几个雷暴 / 台风，没有单一预设能代表，`title` 改用 `director.weather.describe()` 的实时摘要。
 * - 地点：连续航程接力生成的航段（`state.preset.id` 以 `leg-` 开头，不在 `PRESETS` 选项里）时，插入 / 更新一个选项
 *   显示当前航段名（沿用 `director.beginLeg` 已经写好的 `state.preset.name`，不是新造的文案）并选中；不禁用——手动
 *   选别的地点本来就是导演一直支持的显式跳转（`onPresetChanged`），不算「接管冲突」。「自动」标记只在连续航程开着时
 *   显示：关掉后航段名还留着（避免下拉显示一个不存在的地点），但已经没有系统在继续推进它，标记随之消失。
 */
function setupWeatherAutoSync(deps: UiDeps) {
  const { state, director, cloudUniforms } = deps;
  const coverage = $<HTMLInputElement>("coverage");
  const coverageOut = $("coverage-out");
  const cloudBase = $<HTMLInputElement>("cloud-base");
  const cloudBaseOut = $("cloud-base-out");
  const cloudThick = $<HTMLInputElement>("cloud-thick");
  const cloudThickOut = $("cloud-thick-out");
  const wind = $<HTMLInputElement>("wind");
  const windOut = $("wind-out");
  const weatherSel = $<HTMLSelectElement>("weather");
  const cloudSel = $<HTMLSelectElement>("cloud-preset");
  const presetSel = $<HTMLSelectElement>("preset");
  // UX-3：折叠区「天气」的 summary 摘要（只用云型 + 云量，理由同 updateInfo 的「此刻」摘要）
  const weatherSummary = $("weather-summary");

  const isOwned = () => director.active && director.weather.enabled;
  let manual = { coverage: false, base: false, thick: false, wind: false };
  const dragging = { coverage: false, base: false, thick: false, wind: false };
  let lastLeg: unknown = director.leg;
  let legOption: HTMLOptionElement | null = null;

  // 用户亲手拖过（isTrusted）才标「已手动调整」；拖动期间（input → change 之间）250 ms 同步不去抢，松手（change）后恢复跟随
  const track = (key: keyof typeof manual, input: HTMLInputElement) => {
    input.addEventListener("input", (e) => {
      dragging[key] = true;
      if (e.isTrusted && isOwned()) manual[key] = true;
    });
    input.addEventListener("change", () => (dragging[key] = false));
  };
  track("coverage", coverage);
  track("base", cloudBase);
  track("thick", cloudThick);
  track("wind", wind);

  function syncPresetOption() {
    const isLeg = state.preset.id.startsWith("leg-");
    if (isLeg) {
      if (!legOption) {
        legOption = document.createElement("option");
        presetSel.insertBefore(legOption, presetSel.firstChild);
      }
      if (legOption.value !== state.preset.id) legOption.value = state.preset.id;
      if (legOption.textContent !== state.preset.name) legOption.textContent = state.preset.name;
      if (document.activeElement !== presetSel) presetSel.value = state.preset.id;
    } else if (legOption) {
      legOption.remove();
      legOption = null;
    }
    // 地点跳变仍是用户随时可做的操作（不算「接管」），「自动」只表示连续航程还在继续推进这个航段
    setAutoBadge("preset-auto", isLeg && director.active);
  }

  function sync() {
    const owned = isOwned();
    // 换了航段：本航段内的「已手动调整」标记作废，回到「自动」
    if (director.leg !== lastLeg) {
      lastLeg = director.leg;
      manual = { coverage: false, base: false, thick: false, wind: false };
    }
    if (!owned) manual = { coverage: false, base: false, thick: false, wind: false };

    if (owned && !dragging.coverage) {
      const v = cloudUniforms.uCoverage.value;
      coverage.value = String(v);
      coverageOut.textContent = `${Math.round(v * 100)}%`;
    }
    if (owned && !dragging.base) {
      const v = cloudUniforms.uCloudBottom.value;
      cloudBase.value = v.toFixed(1);
      cloudBaseOut.textContent = `${v.toFixed(1)} km`;
    }
    if (owned && !dragging.thick) {
      const v = cloudUniforms.uCloudTop.value - cloudUniforms.uCloudBottom.value;
      cloudThick.value = v.toFixed(1);
      cloudThickOut.textContent = `${v.toFixed(1)} km`;
    }
    if (owned && !dragging.wind) {
      const v = Math.round(state.wind);
      wind.value = String(v);
      windOut.textContent = `${v} m/s`;
    }
    setAutoBadge("coverage-auto", owned, manual.coverage);
    setAutoBadge("cloud-base-auto", owned, manual.base);
    setAutoBadge("cloud-thick-auto", owned, manual.thick);
    setAutoBadge("wind-auto", owned, manual.wind);

    weatherSel.disabled = owned;
    weatherSel.title = owned ? `${director.weather.describe()}；${WEATHER_LOCK_REASON}` : "";
    cloudSel.disabled = owned;
    cloudSel.title = owned ? `当前云型：${REGIME_NAMES[director.weather.regime]}；${WEATHER_LOCK_REASON}` : "";
    setAutoBadge("weather-auto", owned);
    setAutoBadge("cloud-preset-auto", owned);
    if (owned) cloudSel.value = director.weather.regime;

    const cloudName = cloudSel.selectedOptions[0]?.textContent ?? "";
    const coverageText = coverageOut.textContent ?? "";
    weatherSummary.textContent = (owned ? `自动 · ${cloudName} ${coverageText}` : `${cloudName} ${coverageText}`).replace(/\s+/g, " ").trim();

    syncPresetOption();
  }

  window.setInterval(sync, 250);
  sync();
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
  // 250 ms 兜底同步（UX-2，修复审计 P9）：脚本直接改 wonders.enabled（不经过面板）时面板会停在旧值
  window.setInterval(sync, 250);
  sync();
}

// ---------- 声音（T11） ----------

/** 「声音」开关（默认关；勾选 / 按 M 是用户手势，浏览器才允许 AudioContext 出声）、音量、空调气流、提示音。
 *  背景板模式下面板隐藏，但声音照常；M 键在背景板模式里也能开关 */
function setupSoundUi(audio: CabinAudio) {
  const box = $<HTMLInputElement>("sound-on");
  const controls = $("sound-controls");
  const vol = $<HTMLInputElement>("sound-volume");
  const volOut = $("sound-volume-out");
  const ac = $<HTMLInputElement>("sound-aircon");
  const chime = $<HTMLInputElement>("sound-chime");
  const joints = $<HTMLSelectElement>("sound-rail-joints");
  // UX-3：「声音」折叠区标题行本身带开关（PANEL_UX_GUIDE §2.1）；summary 摘要文字
  const summaryText = $("sound-summary-text");
  const sync = () => {
    joints.value = audio.options.railJoints;
    box.checked = audio.enabled;
    controls.hidden = !audio.enabled;
    vol.value = String(Math.round(audio.volume * 100));
    volOut.textContent = `${Math.round(audio.volume * 100)}%`;
    ac.checked = audio.options.aircon;
    chime.checked = audio.options.chime;
    summaryText.textContent = audio.enabled ? `开 · ${Math.round(audio.volume * 100)}%` : "关";
  };
  audio.onChange = sync;
  // 开关挪进了 <summary>：点击它本身不该把整个折叠区跟着收起 / 展开（浏览器默认行为是点击 summary 内任意
  // 位置都触发 <details> 的原生 toggle，除非事件不再冒泡到 summary）。change 事件不受影响，开关照常生效
  box.addEventListener("click", (e) => e.stopPropagation());
  box.addEventListener("change", () => (box.checked ? void audio.enable() : audio.disable()));
  vol.addEventListener("input", () => {
    audio.setVolume(Number(vol.value) / 100);
    volOut.textContent = `${vol.value}%`;
  });
  ac.addEventListener("change", () => audio.setOption("aircon", ac.checked));
  chime.addEventListener("change", () => audio.setOption("chime", chime.checked));
  joints.addEventListener("change", () => audio.setRailJoints(joints.value === "welded" ? "welded" : "jointed"));
  // 火车的车内广播字幕（TR07）：广播时显示站名（声音关着也显示），4 次 / 秒对一次
  const caption = $("rail-caption");
  let lastCaption = "";
  window.setInterval(() => {
    const t = audio.caption;
    if (t === lastCaption) return;
    lastCaption = t;
    if (t) caption.textContent = t;
    caption.classList.toggle("on", !!t);
  }, 250);
  window.addEventListener("keydown", (e) => {
    if (isLetterShortcut(e, "m")) audio.toggle();
  });
  sync();
}

// ---------- 交通工具（TR02） ----------

/** 「交通工具」下拉：切到火车时第一次要拉线路数据（旁边显示「加载中」）；火车模式下飞机专用的控件（地点、高度、机翼位置、襟翼、
 *  连续航程——它会按当前位置接入东亚航线网、改写地点）变灰。时间流速照常可用 */
function setupVehicleUi(vehicle: VehicleControl) {
  const sel = $<HTMLSelectElement>("vehicle");
  const status = $("vehicle-status");
  // T49：航向控制（航向滑块、左右转、直飞、调试「到达」）也是飞机专用
  const planeOnly = ["preset", "altitude", "wing-pos", "high-lift", "voyage-on", "hdg", "nav-dest", "turn-left", "turn-right"].map((id) =>
    $<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(id),
  );
  // 禁用要说明原因（UX-1a，§5.3 规则四）：火车模式下这些控件（及包着它们的标签，悬停标签文字也能看到）的 title 换成原因，
  // 切回飞机时还原各自原来的 title；另在「交通工具」下方显示一行说明
  const hint = $("vehicle-hint");
  const titled: HTMLElement[] = [...planeOnly, ...document.querySelectorAll<HTMLButtonElement>("[data-alt], [data-nav]")];
  for (const el of planeOnly) {
    const label = el.closest("label");
    if (label && !titled.includes(label)) titled.push(label);
  }
  const baseTitle = new Map(titled.map((el) => [el, el.title]));
  const sync = () => {
    sel.value = vehicle.active || vehicle.loading ? "train" : "plane";
    status.textContent = vehicle.status;
    for (const el of planeOnly) el.disabled = vehicle.active;
    document.querySelectorAll<HTMLButtonElement>("[data-alt], [data-nav]").forEach((b) => (b.disabled = vehicle.active));
    for (const el of titled) el.title = vehicle.active ? TRAIN_DISABLED_REASON : (baseTitle.get(el) ?? "");
    hint.hidden = !vehicle.active;
  };
  vehicle.onChange = sync;
  sel.addEventListener("change", () => {
    void vehicle.setVehicle(sel.value === "train" ? "train" : "plane").then(sync);
  });
  sync();
}

// ---------- 调试小地图（DX-06） ----------

/** 面板开关 + 快捷键 N（不在输入框里时）。地图本身默认关，画在左下角，是独立于面板的 canvas 叠层 */
function setupMinimapUi(minimap: DebugMinimap) {
  const box = $<HTMLInputElement>("minimap-on");
  const sync = () => (box.checked = minimap.enabled);
  box.addEventListener("change", () => minimap.setEnabled(box.checked));
  window.addEventListener("keydown", (e) => {
    if (isLetterShortcut(e, "n")) {
      minimap.toggle();
      sync();
    }
  });
  sync();
}

// ---------- 开发者区（FOCUS-ZOOM 起建，PANEL_UX_GUIDE §2.1 / §7） ----------

const PANEL_PREF_KEY = "voyage.pref.panel";

/** 开发者区：默认隐藏；URL 带 ?dev 时本次显示（不写记忆）；Shift + D 切换并记住（只记真实按键） */
function setupDevSection() {
  const sec = $("dev-section");
  let stored = false;
  try {
    const p = JSON.parse(localStorage.getItem(PANEL_PREF_KEY) ?? "null") as { v?: number; dev?: boolean } | null;
    stored = p?.v === 1 && p.dev === true;
  } catch {
    // 拿不到 localStorage：按默认（隐藏）
  }
  // 只认 ?dev、?dev=1 / true / on：dev-browser.mjs 等测量工具用 ?dev=<时间戳> 防缓存，不能被当成「打开开发者区」
  const devParam = new URLSearchParams(location.search).getAll("dev").pop();
  const devUrl = devParam !== undefined && ["", "1", "true", "on"].includes(devParam.toLowerCase());
  sec.hidden = !(devUrl || stored);
  window.addEventListener("keydown", (e) => {
    if (!e.shiftKey || !isLetterShortcut(e, "d")) return;
    sec.hidden = !sec.hidden;
    if (!e.isTrusted) return;
    try {
      const p = (JSON.parse(localStorage.getItem(PANEL_PREF_KEY) ?? "null") as Record<string, unknown> | null) ?? {};
      localStorage.setItem(PANEL_PREF_KEY, JSON.stringify({ ...(p.v === 1 ? p : {}), v: 1, dev: !sec.hidden }));
    } catch {
      // 只是不记忆
    }
  });
}

// ---------- 面板分区折叠记忆（UX-3，PANEL_UX_GUIDE §2.3 / §7.1） ----------

/** 六个可折叠区：默认展开（观景、航程）或默认折叠（天气、声音、画质、页脚），与规范 §2.1 的表一致 */
const PANEL_SECTIONS: { id: string; key: string; defaultOpen: boolean }[] = [
  { id: "section-view", key: "view", defaultOpen: true },
  { id: "section-voyage", key: "voyage", defaultOpen: true },
  { id: "section-weather", key: "weather", defaultOpen: false },
  { id: "section-sound", key: "sound", defaultOpen: false },
  { id: "section-quality", key: "quality", defaultOpen: false },
  { id: "section-footer", key: "footer", defaultOpen: false },
];

/**
 * 折叠状态记忆：与开发者区共用同一个 `voyage.pref.panel` 键（PANEL_PREF_KEY，见上面 setupDevSection），
 * 只记用户亲手展开 / 折叠的（`toggle` 事件的 `isTrusted`）——回归 / 截图脚本用 `sc.js` 直接设 `.open` 属性
 * 不触发 `toggle`，不会写记忆；展开 / 折叠本身只是显示，不改变任何渲染状态、不触发任何 apply（§2.3）。
 */
function setupPanelFoldUi() {
  let stored: Record<string, boolean> = {};
  try {
    const p = JSON.parse(localStorage.getItem(PANEL_PREF_KEY) ?? "null") as { v?: number; sections?: Record<string, boolean> } | null;
    if (p?.v === 1 && p.sections && typeof p.sections === "object") stored = p.sections;
  } catch {
    // 拿不到 localStorage：按默认展开 / 折叠
  }
  for (const { id, key, defaultOpen } of PANEL_SECTIONS) {
    const el = document.getElementById(id) as HTMLDetailsElement | null;
    if (!el) continue;
    el.open = key in stored ? stored[key] : defaultOpen;
    el.addEventListener("toggle", (e) => {
      if (!e.isTrusted) return;
      try {
        const p = (JSON.parse(localStorage.getItem(PANEL_PREF_KEY) ?? "null") as Record<string, unknown> | null) ?? {};
        const prevSections = p.v === 1 && p.sections && typeof p.sections === "object" ? (p.sections as Record<string, boolean>) : {};
        const sections = { ...prevSections, [key]: el.open };
        localStorage.setItem(PANEL_PREF_KEY, JSON.stringify({ ...(p.v === 1 ? p : {}), v: 1, sections }));
      } catch {
        // 只是不记忆
      }
    });
  }
}

// ---------- 折叠区摘要：画质（UX-3） ----------

/** 「画质」折叠区 summary 摘要：复用 #quality-status 已经写好的文字（main.ts 每帧调 quality.describe()），
 *  只去掉括号里给开发者看的 GPU 毫秒数 / 预算（规范 §2.1：GPU 毫秒数进开发者区，摘要只留「自动 → 高」这类结论） */
function setupQualitySummary(quality: QualityController) {
  const status = $("quality-status");
  const summary = $("quality-summary");
  const sync = () => {
    const raw = (status.textContent ?? "").trim();
    const idx = raw.indexOf("（");
    const head = idx >= 0 ? raw.slice(0, idx) : raw;
    summary.textContent = quality.tier === "auto" ? head : `${head}（固定）`;
  };
  window.setInterval(sync, 250);
  sync();
}

/**
 * 聚焦观察（FOCUS-ZOOM）：开发者区的三条滑条（倍率 / 过渡时长 / 暗角），双击滑条或标签复位；按住 Z 聚焦（松开还原）。
 * 只记用户亲手改的（isTrusted）；URL ?zoom= / ?zoomms= 生效时 hint 里注明，本次不写记忆（focus-zoom.ts）
 */
function setupFocusUi(focus: FocusZoom) {
  const hint = $("focus-hint");
  const baseHint = hint.textContent ?? "";
  const bind = (id: string, key: "mag" | "ms" | "vignette", spec: { def: number }, fmt: (v: number) => string, get: () => number) => {
    const input = $<HTMLInputElement>(id);
    const out = $(`${id}-out`);
    const show = () => {
      input.value = String(get());
      out.textContent = fmt(get());
      input.setAttribute("aria-valuetext", fmt(get()));
    };
    input.addEventListener("input", (e) => {
      focus.set(key, Number(input.value), e.isTrusted);
      show();
      syncHint();
    });
    // 双击滑条或它的标签复位（§4.2）
    input.closest("label")?.addEventListener("dblclick", (e) => {
      focus.set(key, spec.def, e.isTrusted);
      show();
      syncHint();
    });
    show();
  };
  const syncHint = () => {
    const urls = [focus.fromUrl.mag ? "zoom" : "", focus.fromUrl.ms ? "zoomms" : ""].filter(Boolean);
    hint.textContent = baseHint + (urls.length ? `（URL 参数 ${urls.join(" / ")} 优先）` : "");
  };
  bind("focus-mag", "mag", FOCUS_MAG, (v) => `${v.toFixed(1)}×`, () => focus.mag);
  bind("focus-ms", "ms", FOCUS_MS, (v) => `${Math.round(v)} ms`, () => focus.durationMs);
  // UX-3 发现并修复：这个控件的 id 原来是 "focus-vignette"，与聚焦暗角叠层 div（focus-zoom.ts 用同一个 id）撞了，
  // getElementById 总是先取到那个 div——拖这条滑条从 FOCUS-ZOOM 上线起就没真正生效过（div 没有 .value、不会派发
  // input 事件）。滑条 id 改成 "focus-vig"（index.html 同步改），叠层 div 的 id 不动。
  bind("focus-vig", "vignette", FOCUS_VIGNETTE, (v) => `${Math.round(v * 100)}%`, () => focus.vignette);
  syncHint();

  // 按住 Z 聚焦：与单字母快捷键同一个守卫（焦点在会吃字母的控件里时不触发）；松开时不看焦点（免得卡在放大状态）
  window.addEventListener("keydown", (e) => {
    if (!e.repeat && !e.shiftKey && isLetterShortcut(e, "z")) focus.hold("key", true);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key.toLowerCase() === "z") focus.hold("key", false);
  });
  window.addEventListener("blur", () => focus.hold("key", false));
}
