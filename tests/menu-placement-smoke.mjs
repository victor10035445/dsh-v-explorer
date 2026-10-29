/**
 * 右键浮层视口内定位冒烟（placeMenu 纯函数，不依赖 DOM）：
 *  1. 视口内正常落位（右下展开，坐标 = 光标）
 *  2. 右侧放不下 → 翻到光标左侧；下侧放不下 → 翻到光标上方
 *  3. 翻转后仍越界（菜单大于剩余空间）→ 贴边
 *  4. 恰好放下（边界相等）不翻转
 *  5. 菜单比视口还大 → 贴边 + maxHeight 压缩高度
 *  6. 量不到视口 / 脏入参 → 退回裸坐标，绝不产出 NaN
 * 运行：node tests/menu-placement-smoke.mjs
 */
import { placeMenu, MENU_MARGIN } from "../src/menu-placement.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};
const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`FAIL: ${message}（actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}）`);
};

const VW = 1200;
const VH = 800;
const W = 200;
const H = 180;
const place = (over = {}) =>
  placeMenu({ x: 100, y: 100, width: W, height: H, viewportWidth: VW, viewportHeight: VH, ...over });

/* ---- 1. 视口内：坐标即光标 ---- */
{
  const p = place();
  eq(p.left, 100, "内部落位 left = 光标");
  eq(p.top, 100, "内部落位 top = 光标");
  eq(p.maxHeight, VH - 2 * MENU_MARGIN, "maxHeight = 视口高 - 2×间隙");
}

/* ---- 2. 右/下边缘翻转（翻转基准是光标） ---- */
{
  const p = place({ x: 1100, y: 700 });
  eq(p.left, 1100 - W, "右侧放不下 → 翻到光标左侧");
  eq(p.top, 700 - H, "下侧放不下 → 翻到光标上方");
  assert(p.left + W <= VW - MENU_MARGIN, "翻转后整体仍在视口内（右）");
  assert(p.top + H <= VH - MENU_MARGIN, "翻转后整体仍在视口内（下）");
}

/* ---- 3. 恰好放下不翻转（边界相等即算放得下） ---- */
{
  const p = place({ x: VW - MENU_MARGIN - W, y: VH - MENU_MARGIN - H });
  eq(p.left, VW - MENU_MARGIN - W, "右边界恰好放下：不翻转");
  eq(p.top, VH - MENU_MARGIN - H, "下边界恰好放下：不翻转");
  const over = place({ x: VW - MENU_MARGIN - W + 1, y: 0 });
  eq(over.left, VW - MENU_MARGIN - W + 1 - W, "越 1px 即翻转");
}

/* ---- 4. 翻转后仍越界：贴边（左/上边界） ---- */
{
  /* 光标贴左上角、菜单比光标到边缘的距离还大 → 翻转后为负 → 夹到 margin */
  const p = place({ x: 3, y: 2 });
  eq(p.left, MENU_MARGIN, "左侧空间不足 → 贴左边 margin");
  eq(p.top, MENU_MARGIN, "上方空间不足 → 贴顶边 margin");
}

/* ---- 5. 菜单比视口还大：贴边 + maxHeight ---- */
{
  const p = place({ x: 40, y: 40, width: 2000, height: 2000 });
  eq(p.left, MENU_MARGIN, "超宽菜单：left 贴 margin");
  eq(p.top, MENU_MARGIN, "超高菜单：top 贴 margin");
  eq(p.maxHeight, VH - 2 * MENU_MARGIN, "超高菜单：maxHeight 压到视口内");
  assert(p.maxHeight < 2000, "maxHeight 必须真正压缩");
}

/* ---- 6. 量不到视口 / 脏入参：退回裸坐标，不产出 NaN ---- */
{
  const p = placeMenu({ x: 250, y: 350, width: W, height: H });
  eq(p.left, 250, "无视口尺寸：left 退回光标");
  eq(p.top, 350, "无视口尺寸：top 退回光标");
  eq(p.maxHeight, undefined, "无视口尺寸：不给 maxHeight（交给 CSS）");

  const dirty = placeMenu({ x: NaN, y: undefined, width: NaN, height: null, viewportWidth: 800, viewportHeight: 600 });
  assert(Number.isFinite(dirty.left) && Number.isFinite(dirty.top), "脏入参不产出 NaN");
  eq(dirty.left, MENU_MARGIN, "脏 x → 贴 margin");
  eq(dirty.top, MENU_MARGIN, "脏 y → 贴 margin");

  const noArg = placeMenu();
  assert(Number.isFinite(noArg.left) && Number.isFinite(noArg.top), "空入参不产出 NaN");
}

/* ---- 7. 自定义 margin ---- */
{
  const p = place({ x: 2, y: 2, margin: 24 });
  eq(p.left, 24, "自定义 margin 生效（left）");
  eq(p.top, 24, "自定义 margin 生效（top）");
  /* 负 margin 视为 0：贴边夹取应落在 0 而不是 2（光标内部、无需夹取时不改坐标） */
  const neg = placeMenu({ x: 500, y: 500, width: 800, height: 800, viewportWidth: 1200, viewportHeight: 800, margin: -5 });
  eq(neg.left, 0, "负 margin 归零（贴边落到 0）");
  eq(neg.top, 0, "负 margin 归零（贴顶落到 0）");
}

/* ---- 8. 小视口（小于 2×margin）：maxHeight 不为负 ---- */
{
  const p = place({ viewportWidth: 120, viewportHeight: 10 });
  assert(p.maxHeight >= 0, "极小视口 maxHeight 不为负");
}

console.log("\nALL MENU-PLACEMENT SMOKE TESTS PASSED");
