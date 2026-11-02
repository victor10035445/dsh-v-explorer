/**
 * 书签 SSE 会话作用域换源冒烟（src/bookmarks-events.mjs，
 * change port-dsh-0-2-1-sidebar-yield · 0.2.1-rc.5 换源）：
 *  1. 装配即按屏上会话连接：refresh + EventSource(sessionId)
 *  2. mounted 切换 → 关旧连接、刷新并重连新会话（读数与订阅双换）
 *  3. bookmarks-changed 帧触发刷新；非 JSON 帧忽略
 *  4. mounted → undefined → 关连接、不重连、不抛
 *  5. 卸载（effect cleanup）→ 退订并关连接，后续切换不再重连
 *  6. mounted 观察口缺席/形状不符 → 警告一次、SSE 不连接（chip 条级降级）
 *
 * 运行：node tests/bookmarks-events-smoke.mjs
 */
import { installBookmarksEvents } from "../src/bookmarks-events.mjs";
import { bookmarkRepo } from "../src/bookmark-repo.mjs";
import { ctxRef } from "../src/input-facade.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};

/** EventSource 桩（记录实例、可注入帧、可观察关闭）。 */
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.onmessage = null;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(payload) {
    if (typeof this.onmessage !== "function") throw new Error("onmessage not installed");
    this.onmessage({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }
}
const resetSources = () => {
  FakeEventSource.instances = [];
};

globalThis.EventSource = FakeEventSource;

/* refresh 桩：只记录会话 id（SSE 作用域行为本身不需要真实 fetch）。 */
const refreshCalls = [];
const originalRefresh = bookmarkRepo.refresh;
bookmarkRepo.refresh = (_ctx, sessionId) => {
  refreshCalls.push(sessionId);
};
const resetRefreshes = () => {
  refreshCalls.length = 0;
};

/** mounted 可观察口 fake（可切换屏上会话并通知订阅者）。 */
function makeCtx(initialSession) {
  const state = { mounted: initialSession, listeners: new Set() };
  let cleanup;
  const ctx = {
    sidebarRight: {
      mounted: {
        getSnapshot: () => state.mounted,
        subscribe: (fn) => {
          state.listeners.add(fn);
          return () => state.listeners.delete(fn);
        }
      }
    },
    effect: (fn) => {
      cleanup = fn();
      return cleanup;
    },
    _state: state,
    _dispose: () => {
      if (typeof cleanup === "function") cleanup();
      cleanup = undefined;
    }
  };
  return ctx;
}
const mount = (ctx, sessionId) => {
  ctx._state.mounted = sessionId;
  for (const fn of [...ctx._state.listeners]) fn();
};

/** 捕获 console.warn（安装期告警）。 */
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

try {
  /* ── 1–5. 正常路径：装配即连、切换重连、帧触发刷新、undefined 断开、卸载收尾 ── */
  {
    resetSources();
    resetRefreshes();
    const ctx = makeCtx("s1");
    ctxRef.current = ctx;
    installBookmarksEvents(ctx);

    assert(refreshCalls.join(",") === "s1", "install must refresh the on-screen session, got " + JSON.stringify(refreshCalls));
    assert(FakeEventSource.instances.length === 1, "install must open exactly one SSE connection");
    assert(FakeEventSource.instances[0].url === "/api/dsh-v-explorer/events?sessionId=s1", "SSE url must scope to the on-screen session, got " + FakeEventSource.instances[0].url);

    /* 2. mounted 切换 → 关旧、刷新并重连。 */
    mount(ctx, "s2");
    assert(FakeEventSource.instances.length === 2, "session switch must open a new SSE connection");
    assert(FakeEventSource.instances[0].closed === true, "old SSE connection must be closed on switch");
    assert(FakeEventSource.instances[1].closed === false, "new SSE connection must stay open");
    assert(refreshCalls.join(",") === "s1,s2", "switch must refresh the new session, got " + JSON.stringify(refreshCalls));
    assert(FakeEventSource.instances[1].url.includes("sessionId=s2"), "new SSE url must carry the new session id");

    /* 3. bookmarks-changed 帧 → 刷新；非 JSON 帧忽略。 */
    FakeEventSource.instances[1].emit({ type: "bookmarks-changed" });
    assert(refreshCalls.join(",") === "s1,s2,s2", "bookmarks-changed must refresh the bound session");
    const beforeNoise = refreshCalls.length;
    FakeEventSource.instances[1].emit("");
    FakeEventSource.instances[1].emit({ type: "something-else" });
    assert(refreshCalls.length === beforeNoise, "non-JSON / unrelated frames must not refresh");

    /* 4. mounted → undefined：关连接、不重连、不抛。 */
    mount(ctx, undefined);
    assert(FakeEventSource.instances.length === 2, "no session must not open a connection");
    assert(FakeEventSource.instances[1].closed === true, "leaving to no session must close the connection");
    assert(refreshCalls.join(",") === "s1,s2,s2", "no session must not refresh anything");

    /* 回到会话 → 重连一次。 */
    mount(ctx, "s1");
    assert(FakeEventSource.instances.length === 3, "returning to a session must reconnect");
    assert(refreshCalls[refreshCalls.length - 1] === "s1", "reconnect must refresh the on-screen session");

    /* 5. 卸载：退订并关连接；后续切换不再重连。 */
    ctx._dispose();
    assert(FakeEventSource.instances[2].closed === true, "cleanup must close the live connection");
    mount(ctx, "s3");
    assert(FakeEventSource.instances.length === 3, "post-cleanup switches must not reconnect");
    assert(refreshCalls[refreshCalls.length - 1] === "s1", "post-cleanup switches must not refresh");
  }

  /* ── 6a. mounted 缺席 → 警告一次、SSE 不连接 ── */
  {
    resetSources();
    resetRefreshes();
    const cap = captureWarnings();
    try {
      const ctx = { sidebarRight: {}, effect: (fn) => fn() };
      installBookmarksEvents(ctx);
      assert(cap.warns.length === 1, "missing mounted observer must warn exactly once, got " + JSON.stringify(cap.warns));
      assert(cap.warns[0].includes("bookmarks SSE sync skipped"), "warning must name the skipped capability");
      assert(FakeEventSource.instances.length === 0, "missing observer must not connect SSE");
      assert(refreshCalls.length === 0, "missing observer must not refresh");
    } finally {
      cap.restore();
    }
  }

  /* ── 6b. 只有读数、没有订阅（形状不符）→ 同样降级（订阅是切换驱动，必须双口） ── */
  {
    resetSources();
    resetRefreshes();
    const cap = captureWarnings();
    try {
      const ctx = {
        sidebarRight: { mounted: { getSnapshot: () => "s1" } },
        effect: (fn) => fn()
      };
      installBookmarksEvents(ctx);
      assert(cap.warns.length === 1, "read-only mounted face must warn once (subscription is required), got " + JSON.stringify(cap.warns));
      assert(FakeEventSource.instances.length === 0, "read-only mounted face must not connect SSE");
    } finally {
      cap.restore();
    }
  }

  console.log("\nALL BOOKMARKS-EVENTS SMOKE TESTS PASSED");
} finally {
  bookmarkRepo.refresh = originalRefresh;
  delete globalThis.EventSource;
  ctxRef.current = null;
}
