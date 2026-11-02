/**
 * 自动展开状态机冒烟测试（specs/sidebar-auto-open · 让位语义 + 首次播种，
 * change port-dsh-0-2-1-sidebar-yield）：
 *  0. 安装时清理旧版「保持关闭」记忆键；mounted 观察口形状不符 → 警告一次、跳过安装
 *  1. 无记忆新会话首次播种：展开 + 落出 files + bookmarks（files 前台）；跨拍幂等
 *  2. 播种后用户手动收起（停留）→ 不争抢（本加载周期该会话免扰）
 *  3. 有记忆会话（tabs 非空 / 已展开）→ 零动作
 *  4. 手动收起 → 刷新模拟（重建 fake、按持久化恢复收起态）→ 不重开
 *  5. 播种一次后切走再切回 → 不重做（有记忆判定成立）
 *  6. 挂载竞态：seat 未铸造时官方命令抛错 → 不记账，轮询重试直至成功
 *  7. 落页中途失败：files 落出后 bookmarks 抛错 → 下拍无视判定补齐
 *  8. 切换后立即判定（adoption 竞态窗口）→ 不在切换瞬间动作；采纳完成后判非 virgin
 *  9. 无会话空态清记账 → 极端会话（收起且关光页）回来自重判一次（D5 接受边界）
 * 10. tabsIn 形状缺席 → 警告一次、不播种（让位优先）
 * 11. 降级：active/focus 缺席（旧宿主）→ 两页照常落出，不崩
 * 12. 纯状态发现：mounted 静默变化（无任何通知）也被轮询兜住
 *
 * fake sidebarRight 按 0.2.1-rc.5 契约建模：
 *  - mounted 是 ObservableSnapshot（getSnapshot + subscribe，可切换屏上会话）
 *  - tabsIn(sessionId) 读「committed tabs」：adoption 前空表；播种即产生持久化痕迹
 *  - isExpanded() 读屏上会话的列状态（无挂载 surface 时 false）
 *  - openTab 先展开列、页型去重即聚焦；无 seat / adoption 未完成时抛错
 * 动作只在轮询拍做（装配拍与订阅回调都不动作），故测试全部经可注入的短轮询驱动。
 * 运行：node tests/auto-open-smoke.mjs（全程 ≈3s）
 */
import { installAutoOpen } from "../src/auto-open.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* localStorage 替身（node 无 localStorage）。 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
const LEGACY_KEY = "dsh-v-explorer:sidebarClosed";

const POLL = 50; /* 测试用轮询间隔（正式 700ms） */
const oneTick = () => wait(65); /* 恰跨一个轮询拍（<2×POLL），逐拍观察 */
const step = () => wait(200); /* 多拍，断言稳定（幂等） */

/** 捕获 console.warn（仅用于本用例的安装/拍内告警）。 */
function captureWarnings() {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  return {
    warns,
    restore: () => {
      console.warn = orig;
    }
  };
}

/**
 * fake ctx（0.2.1-rc.5 持久化语义）。
 * @param {object} [options]
 * @param {boolean} [options.seatMounted] seat 是否已铸造（false 时官方命令抛错）
 * @param {object} [options.sessions] 预置持久化会话：{ id: { tabs: string[], expanded: boolean } }
 * @param {object} [options.adoptAfterMs] { id: ms }：切到该会话后 adoption 需 ms 完成（期间 tabsIn 空、命令抛错）
 * @param {boolean} [options.brokenMounted] mounted 形状不符（非 ObservableSnapshot）
 * @param {boolean} [options.noTabsIn] 控制器缺少 tabsIn 公共方法
 */
function makeCtx(options = {}) {
  const state = {
    mounted: undefined,
    seatMounted: options.seatMounted ?? true,
    surfaces: new Map(), /* id → { expanded, tabs:Map(kind→id), order:[], activeId } */
    adopting: new Set(), /* adoption 未完成的会话：tabsIn 空表、命令抛错 */
    adoptAfterMs: new Map(Object.entries(options.adoptAfterMs ?? {})),
    listeners: new Set(),
    opens: [],
    focusLog: [],
    seq: 0
  };

  const surfaceOf = (id) => {
    let s = state.surfaces.get(id);
    if (!s) {
      s = { expanded: false, tabs: new Map(), order: [], activeId: undefined };
      state.surfaces.set(id, s);
    }
    return s;
  };

  /* 预置持久化痕迹（模拟上次运行写入的 per-session localStorage）。 */
  for (const [id, persisted] of Object.entries(options.sessions ?? {})) {
    const s = surfaceOf(id);
    s.expanded = persisted.expanded === true;
    for (const kind of persisted.tabs ?? []) {
      s.tabs.set(kind, `${kind}#${++state.seq}`);
      s.order.push(kind);
    }
    s.activeId = s.order.length > 0 ? s.tabs.get(s.order[s.order.length - 1]) : undefined;
  }

  const mountedObs = {
    getSnapshot: () => state.mounted,
    subscribe: (fn) => {
      state.listeners.add(fn);
      return () => state.listeners.delete(fn);
    }
  };

  const requirementError = () => new Error("sidebarRight: no session surface is mounted");
  const assertUsable = () => {
    if (!state.seatMounted || state.mounted === undefined || state.adopting.has(state.mounted)) {
      throw requirementError();
    }
  };

  let cleanup;
  const ctx = {
    sidebarRight: {
      mounted: options.brokenMounted ? { getSnapshot: "not-a-function" } : mountedObs,
      ...(options.noTabsIn
        ? {}
        : {
            tabsIn: (sessionId) =>
              state.adopting.has(sessionId) ? [] : [...surfaceOf(sessionId).order]
          }),
      isExpanded: () =>
        state.seatMounted && state.mounted !== undefined ? surfaceOf(state.mounted).expanded : false,
      openTab: (kind) => {
        assertUsable();
        const s = surfaceOf(state.mounted);
        state.opens.push(kind);
        s.expanded = true; /* openContent 必然展开列 */
        if (!s.tabs.has(kind)) {
          s.tabs.set(kind, `${kind}#${++state.seq}`);
          s.order.push(kind);
        }
        s.activeId = s.tabs.get(kind); /* 新落出/去重聚焦都置前台 */
      },
      active: () => {
        if (!state.seatMounted || state.mounted === undefined) return undefined;
        const id = surfaceOf(state.mounted).activeId;
        return id === undefined ? undefined : { id };
      },
      focus: (tabId) => {
        assertUsable();
        state.focusLog.push(tabId);
        const s = surfaceOf(state.mounted);
        if ([...s.tabs.values()].includes(tabId)) s.activeId = tabId;
      }
    },
    effect: (fn) => {
      cleanup = fn();
      return cleanup;
    },
    opens: state.opens,
    _state: state,
    _surface: surfaceOf,
    _dispose: () => {
      if (typeof cleanup === "function") cleanup();
      cleanup = undefined;
    }
  };
  return ctx;
}

/** 切换屏上会话（发布 mounted 并通知订阅者——插件不订阅，动作仍只在轮询拍）。 */
function mount(ctx, sessionId) {
  const state = ctx._state;
  state.mounted = sessionId;
  if (sessionId !== undefined) {
    const delay = state.adoptAfterMs.get(sessionId);
    if (delay !== undefined) {
      state.adopting.add(sessionId);
      setTimeout(() => state.adopting.delete(sessionId), delay);
    }
  }
  for (const fn of [...state.listeners]) fn();
}

const tabKinds = (ctx, id) => ctx._surface(id).order.join(",");
const activeKind = (ctx, id) => {
  const s = ctx._surface(id);
  for (const [kind, tabId] of s.tabs) if (tabId === s.activeId) return kind;
  return undefined;
};
const bothTabsPresent = (ctx, id) => {
  const s = ctx._surface(id);
  return s.tabs.has("files") && s.tabs.has("bookmarks");
};

(async () => {
  /* ── 0a. 旧键清理；0b. mounted 形状不符 → 警告一次并跳过安装 ── */
  store.set(LEGACY_KEY, "1");
  {
    const ctx = makeCtx();
    installAutoOpen(ctx, { pollMs: POLL });
    assert(!store.has(LEGACY_KEY), "stale closed-preference key must be removed on install");
    ctx._dispose();
  }
  {
    const cap = captureWarnings();
    try {
      const ctx = makeCtx({ brokenMounted: true });
      installAutoOpen(ctx, { pollMs: POLL });
      mount(ctx, "s1");
      await step();
      assert(cap.warns.length === 1 && cap.warns[0].includes("mounted observer unavailable"), "broken mounted observer must warn once and skip installation, got " + JSON.stringify(cap.warns));
      assert(ctx.opens.length === 0, "skipped installation must never act");
      ctx._dispose();
    } finally {
      cap.restore();
    }
  }

  /* ── 1. 无记忆新会话首次播种 + 跨拍幂等 + 停留期间手动收起不争抢 ── */
  {
    const ctx = makeCtx();
    installAutoOpen(ctx, { pollMs: POLL });
    mount(ctx, "s1");
    await step();
    assert(ctx.opens.join(",") === "files,bookmarks", "virgin session must seed both tabs, got " + JSON.stringify(ctx.opens));
    assert(tabKinds(ctx, "s1") === "files,bookmarks", "strip order must be files then bookmarks, got " + tabKinds(ctx, "s1"));
    assert(bothTabsPresent(ctx, "s1"), "both tabs must be present after seeding");
    assert(activeKind(ctx, "s1") === "files", "files must be back in front after bookmarks lands");
    await step();
    await step();
    assert(ctx.opens.length === 2, "same session must stay idempotent across poll ticks");

    /* 播种成功后用户手动收起：本加载周期该会话已结算，不争抢。 */
    ctx._surface("s1").expanded = false;
    await step();
    await step();
    assert(ctx.opens.length === 2, "manual collapse after seeding must not be re-opened (settled this load)");
    ctx._dispose();
  }

  /* ── 2. 有记忆会话零动作：tabs 非空（收起）；tabs 空但已展开 ── */
  {
    const ctx = makeCtx({ sessions: { memo: { tabs: ["files", "bookmarks"], expanded: false } } });
    installAutoOpen(ctx, { pollMs: POLL });
    mount(ctx, "memo");
    await step();
    await step();
    assert(ctx.opens.length === 0, "session with committed tabs must get zero actions (yield)");
    ctx._dispose();
  }
  {
    const ctx = makeCtx({ sessions: { opened: { tabs: [], expanded: true } } });
    installAutoOpen(ctx, { pollMs: POLL });
    mount(ctx, "opened");
    await step();
    await step();
    assert(ctx.opens.length === 0, "expanded session counts as having traces, must get zero actions");
    ctx._dispose();
  }

  /* ── 3. 手动收起 → 刷新模拟（重建 fake、按持久化恢复收起 + tabs）→ 不重开 ── */
  {
    const before = makeCtx({ sessions: { s1: { tabs: ["files", "bookmarks"], expanded: true } } });
    installAutoOpen(before, { pollMs: POLL });
    mount(before, "s1");
    await step();
    assert(before.opens.length === 0, "pre-existing session must not be touched");
    before._surface("s1").expanded = false; /* 用户手动收起 → 官方持久化记为收起 */
    await step();
    assert(before.opens.length === 0, "manual collapse on a settled session must not be fought");
    before._dispose();

    const after = makeCtx({ sessions: { s1: { tabs: ["files", "bookmarks"], expanded: false } } });
    installAutoOpen(after, { pollMs: POLL });
    mount(after, "s1"); /* 刷新后会话恢复选中：持久化 = 收起 */
    await step();
    await step();
    assert(after.opens.length === 0, "reload must restore the collapsed state, not re-seed (yield semantics)");
    after._dispose();
  }

  /* ── 4. 播种一次后切走再切回 → 不重做（有记忆判定成立） ── */
  {
    const ctx = makeCtx();
    installAutoOpen(ctx, { pollMs: POLL });
    mount(ctx, "s1");
    await step();
    assert(ctx.opens.length === 2, "first session must seed once");
    mount(ctx, "s2");
    await step();
    assert(ctx.opens.length === 4, "second virgin session must seed once");
    /* 用户把 s1 收起后再切回：tabs 仍在 → 有痕迹，零动作。 */
    ctx._surface("s1").expanded = false;
    mount(ctx, "s1");
    await step();
    await step();
    assert(ctx.opens.length === 4, "returning to a seeded session must not re-seed, got " + ctx.opens.length);
    ctx._dispose();
  }

  /* ── 5. 挂载竞态：轮询重试直至成功 ── */
  {
    const ctx = makeCtx({ seatMounted: false });
    installAutoOpen(ctx, { pollMs: POLL });
    mount(ctx, "s1");
    await step();
    assert(ctx.opens.length === 0, "failed attempts before seat mint must not count as settled");
    ctx._state.seatMounted = true; /* 会话面铸造完成 */
    await step();
    assert(ctx.opens.join(",") === "files,bookmarks", "poll retry after seat mint must seed both tabs");
    assert(activeKind(ctx, "s1") === "files", "retry path must also put files back in front");
    ctx._dispose();
  }

  /* ── 6. 落页中途失败：files 已展开列、bookmarks 抛错 → 下拍无视判定补齐 ── */
  {
    const ctx = makeCtx();
    const realOpen = ctx.sidebarRight.openTab;
    let bookmarkFails = 1;
    ctx.sidebarRight.openTab = (kind) => {
      if (kind === "bookmarks" && bookmarkFails > 0) {
        bookmarkFails -= 1;
        throw new Error("bookmarks kind exploded once");
      }
      realOpen(kind);
    };
    installAutoOpen(ctx, { pollMs: POLL });
    mount(ctx, "s1");
    await oneTick();
    assert(ctx.opens.join(",") === "files", "partial failure tick opens files only");
    assert(ctx._surface("s1").expanded === true, "files open already expanded the column (the trap)");
    assert(activeKind(ctx, "s1") === "files", "partial state still shows files");
    await oneTick();
    assert(
      ctx.opens.join(",") === "files,files,bookmarks",
      "next tick must repair bookmarks despite expanded column (retryFor checked before virgin), got " + ctx.opens.join(",")
    );
    assert(bothTabsPresent(ctx, "s1") && activeKind(ctx, "s1") === "files", "repaired session must have both tabs, files in front");
    const settledOpens = ctx.opens.length;
    await step();
    await step();
    assert(ctx.opens.length === settledOpens, "repaired session must settle idempotent afterwards");
    ctx._dispose();
  }

  /* ── 7. 切换后立即判定（adoption 竞态窗口）：不误播种有记忆会话 ── */
  {
    const ctx = makeCtx({
      sessions: { memo: { tabs: ["files", "bookmarks"], expanded: true } },
      adoptAfterMs: { memo: 20 }
    });
    installAutoOpen(ctx, { pollMs: 200 }); /* 真实节奏量级：轮询远慢于 adoption */
    mount(ctx, "memo");
    assert(ctx.sidebarRight.tabsIn("memo").length === 0, "adoption window must model an empty committed-tabs list");
    await wait(100); /* 切换瞬间：尚未到轮询拍 */
    assert(ctx.opens.length === 0, "switching must not act synchronously (actions only on poll ticks)");
    await wait(300); /* 轮询拍：adoption 已完成，读到的 tabs 非空 */
    assert(ctx.opens.length === 0, "after adoption a remembered session must be judged non-virgin; no seeding");
    assert(ctx._surface("memo").order.join(",") === "files,bookmarks", "persisted tabs must be left untouched");
    ctx._dispose();
  }

  /* ── 8. 无会话空态清记账 → 极端会话（收起且关光页）回来自重判一次 ── */
  {
    const ctx = makeCtx();
    installAutoOpen(ctx, { pollMs: POLL });
    mount(ctx, "s1");
    await step();
    assert(ctx.opens.length === 2, "baseline seeding");

    /* 用户手动收起并关光所有页（接受边界：此时该会话又"看起来无记忆"）。 */
    const s = ctx._surface("s1");
    s.expanded = false;
    s.tabs.clear();
    s.order.length = 0;
    s.activeId = undefined;
    await step();
    assert(ctx.opens.length === 2, "settled session must not be re-judged while it stays on screen");

    mount(ctx, undefined); /* 回空态：两笔记账清空 */
    await step();
    assert(ctx.opens.length === 2, "no session must not trigger actions");

    mount(ctx, "s1");
    await step();
    assert(ctx.opens.length === 4, "empty-state reset re-judges once; an empty/collapsed session is seeded again (accepted edge)");
    ctx._dispose();
  }

  /* ── 9. tabsIn 形状缺席/异常返回 → 警告一次、不播种（让位优先，无法判定即跳过） ── */
  {
    const cap = captureWarnings();
    try {
      const ctx = makeCtx({ noTabsIn: true });
      installAutoOpen(ctx, { pollMs: POLL });
      mount(ctx, "s1");
      await step();
      await step();
      assert(ctx.opens.length === 0, "without tabsIn the plugin must not guess virgin (yield first)");
      assert(
        cap.warns.length === 1 && cap.warns[0].includes("tabsIn unavailable"),
        "missing tabsIn must warn exactly once, got " + JSON.stringify(cap.warns)
      );
      ctx._dispose();

      /* tabsIn 存在但返回非数组（契约漂移）→ 同样无法判定，警告一次、零动作。 */
      const ctxBadShape = makeCtx();
      ctxBadShape.sidebarRight.tabsIn = () => undefined;
      installAutoOpen(ctxBadShape, { pollMs: POLL });
      mount(ctxBadShape, "s1");
      await step();
      await step();
      assert(ctxBadShape.opens.length === 0, "malformed tabsIn must not seed either");
      assert(
        cap.warns.length === 2 && cap.warns[1].includes("malformed"),
        "malformed tabsIn must warn exactly once more, got " + JSON.stringify(cap.warns)
      );
      ctxBadShape._dispose();
    } finally {
      cap.restore();
    }
  }

  /* ── 10. 降级：active/focus 缺席（旧宿主）→ 两页照常落出不崩 ── */
  {
    const ctx = makeCtx();
    delete ctx.sidebarRight.active;
    delete ctx.sidebarRight.focus;
    installAutoOpen(ctx, { pollMs: POLL });
    mount(ctx, "s1");
    await step();
    assert(ctx.opens.join(",") === "files,bookmarks", "missing active/focus must not break the two-tab seeding");
    assert(bothTabsPresent(ctx, "s1"), "both tabs still land without focus-back");
    assert(activeKind(ctx, "s1") === "bookmarks", "without focus-back the last-opened page stays active (documented degradation)");
    ctx._dispose();
  }

  /* ── 11. 纯状态发现：mounted 静默变化（无任何通知）也被轮询兜住 ── */
  {
    const ctx = makeCtx();
    installAutoOpen(ctx, { pollMs: POLL });
    ctx._state.mounted = "blank-1"; /* 无通知/事件，状态静默出现 */
    await step();
    assert(ctx.opens.join(",") === "files,bookmarks", "silent mounted change must still seed both tabs");
    ctx._dispose();
  }

  console.log("\nALL AUTO-OPEN SMOKE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
