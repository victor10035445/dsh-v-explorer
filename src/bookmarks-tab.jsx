/**
 * bookmarks-tab.jsx — 官方右侧栏「书签」页型（specs/bookmarks-tab）。
 *
 * 注册面：{id, kind:"bookmarks", priority:"extension"} + guide 顺序 20（排在
 * files 10 之后）；体挂 sidebar.right.pane.tab，title 挂 ...title 座。
 * ≥2 个页型时默认页为 Guide——官方规则，已接受（proposal）。
 *
 * 行为：会话作用域书签列表（bookmarkRepo，本 tab 与 files 树身共享）；
 * 每个书签是子树的虚拟根，懒加载与展开状态按 absPath 独立；文件书签点击
 * openResource 进官方预览；目录书签点击展开；失效书签保留并删除线标记
 * （exists:false，重验即自动摘标）；变更流任意帧 + 可见性过渡 → 500ms 去抖
 * 重验（重验 = /bookmarks 重拉，宿主逐条 stat 重标 exists/isDir）。
 */
import { useEffect, useSyncExternalStore, useRef } from "react";
import { buildRowMenuItems, RowMenu, useRowMenu } from "./row-menu.jsx";
import { bookmarkRepo } from "./bookmark-repo.mjs";
import { services } from "./services.mjs";
import { fileAddressFor, joinWorkspacePath } from "./workspace-path.mjs";
import { hasHiddenSegment, relFromAbs } from "./tree-utils.mjs";
import { BOOKMARKS_TAB_ID, bookmarksTabDefinition } from "./tab-definitions.mjs";
import { failureLine } from "./files-tab.jsx";

export { BOOKMARKS_TAB_ID, bookmarksTabDefinition };

/** guide 条目图标：React 组件（官方同形态）。 */
export function GuideBookmarkGlyph({ size, className }) {
  return (
    <span
      className={className}
      style={{ display: "inline-flex", width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: bookmarkGlyph() }}
    />
  );
}

/* 展开状态/子目录层级：模块级按 tabId 存活（files 同款）。 */
const bmModels = new Map();

function bmModelFor(tabId, signal) {
  let model = bmModels.get(tabId);
  if (model) return model;
  model = { levels: new Map(), expanded: new Set(), version: 0, listeners: new Set() };
  bmModels.set(tabId, model);
  signal.addEventListener(
    "abort",
    () => {
      bmModels.delete(tabId);
    },
    { once: true }
  );
  return model;
}

function bmBump(model) {
  model.version += 1;
  for (const listener of [...model.listeners]) {
    try {
      listener();
    } catch {
      /* 单订阅者异常不拖垮 */
    }
  }
}

/** 书签根字形（本地一份，避免跨模块导出展示细节）。 */
function bookmarkGlyph() {
  return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 2.8h8a.8.8 0 0 1 .8.8v10.1L8 10.9l-4.8 2.8V3.6a.8.8 0 0 1 .8-.8z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
}

export function BookmarksTabBody({ useTabInfo, sessionId, useSessions, t }) {
  const { tab } = useTabInfo();
  const cwd = typeof useSessions === "function" ? useSessions((sessions) => sessions.byId[sessionId]?.cwd) : undefined;
  const model = bmModelFor(tab.id, tab.signal);
  useSyncExternalStore(
    (listener) => {
      model.listeners.add(listener);
      return () => model.listeners.delete(listener);
    },
    () => model.version,
    () => model.version
  );
  /* 书签列表（会话作用域；identity 稳定，仅在变化时更新）。 */
  const bookmarks = useSyncExternalStore(bookmarkRepo.subscribe, () => bookmarkRepo.getSnapshot(sessionId), () => bookmarkRepo.getSnapshot(sessionId));
  const [menu, openMenu] = useRowMenu();
  const generationsRef = useRef(new Map());
  const visible = tab.visible !== false;
  const active = sessionId !== undefined && visible;

  const loadDir = (abs, silent = false) => {
    if (!active || cwd === undefined || cwd === null) return;
    const generations = generationsRef.current;
    const generation = (generations.get(abs) ?? 0) + 1;
    generations.set(abs, generation);
    if (!silent || !model.levels.has(abs)) {
      model.levels.set(abs, { status: "loading" });
      bmBump(model);
    }
    services.ctxRef.current?.remote?.workspaceFiles
      ?.list(sessionId, abs, tab.signal)
      .then((result) => {
        if (generations.get(abs) !== generation) return;
        if (result?.ok) {
          const entries = (result.value?.entries ?? [])
            .map((entry) => ({ name: entry.name, type: entry.type, abs: `${abs.replace(/[/\\]+$/, "")}/${entry.name}` }))
            .sort((a, b) => (a.type !== b.type ? (a.type === "directory" ? -1 : 1) : String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" })));
          model.levels.set(abs, { status: "ok", entries, truncated: !!result.value?.truncated });
        } else {
          model.levels.set(abs, { status: "error", failure: result?.error ?? { code: "unknown", message: "unknown" } });
        }
        bmBump(model);
      })
      .catch((error) => {
        if (generations.get(abs) !== generation) return;
        model.levels.set(abs, { status: "error", failure: { code: "unknown", message: String(error?.message || error) } });
        bmBump(model);
      });
  };

  /* 挂载/可见 → 拉书签（含 exists/isDir 重验）。 */
  useEffect(() => {
    if (!active) return undefined;
    bookmarkRepo.refresh(services.ctxRef.current, sessionId);
    const onVisible = () => {
      if (document.visibilityState === "visible") bookmarkRepo.refresh(services.ctxRef.current, sessionId);
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, visible, cwd]);

  /* 变更流任意帧 → 500ms 去抖重验（对齐 files 树身的刷新节奏）。 */
  useEffect(() => {
    if (!active || !services.hub) return undefined;
    let timer = null;
    const unsubscribe = services.hub.follow(sessionId, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => bookmarkRepo.refresh(services.ctxRef.current, sessionId), 500);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, visible]);

  const toggleDir = (abs) => {
    if (model.expanded.has(abs)) {
      model.expanded.delete(abs);
      bmBump(model);
      return;
    }
    model.expanded.add(abs);
    bmBump(model);
    if (!model.levels.has(abs)) loadDir(abs);
  };

  const openFile = (abs) => {
    try {
      tab.actions?.openResource(fileAddressFor(sessionId, cwd, abs));
    } catch {
      /* 地址无效不冒泡 */
    }
  };

  const rowMenu = (abs, bookmarked, isDir) => (e) => {
    e.preventDefault();
    const rel = relFromAbs(cwd, abs);
    const items = buildRowMenuItems(
      { t, sessionId, rel, isDir, isHtml: /\.(html?|xhtml)$/i.test(abs) },
      { bookmarked, actions: services.actions }
    );
    openMenu(items, e.clientX, e.clientY);
  };

  const list = bookmarks ?? [];
  const error = bookmarkRepo.errorOf(sessionId);

  return (
    <div className="dve-paneBody">
      <div className="dve-paneHead">
        <span className="dve-panePath">{t("bm.title")}</span>
        <span className="dve-bmCount">{list.length}</span>
      </div>
      <div className="dve-tree">
        {list.length === 0 ? (
          <div className="dve-muted dve-pad">{error ? t("bm.errLoad") + ": " + error : t("bm.empty")}</div>
        ) : (
          <ul className="dve-level">
            {list.map((bookmark) => (
              <BookmarkRootRow
                key={bookmark.path}
                bookmark={bookmark}
                cwd={cwd}
                model={model}
                sessionId={sessionId}
                t={t}
                onToggle={toggleDir}
                onOpen={openFile}
                onMenu={rowMenu}
                loadDir={loadDir}
              />
            ))}
          </ul>
        )}
      </div>
      <RowMenu items={menu?.items} x={menu?.x} y={menu?.y} onClose={() => openMenu(null)} />
    </div>
  );
}

/** 书签根行（虚拟子树根）：失效保留 + 删除线；目录可展开；文件点击进预览。 */
function BookmarkRootRow({ bookmark, cwd, model, sessionId, t, onToggle, onOpen, onMenu, loadDir }) {
  const abs = joinWorkspacePath(cwd, bookmark.path);
  const isDir = bookmark.isDir === true;
  const invalid = bookmark.exists === false;
  const open = isDir && model.expanded.has(abs);
  const childLevel = isDir && open ? model.levels.get(abs) : null;
  const bookmarked = !hasHiddenSegment(bookmark.path);
  return (
    <li className="dve-rowWrap">
      <div
        className={"dve-row" + (invalid ? " dve-rowInvalid" : "")}
        style={{ paddingLeft: 8 }}
        onClick={() => (invalid ? undefined : isDir ? onToggle(abs) : onOpen(abs))}
        onContextMenu={onMenu(abs, bookmarked && bookmarkRepo.has(sessionId, bookmark.path), isDir)}
        title={bookmark.path}
      >
        <span className="dve-caret">{isDir ? <span className="dve-glyph" dangerouslySetInnerHTML={{ __html: filesCaret(open) }} /> : null}</span>
        <span className="dve-glyph" dangerouslySetInnerHTML={{ __html: bookmarkGlyph() }} />
        <span className="dve-rowName">{bookmark.path}</span>
        {invalid && <span className="dve-badge">{t("bm.gone")}</span>}
      </div>
      {isDir && open && (
        <BookmarkChildLevel model={model} level={childLevel} abs={abs} depth={1} t={t} sessionId={sessionId} onToggle={onToggle} onOpen={onOpen} onMenu={onMenu} cwd={cwd} />
      )}
    </li>
  );
}

function BookmarkChildLevel({ model, level, abs, depth, t, sessionId, onToggle, onOpen, onMenu, cwd }) {
  if (!level || level.status === "loading") {
    return (
      <div className="dve-muted dve-pad" style={{ paddingLeft: 8 + depth * 16 }}>
        {t("files.loading")}
      </div>
    );
  }
  if (level.status === "error") {
    return (
      <div className="dve-muted dve-pad" style={{ paddingLeft: 8 + depth * 16 }}>
        {failureLine(t, level.failure)}
      </div>
    );
  }
  if (level.entries.length === 0) {
    return (
      <div className="dve-muted dve-pad" style={{ paddingLeft: 8 + depth * 16 }}>
        {t("files.empty")}
      </div>
    );
  }
  return (
    <ul className="dve-level">
      {level.entries.map((entry) => {
        const isDir = entry.type === "directory";
        const open = isDir && model.expanded.has(entry.abs);
        const rel = relFromAbs(cwd, entry.abs);
        return (
          <li className="dve-rowWrap" key={entry.abs}>
            <div
              className="dve-row"
              style={{ paddingLeft: 8 + depth * 16 }}
              onClick={() => (isDir ? onToggle(entry.abs) : onOpen(entry.abs))}
              onContextMenu={onMenu(entry.abs, bookmarkRepo.has(sessionId, rel), isDir)}
              title={rel}
            >
              <span className="dve-caret">{isDir ? <span className="dve-glyph" dangerouslySetInnerHTML={{ __html: filesCaret(open) }} /> : null}</span>
              <span className="dve-glyph" dangerouslySetInnerHTML={{ __html: filesFile() }} />
              <span className="dve-rowName">{entry.name}</span>
            </div>
            {isDir && open && (
              <BookmarkChildLevel model={model} level={model.levels.get(entry.abs)} abs={entry.abs} depth={depth + 1} t={t} sessionId={sessionId} onToggle={onToggle} onOpen={onOpen} onMenu={onMenu} cwd={cwd} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 子层目录/文件符（files-tab 的字形不跨模块公开——本地重画一份）。 */
function filesCaret(open) {
  return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="' + (open ? "M5 4l4.5 4L5 12" : "M4.5 6.2L8.5 10l4-3.8") + '" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function filesFile() {
  return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 2.2h5.2L12.8 6v7.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.2 2.4V6h3.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
}
