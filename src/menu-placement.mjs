/**
 * menu-placement.mjs — 右键浮层（行菜单 / 框选菜单）的视口内定位：纯函数，node 可直接测。
 *
 * 背景：`.dve-menu` / `.dve-selMenu` 都是 `position: fixed` 且按光标 `clientX/clientY`
 * 直接落位——靠近视口右边或下边时，菜单会被屏幕裁掉。
 *
 * 定位策略（每轴独立）：
 *  1. 先按「右下展开」放（菜单左上角 = 光标）
 *  2. 该方向放不下 → 翻转到光标另一侧（菜单右边/下边贴光标）
 *  3. 翻转后仍越界（菜单比剩余空间还大）→ 贴边，并以 maxHeight 兜底滚动
 *
 * 返回值里的 `maxHeight` 让调用方限制浮层高度（配合 overflow 滚动）——当菜单本身
 * 比视口还高时，任何坐标都放不下，只能压缩高度。浮层必须 `box-sizing:border-box`
 * （`.dve-menu/.dve-selMenu` 已声明），否则 padding+border 会吃掉 2×margin 的余量，
 * 夹取后仍可能越界几像素。
 */

/** 浮层与视口边缘保留的间隙（px）。 */
export const MENU_MARGIN = 8;

const isNum = (value) => typeof value === "number" && Number.isFinite(value);

/** 夹到 [lo, hi]；hi < lo 时以 lo 为准（永不返回 NaN/负向区间）。 */
function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/**
 * 计算浮层在视口内的落位。
 * @param {{x:number, y:number, width:number, height:number,
 *          viewportWidth:number, viewportHeight:number, margin?:number}} input
 *        x/y = 光标视口坐标；width/height = 浮层实测尺寸；
 *        viewportWidth/Height = 视口尺寸（量不到时传 undefined → 退回裸坐标）
 * @returns {{left:number, top:number, maxHeight:number|undefined}}
 */
export function placeMenu({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = MENU_MARGIN
} = {}) {
  const cursorX = isNum(x) ? x : 0;
  const cursorY = isNum(y) ? y : 0;
  const w = isNum(width) ? width : 0;
  const h = isNum(height) ? height : 0;
  const gap = isNum(margin) ? Math.max(0, margin) : MENU_MARGIN;

  /* 量不到视口（非浏览器环境 / 异常值）：退回改造前的裸坐标，绝不落成 NaN */
  if (!isNum(viewportWidth) || !isNum(viewportHeight)) {
    return { left: cursorX, top: cursorY, maxHeight: undefined };
  }

  /* 贴边时的最大偏移。菜单比视口还大时退化为 margin（配合 maxHeight 压缩） */
  const maxLeft = Math.max(gap, viewportWidth - gap - w);
  const maxTop = Math.max(gap, viewportHeight - gap - h);

  /* 该方向放不下就翻到光标另一侧（翻转基准是光标，不是屏幕边） */
  const wantLeft = cursorX + w > viewportWidth - gap ? cursorX - w : cursorX;
  const wantTop = cursorY + h > viewportHeight - gap ? cursorY - h : cursorY;

  return {
    left: clamp(wantLeft, gap, maxLeft),
    top: clamp(wantTop, gap, maxTop),
    maxHeight: Math.max(0, viewportHeight - 2 * gap)
  };
}
