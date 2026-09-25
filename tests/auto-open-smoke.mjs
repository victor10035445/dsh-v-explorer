/**
 * 自动展开状态机冒烟测试（specs/sidebar-auto-open · C 语义 + 双页常开，2026-09-25）：
 *  0. 安装时清理旧版「保持关闭」记忆键
 *  1. 新会话（current 出现）→ 展开 + 常开 files+bookmarks 两页（files 前台）；多拍幂等
 *  2. 手动收起（当前会话停留期间）→ 不争抢、不重开
 *  3. 切走再切回 → 重新展开两页；切回已展开的会话不重复动作
 *  4. 无会话（current undefined）不触发，且记账失效（回到该会话重新展开）
 *  5. 挂载竞态：seat 未挂载时官方命令抛错 → 不记账，轮询重试直至成功
 *  5b. 落页中途失败：files 落出后 bookmarks 抛错 → 不记账，下拍无视「已展开」补齐
 *  5c. 降级：active/focus 缺席（旧宿主）→ 两页照常落出，不崩、不记账卡死
 *  6. 纯状态发现：current 变化无需任何事件通知（blank 复用/无事件路径）也被轮询兜住
 *
 * 动作只在轮询拍做（提交拍会落在离场 seat 上污染记账——见 src/auto-open.mjs 头注），
 * 故本测试不再喂订阅通知，全部经可注入的短轮询间隔驱动。
 * fake sidebarRight 按官方契约建模页型语义：openTab 先展开列、页在同 pane
 * 去重即聚焦（新页追加为末位 tab 并成为活动页）；active() 读活动页；focus()
 * 点回已有页（缺失忽略）。运行：node tests/auto-open-smoke.mjs（全程 ≈1s）
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

/* fake ctx：effect 立即执行；sessions.list 可控快照（无订阅——插件动作必须
 * 不依赖提交事件）；sidebarRight 可控行为（seatMounted 对齐官方语义：
 * isExpanded() 无挂载 surface 时也返回 false，openTab 无挂载时响亮抛错）。 */
function makeCtx() {
  const state = {
    current: undefined,
    expanded: false,
    seatMounted: true,
    tabs: new Map(), /* kind → tabId（页型每 pane 至多一个） */
    order: [], /* strip 顺序 */
    activeId: undefined,
    focusLog: [],
    seq: 0
  };
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ current: state.current })
      }
    },
    sidebarRight: {
      isExpanded: () => (state.seatMounted ? state.expanded : false),
      openTab: (kind) => {
        if (!state.seatMounted) throw new Error("no mounted surface");
        ctx.opens.push(kind);
        state.expanded = true; /* openContent 必然展开列 */
        if (!state.tabs.has(kind)) {
          state.tabs.set(kind, `${kind}#${++state.seq}`);
          state.order.push(kind);
        }
        state.activeId = state.tabs.get(kind); /* 新落出/去重聚焦都置前台 */
      },
      active: () => {
        if (!state.seatMounted || state.activeId === undefined) return undefined;
        return { id: state.activeId };
      },
      focus: (tabId) => {
        if (!state.seatMounted) throw new Error("no mounted surface");
        state.focusLog.push(tabId);
        if ([...state.tabs.values()].includes(tabId)) state.activeId = tabId;
      }
    },
    effect: (fn) => fn(),
    opens: [],
    _state: state
  };
  return ctx;
}

const tabKinds = (st) => st.order.join(",");
const activeKind = (st) => {
  for (const [kind, id] of st.tabs) if (id === st.activeId) return kind;
  return undefined;
};
const bothTabsPresent = (st) => st.tabs.has("files") && st.tabs.has("bookmarks");

(async () => {
  /* ── 0 + 1. 旧键清理；新会话自动展开 + 双页常开 + 跨拍幂等 ── */
  store.set(LEGACY_KEY, "1");
  const ctx = makeCtx();
  installAutoOpen(ctx, { current: ctx }, { pollMs: POLL });
  assert(!store.has(LEGACY_KEY), "stale closed-preference key must be removed on install");
  ctx._state.current = "s1"; /* 直接改状态，不喂任何事件 */
  await step();
  assert(ctx.opens.join(",") === "files,bookmarks", "new session must open both tabs, got " + JSON.stringify(ctx.opens));
  assert(tabKinds(ctx._state) === "files,bookmarks", "strip order must be files then bookmarks, got " + tabKinds(ctx._state));
  assert(bothTabsPresent(ctx._state), "both tabs must be present after auto-open");
  assert(activeKind(ctx._state) === "files", "files must be back in front after bookmarks lands, got " + activeKind(ctx._state));
  await step();
  await step();
  assert(ctx.opens.length === 2, "same session must stay idempotent across poll ticks");

  /* ── 2. 手动收起（当前会话停留期间）不争抢 ── */
  ctx._state.expanded = false; // 用户点收起
  await step();
  await step();
  assert(ctx.opens.length === 2, "manual collapse while staying must not be fought");

  /* ── 3a. 切走（s2 全新默认收起）→ 自动展开两页 ── */
  ctx._state.expanded = false; // s2 自身 store 默认收起
  ctx._state.current = "s2";
  await step();
  assert(ctx.opens.length === 4 && ctx.opens[2] === "files" && ctx.opens[3] === "bookmarks", "switching to a collapsed session must open both tabs");
  assert(bothTabsPresent(ctx._state) && activeKind(ctx._state) === "files", "s2 must end with both tabs, files in front");

  /* ── 3b. 切回 s1（用户此前手动收起过）→ 重新展开（每次进入都展开） ── */
  ctx._state.expanded = false; // s1 记住的是"收起"
  ctx._state.current = "s1";
  await step();
  assert(ctx.opens.length === 6, "returning to a session must re-open (no cross-session memory)");

  /* ── 3c. 切回 s2（该会话此前已展开）→ 不重复动作 ── */
  ctx._state.expanded = true; // s2 记住的是"展开"
  ctx._state.current = "s2";
  await step();
  assert(ctx.opens.length === 6, "returning to an expanded session must not re-open");

  /* ── 4. 无会话不触发；记账失效后回到会话重新展开 ── */
  ctx._state.expanded = false; // s2 被用户收起后清空选择
  ctx._state.current = undefined;
  await step();
  assert(ctx.opens.length === 6, "no session must not open");
  ctx._state.current = "s2";
  await step();
  assert(ctx.opens.length === 8, "re-entering after no-session must re-open");

  /* ── 5. 挂载竞态：轮询重试直至成功 ── */
  const ctx2 = makeCtx();
  ctx2._state.seatMounted = false; // 页面刚加载，会话窗口未挂载
  installAutoOpen(ctx2, { current: ctx2 }, { pollMs: POLL });
  ctx2._state.current = "s1";
  await step();
  assert(ctx2.opens.length === 0, "failed attempts before mount must not count as settled");
  ctx2._state.seatMounted = true; // 会话面挂载完成
  await step();
  assert(ctx2.opens.join(",") === "files,bookmarks", "poll retry after mount must open both tabs");
  assert(activeKind(ctx2._state) === "files", "retry path must also put files back in front");

  /* ── 5b. 落页中途失败：files 已展开列、bookmarks 抛错 → 下拍补齐 ── */
  const ctxB = makeCtx();
  const realOpen = ctxB.sidebarRight.openTab;
  let bookmarkFails = 1;
  ctxB.sidebarRight.openTab = (kind) => {
    if (kind === "bookmarks" && bookmarkFails > 0) {
      bookmarkFails -= 1;
      throw new Error("bookmarks kind exploded once");
    }
    realOpen(kind);
  };
  installAutoOpen(ctxB, { current: ctxB }, { pollMs: POLL });
  ctxB._state.current = "s1";
  await oneTick();
  assert(ctxB.opens.join(",") === "files", "partial failure tick opens files only");
  assert(ctxB._state.expanded === true, "files open already expanded the column (the trap)");
  assert(activeKind(ctxB._state) === "files", "partial state still shows files");
  await oneTick();
  assert(ctxB.opens.join(",") === "files,files,bookmarks", "next tick must repair bookmarks despite expanded column (files dedupe-focus + bookmarks open)");
  assert(bothTabsPresent(ctxB._state) && activeKind(ctxB._state) === "files", "repaired session must have both tabs, files in front");
  const settledOpens = ctxB.opens.length;
  await step();
  await step();
  assert(ctxB.opens.length === settledOpens, "repaired session must settle idempotent afterwards");

  /* ── 5c. 降级：active/focus 缺席（旧宿主）→ 两页照常落出不崩 ── */
  const ctxC = makeCtx();
  delete ctxC.sidebarRight.active;
  delete ctxC.sidebarRight.focus;
  installAutoOpen(ctxC, { current: ctxC }, { pollMs: POLL });
  ctxC._state.current = "s1";
  await step();
  assert(ctxC.opens.join(",") === "files,bookmarks", "missing active/focus must not break the two-tab reveal");
  assert(bothTabsPresent(ctxC._state), "both tabs still land without focus-back");
  assert(activeKind(ctxC._state) === "bookmarks", "without focus-back the last-opened page stays active (documented degradation)");

  /* ── 6. 纯状态发现：无事件路径（blank 会话复用）也被兜住 ── */
  const ctx3 = makeCtx();
  installAutoOpen(ctx3, { current: ctx3 }, { pollMs: POLL });
  ctx3._state.current = "blank-1"; // 无任何通知/事件，状态静默出现
  await step();
  assert(ctx3.opens.join(",") === "files,bookmarks", "silent current appearance must still open both tabs");

  console.log("\nALL AUTO-OPEN SMOKE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
