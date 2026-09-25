/**
 * dsh-v-explorer — 客户端源码（由 build.mjs 用 esbuild 打包成
 * factory 形式的 lib/client.js；react/@deepseek-ai/* 全部 external）。
 *
 * 官方侧栏接管形态（change official-sidebar-adoption）：
 *  - 文档渲染器：documentPreviews 注册 Reader Pro markdown（extensions
 *    ["md","markdown"]，extension 带默认胜出官方 markdown）与 JSON 美化
 *    （extensions ["json"]），体挂 sidebar.right.tab.document 座；load-more
 *    由官方宿主托管（scrollportRef），行号导航自消费 navigation.params.line
 *  - 页型：sidebarRightTabs 注册 files（kind "files"，extension 接管官方树，
 *    guide 顺序 10）与 bookmarks（kind "bookmarks"，guide 顺序 20）；体挂
 *    sidebar.right.pane.tab 座。官方树的下拉仍在，可切回
 *  - 变更流：workspaceFiles.changes 的插件单点订阅（官方 ChangeFeed 私有），
 *    每会话至多一条，树身/书签共享，可见才订阅、归零即 dispose
 *  - 自动展开：进入会话幂等落出 files + bookmarks 两页（最常用常开，files 保持
 *    前台）；无跨会话关闭记忆——手动收起仅作用于当前会话（specs/sidebar-auto-open）
 *  - 默认宽度：装配时把右栏保存偏好预置为契约最小 300px（layout panels 绑定
 *    动作，官方同路写入），首开 45% 播种不再生效；会话内拖拽宽度由官方承接
 *  - 引用体系（保留项）：composer chip 条（conversation.input.dock）点击改走
 *    官方 openResource（降级复制）；会话窗口框选→引用；宿主 /snapshot 快照
 *    与 pre-step 摘录不变
 *  - 跨窗口 UI（toast/框选菜单）挂 shell.overlay 的零尺寸条目——旧 dock 与
 *    预览浮窗整体退役（specs/composer-integration 与 6.x 退役任务）
 *
 * 降级（design D9）：sidebarRightTabs / documentPreviews / remote.workspaceFiles
 * 任一缺席时跳过对应注册面（console.warn 一次），chips/框选/书签 SSE 照常——
 * 与 0.1.2 的「响亮失败」不同，这是对未知新版的静默降级。
 */
import { services, provideServices } from "./services.mjs";
import { ctxRef } from "./input-facade.mjs";
import { dictionaries } from "./dictionaries.mjs";
import { createChangesHub } from "./changes-hub.mjs";
import { bookmarkRepo } from "./bookmark-repo.mjs";
import { installConversationSelection, OverlayUi } from "./ui-bus.jsx";
import { createRowActions } from "./row-menu.jsx";
import { installAutoOpen } from "./auto-open.mjs";
import { installRightbarDefaultWidth } from "./rightbar-width.mjs";
import { RefChipBar } from "./chips.jsx";
import { filesTabDefinition, FilesTabBody, FILES_TAB_ID, GuideFolderGlyph, hookBookmarkVersion } from "./files-tab.jsx";
import { bookmarksTabDefinition, BookmarksTabBody, BOOKMARKS_TAB_ID, GuideBookmarkGlyph } from "./bookmarks-tab.jsx";
import { readerMarkdownDefinition, ReaderMarkdownBody, READER_MARKDOWN_ID } from "./reader-markdown.jsx";
import { readerJsonDefinition, ReaderJsonBody, READER_JSON_ID } from "./reader-json.jsx";
// 构建期由 build.mjs 从 src/markdown-reader-pro.css 变换注入（字符串）。
import PREVIEW_CSS from "virtual:dve-reader-css";

const PLUGIN_ID = "dsh-v-explorer";
const NS = "dsh-v-explorer";

/** 依赖的服务名（loader 排序；都是 0.1.5-rc.2 平台种子/官方模块）。 */
export const inject = [
  "slots",
  "locale",
  "sessions",
  "layout",
  "sidebarRightTabs",
  "sidebarRight",
  "documentPreviews",
  "remote",
  "remote.workspaceFiles"
];

/* ------------------------------------------------------------------ *
 * 样式
 *  - PREVIEW_CSS：Reader Pro 主题（作用域 .dve-rp/.dve-rpBody/.dve-md）
 *  - explorer.css：页型体（树/菜单/toast/chips）走宿主 --dsw-alias-* 令牌
 * ------------------------------------------------------------------ */

const CSS = `
/* ── 页型体骨架 ── */
.dve-paneBody{display:flex;flex-direction:column;height:100%;min-height:0}
.dve-paneHead{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dve-panePath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,var(--dsw-font-family,monospace))}
.dve-bmCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.dve-tree{flex:1;min-height:0;overflow:auto;padding:6px 0 24px;font-size:12.5px}
.dve-level{list-style:none;margin:0;padding:0}
.dve-rowWrap{display:block}
.dve-row{display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap;user-select:none}
.dve-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dve-caret{display:inline-flex;flex:none;width:14px;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dve-glyph{display:inline-flex;flex:none;width:15px;height:15px;color:var(--dsw-alias-label-secondary)}
.dve-glyph svg{width:15px;height:15px;display:block}
.dve-rowName{overflow:hidden;text-overflow:ellipsis;min-width:0}
.dve-rowOther{color:var(--dsw-alias-label-tertiary);cursor:default}
.dve-rowInvalid{opacity:.75}
.dve-rowInvalid .dve-rowName{color:var(--dsw-alias-state-error-primary);text-decoration:line-through}
.dve-star{flex:none;color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:1}
.dve-badge{flex:none;font-size:10.5px;color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);border-radius:5px;padding:0 4px;opacity:.85}
.dve-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:6px 8px}
.dve-errLine{word-break:break-all;white-space:normal}
.dve-pad{padding:14px 12px;line-height:1.7}
.dve-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;border:none;background:transparent;border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dve-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dve-iconBtn:disabled{opacity:.4;cursor:default}
/* ── 右键菜单 / 框选菜单 ── */
.dve-menu,.dve-selMenu{position:fixed;z-index:10000;min-width:170px;padding:4px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv3)}
.dve-menuItem,.dve-selItem{display:block;width:100%;text-align:left;padding:7px 12px;border:none;background:transparent;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);border-radius:7px;cursor:pointer}
.dve-menuItem:hover,.dve-selItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* ── toast 栈 ── */
.dve-toasts{position:fixed;right:16px;bottom:16px;z-index:10001;display:flex;flex-direction:column;gap:8px}
.dve-toast{max-width:360px;padding:8px 14px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-alias-label-primary);font-size:12px;border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv2);animation:dveToastIn .18s ease-out}
@keyframes dveToastIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dve-toast--err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dve-toast--ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}
/* ── 引用 chip 条：官方行内引用同配方（业务色、无胶囊、无效删除线），
      颜色全部来自 --dsw-alias-* 别名层；容器宽度公式对齐官方 dock 条 ── */
.dve-chipBar{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,24px) - var(--dsh-composer-side-clearance,24px) - var(--dsh-composer-dock-inset,16px) - var(--dsh-composer-dock-inset,16px));max-width:calc(var(--dsh-composer-card-max-width,780px) - var(--dsh-composer-dock-inset,16px) - var(--dsh-composer-dock-inset,16px));margin:0 auto;padding:0 var(--dsh-composer-dock-inset,16px);display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;justify-content:center;flex:none;position:relative}
.dve-chip{display:inline-flex;align-items:center;gap:2px;max-width:340px;padding:1px 4px 1px 6px;border:none;border-radius:6px;background:transparent;font-size:12px;line-height:20px;font-family:var(--dsw-font-family,inherit);cursor:pointer;color:var(--dsw-alias-state-business-primary)}
.dve-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dve-chipInvalid{opacity:.7;color:var(--dsw-alias-state-error-primary)}
.dve-chipInvalid .dve-chipName{text-decoration:line-through}
.dve-chipName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,var(--dsw-font-family,monospace))}
.dve-chipRange{flex:none;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,var(--dsw-font-family,monospace))}
.dve-chipInvalid .dve-chipRange{color:inherit}
.dve-chipX{flex:none;width:16px;height:16px;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;border-radius:999px}
.dve-chipX:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dve-chipPop{position:fixed;z-index:10002;max-width:440px;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv3);padding:8px 10px;font:400 11px/16px var(--ds-font-family-code,var(--dsw-font-family,monospace));color:var(--dsw-alias-label-secondary);white-space:pre;pointer-events:none}
.dve-chipPopLine{display:flex;gap:8px}
.dve-chipPopN{flex:none;color:var(--dsw-alias-label-tertiary);text-align:right;min-width:2.2em}
.dve-chipPopT{min-width:0;overflow:hidden;text-overflow:ellipsis}
/* ── 渲染器体胶水：令牌根 / 滚动容器（scrollportRef 挂这里，load-more 归官方） ── */
.dve-rp{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bg-primary)}
.dve-rpBody{flex:1;min-height:0;overflow:auto}
.dve-rpNote{padding:10px 26px;color:var(--accent-warning);font-size:12px}
/* ── Reader Pro 正文胶水：留白 / 长词换行 / 表格横向滚动 ── */
.dve-md{padding:22px 26px;overflow-wrap:break-word}
.dve-md table{display:block;width:max-content;max-width:100%;overflow-x:auto;border-radius:var(--radius-lg)}
/* ── 任务列表复选框：li::before 绘制，不注入原始 HTML（html:false 防线不动） ── */
.dve-md li.dve-task{list-style:none}
.dve-md li.dve-task::before{content:"";display:inline-block;width:16px;height:16px;box-sizing:border-box;border:2px solid var(--border-default);border-radius:5px;margin-right:8px;vertical-align:-3px;background:var(--bg-secondary);transition:all var(--transition-fast)}
.dve-md li.dve-task:hover::before{border-color:var(--accent-primary)}
.dve-md li.dve-taskDone::before{content:"✓";background:var(--accent-success);border-color:var(--accent-success);color:var(--bg-primary);font-size:11px;font-weight:700;line-height:12px;text-align:center}
/* ── 行号导航定位：目标块的底色脉冲（走 Reader Pro 令牌域） ── */
@keyframes dveLinePulse{from{background:color-mix(in srgb,var(--accent-primary) 28%,transparent)}to{background:transparent}}
.dve-linePulse{animation:dveLinePulse 1.5s ease-out}
/* ── JSON 渲染器 ── */
.dve-json{margin:0;padding:18px 22px;font:400 12px/1.6 var(--ds-font-family-code,var(--dsw-font-family,monospace));color:var(--text-primary);white-space:pre;tab-size:2}
.dve-jsonWrap{white-space:pre-wrap;overflow-wrap:break-word}
`;

/** 两张样式表：主题（作用域化 Reader Pro）+ explorer（页型体/菜单/chips）。 */
function installStyles(ctx) {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tags = [
      ["reader-theme.css", PREVIEW_CSS],
      ["explorer.css", CSS]
    ].map(([name, text]) => {
      const tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.sheet = name;
      tag.textContent = text;
      document.head.appendChild(tag);
      return tag;
    });
    return () => {
      for (const tag of tags) tag.remove();
    };
  }, "dsh-v-explorer: styles");
}

/* ── 页型 title 座（chip 徽标用；icon 由 guide 定义提供） ── */

function FilesTabTitle({ t }) {
  return <span className="dve-tabTitle">{t("files.typeLabel")}</span>;
}

function BookmarksTabTitle({ t }) {
  return <span className="dve-tabTitle">{t("bm.typeLabel")}</span>;
}

/* ------------------------------------------------------------------ *
 * 书签多标签页同步：/events SSE（bookmarks-changed）按当前会话连接
 * ------------------------------------------------------------------ */

function installBookmarksEvents(ctx) {
  ctx.effect(() => {
    let source = null;
    let connected = undefined;
    const connect = () => {
      let sessionId;
      try {
        sessionId = ctx.sessions?.list?.getSnapshot?.()?.current;
      } catch {
        return;
      }
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
    const unsubscribe = ctx.sessions?.list?.subscribe?.(connect);
    connect();
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
      if (source) source.close();
      connected = undefined;
    };
  }, "dsh-v-explorer: bookmarks events");
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  ctxRef.current = ctx;
  ctx.locale.register(NS, dictionaries);
  const t = ctx.locale.bind(NS);
  provideServices({ t, actions: createRowActions(t), ctxRef });

  installStyles(ctx);

  /* 右栏默认宽度落定契约最小值（独立于页型接管面——降级形态同样生效；
   * 形状探测缺席即 warn 跳过，见 src/rightbar-width.mjs）。 */
  installRightbarDefaultWidth(ctx);

  /* 注册面探测（design D9：缺席即静默跳过对应面，一次 warn）。 */
  const previews = ctx.documentPreviews;
  const tabs = ctx.sidebarRightTabs;
  const sidebar = ctx.sidebarRight;
  const remoteOk = typeof ctx.remote?.workspaceFiles?.list === "function";
  const missing = [];
  if (!previews) missing.push("documentPreviews");
  if (!tabs || !sidebar) missing.push("sidebarRightTabs/sidebarRight");
  if (!remoteOk) missing.push("remote.workspaceFiles");
  if (missing.length > 0) {
    console.warn("[dsh-v-explorer] official sidebar faces unavailable, skipping:", missing.join(", "));
  }

  /* 文档渲染器：Reader Pro markdown + JSON 美化（extension 胜默认）。
     官方契约（DocumentPreviewDefinition）：title 是 () => string 的 locale
     函数——工具栏渲染时才求值；传字符串会在 selected.title() 处崩溃。 */
  if (previews) {
    try {
      previews.register(readerMarkdownDefinition(() => t("rd.markdown")));
      previews.register(readerJsonDefinition(() => t("rd.json")));
      ctx.slots.inject("sidebar.right.tab.document", () =>
        ctx.slots.register({ name: "sidebar.right.tab.document", key: READER_MARKDOWN_ID, locale: NS }, ReaderMarkdownBody)
      );
      ctx.slots.inject("sidebar.right.tab.document", () =>
        ctx.slots.register({ name: "sidebar.right.tab.document", key: READER_JSON_ID, locale: NS }, ReaderJsonBody)
      );
    } catch (error) {
      console.warn("[dsh-v-explorer] document renderer registration skipped:", error);
    }
  }

  /* 页型接管：files（extension 胜官方内置）+ bookmarks；变更流与自动展开只在
     侧栏面完整时装配。 */
  if (tabs && sidebar && remoteOk) {
    try {
      tabs.register(filesTabDefinition(t, { folder: GuideFolderGlyph }));
      tabs.register(bookmarksTabDefinition(t, { bookmark: GuideBookmarkGlyph }));
      ctx.slots.inject("sidebar.right.pane.tab", () =>
        ctx.slots.register({ name: "sidebar.right.pane.tab", key: FILES_TAB_ID, locale: NS }, FilesTabBody)
      );
      ctx.slots.inject("sidebar.right.pane.tab", () =>
        ctx.slots.register({ name: "sidebar.right.pane.tab", key: BOOKMARKS_TAB_ID, locale: NS }, BookmarksTabBody)
      );
      ctx.slots.inject("sidebar.right.pane.tab.title", () =>
        ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: FILES_TAB_ID, locale: NS }, FilesTabTitle)
      );
      ctx.slots.inject("sidebar.right.pane.tab.title", () =>
        ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: BOOKMARKS_TAB_ID, locale: NS }, BookmarksTabTitle)
      );
      provideServices({ hub: createChangesHub(() => ctxRef.current?.remote) });
      /* ★ 角标随书签仓库变化实时刷新（files-tab 的 repo→版本号桥，装一次）。 */
      hookBookmarkVersion();
      installAutoOpen(ctx, ctxRef);
    } catch (error) {
      console.warn("[dsh-v-explorer] sidebar page registration skipped:", error);
    }
  }

  /* 引用 chip 条：session 作用域 slot，无 store（数据走模块级仓库/facade）。 */
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register({ name: "conversation.input.dock", id: "dsh-v-explorer-ref-chips", order: 10, locale: NS }, RefChipBar)
  );

  /* 跨窗口 UI（toast 栈 / 会话框选菜单）：root 作用域零尺寸条目。 */
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: "dsh-v-explorer-ui", order: 60 }, OverlayUi)
  );

  /* 会话窗口框选 → 引用（保留项；预览框选入口已随浮窗退役）。 */
  installConversationSelection(ctx, ctxRef, t);

  /* 书签多标签页同步（/events 上的 bookmarks-changed）。 */
  installBookmarksEvents(ctx);
}
