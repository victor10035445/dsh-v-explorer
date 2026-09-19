/**
 * bookmark-repo.mjs — 书签仓库（模块级单例，useSyncExternalStore 消费）。
 *
 * 为什么不用 slot store：书签集合被 files 树身（★ 角标 + 右键 toggle）与
 * 书签 tab（列表渲染 + 增删）两个 body 共享，而一个 slot store handle 只能
 * 挂一个注册；模块级可观察仓库让两处订阅同一份数据，无作用域摩擦。
 *
 * 数据形状（宿主 GET /bookmarks 响应）：[{path, addedAt, exists, isDir}]
 * 同步源：本页 CRUD 响应体直落 + /events SSE bookmarks-changed（多标签页）
 * + 变更流触发的重验（refresh）。
 */
import { apiGet, apiPost } from "./api.mjs";

/** sessionId → { list, loaded, error } */
const state = new Map();
const listeners = new Set();

function snapshotOf(sessionId) {
  return state.get(sessionId) ?? { list: [], loaded: false, error: null };
}

function emit(sessionId) {
  for (const listener of listeners) {
    try {
      listener(sessionId);
    } catch {
      /* 单个订阅者异常不拖垮通知 */
    }
  }
}

function setEntry(sessionId, patch) {
  const prev = snapshotOf(sessionId);
  state.set(sessionId, { ...prev, ...patch });
  emit(sessionId);
}

/* ── 会话未就绪 404 的退避重试：0.6s 起步、5s 封顶、8 次（≈24s 窗口）。每会话
   同时至多一个 pending timer；成功拉取或会话重置时清除。 ── */
const retryTimers = new Map();
const RETRY_BASE_MS = 600;
const RETRY_CAP_MS = 5000;
const RETRY_MAX_TRIES = 8;

function clearRetry(sessionId) {
  const timer = retryTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    retryTimers.delete(sessionId);
  }
}

function scheduleRetry(ctx, sessionId, attempt) {
  if (attempt > RETRY_MAX_TRIES) return;
  clearRetry(sessionId);
  const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  const timer = setTimeout(() => {
    retryTimers.delete(sessionId);
    void bookmarkRepo.refresh(ctx, sessionId); // 成功或仍未就绪都会走 refresh 自己的分支
  }, delay);
  timer.unref?.();
  retryTimers.set(sessionId, timer);
}

export const bookmarkRepo = {
  /** React 订阅面：getSnapshot(sessionId) + subscribe(fn(sessionId))。 */
  getSnapshot(sessionId) {
    return snapshotOf(sessionId).list;
  },
  isLoaded(sessionId) {
    return snapshotOf(sessionId).loaded;
  },
  errorOf(sessionId) {
    return snapshotOf(sessionId).error;
  },
  /** fn(sessionId) 在该会话书签集变化时被调；返回退订函数。 */
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  has(sessionId, rel) {
    return snapshotOf(sessionId).list.some((b) => b.path === rel);
  },
  /** 拉取书签列表（含 exists/isDir 标注）。会话未就绪 404（重启窗口期）按
   *  退避重试兜底（0.6s 起步、5s 封顶、8 次 ≈24s，同旧 /list 语义），期间保持
   *  未 loaded、不落错误；其它错误照常落账。 */
  async refresh(ctx, sessionId) {
    if (!sessionId) return;
    try {
      const data = await apiGet("/bookmarks", { sessionId });
      clearRetry(sessionId);
      setEntry(sessionId, { list: Array.isArray(data.bookmarks) ? data.bookmarks : [], loaded: true, error: null });
    } catch (error) {
      const message = String(error?.message || error);
      if (/session not found/i.test(message)) {
        setEntry(sessionId, { list: [], loaded: false, error: null });
        scheduleRetry(ctx, sessionId, 1);
        return;
      }
      setEntry(sessionId, { error: message });
    }
  },
  /** 加入书签（响应体直落，幂等由宿主保证）。 */
  async add(ctx, sessionId, rel) {
    const data = await apiPost("/bookmark-add", { sessionId, path: rel });
    setEntry(sessionId, { list: Array.isArray(data.bookmarks) ? data.bookmarks : [], loaded: true, error: null });
    return data;
  },
  /** 移除书签（幂等）。 */
  async remove(ctx, sessionId, rel) {
    const data = await apiPost("/bookmark-remove", { sessionId, path: rel });
    setEntry(sessionId, { list: Array.isArray(data.bookmarks) ? data.bookmarks : [], loaded: true, error: null });
    return data;
  },
  /** 会话切换时清缓存（书签集随 cwd 走）并撤销未就绪重试。 */
  reset(sessionId) {
    clearRetry(sessionId);
    if (state.delete(sessionId)) emit(sessionId);
  },
  resetAll() {
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    state.clear();
    emit(null);
  }
};
