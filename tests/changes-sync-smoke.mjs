/**
 * changes-sync 冒烟测试（变更流目录级同步编排 —— files 树身与书签 tab 共用）：
 *  1. ready 帧 → 去抖 onRefresh 恰好一次（基线对齐）
 *  2. change 帧（version 观察）→ 去抖 onRefresh；窗口内多帧合并为一次
 *  3. change + absent → onAbsent 立即同步触发（不等待去抖）+ 去抖 onRefresh
 *  4. 未知帧 kind（未来扩展）→ 忽略，不触发任何动作
 *  5. refreshNow → 立即 onRefresh 且取消未触发的去抖（不双发）
 *  6. dispose → 退订生效，后续帧不再驱动；未触发 timer 清理
 *  7. pruneAbsentEntry：只动 ok 层、精确匹配 abs、无匹配返回 false 且不动层
 *
 * 运行：node tests/changes-sync-smoke.mjs
 */
import { createChangeSync, pruneAbsentEntry, CHANGE_SYNC_DEBOUNCE_MS } from "../src/changes-sync.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fake hub.follow：登记 handler，收集退订调用。 */
function makeHub() {
  const handlers = new Set();
  let unsubscribes = 0;
  const follow = (sessionId, handler) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      unsubscribes += 1;
    };
  };
  const emit = (frame) => {
    for (const handler of [...handlers]) handler(frame);
  };
  return { follow, emit, get subscriberCount() { return handlers.size; }, get unsubscribes() { return unsubscribes; } };
}

const DEBOUNCE = 20;

(async () => {
  /* ── 1. ready 帧 → 去抖 onRefresh 一次 ── */
  {
    const hub = makeHub();
    const refreshes = [];
    const sync = createChangeSync({ follow: hub.follow, sessionId: "s1", debounceMs: DEBOUNCE, onAbsent: () => assert(false, "ready must not fire onAbsent"), onRefresh: () => refreshes.push(1) });
    hub.emit({ kind: "ready" });
    assert(refreshes.length === 0, "ready must not refresh synchronously");
    await wait(DEBOUNCE + 30);
    assert(refreshes.length === 1, "ready must produce exactly one debounced refresh, got " + refreshes.length);
    sync.dispose();
  }

  /* ── 2. change 帧合并 + absent 即时摘除 ── */
  {
    const hub = makeHub();
    const refreshes = [];
    const absents = [];
    const sync = createChangeSync({ follow: hub.follow, sessionId: "s1", debounceMs: DEBOUNCE, onAbsent: (p) => absents.push(p), onRefresh: () => refreshes.push(1) });
    hub.emit({ kind: "change", change: { absolutePath: "/w/a.txt", version: "v1" } });
    hub.emit({ kind: "change", change: { absolutePath: "/w/b.txt", version: "v2" } });
    hub.emit({ kind: "change", change: { absolutePath: "/w/gone.txt", absent: true } });
    assert(JSON.stringify(absents) === JSON.stringify(["/w/gone.txt"]), "absent must fire synchronously and only for absent observations");
    assert(refreshes.length === 0, "debounced refresh must not fire synchronously");
    await wait(DEBOUNCE + 30);
    assert(refreshes.length === 1, "frames inside one debounce window must merge into one refresh, got " + refreshes.length);
    sync.dispose();
  }

  /* ── 3. 未知帧 kind 忽略 ── */
  {
    const hub = makeHub();
    let calls = 0;
    const sync = createChangeSync({ follow: hub.follow, sessionId: "s1", debounceMs: DEBOUNCE, onAbsent: () => assert(false, "unknown frame must not fire onAbsent"), onRefresh: () => { calls += 1; } });
    hub.emit({ kind: "something-new" });
    hub.emit(undefined);
    await wait(DEBOUNCE + 30);
    assert(calls === 0, "unknown frames must be ignored");
    sync.dispose();
  }

  /* ── 4. refreshNow：立即刷新 + 取消未触发去抖（不双发） ── */
  {
    const hub = makeHub();
    const refreshes = [];
    const sync = createChangeSync({ follow: hub.follow, sessionId: "s1", debounceMs: DEBOUNCE, onAbsent: () => {}, onRefresh: () => refreshes.push(1) });
    hub.emit({ kind: "change", change: { absolutePath: "/w/a.txt", version: "v1" } });
    sync.refreshNow();
    assert(refreshes.length === 1, "refreshNow must refresh immediately");
    await wait(DEBOUNCE + 30);
    assert(refreshes.length === 1, "refreshNow must cancel the pending debounce (no double fire)");
    sync.dispose();
  }

  /* ── 5. dispose：退订 + timer 清理 ── */
  {
    const hub = makeHub();
    let calls = 0;
    const sync = createChangeSync({ follow: hub.follow, sessionId: "s1", debounceMs: DEBOUNCE, onAbsent: () => {}, onRefresh: () => { calls += 1; } });
    hub.emit({ kind: "ready" });
    sync.dispose();
    assert(hub.unsubscribes === 1 && hub.subscriberCount === 0, "dispose must unsubscribe");
    hub.emit({ kind: "change", change: { absolutePath: "/w/a.txt", version: "v2" } });
    await wait(DEBOUNCE + 30);
    assert(calls === 0, "frames after dispose must not drive refresh");
  }

  /* ── 6. 默认去抖 = 500ms（files 树身既有节奏常量钉住） ── */
  assert(CHANGE_SYNC_DEBOUNCE_MS === 500, "default debounce must stay 500ms");

  /* ── 7. pruneAbsentEntry：ok 层精确摘除，其余层不动 ── */
  {
    const levels = new Map([
      ["dirA", { status: "ok", entries: [{ name: "a.txt", abs: "/w/dirA/a.txt" }, { name: "b.txt", abs: "/w/dirA/b.txt" }] }],
      ["dirB", { status: "ok", entries: [{ name: "a.txt", abs: "/w/dirB/a.txt" }] }],
      ["dirC", { status: "error", failure: { code: "x" } }]
    ]);
    const touched = pruneAbsentEntry(levels, "/w/dirA/a.txt");
    assert(touched === true, "prune must report a touch when an entry was removed");
    assert(levels.get("dirA").entries.length === 1 && levels.get("dirA").entries[0].abs === "/w/dirA/b.txt", "prune must remove only the absent entry");
    assert(levels.get("dirB").entries.length === 1, "same-named entries in other dirs must stay");
    assert(levels.get("dirC").status === "error", "non-ok levels must be untouched");
    const again = pruneAbsentEntry(levels, "/w/dirA/a.txt");
    assert(again === false, "second prune of the same path must report no touch");
  }

  console.log("\nALL CHANGES-SYNC SMOKE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
