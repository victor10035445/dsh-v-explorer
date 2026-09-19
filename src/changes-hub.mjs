/**
 * changes-hub.mjs — 会话级 workspaceFiles 变更流的插件单点订阅。
 *
 * 官方 ChangeFeed 是 resource provider 私有的客户端级单例（provider.d.ts：
 * "One ChangeFeed serves every open file of the Client"），其 per-file follow()
 * 面不对插件开放——插件经生成 Remote 自建托管流（每会话在 provider 之外多一条
 * Host 订阅，design D3）。约束：
 *  - 每会话至多一条流：树身与书签 tab 共享同一帧分发（follow 计数）
 *  - 最后一个 follower 离开即 dispose stream（归零即无额外订阅）
 *  - RemoteStream 自带跨代重连；循环退出仅发生在 dispose/致命错误——后者
 *    短暂延迟后重建一次（防雪崩）
 */
export function createChangesHub(getRemote) {
  /** sessionId → { stream, handlers:Set, disposed, restartTimer } */
  const sessions = new Map();

  function openStream(sessionId) {
    const remote = getRemote();
    if (!remote) throw new Error("remote service unavailable");
    return remote.$stream({
      name: `dsh-v-explorer changes of ${sessionId}`,
      open: (signal) => remote.workspaceFiles.changes(sessionId, signal),
      ended: () => new Error(`dsh-v-explorer changes of ${sessionId} ended`)
    });
  }

  function pump(sessionId, entry) {
    (async () => {
      try {
        for await (const item of entry.stream) {
          const frame = item?.value;
          if (!frame) continue;
          try {
            item.accept?.();
          } catch {
            /* accept 失败不影响分发 */
          }
          for (const handler of [...entry.handlers]) {
            try {
              handler(frame);
            } catch {
              /* 单个 handler 异常不拖垮分发 */
            }
          }
        }
      } catch {
        /* dispose 或致命错误：仅当仍有 follower 且未 dispose 时重建一次 */
      }
      if (entry.disposed || sessions.get(sessionId) !== entry) return;
      if (entry.handlers.size > 0 && !entry.restartTimer) {
        entry.restartTimer = setTimeout(() => {
          entry.restartTimer = null;
          if (entry.disposed || entry.handlers.size === 0 || sessions.get(sessionId) !== entry) return;
          try {
            entry.stream = openStream(sessionId);
            pump(sessionId, entry);
          } catch {
            /* remote 不可用：放弃本轮，等下次 follow 触发 */
          }
        }, 2000);
        entry.restartTimer.unref?.();
      }
    })();
  }

  function ensure(sessionId) {
    let entry = sessions.get(sessionId);
    if (entry) return entry;
    entry = { stream: null, handlers: new Set(), disposed: false, restartTimer: null };
    sessions.set(sessionId, entry);
    try {
      entry.stream = openStream(sessionId);
      pump(sessionId, entry);
    } catch (error) {
      /* remote 缺席（降级形态）：流不开，follow 仍然登记（无帧到达） */
      entry.error = error;
    }
    return entry;
  }

  return {
    /** 登记一个 follower；返回退订函数（最后一个退订 dispose 流）。 */
    follow(sessionId, handler) {
      const entry = ensure(sessionId);
      entry.handlers.add(handler);
      return () => {
        const current = sessions.get(sessionId);
        if (current !== entry) return;
        entry.handlers.delete(handler);
        if (entry.handlers.size === 0 && !entry.disposed) {
          entry.disposed = true;
          if (entry.restartTimer) {
            clearTimeout(entry.restartTimer);
            entry.restartTimer = null;
          }
          sessions.delete(sessionId);
          const stream = entry.stream;
          if (stream) {
            Promise.resolve(stream.dispose?.()).catch(() => {});
          }
        }
      };
    },
    /** 测试/卸载辅助：全部流立即 dispose。 */
    disposeAll() {
      for (const [sessionId, entry] of [...sessions.entries()]) {
        entry.disposed = true;
        if (entry.restartTimer) clearTimeout(entry.restartTimer);
        sessions.delete(sessionId);
        Promise.resolve(entry.stream?.dispose?.()).catch(() => {});
      }
    }
  };
}
