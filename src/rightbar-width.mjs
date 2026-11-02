/**
 * rightbar-width.mjs — 右侧栏默认宽度落定为契约最小值（specs/sidebar-auto-open ·
 * 默认宽度，2026-09-25 用户补充：自动展开的右栏太宽）。
 *
 * 官方契约（0.2.1-rc.5 dsh-client-ui-layout 实现核实，2026-11-02）：
 *  - 布局 store 的 `layoutInfo.rightbar` 是「保存的宽度偏好」(px)，首开前为 null；
 *    官方以 `rightbar ??= max(300, round(viewport×0.45))` 播种——首开默认即视口
 *    45%，宽屏上过宽（用户诉求）。
 *  - `setRightbar(px)` 是官方唯一的宽度写入口（拖拽把手同路），夹取
 *    [300 = RIGHTBAR_MIN, 视口×0.7 = RIGHTBAR_MAX_RATIO]；0.2.1-rc.5 拖拽把手
 *    实测仍调 `actions.setRightbar`。
 *  - 常量 `RIGHTBAR_MIN` / `RIGHTBAR_DEFAULT_RATIO` 在 `columns.d.ts` 仍为 300 /
 *    0.45（0.2.1-rc.5 核实）。
 *  - 公共面 `ILayout`（ctx.layout）只暴露 selectPanel/toggleSidebar/openRightbar/
 *    closeRightbar，没有宽度 API；但 LayoutController 运行时实例的 `panels`
 *    字段就是布局 store 的绑定动作集（官方 open/close 亦经此调用，绑定时已剥
 *    draft 形参），`panels.setRightbar(300)` 与官方写入口完全同路。
 *  - ⚠ 0.2.1 的 `ILayout.openRightbar` 语义已从「命令」变为「报告」
 *    （"without changing its expanded state"）：本模块 MUST NOT 依赖它触发展开，
 *    展开由页型 openTab（`planSetExpanded(true)`）或官方 corner 按钮承接。
 *
 * 策略：装配时（每次页面冷加载，右列必然未显示、偏好必为 null）把偏好预置为
 * 契约最小 300px——此后官方 `??=` 播种不再生效，自动展开与手动打开都以最小宽度
 * 落出；会话内用户拖拽改写偏好由官方承接，插件不再干预。0.2.1-rc.5 的每会话
 * 持久化（`dsh.sidebar-right.v1`）只存 SurfaceState（页型/分栏/展开态），不含列宽；
 * 布局 store 的 `rightbar` 每次页面加载初始化为 null（`createLayoutStore` init
 * 核实），因此刷新后回到装配拍重新预置 300px——「默认 = 最小宽度」语义不变
 * （真实浏览器落点仍列入 live 验证，design D6；不符即单独立项）。
 *
 * 守卫：
 *  - 形状特性探测：`panels.setRightbar` 缺席（宿主升级后实例形状变化）→
 *    warn 一次并跳过（design D9 降级哲学），自动展开等其余能力不受影响。
 *  - 热重载守卫：插件 patchReload live 重装配时右列可能已在显示（用户布局
 *    在场）——经官方拖拽把手（`[data-side="rightbar"]`，inline left =
 *    视口 − 列宽）反读当前列宽，若偏离官方默认播种值则判定用户已自选宽度，
 *    跳过写入；无把手（正常冷启动必走此路）直接预置。
 */

/** 官方 RIGHTBAR_MIN（columns.d.ts 契约常量，0.2.1-rc.5 核实）。 */
const RIGHTBAR_MIN = 300;
/** 官方首开播种比 RIGHTBAR_DEFAULT_RATIO，用于热重载时识别「仍是默认播种」。
 *  0.2.1-rc.5 仍为 0.45（columns.d.ts 核实）。 */
const RIGHTBAR_DEFAULT_RATIO = 0.45;

export function installRightbarDefaultWidth(ctx) {
  const panels = ctx.layout?.panels;
  if (typeof panels?.setRightbar !== "function") {
    console.warn("[dsh-v-explorer] layout face lacks bound width actions, default width seeding skipped");
    return;
  }
  try {
    /* 热重载守卫：右列在显示时反读当前宽度；非默认播种（用户已自选）则不动。 */
    const handle = typeof document !== "undefined" ? document.querySelector('[data-side="rightbar"]') : null;
    if (handle?.parentElement?.getBoundingClientRect && handle?.style) {
      const viewport = handle.parentElement.getBoundingClientRect().width;
      const current = viewport - Number.parseFloat(handle.style.left);
      const seeded = Math.max(RIGHTBAR_MIN, Math.round(viewport * RIGHTBAR_DEFAULT_RATIO));
      if (Number.isFinite(current) && Math.abs(current - seeded) > 1) return; /* 用户宽度在场 */
    }
    panels.setRightbar(RIGHTBAR_MIN);
  } catch (error) {
    console.warn("[dsh-v-explorer] rightbar default width seeding skipped:", error?.message ?? error);
  }
}
