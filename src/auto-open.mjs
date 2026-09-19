/**
 * auto-open.mjs — 新会话自动展开官方右侧栏 files 页型（specs/sidebar-auto-open）。
 *
 * 公共面事实：ISidebarRight 只有 isExpanded()/toggleExpanded() 读写，没有展开
 * 状态的观察口（服务 d.ts 已核实）——迁移观测用 700ms 低频轮询实现（一次方法
 * 调用，开销可忽略），轮询仅在 install 效果存续期间运行。
 *
 * 规则：
 *  - 触发：当前会话变化且会话存在（sessions.list current 变化即会话已恢复/新建）
 *  - 动作：侧栏未展开时 openTab("files")（全局面板/无会话面时官方动作自身
 *    抛错——捕获吞掉，不是用户错误）
 *  - 记忆：localStorage "dsh-v-explorer:sidebarClosed"——展开状态观测到的
 *    true→false 迁移（用户手动收起；本插件动作只产生 false→true）即写入，
 *    false→true 迁移（手动展开）即清除
 *  - 幂等：同一会话只自动展开一次
 */
const SIDEBAR_CLOSED_KEY = "dsh-v-explorer:sidebarClosed";
const POLL_MS = 700;

function readClosedPref() {
  try {
    return localStorage.getItem(SIDEBAR_CLOSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeClosedPref(closed) {
  try {
    if (closed) localStorage.setItem(SIDEBAR_CLOSED_KEY, "1");
    else localStorage.removeItem(SIDEBAR_CLOSED_KEY);
  } catch {
    /* 存储不可用：按无记忆处理（每次都尝试自动展开） */
  }
}

export function installAutoOpen(ctx, ctxRef) {
  if (!ctx.sidebarRight) return;
  let openedFor = null;

  const currentSession = () => {
    try {
      const snap = ctx.sessions?.list?.getSnapshot?.();
      return snap?.current;
    } catch {
      return undefined;
    }
  };

  /* 会话变化 → 幂等自动展开。 */
  ctx.effect(() => {
    const sync = () => {
      const sessionId = currentSession();
      if (sessionId === undefined || openedFor === sessionId) return;
      if (readClosedPref()) return;
      try {
        if (ctx.sidebarRight.isExpanded()) {
          openedFor = sessionId;
          return;
        }
        ctx.sidebarRight.openTab("files");
        openedFor = sessionId;
      } catch {
        /* 无 mounted surface / 非会话面板：本轮放弃，会话面挂载后的下一次
           会话变化或重载会再试。 */
      }
    };
    const unsubscribe = ctx.sessions?.list?.subscribe?.(sync);
    sync();
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, "dsh-v-explorer: session auto-open");

  /* 展开迁移观测（轮询）：true→false=手动收起记偏好；false→true=手动展开清偏好。
     本插件动作只产生 false→true，不存在误记；own-open 后的立即收起也按用户
     收起对待（与手动语义一致）。 */
  ctx.effect(() => {
    let wasExpanded = null;
    const timer = setInterval(() => {
      let expanded;
      try {
        expanded = ctx.sidebarRight.isExpanded();
      } catch {
        return;
      }
      if (expanded === wasExpanded) return;
      const first = wasExpanded === null;
      wasExpanded = expanded;
      if (first) return;
      if (!expanded) writeClosedPref(true);
      else writeClosedPref(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, "dsh-v-explorer: expansion preference watch");
}
