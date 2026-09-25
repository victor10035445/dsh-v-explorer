/**
 * bookmark-repo 快照稳定性冒烟（React #185 回归钉，2026-09-25）：
 *  1. 未知会话 getSnapshot 引用稳定——旧实现每次调用新建 `{list:[]}`，
 *     useSyncExternalStore 判定快照永远在变 → 同步重渲染死循环 → React
 *     #185（Maximum update depth exceeded）；书签 tab 随自动展开立即挂载、
 *     与首拉 /bookmarks 竞态的窗口即暴露
 *  2. refresh 成功 → 内容/loaded 正确 + 引用跨调用稳定
 *  3. refresh 404「session not found」→ 稳定空快照 + 未 loaded + 退避重试最终成功
 *  4. subscribe：变更通知携带 sessionId；退订生效
 *  5. add/remove：响应体直落 + 引用稳定
 *  6. 服务端非数组 bookmarks → 稳定空快照（不产生新引用）
 *
 * 运行：node tests/bookmark-repo-smoke.mjs（全程 ≈1s，含 600ms 重试等待）
 */

/* fetch 替身先于模块加载就位（api.mjs 用全局 fetch）。 */
let fetchImpl = async () => {
  throw new Error("fetch not stubbed");
};
globalThis.fetch = (...args) => fetchImpl(...args);

const { bookmarkRepo } = await import("../src/bookmark-repo.mjs");

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? "Not Found" : "",
  json: async () => body
});

(async () => {
  /* ── 1. 未知会话：引用稳定（#185 回归核心断言） ── */
  {
    const a = bookmarkRepo.getSnapshot("s1");
    const b = bookmarkRepo.getSnapshot("s1");
    assert(Array.isArray(a) && a.length === 0, "unknown session must yield an empty list");
    assert(a === b, "getSnapshot MUST return a stable reference across calls (got a fresh array each call → React #185 loop)");
    assert(bookmarkRepo.isLoaded("s1") === false, "unknown session must not be loaded");
  }

  /* ── 4a. subscribe 通知带 sessionId ── */
  const seen = [];
  const unsub = bookmarkRepo.subscribe((sessionId) => seen.push(sessionId));

  /* ── 2. refresh 成功：内容 + 稳定引用 ── */
  fetchImpl = async () => jsonRes(200, { bookmarks: [{ path: "readme.md", addedAt: "t", exists: true, isDir: false }] });
  await bookmarkRepo.refresh({}, "s1");
  assert(bookmarkRepo.isLoaded("s1") === true, "refresh must mark loaded");
  assert(bookmarkRepo.getSnapshot("s1").length === 1 && bookmarkRepo.getSnapshot("s1")[0].path === "readme.md", "refresh must store the response list");
  assert(bookmarkRepo.getSnapshot("s1") === bookmarkRepo.getSnapshot("s1"), "loaded snapshot must stay reference-stable across calls");
  assert(seen.includes("s1"), "subscribers must be notified with the sessionId");

  /* ── 3. 404 退避重试：稳定空快照 + 最终成功 ── */
  let calls = 0;
  fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? jsonRes(404, { error: "session not found or has no cwd" }) : jsonRes(200, { bookmarks: [{ path: "late.md", addedAt: "t", exists: true, isDir: false }] });
  };
  await bookmarkRepo.refresh({}, "s2");
  assert(bookmarkRepo.isLoaded("s2") === false, "404 window must stay not-loaded");
  const emptyRef = bookmarkRepo.getSnapshot("s2");
  assert(emptyRef === bookmarkRepo.getSnapshot("s2"), "404 window snapshot must be reference-stable");
  await wait(900); /* 重试基线 600ms */
  assert(bookmarkRepo.isLoaded("s2") === true && bookmarkRepo.getSnapshot("s2")[0]?.path === "late.md", "backoff retry must eventually load (got calls=" + calls + ")");

  /* ── 5. add / remove：响应体直落 + 稳定引用 ── */
  fetchImpl = async () => jsonRes(200, { bookmarks: [{ path: "a.md", addedAt: "t", exists: true, isDir: false }] });
  await bookmarkRepo.add({}, "s3", "a.md");
  const afterAdd = bookmarkRepo.getSnapshot("s3");
  assert(afterAdd.length === 1 && afterAdd[0].path === "a.md", "add must store the response list");
  assert(afterAdd === bookmarkRepo.getSnapshot("s3"), "add snapshot must be reference-stable");
  fetchImpl = async () => jsonRes(200, { bookmarks: [] });
  await bookmarkRepo.remove({}, "s3", "a.md");
  assert(bookmarkRepo.getSnapshot("s3").length === 0, "remove must store the response list");

  /* ── 6. 非数组响应 → 稳定空快照 ── */
  fetchImpl = async () => jsonRes(200, { bookmarks: "garbage" });
  await bookmarkRepo.refresh({}, "s4");
  assert(bookmarkRepo.getSnapshot("s4") === bookmarkRepo.getSnapshot("s4"), "non-array response must fall back to the stable empty snapshot");

  /* ── 4b. 退订生效 ── */
  unsub();
  const seenBefore = seen.length;
  await bookmarkRepo.refresh({}, "s1");
  assert(seen.length === seenBefore, "unsubscribed listener must not be called");

  bookmarkRepo.resetAll();
  console.log("\nALL BOOKMARK-REPO SMOKE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  bookmarkRepo.resetAll();
  process.exit(1);
});
