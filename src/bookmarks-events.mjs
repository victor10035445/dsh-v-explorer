/**
 * bookmarks-events.mjs — 书签多标签页同步：/events SSE（bookmarks-changed）按屏上
 * 会话连接（specs/bookmarks-tab · 多标签页同步；change port-dsh-0-2-1-sidebar-yield）。
 *
 * 会话作用域换源（0.2.1-rc.5）：读数与订阅**双换**——
 *  - 原读数 `ctx.sessions.list.getSnapshot().current` 已被官方删除（选中态移交
 *    视图层），0.2.1 上恒 undefined，SSE 永不按会话连接（多标签同步静默失效）。
 *  - 即使只换读数也不行：官方把选中态交给视图层后，`sessions.list` 的提交已不
 *    代表会话切换——必须同时把订阅换成 `ctx.sidebarRight.mounted.subscribe`。
 *
 * 降级（design D9）：`mounted` 观察口缺席/形状不符 → 警告一次、SSE 不连接；
 * 引用 chip 条与会话框选等其余能力照常（本模块只负责书签 SSE 作用域）。
 */
import { bookmarkRepo } from "./bookmark-repo.mjs";
import { ctxRef } from "./input-facade.mjs";
import {
  canReadOnScreenSession,
  canSubscribeOnScreenSession,
  onScreenSessionId,
  subscribeOnScreenSession
} from "./on-screen-session.mjs";

export function installBookmarksEvents(ctx) {
  ctx.effect(() => {
    if (!canReadOnScreenSession(ctx) || !canSubscribeOnScreenSession(ctx)) {
      console.warn(
        "[dsh-v-explorer] sidebarRight.mounted observer unavailable, bookmarks SSE sync skipped (chips unaffected)"
      );
      return undefined;
    }
    let source = null;
    let connected; /* 当前 SSE 连接对应的会话；undefined = 未连接 */
    const connect = () => {
      const sessionId = onScreenSessionId(ctx);
      if (sessionId === connected) return;
      connected = sessionId;
      if (source) {
        source.close();
        source = null;
      }
      if (sessionId === undefined) return;
      bookmarkRepo.refresh(ctxRef.current, sessionId);
      source = new EventSource(`/api/dsh-v-explorer/events?sessionId=${encodeURIComponent(sessionId)}`);
      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data?.type === "bookmarks-changed") bookmarkRepo.refresh(ctxRef.current, sessionId);
        } catch {
          /* 非 JSON 帧（注释/心跳）忽略 */
        }
      };
      /* onerror：EventSource 自带重连；会话失效 404 时静默等待下一轮连接 */
    };
    const unsubscribe = subscribeOnScreenSession(ctx, connect);
    connect();
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
      if (source) source.close();
      connected = undefined;
    };
  }, "dsh-v-explorer: bookmarks events");
}
