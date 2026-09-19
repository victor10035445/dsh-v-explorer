/**
 * 自动展开状态机冒烟测试（specs/sidebar-auto-open）：
 *  1. 新会话（sessions.list current 变化）→ 未收起且无「保持关闭」偏好 →
 *     openTab("files")；同一会话幂等（不重复 open）
 *  2. 用户手动收起（非本插件动作引起的 expanded 迁移）→ 偏好置位；再换会话不自动开
 *  3. 用户手动展开 → 偏好清除；换会话恢复自动展开
 *  4. 无会话（current undefined）不触发
 * 运行：node tests/auto-open-smoke.mjs（轮询 700ms，全程 ≈3s）
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
const KEY = "dsh-v-explorer:sidebarClosed";

/* fake ctx：effect 立即执行；sessions.list 可控快照 + 订阅；sidebarRight 可控行为。 */
function makeCtx() {
  const state = { current: undefined, expanded: false };
  const listeners = new Set();
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ current: state.current }),
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        }
      }
    },
    sidebarRight: {
      isExpanded: () => state.expanded,
      openTab: (kind) => {
        ctx.opens.push(kind);
        state.expanded = true;
      }
    },
    effect: (fn) => fn(),
    opens: [],
    _state: state,
    _listeners: listeners
  };
  return ctx;
}

const setSession = (ctx, id) => {
  ctx._state.current = id;
  for (const fn of [...ctx._listeners]) fn();
};

(async () => {
  /* ── 1. 新会话自动展开 + 幂等 ── */
  const ctx = makeCtx();
  installAutoOpen(ctx, { current: ctx });
  setSession(ctx, "s1");
  await wait(30);
  assert(ctx.opens.length === 1 && ctx.opens[0] === "files", "new session must openTab files, got " + JSON.stringify(ctx.opens));
  setSession(ctx, "s1"); // 同一会话重复通知
  await wait(30);
  assert(ctx.opens.length === 1, "same session must be idempotent");
  await wait(800); // 轮询观测到展开后的 true 相位（fake openTab 是同步的；官方真实展开是异步的）

  /* ── 2. 手动收起 → 偏好置位；换会话不再自动开 ── */
  ctx._state.expanded = false; // 模拟用户点收起（本插件动作只产生 false→true，不存在误记）
  await wait(900); // 轮询捕获 true→false 迁移
  assert(store.get(KEY) === "1", "manual close must persist preference, got " + store.get(KEY));
  setSession(ctx, "s2");
  await wait(80);
  assert(ctx.opens.length === 1, "closed preference must suppress auto-open");

  /* ── 3. 手动展开 → 偏好清除；换会话恢复自动展开 ── */
  ctx._state.expanded = true; // 用户手动展开
  await wait(900);
  assert(!store.has(KEY), "manual expand must clear preference");
  setSession(ctx, "s3");
  await wait(80);
  assert(ctx.opens.length === 1, "no open while already expanded");

  /* 展开态下换会话 → 不重复 open（幂等对 expanded 态同样成立） */
  ctx._state.expanded = false;
  await wait(800); // 手动收起 again → 偏好置位
  assert(store.get(KEY) === "1", "second manual close must persist");
  setSession(ctx, "s4");
  await wait(80);
  assert(ctx.opens.length === 1, "still suppressed");

  /* ── 4. 无会话不触发 ── */
  const ctx2 = makeCtx();
  installAutoOpen(ctx2, { current: ctx2 });
  setSession(ctx2, undefined);
  await wait(60);
  assert(ctx2.opens.length === 0, "no session must not open");
  store.delete(KEY);
  setSession(ctx2, "s5");
  await wait(60);
  assert(ctx2.opens.length === 1 && ctx2.opens[0] === "files", "fresh session opens after preference cleared");

  console.log("\nALL AUTO-OPEN SMOKE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
