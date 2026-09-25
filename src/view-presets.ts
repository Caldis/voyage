/**
 * 视角：头部位置（座舱坐标，米）的预设、范围，以及「按住拖动才转」的交互。
 *
 * 座舱坐标：原点在舱壁内饰面上的窗洞中心，x 沿舱壁（右侧座位朝机头，左侧座位朝机尾），y 向上，z 朝窗外（舱内为负）。
 * 相机总是看向窗板中心，所以「往哪边看」由头的位置决定：头挪到窗口的机头一侧，视线就斜着朝机尾看。
 * head.tx / ty / tz 是目标位置，head.x / y / z 每帧平滑跟随（main.ts），回归脚本直接设这些字段。
 */

export interface Head {
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
}

/** 预设。fwd：头朝机头方向偏移（米，负数朝机尾），换成 x 时乘座位方向；y、z 同座舱坐标 */
export interface ViewPreset {
  id: string;
  name: string;
  fwd: number;
  y: number;
  z: number;
}

/**
 * 头离舱壁内饰面最近能到哪里（z 的上限）。场景着色器按「眼睛在舱壁平面之前（z < 0）」来求窗洞、内衬和遮光板的交点，
 * 眼睛进到窗洞里（z ≥ 0）时这些交点落到眼睛身后，画面会错。留 3 cm 余量：此时眼睛离窗板约 10.5 cm（窗板深 7.5 cm），
 * 窗洞开口（34 × 47 cm）已经超出 50° 的视场，窗框基本看不见，就是额头贴窗的视角。
 */
export const HEAD_Z_NEAR = -0.03;
export const HEAD_Z_FAR = -0.75;
/** 头在舱壁方向（x）、上下（y）能挪的范围 */
export const HEAD_X_RANGE = 0.32;
export const HEAD_Y_MIN = -0.12;
export const HEAD_Y_MAX = 0.18;

export const VIEW_PRESETS: ViewPreset[] = [
  { id: "seated", name: "标准（坐姿看窗）", fwd: 0, y: 0.02, z: -0.42 },
  { id: "close", name: "贴窗（额头贴着窗）", fwd: 0, y: 0.0, z: HEAD_Z_NEAR },
  { id: "wing", name: "看机翼（向后下方）", fwd: 0.2, y: 0.14, z: -0.26 },
  { id: "ahead", name: "看前方（沿机身朝机头）", fwd: -0.3, y: 0.03, z: -0.24 },
  { id: "behind", name: "看后方（沿机身朝机尾）", fwd: 0.3, y: 0.03, z: -0.24 },
];


const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

/** 把预设换成头的目标位置（x 按座位方向换算） */
export function applyViewPreset(head: Head, preset: ViewPreset, seat: "right" | "left") {
  const sign = seat === "right" ? 1 : -1;
  head.tx = clamp(preset.fwd * sign, -HEAD_X_RANGE, HEAD_X_RANGE);
  head.ty = clamp(preset.y, HEAD_Y_MIN, HEAD_Y_MAX);
  head.tz = clamp(preset.z, HEAD_Z_FAR, HEAD_Z_NEAR);
}

/**
 * 画布上按住左键（或手指）拖动才改变视角，松开后停在那里；滚轮前后挪头；双击回到当前视角预设。
 * 面板上的操作不会触发（事件只挂在画布上）。
 */
export function setupViewControls(canvas: HTMLElement, head: Head, resetToPreset: () => void) {
  let drag: { id: number; x: number; y: number } | null = null;
  canvas.style.touchAction = "none"; // 触屏上拖动不要滚动页面
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = (e.clientX - drag.x) / window.innerWidth;
    const dy = (e.clientY - drag.y) / window.innerHeight;
    drag.x = e.clientX;
    drag.y = e.clientY;
    // 往右拖，头往屏幕右侧挪（屏幕右侧对应座舱坐标 −x）；灵敏度和原来「鼠标扫过整个屏幕」一致：横向 0.28 m、纵向 0.2 m
    head.tx = clamp(head.tx - dx * 0.28, -HEAD_X_RANGE, HEAD_X_RANGE);
    head.ty = clamp(head.ty - dy * 0.2, HEAD_Y_MIN, HEAD_Y_MAX);
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("dblclick", () => resetToPreset());
  canvas.addEventListener(
    "wheel",
    (e) => {
      // 往下滚靠近窗。越靠近，每一格挪得越少，贴窗时好控制
      const k = 0.0004 * clamp((HEAD_Z_NEAR - head.tz) / 0.2 + 0.25, 0.25, 1);
      head.tz = clamp(head.tz + e.deltaY * k, HEAD_Z_FAR, HEAD_Z_NEAR);
    },
    { passive: true },
  );
}
