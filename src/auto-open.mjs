/**
 * auto-open.mjs — 无记忆会话首次进入播种右侧栏（files + bookmarks 双页一次），
 * 此后让位官方每会话持久化（specs/sidebar-auto-open · 让位语义，
 * change port-dsh-0-2-1-sidebar-yield；DSH 0.2.1-rc.5 契约）。
 *
 * 语义（0.2.1-rc.5 起）：
 *  - 官方右侧栏改为**每会话 localStorage 持久化**（`dsh.sidebar-right.v1`），
 *    新会话初始面是「收起、一 pane、零 tab」，展开空列时才按 settle 规则播种默认页。
 *  - 因此插件从「每次进入会话都展开」（C 语义，前提是官方无记忆）降级为
 *    **仅首次播种**：屏上会话无持久化痕迹时展开一次并落出 files + bookmarks 两页；
 *    此后该会话的收起/展开/关页/刷新还原全归官方持久化，插件永不触碰。
 *  - 已接受边界（design D3）：virgin 判定是行为性的，"从未展开过的旧会话"也会被
 *    播种一次；播种只发生一次，此后即有记忆，不会反复。
 *
 * 驱动信号（0.2.1-rc.5）：`ctx.sidebarRight.mounted` ——
 * `ObservableSnapshot<SessionId | undefined>`，官方在 React 渲染前发布「屏上会话」，
 * 正是插件想问的问题。0.2.1 已删除 `sessions.list.current`（选中态移交视图层），
 * 原读数恒 undefined（真机零日志的根因）。本文件只消费 getSnapshot（轮询拍），
 * 不订阅——动作 MUST NOT 在任何订阅回调中同步执行。
 *
 * virgin 判定（公共面行为近似）：`tabsIn(sessionId)` 为空 ∧ `isExpanded()` 为 false
 * ≈ 该会话无持久化痕迹。`tabsIn` 契约原文："Read the committed tabs of a Session...
 * or an empty list before adoption"——切换后 adoption 未完成的短窗口内可能读空，
 * 双保险自愈：动作只在 ≥700ms 轮询拍（采纳通常早已完成）、失败不记账下拍重判。
 * 无法判定（`tabsIn` 缺席/形状不符）时按让位优先跳过播种并警告一次。
 *
 * 双页落出（原 revealTabs 原样平移，0.2.1 契约逐项核实未变）：
 * files（当前工作区树）与 bookmarks 是最常用的两页，播种拍一并落出（各一次
 * openTab），落完把活动页点回 files——默认前台仍是文件树，书签以第二个 tab 常驻
 * tab 条。三连调用全部公共面安全：
 *  - openTab 必然展开列（openContent 先 planSetExpanded(true)），无需另调展开
 *  - 页型在同 pane **去重即聚焦**（stores.d.ts："Opening a page into a pane
 *    that shows it focuses that tab"）——重复 openTab / 补齐重试都幂等，不重建 tab
 *  - active() 无挂载 surface 时返回 undefined（不抛）；focus() 对缺失 tab 静默
 *    忽略、无变化的 focus 不计划不记录
 *
 * 为什么动作只在轮询拍做、装配拍与订阅回调都不动作（真机二轮诊断 D6 的结论沿用）：
 *  - 会话的侧栏 store 由官方 seat 铸造；命令对准的是**当前屏上会话**的 store。
 *    换座/采纳与 React 渲染并发，同步拍动作可能落在旧 surface 上却给新会话记账
 *    （settledFor 被污染，此后永不重试）。
 *  - 轮询拍把动作推到一个独立宏任务，且距装配至少一个间隔；seat 未铸造时官方
 *    命令抛错——不记账，下拍重试，直至成功或屏上会话变化。
 *  - 官方「新建会话」复用同 workspace 的 blank 会话，mounted 可能不变——纯状态
 *    轮询天然兜住。
 *
 * 记账规则（design D5）：
 *  - 播种成功，或判定「已有持久化痕迹」→ `settledFor = sessionId`：本页面加载
 *    周期内该会话免扰（切回不再重做，因为"有记忆"的判定已经成立）
 *  - `retryFor`：播种尝试**中途**失败（files 已落出、列已展开、记账未成）时记下
 *    该会话，下拍**无视判定**继续补齐——判定顺序 MUST 先查 retryFor 再判 virgin
 *    （部分失败后列已展开、virgin 已翻转，顺序颠倒会把补齐吞成"记账收工"，
 *    书签永久缺席）
 *  - 无会话（屏上 undefined）清空两笔记账（回空态再进，重判一次，代价一次只读探测）
 *  - 播种失败不记账 → 下拍重试；连续失败日志节流（console.debug，Verbose 级）
 *  - 安装时清理旧版本遗留的记忆键（让位语义下不再读取，防混淆）
 */
import { canReadOnScreenSession, onScreenSessionId } from "./on-screen-session.mjs";

const LEGACY_CLOSED_KEY = "dsh-v-explorer:sidebarClosed";
const POLL_MS = 700;
/** 连续失败日志节流：首次 + 此后每 5 次失败记一条（console.debug，Verbose 级）。 */
const FAIL_LOG_EVERY = 5;

export function installAutoOpen(ctx, opts = {}) {
  if (!ctx.sidebarRight) return;
  /* 形状探测（design D9）：观察口缺席/形状不符 → 警告一次并跳过安装，其余能力照常。 */
  if (!canReadOnScreenSession(ctx)) {
    console.warn(
      "[dsh-v-explorer] sidebarRight.mounted observer unavailable, session auto-open skipped"
    );
    return;
  }
  const sidebar = ctx.sidebarRight;
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : POLL_MS;
  let settledFor; /* 已结算（播种成功或判定已有痕迹）的会话；undefined = 尚无 */
  let retryFor; /* 上拍播种尝试中途失败、待补齐的会话（可能已展开） */
  let failStreak = 0;
  let warnedNoTabsIn = false;

  /** 无持久化痕迹 ≈ 无 committed tabs 且当前收起。无法判定时按让位优先返回 false。 */
  const isVirgin = (sessionId) => {
    const tabsIn = sidebar.tabsIn;
    const warnUnjudgeable = () => {
      if (warnedNoTabsIn) return;
      warnedNoTabsIn = true;
      console.warn(
        "[dsh-v-explorer] sidebarRight.tabsIn unavailable or malformed, persistence-free detection disabled (auto-open skipped)"
      );
    };
    if (typeof tabsIn !== "function") {
      warnUnjudgeable();
      return false;
    }
    const tabs = tabsIn.call(sidebar, sessionId);
    if (!Array.isArray(tabs)) {
      warnUnjudgeable(); /* committed tabs 形状异常：无法判定 → 让位优先 */
      return false;
    }
    return tabs.length === 0 && !sidebar.isExpanded();
  };

  /* 播种：展开并落出两页。files 先行（落在活动 pane、成为前台页），bookmarks
   * 随后追加为第二个 tab；趁 files 刚聚焦抓它的 tabId，落完书签后点回 files。
   * 全程页型幂等：已开的页去重即聚焦，重试不重建、不改用户既有布局。 */
  const revealTabs = () => {
    sidebar.openTab("files");
    const filesTab = typeof sidebar.active === "function" ? sidebar.active() : undefined;
    sidebar.openTab("bookmarks");
    if (filesTab && typeof sidebar.focus === "function") sidebar.focus(filesTab.id);
  };

  const tick = () => {
    const sessionId = onScreenSessionId(ctx);
    if (sessionId === undefined) {
      /* 无会话空态：两笔记账失效（回空态再进，重判一次）。 */
      settledFor = undefined;
      retryFor = undefined;
      return;
    }
    if (settledFor === sessionId) return; /* 本加载周期内该会话免扰 */
    try {
      /* 判定顺序：先查待补齐，再判 virgin（见文件头「记账规则」）。 */
      if (retryFor !== sessionId && !isVirgin(sessionId)) {
        settledFor = sessionId; /* 已有持久化痕迹：记账收工，零动作 */
        retryFor = undefined;
        failStreak = 0;
        console.debug(
          `[dsh-v-explorer] auto-open: session ${sessionId} already has sidebar persistence, yielding`
        );
        return;
      }
      revealTabs(); /* 首次播种；或 retryFor 待补齐（无视「已展开」） */
      settledFor = sessionId; /* 成功才记账；失败下拍重试 */
      retryFor = undefined;
      failStreak = 0;
      console.debug(`[dsh-v-explorer] auto-open: files+bookmarks tabs seeded for session ${sessionId}`);
    } catch (error) {
      /* seat 未铸造 / 非会话面板 / 落页中途失败：不记账，下拍重试（补齐）。 */
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
    /* 旧版「保持关闭」记忆键清理（让位语义下不再读取，清理仅防混淆）。 */
    try {
      localStorage.removeItem(LEGACY_CLOSED_KEY);
    } catch {
      /* 存储不可用：键残留无害，新逻辑不读取它。 */
    }

    /* 动作只在轮询拍做：装配拍不动作（mounted 可能刚发布、adoption 尚未完成）。 */
    const timer = setInterval(tick, pollMs);
    return () => clearInterval(timer);
  }, "dsh-v-explorer: session auto-open");
}
