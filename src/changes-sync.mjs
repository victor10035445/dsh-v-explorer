/**
 * changes-sync.mjs — 变更流跟随的目录级同步编排（files 树身与书签 tab 共用，
 * 无 JSX，node 可直接测）。
 *
 * 帧语义（官方 WorkspaceFileWatchFrame，dsh-api-workspace-files types.d.ts 核实；
 * 帧报告"观察"而非增量——消费方据此自行重拉）：
 *  - ready：Host 观察就绪、根已解析（排队积压随后以 change 帧补发）→ 去抖后
 *    全量静默重拉一次（基线对齐）
 *  - change + absent：被观察路径已消失 → 立即（不等去抖）从全部已加载 ok 层
 *    摘除该条目——被删除的文件/目录不应在树上多挂 500ms；随后照常去抖重拉
 *    （同目录可能还有其它变化）
 *  - change + version：内容观察 → 去抖后静默重拉
 *  - 未知 kind（未来版本扩展帧）忽略
 *
 * 去抖：500ms 尾沿（files 树身既有节奏），窗口内重复帧合并为一次重拉；
 * refreshNow() 供可见性过渡 / focus / tab 显隐等兜底路径直连（跳过去抖并取消
 * 未触发的 timer，不双发）。
 */
export const CHANGE_SYNC_DEBOUNCE_MS = 500;

/**
 * 从全部已加载 ok 层摘除 absolutePath 条目（absent 观察）；仅被摘除的层替换为
 * 新对象（快照身份诚实），无匹配时不动任何层。
 * @param levels - absPath → level 的 Map（files/bookmark 树模型同形）。
 * @param absolutePath - absent 观察的绝对路径。
 * @returns 是否有层被摘除（调用方据此决定是否 bump 渲染版本）。
 */
export function pruneAbsentEntry(levels, absolutePath) {
  let touched = false;
  for (const [abs, level] of levels) {
    if (level.status !== "ok") continue;
    const kept = level.entries.filter((entry) => entry.abs !== absolutePath);
    if (kept.length !== level.entries.length) {
      levels.set(abs, { ...level, entries: kept });
      touched = true;
    }
  }
  return touched;
}

/**
 * 订阅一路 changes 流并编排 absent 摘除与去抖重拉。
 * @param opts.follow - 变更流登记面（services.hub.follow），返回退订函数。
 * @param opts.sessionId - 会话 id（follow 的作用域键）。
 * @param opts.debounceMs - 重拉去抖窗口（默认 500ms 尾沿）。
 * @param opts.onAbsent - absent 观察的即时处理（同步调用）。
 * @param opts.onRefresh - 去抖到期的重拉动作（also refreshNow 直连入口）。
 * @returns { refreshNow, dispose } —— dispose 退订并清理未触发的 timer。
 */
export function createChangeSync({ follow, sessionId, debounceMs = CHANGE_SYNC_DEBOUNCE_MS, onAbsent, onRefresh }) {
  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onRefresh();
    }, debounceMs);
  };
  const unsubscribe = follow(sessionId, (frame) => {
    if (frame?.kind === "ready") {
      schedule();
    } else if (frame?.kind === "change") {
      if (frame.change?.absent && frame.change.absolutePath) onAbsent(frame.change.absolutePath);
      schedule();
    }
  });
  return {
    refreshNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      onRefresh();
    },
    dispose() {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}
