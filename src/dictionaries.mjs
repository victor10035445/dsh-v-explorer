/**
 * dictionaries.mjs — zh/en 字典（ctx.locale.register(NS, {zh, en})）。
 * 键集合两语言对齐（官方 locale 检查要求）；插值占位符 {message}。
 */

const zh = {
  /* 文件页型（files 接管） */
  "files.typeLabel": "文件",
  "files.guideTitle": "工作区文件",
  "files.guideDescription": "浏览本会话工作区的文件",
  "files.loading": "读取中…",
  "files.empty": "空目录",
  "files.truncated": "条目太多，只显示了一部分。",
  "files.noWorkspace": "这个会话没有工作区目录。",
  "files.reload": "重新读取",
  "files.errNotFound": "这个目录不在了。可能已被移动或删除。",
  "files.errOutside": "这个目录在工作区之外，侧栏不会读取它。",
  "files.errNotDir": "这不是一个目录。",
  "files.errUnavailable": "读取失败：{message}",

  /* 书签页型 */
  "bm.typeLabel": "书签",
  "bm.title": "书签",
  "bm.guideTitle": "书签",
  "bm.guideDescription": "收藏的工作区文件与目录",
  "bm.empty": "还没有书签。在文件树右键「加入书签」。",
  "bm.errLoad": "书签读取失败",
  "bm.gone": "已失效",

  /* 行菜单（files / 书签共用） */
  "menu.openDir": "打开所在目录",
  "menu.copyPath": "复制路径",
  "menu.insertRef": "插入到会话",
  "menu.browse": "用浏览器打开",
  "menu.addBookmark": "加入书签",
  "menu.removeBookmark": "移除书签",

  /* 文档渲染器标题 */
  "rd.markdown": "Markdown（Reader Pro）",
  "rd.json": "JSON（格式化）",

  /* toast / 提示 */
  "ex.title": "文件探索器",
  "ex.toastCopied": "已复制",
  "ex.toastFail": "操作失败",
  "ex.toastRefInserted": "已插入引用",
  "ex.toastRefCopied": "已复制引用（composer 不可达）",
  "ex.toastRefFromSnapshot": "已引用快照",
  "ex.refInvalid": "引用失效",
  "ex.noSession": "没有当前会话",
  "ex.sendRef": "发送引用到会话",
  "ex.copyRef": "复制引用",
  "ex.star": "已收藏"
};

/** 英文字典（键集合与 zh 对齐，官方 locale 检查要求）。 */
const en = {
  "files.typeLabel": "Files",
  "files.guideTitle": "Workspace files",
  "files.guideDescription": "Browse files in this session's workspace",
  "files.loading": "Reading…",
  "files.empty": "Empty directory",
  "files.truncated": "Too many entries, showing only some of them.",
  "files.noWorkspace": "This session has no workspace directory.",
  "files.reload": "Reload",
  "files.errNotFound": "That directory is gone. It may have been moved or deleted.",
  "files.errOutside": "That directory is outside the workspace, so the sidebar will not read it.",
  "files.errNotDir": "That is not a directory.",
  "files.errUnavailable": "Read failed: {message}",

  "bm.typeLabel": "Bookmarks",
  "bm.title": "Bookmarks",
  "bm.guideTitle": "Bookmarks",
  "bm.guideDescription": "Pinned workspace files and directories",
  "bm.empty": "No bookmarks yet. Right-click a row in the file tree to add one.",
  "bm.errLoad": "Failed to load bookmarks",
  "bm.gone": "missing",

  "menu.openDir": "Open containing folder",
  "menu.copyPath": "Copy path",
  "menu.insertRef": "Insert into chat",
  "menu.browse": "Open in browser",
  "menu.addBookmark": "Add bookmark",
  "menu.removeBookmark": "Remove bookmark",

  "rd.markdown": "Markdown (Reader Pro)",
  "rd.json": "JSON (formatted)",

  "ex.title": "Explorer",
  "ex.toastCopied": "Copied",
  "ex.toastFail": "Action failed",
  "ex.toastRefInserted": "Reference inserted",
  "ex.toastRefCopied": "Reference copied (composer unavailable)",
  "ex.toastRefFromSnapshot": "Snapshot referenced",
  "ex.refInvalid": "Reference invalid",
  "ex.noSession": "No current session",
  "ex.sendRef": "Send reference to chat",
  "ex.copyRef": "Copy reference",
  "ex.star": "Bookmarked"
};

export const dictionaries = { zh, en };
