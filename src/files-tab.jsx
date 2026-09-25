/**
 * files-tab.jsx — 官方右侧栏 files 页型的 extension 接管（任务 5.x）。
 *
 * 注册面（design D2）：{id, kind:"files", priority:"extension"} + guide 顺序 10
 * ——同 kind 同优先级 extension 胜官方内置，本插件的树身上台；卸载/降级即恢复
 * 官方树。体挂 sidebar.right.pane.tab（key = id），title 挂 sidebar.right.pane.tab.title。
 *
 * 与官方树的差异（specs/files-explorer）：点文件即官方 openResource（reveal 既有
 * tab）；点目录仅展开不跳转；. 开头隐藏段照常显示，但不提供加入书签；
 * 变更流单点订阅（services.hub），可见才订阅、500ms 去抖静默重拉展开目录；
 * focus/可见性/tab 显隐是推送的兜底。
 */
import { useEffect, useSyncExternalStore, useRef } from "react";
import { buildRowMenuItems, RowMenu, useRowMenu } from "./row-menu.jsx";
import { bookmarkRepo } from "./bookmark-repo.mjs";
import { services } from "./services.mjs";
import { fileAddressFor, joinWorkspacePath } from "./workspace-path.mjs";
import { compareEntries, hasHiddenSegment, relFromAbs } from "./tree-utils.mjs";
import { createChangeSync, pruneAbsentEntry } from "./changes-sync.mjs";
import { FILES_TAB_ID, filesTabDefinition } from "./tab-definitions.mjs";

export { FILES_TAB_ID, filesTabDefinition };

export const FILES_KIND = "files";

/** guide 条目图标：React 组件（官方同形态，接收 {size, className}）。 */
export function GuideFolderGlyph({ size, className }) {
  return (
    <span
      className={className}
      style={{ display: "inline-flex", width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: folderGlyph() }}
    />
  );
}

/** 树内使用的极简 SVG 字形（同旧 dock 的 FolderIcon/FileIcon）。 */
export function folderGlyph() {
  return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h6c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2v-7.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
}

function fileGlyph() {
  return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 2.2h5.2L12.8 6v7.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.2 2.4V6h3.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
}

function caretGlyph(open) {
  return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="' + (open ? "M5 4l4.5 4L5 12" : "M4.5 6.2L8.5 10l4-3.8") + '" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

/* ------------------------------------------------------------------ *
 * 树模型（模块级，按 tabId 存活；tab.record 销毁（signal abort）即丢弃）
 * ------------------------------------------------------------------ */

const treeModels = new Map();

function createTreeModel(tabId, signal) {
  const model = {
    id: tabId,
    /** absPath → {status, entries, truncated, failure} */
    levels: new Map(),
    /** 展开的目录 absPath 集合（根恒在）。 */
    expanded: new Set(),
    root: "",
    version: 0,
    listeners: new Set()
  };
  treeModels.set(tabId, model);
  signal.addEventListener(
    "abort",
    () => {
      treeModels.delete(tabId);
    },
    { once: true }
  );
  return model;
}

function treeModelFor(tabId, signal) {
  return treeModels.get(tabId) ?? createTreeModel(tabId, signal);
}

function bump(model) {
  model.version += 1;
  for (const listener of [...model.listeners]) {
    try {
      listener();
    } catch {
      /* 单订阅者异常不拖垮 */
    }
  }
}

/** cwd（绝对）+ rel → abs（joinWorkspacePath 薄别名，含 rel 已绝对原样）。 */
const absFromRel = joinWorkspacePath;

/* ------------------------------------------------------------------ *
 * 体组件
 * ------------------------------------------------------------------ */

export function FilesTabBody({ useTabInfo, sessionId, useSessions, t }) {
  const { tab } = useTabInfo();
  const cwd = typeof useSessions === "function" ? useSessions((sessions) => sessions.byId[sessionId]?.cwd) : undefined;
  const model = treeModelFor(tab.id, tab.signal);
  useSyncExternalStore(
    (listener) => {
      model.listeners.add(listener);
      return () => model.listeners.delete(listener);
    },
    () => model.version,
    () => model.version
  );
  const [menu, openMenu] = useRowMenu();
  /** absPath → 请求代（最新请求胜出，官方同款竞态守卫）。 */
  const generationsRef = useRef(new Map());

  const root = cwd ?? "";
  const visible = tab.visible !== false;
  const active = sessionId !== undefined && root !== "" && visible;
  const refreshTickRef = useRef(null);

  /** 单目录拉取（silent 不置 loading）。RemoteResult {ok,value}|{ok,error}。 */
  const loadDir = (abs, silent = false) => {
    if (!active) return;
    const generations = generationsRef.current;
    const generation = (generations.get(abs) ?? 0) + 1;
    generations.set(abs, generation);
    if (!silent || !model.levels.has(abs)) {
      model.levels.set(abs, { status: "loading" });
      bump(model);
    }
    services.ctxRef.current?.remote?.workspaceFiles
      ?.list(sessionId, abs, tab.signal)
      .then((result) => {
        if (generations.get(abs) !== generation) return;
        if (result?.ok) {
          const entries = (result.value?.entries ?? [])
            .map((entry) => ({ name: entry.name, type: entry.type, abs: `${abs.replace(/[/\\]+$/, "")}/${entry.name}` }))
            .sort(compareEntries);
          model.levels.set(abs, { status: "ok", entries, truncated: !!result.value?.truncated });
        } else {
          model.levels.set(abs, { status: "error", failure: result?.error ?? { code: "unknown", message: "unknown" } });
        }
        bump(model);
      })
      .catch((error) => {
        if (generations.get(abs) !== generation) return;
        model.levels.set(abs, { status: "error", failure: { code: "unknown", message: String(error?.message || error) } });
        bump(model);
      });
  };

  /** 静默重拉根 + 全部展开目录（变更流去抖后与兜底共用）。 */
  const refreshExpanded = () => {
    if (!active) return;
    loadDir(root, true);
    for (const abs of model.expanded) {
      if (abs !== root) loadDir(abs, true);
    }
  };
  refreshTickRef.current = refreshExpanded;

  /* 首次/根变化：重置并加载根。 */
  useEffect(() => {
    if (sessionId === undefined || root === "") return;
    if (model.root !== root) {
      model.root = root;
      model.levels = new Map();
      model.expanded = new Set([root]);
      bump(model);
    }
    if (!model.levels.has(root)) loadDir(root);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [sessionId, root]);

  /* 变更流：可见才订阅；ready=基线就位补刷一次；change=absent 即时摘除 + 500ms
     去抖静默重拉（编排在 changes-sync 共用模块，书签 tab 同款语义）。 */
  useEffect(() => {
    if (!active || !services.hub) return undefined;
    const sync = createChangeSync({
      follow: services.hub.follow,
      sessionId,
      onAbsent: (absolutePath) => {
        if (pruneAbsentEntry(model.levels, absolutePath)) bump(model);
      },
      onRefresh: () => refreshTickRef.current?.()
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshTickRef.current?.();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      sync.dispose();
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [sessionId, root, visible]);

  /* tab 显隐过渡：隐藏→可见补刷一次（sidebar 收起期间错过的变更）。 */
  useEffect(() => {
    if (visible) refreshTickRef.current?.();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [visible]);

  /* 书签集变化 → 角标随订阅刷新。 */
  useSyncExternalStore(bookmarkRepo.subscribe, () => bookmarkVersion(), () => bookmarkVersion());

  const reload = () => {
    if (root === "") return;
    model.levels = new Map();
    model.expanded = new Set([root]);
    bump(model);
    loadDir(root);
  };

  const toggleDir = (entry) => {
    if (model.expanded.has(entry.abs)) {
      model.expanded.delete(entry.abs);
      bump(model);
      return;
    }
    model.expanded.add(entry.abs);
    bump(model);
    if (!model.levels.has(entry.abs)) loadDir(entry.abs);
  };

  const openFile = (entry) => {
    try {
      tab.actions?.openResource(fileAddressFor(sessionId, cwd, entry.abs));
    } catch {
      /* 地址无效（wiring mistake）不冒泡：静默忽略 */
    }
  };

  const rowMenu = (entry, bookmarked) => (e) => {
    e.preventDefault();
    const rel = relFromAbs(cwd, entry.abs);
    const items = buildRowMenuItems(
      { t, sessionId, rel, isDir: entry.type === "directory", isHtml: /\.(html?|xhtml)$/i.test(entry.name) },
      { bookmarked, actions: services.actions }
    );
    openMenu(items, e.clientX, e.clientY);
  };

  const level = model.levels.get(root);
  const empty = root === "";

  return (
    <div className="dve-paneBody">
      <div className="dve-paneHead">
        <span className="dve-panePath" title={cwd ?? ""}>
          {cwd ?? t("files.noWorkspace")}
        </span>
        <button type="button" className="dve-iconBtn" title={t("files.reload")} onClick={reload} disabled={empty}>
          <ReloadGlyph />
        </button>
      </div>
      <div className="dve-tree">
        {sessionId === undefined || empty ? (
          <div className="dve-muted dve-pad">{t("files.noWorkspace")}</div>
        ) : (
          <TreeLevel
            model={model}
            level={level}
            abs={root}
            depth={0}
            t={t}
            cwd={cwd}
            sessionId={sessionId}
            tab={tab}
            onToggle={toggleDir}
            onOpen={openFile}
            onMenu={rowMenu}
          />
        )}
      </div>
      <RowMenu items={menu?.items} x={menu?.x} y={menu?.y} onClose={() => openMenu(null)} />
    </div>
  );
}

/** 书签仓库版本号：订阅粒度用（repo 自身无版本计数，用 loaded/list 长度合成）。 */
let repoVersionCache = { s: "", v: 0 };
function bookmarkVersion() {
  return repoVersionCache.v;
}
/* 订阅仓库把变化转成版本号 bump（模块级，安装一次）。 */
let repoHooked = false;
export function hookBookmarkVersion() {
  if (repoHooked) return;
  repoHooked = true;
  bookmarkRepo.subscribe(() => {
    repoVersionCache = { s: "", v: repoVersionCache.v + 1 };
  });
}

/** 递归渲染一层目录（含 loading/error/truncated/empty 行与子目录展开）。 */
function TreeLevel({ model, level, abs, depth, t, cwd, sessionId, tab, onToggle, onOpen, onMenu }) {
  const rel = relFromAbs(cwd, abs);
  if (!level || level.status === "loading") {
    return (
      <div className="dve-muted dve-pad" style={{ paddingLeft: 8 + depth * 16 }}>
        {t("files.loading")}
      </div>
    );
  }
  if (level.status === "error") {
    return (
      <div className="dve-muted dve-pad dve-errLine" style={{ paddingLeft: 8 + depth * 16 }}>
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
      {level.entries.map((entry) => (
        <TreeRow
          key={entry.abs}
          model={model}
          entry={entry}
          depth={depth}
          t={t}
          cwd={cwd}
          sessionId={sessionId}
          tab={tab}
          onToggle={onToggle}
          onOpen={onOpen}
          onMenu={onMenu}
        />
      ))}
      {level.truncated && (
        <div className="dve-muted dve-pad" style={{ paddingLeft: 8 + depth * 16 }}>
          {t("files.truncated")}
        </div>
      )}
    </ul>
  );
}

function TreeRow({ model, entry, depth, t, cwd, sessionId, tab, onToggle, onOpen, onMenu }) {
  const isDir = entry.type === "directory";
  const isOther = !isDir && entry.type !== "file";
  const open = isDir && model.expanded.has(entry.abs);
  const rel = relFromAbs(cwd, entry.abs);
  const bookmarked = !hasHiddenSegment(rel) && bookmarkRepo.has(sessionId, rel);
  const childLevel = isDir && open ? model.levels.get(entry.abs) : null;
  return (
    <li className="dve-rowWrap">
      <div
        className={"dve-row" + (isOther ? " dve-rowOther" : "")}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => (isDir ? onToggle(entry) : isOther ? undefined : onOpen(entry))}
        onContextMenu={onMenu(entry, bookmarked)}
        title={rel}
      >
        <span className="dve-caret">{isDir ? <span className="dve-glyph" dangerouslySetInnerHTML={{ __html: caretGlyph(open) }} /> : null}</span>
        <span className="dve-glyph" dangerouslySetInnerHTML={{ __html: isDir ? folderGlyph() : fileGlyph() }} />
        <span className="dve-rowName">{entry.name}</span>
        {bookmarked && (
          <span className="dve-star" title={t("ex.star")}>
            ★
          </span>
        )}
      </div>
      {isDir && open && (
        <TreeLevel
          model={model}
          level={childLevel}
          abs={entry.abs}
          depth={depth + 1}
          t={t}
          cwd={cwd}
          sessionId={sessionId}
          tab={tab}
          onToggle={onToggle}
          onOpen={onOpen}
          onMenu={onMenu}
        />
      )}
    </li>
  );
}

/** 失败行文案（对齐官方失败码语义）。 */
export function failureLine(t, failure) {
  switch (failure?.code) {
    case "workspace-file/not-found":
      return t("files.errNotFound");
    case "workspace-file/outside-workspace":
      return t("files.errOutside");
    case "workspace-file/not-directory":
      return t("files.errNotDir");
    default:
      return t("files.errUnavailable").replace("{message}", String(failure?.message ?? ""));
  }
}

function ReloadGlyph() {
  return (
    <span
      className="dve-glyph"
      dangerouslySetInnerHTML={{
        __html: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.6V5h-2.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      }}
    />
  );
}
