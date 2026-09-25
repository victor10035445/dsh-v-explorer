/**
 * auto-open.mjs — 进入会话自动展开官方右侧栏，并常开 files + bookmarks 两页
 * （specs/sidebar-auto-open；C 语义 design D6 2026-09-25 修订，双页常开为同日用户补充）。
 *
 * C 语义（design D6 2026-09-25 修订）：无「保持关闭」记忆——每次进入会话
 * （新建、切入、切回、页面加载恢复）都尝试展开；手动收起仅作用于当前会话
 * （官方右侧栏状态是每会话内存态，由官方承接）。
 *
 * 双页常开：files（当前工作区树）与 bookmarks 是最常用的两页，展开拍一并落出
 * （各一次 openTab），落完把活动页点回 files——默认前台仍是文件树，书签以第二
 * 个 tab 常驻 tab 条，无需手动补开。三连调用全部公共面安全（官方契约背书）：
 *  - openTab 必然展开列（openContent 先 planSetExpanded(true)）
 *  - 页型在同 pane **去重即聚焦**（stores.d.ts："Opening a page into a pane
 *    that shows it focuses that tab"）——重复 openTab / 补齐重试都幂等，不重建 tab
 *  - active() 无挂载 surface 时返回 undefined（不抛）；focus() 对缺失 tab 静默
 *    忽略、无变化的 focus 不计划不记录
 *
 * 为什么动作只在轮询拍做、绝不在 sessions.list 提交拍做（真机二轮诊断）：
 *  - current 提交回调与 React 换座（旧 seat 卸载 / 新 seat 挂载）是并发的——
 *    提交拍此刻 mounted seat 仍是**即将离开的会话**，openTab('files') 会落在
 *    旧 surface 上，却给新会话记账（settledFor 被污染，此后永不重试）。真机
 *    表现即"新建会话首进不开，切走再切回才开"。
 *  - 轮询拍距提交 ≥700ms，换座早已完成，isExpanded()/openTab 都对准当前
 *    会话 surface；seat 未挂载（慢机器/慢 create RPC）时官方命令抛错——
 *    不记账，下拍重试，直至成功或会话再次变化。
 *  - 官方「新建会话」复用同 workspace 的 blank 会话，current 可能不变、无
 *    提交事件——纯状态比对天然兜住。
 *
 * 公共面事实：ISidebarRight 只有 isExpanded()/toggleExpanded() 读写，没有
 * 展开状态的观察口（服务 d.ts 已核实）；isExpanded() 在"无挂载 surface"时
 * 同样返回 false，故不做任何展开状态推断，只把它当"是否需要展开"的读数。
 *
 * 记账规则：
 *  - 成功（两页落出完成，或已展开且无待补齐）才记账 → 同会话停留期间幂等，
 *    不与用户此后的手动收起/布局调整争抢；失败不记账 → 下拍重试
 *  - retryFor：落页尝试**中途**失败（files 已落出、列已展开）时记下该会话，
 *    下拍无视「已展开」补齐——否则部分失败会被「已展开即不动」吞掉，书签
 *    永久缺席。补齐路径全程幂等（去重即聚焦），且只作用于未记账会话，
 *    不触碰已结算的用户布局
 *  - current 变化即视为新的一次进入（切回历史会话照常展开）
 *  - 无会话（current undefined）记账失效，且 MUST NOT 触发
 *  - 安装时清理旧版本遗留的记忆键（C 语义下不再读取，防混淆）
 */
const LEGACY_CLOSED_KEY = "dsh-v-explorer:sidebarClosed";
const POLL_MS = 700;
/** 连续失败日志节流：首次 + 此后每 5 次失败记一条（console.debug，Verbose 级）。 */
const FAIL_LOG_EVERY = 5;

export function installAutoOpen(ctx, ctxRef, opts = {}) {
  if (!ctx.sidebarRight) return;
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : POLL_MS;
  let settledFor; /* 已成功处理（两页就位或本已展开）的会话；undefined = 尚无 */
  let retryFor; /* 上拍落页尝试中途失败、待补齐的会话（可能已展开） */
  let failStreak = 0;

  const currentSession = () => {
    try {
      const snap = ctx.sessions?.list?.getSnapshot?.();
      return snap?.current;
    } catch {
      return undefined;
    }
  };

  /* 展开并落出两页：files 先行（落在活动 pane、成为前台页），bookmarks 随后
   * 追加为第二个 tab；趁 files 刚聚焦抓它的 tabId，落完书签后点回 files。
   * 全程页型幂等：已开的页去重即聚焦，重试不重建、不改用户既有布局。 */
  const revealTabs = (sidebar) => {
    sidebar.openTab("files");
    const filesTab = typeof sidebar.active === "function" ? sidebar.active() : undefined;
    sidebar.openTab("bookmarks");
    if (filesTab && typeof sidebar.focus === "function") sidebar.focus(filesTab.id);
  };

  const tick = () => {
    const sessionId = currentSession();
    if (sessionId === undefined) {
      if (settledFor !== undefined) settledFor = undefined; /* 无会话空态：记账失效 */
      retryFor = undefined;
      return;
    }
    if (settledFor === sessionId) return; /* 停留期间幂等，不争抢手动收起 */
    try {
      /* 收起 → 展开落两页；已展开但上拍中途失败（retryFor）→ 幂等补齐。 */
      if (!ctx.sidebarRight.isExpanded() || retryFor === sessionId) {
        revealTabs(ctx.sidebarRight);
      }
      settledFor = sessionId; /* 成功才记账；失败下拍重试 */
      retryFor = undefined;
      failStreak = 0;
      console.debug(`[dsh-v-explorer] auto-open: files+bookmarks tabs revealed for session ${sessionId}`);
    } catch (error) {
      /* seat 未挂载 / 非会话面板 / 落页中途失败：不记账，下拍重试（补齐）。 */
      retryFor = sessionId;
      failStreak += 1;
      if (failStreak === 1 || failStreak % FAIL_LOG_EVERY === 0) {
        console.debug(
          `[dsh-v-explorer] auto-open: retrying for session ${sessionId} ` +
            `(streak=${failStreak}: ${error?.message ?? error})`
        );
      }
    }
  };

  ctx.effect(() => {
    /* 旧版「保持关闭」记忆键清理（specs/sidebar-auto-open · 无跨会话关闭记忆）。 */
    try {
      localStorage.removeItem(LEGACY_CLOSED_KEY);
    } catch {
      /* 存储不可用：键残留无害，新逻辑不读取它。 */
    }

    const timer = setInterval(tick, pollMs);
    tick();
    return () => clearInterval(timer);
  }, "dsh-v-explorer: session auto-open");
}
