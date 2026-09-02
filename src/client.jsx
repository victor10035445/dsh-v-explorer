/**
 * dsh-v-explorer — 客户端源码（由 build.mjs 用 esbuild 打包成
 * factory 形式的 lib/client.js；react/@deepseek-ai/* 全部 external）。
 *
 * 结构：
 *  - 会话头部 utilities 区（session log 按钮右侧）注入 dock 开关按钮
 *  - shell.overlay 注册右侧 dock（VS Code 式文件树）+ Markdown 预览浮窗；
 *    dock 打开时按实际重叠量给宿主 AppFrame 中列让位（padding-right），
 *    会话区在剩余可见空间重新居中，而不是被浮层盖住
 *  - 树懒加载：展开目录时按层拉取 /api/dsh-v-explorer/list
 *  - 自动刷新（A）：宿主 fs.watch(recursive) 监听会话 cwd，SSE /events 推送
 *    fs-changed 信号 → 静默重拉当前展开目录（不打 loading、不丢展开状态；
 *    标签页隐藏时跳过重拉，恢复可见时补刷）。（B 兜底）dock 重新打开、窗口
 *    聚焦、页面恢复可见、预览打开文件时同样静默补刷
 *  - 会话切换：订阅 sessions.list，current 变化即重置树并换 cwd
 *  - 右键菜单：打开所在目录 / 复制路径 / 插入到会话（官方 @path 引用语法，
 *    经 slash/input-insert-text 事件写进当前会话 composer）；html 文件另有
 *    「打开」——用系统默认浏览器按 file 协议打开（宿主端 /open-browser）
 *  - 书签面板：dock 上下分层（explorer flex:1 + 水平分隔条 ns-resize + 定高
 *    书签区，高度/收起记忆 localStorage）。书签 = 纯路径引用表 + 多根树视图
 *    （每个书签是一棵子树的虚拟根，懒加载与 explorer 共享 nodes 缓存、展开
 *    状态按 x:/b: 命名空间独立）；持久化在宿主端 .dsh-v-explorer/bookmarks.json
 *    （GET /bookmarks、POST /bookmark-add|bookmark-remove，响应体直接落账
 *    store）；SSE bookmarks-changed 驱动多标签页同步；右键菜单来源感知
 *    （「移除」只对书签根、「加入」对其它一切，toggle）；explorer 已收藏行
 *    ★ 角标；失效书签保留并标记（删除线 + 暗色），绝不自动清理
 *  - 预览浮窗：可拖拽、可最小化成一条。可预览格式由 src/previewers.mjs
 *    注册表决定——markdown-it 渲染 md（html:false 防 XSS），文本类（txt/
 *    json/py/yaml/…）按 <pre> 纯文本渲染（React 文本子节点自动转义），标题栏
 *    带语言徽章；每个条目预留 styles 字段作为该格式的 CSS 显示样式接口
 *    （collectPreviewerCss 汇总注入，钩子 .dve-code--<id>）。链接拦截：外链
 *    新开、相对可预览文件继续预览、相对 .html 用默认浏览器打开；主题来自
 *    src/markdown-reader-pro.css（构建期作用域化注入，Deep Ocean 深色
 *    为基准，经 body[data-ds-dark-theme] 钩子适配浅色主题）
 *  - 「引用」摘录索引：引用<路径>#起-止（1 基行:列，见 src/ref-shared.mjs）。
 *    预览页框选右键「发送引用到会话」——文本类按逐行 span 精确到列，markdown
 *    按源行标注块取整行粒度；会话窗口框选右键同样发送，短选区内联、长选区
 *    物化为 .dsh-v-explorer/refs/ 快照后引用。宿主端在 agent/pre-step（进入模型步骤
 *    的时刻）捕获摘录并作为上下文消息插在引用者紧后，捕获即定格、无漂移。
 *    输入栏 chip 条（conversation.input.dock）实时解析草稿里的引用：官方
 *    行内引用同配方样式（业务色/无胶囊/无效删除线，全部走 --dsw-alias-* 令牌，
 *    随官方主题与风格插件联动）、悬停摘录预览卡、点击打开预览窗定位脉冲、
 *    × 从草稿移除
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defineStore } from "@deepseek-ai/dsh-client-runtime/client";
import MarkdownIt from "markdown-it";
// 构建期由 build.mjs 从 src/markdown-reader-pro.css 变换注入（字符串）。
import PREVIEW_CSS from "virtual:dve-reader-css";
// dock 让位量计算（纯函数，tests/dock-yield-smoke.mjs 有边界测试）。
import { computeDockYield } from "./dock-yield.mjs";
// 预览格式注册表：哪些文件能点开预览 + 每格式预留的 CSS 显示样式接口。
import { CODE_FALLBACK, previewerFor, badgeFor, codeClassFor, displayTextFor, collectPreviewerCss } from "./previewers.mjs";
// 「引用」token 语法：与宿主端共用同一份实现（生成/解析/切片）。
import {
  parseRefTokens,
  buildRefToken,
  quotePathIfNeeded,
  sliceLines,
  INLINE_SNIPPET_MAX_CHARS
} from "./ref-shared.mjs";

/* ------------------------------------------------------------------ *
 * 常量与工具
 * ------------------------------------------------------------------ */

const PLUGIN_ID = "dsh-v-explorer";
const NS = "dsh-v-explorer";
const API = "/api/dsh-v-explorer";
const WIDTH_KEY = "dsh-v-explorer:width";
const OPEN_KEY = "dsh-v-explorer:open";
/** 书签面板：高度与收起状态的 localStorage 记忆键（读写容错同 WIDTH_KEY/OPEN_KEY）。 */
const BOOKMARK_H_KEY = "dsh-v-explorer:bookmarkH";
const BOOKMARK_OPEN_KEY = "dsh-v-explorer:bookmarkOpen";
/** 书签区默认高度（无记忆时；渲染/拖拽另有 96px ～ dock高-160px 的 clamp）。 */
const BOOKMARK_DEFAULT_H = 240;

/** 会话就绪重试：宿主端会话是懒恢复的，重启后页面先于恢复发起请求时
    /list、/events 会 404（session not found）。退避 0.6s 起步、5s 封顶、
    8 次预算（≈24s 窗口）；根目录拉取与 SSE 订阅共用。 */
const READY_RETRY_BASE_MS = 600;
const READY_RETRY_MAX = 8;

/** dock 开关记忆：没有记忆（或读不到）时默认展开；用户手动关过就保持关闭。 */
function savedOpen() {
  try {
    const saved = localStorage?.getItem(OPEN_KEY);
    return saved === null || saved === undefined ? true : saved === "1";
  } catch {
    return true;
  }
}

function rememberOpen(value) {
  try {
    localStorage?.setItem(OPEN_KEY, value ? "1" : "0");
  } catch {
    /* 隐私模式等场景写不进就算了 */
  }
}

/** 书签区展开记忆：没有记忆（或读不到）默认收起——空书签面板占 1/3 高度是
    负价值；区块头常驻可见保证可发现性，首次加入书签时自动展开一次（写入记忆）。 */
function savedBookmarkOpen() {
  try {
    return localStorage?.getItem(BOOKMARK_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberBookmarkOpen(value) {
  try {
    localStorage?.setItem(BOOKMARK_OPEN_KEY, value ? "1" : "0");
  } catch {
    /* 同上 */
  }
}

/** 书签区高度记忆：无记忆返回 null（布局用默认高度）。 */
function savedBookmarkH() {
  try {
    const saved = Number(localStorage?.getItem(BOOKMARK_H_KEY));
    return Number.isFinite(saved) && saved >= 96 ? saved : null;
  } catch {
    return null;
  }
}

function rememberBookmarkH(value) {
  try {
    localStorage?.setItem(BOOKMARK_H_KEY, String(Math.round(value)));
  } catch {
    /* 同上 */
  }
}

/** 书签集合成员判断键：win32/mac 文件系统大小写不敏感（与服务端归一化去重同款），
    同一路径的大小写变体在客户端也折叠成同一成员。 */
const BOOKMARK_CASE_FOLD = typeof navigator !== "undefined" && /win|mac/i.test(String(navigator.platform || ""));
function bookmarkKeyOf(rel) {
  return BOOKMARK_CASE_FOLD ? rel.toLowerCase() : rel;
}

/** @type {import("react").MutableRefObject<import("react").Context | null>} 由 apply 注入 */
const ctxRef = { current: null };

async function api(route, params) {
  const query = new URLSearchParams(params ?? {}).toString();
  const res = await fetch(API + route + (query ? "?" + query : ""));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.status + " " + res.statusText);
  return body;
}

async function apiPost(route, payload) {
  const res = await fetch(API + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.status + " " + res.statusText);
  return body;
}

/** 官方 @path 引用语法：含空格的路径用 @"..." 包裹。 */
function referenceOf(rel) {
  return /\s/.test(rel) ? '@"' + rel + '"' : "@" + rel;
}

/**
 * 把文本插入当前会话的 composer。
 *
 * 不走 slash/input-insert-text 事件——它的 span 参数是 pick 时的 CAS 快照
 * （draftRev 必须与输入机当前状态一致），外部调用者读不到机器状态，必然失败。
 * 改走 DOM 层：对 composer 的 textarea（稳定钩子 data-phase 属性）用原型
 * setter 绕过 React 值追踪写入新值，再派发冒泡 input 事件——React onChange
 * 触发，输入机按「一次普通草稿变更」处理，等同真实键入。
 */
const COMPOSER_TA = '[data-conversation-scroll] textarea[data-phase]';

function findComposer() {
  if (typeof document === "undefined") return null;
  return document.querySelector(COMPOSER_TA) ?? document.querySelector("textarea[data-phase]");
}

/** 用原型 setter + 冒泡 input 事件整体改写 composer 草稿（等同真实键入）。 */
function setComposerValue(ta, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(ta, value);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  return true;
}

function insertIntoComposer(text) {
  try {
    const ta = findComposer();
    if (!ta || ta.disabled || ta.readOnly) return false;
    const current = ta.value;
    const glue = current.length > 0 && !/\s$/.test(current) ? " " : "";
    return setComposerValue(ta, current + glue + text);
  } catch {
    return false;
  }
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/* 代码块语言徽章：Reader Pro 主题用 pre[data-lang]::before 显示右上角语言标签，
   默认 fence 渲染器不带该属性——包一层，把 info 串的首段写进 data-lang。 */
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = (tokens[idx].info || "").trim().split(/\s+/)[0] || "";
  const html = defaultFence(tokens, idx, options, env, self);
  return info ? html.replace("<pre>", '<pre data-lang="' + md.utils.escapeHtml(info) + '">') : html;
};

/* 任务列表：`- [ ]` / `- [x]` → li 打 dve-task / dve-taskDone 类并剥掉标记，
   复选框由 CSS ::before 绘制——不注入任何原始 HTML，html:false 防线不动。 */
md.core.ruler.after("inline", "dve_task_lists", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "inline") continue;
    const match = /^\[([ xX])\]\s+/.exec(tokens[i].content);
    if (!match) continue;
    const paragraphOpen = tokens[i - 1];
    const itemOpen = tokens[i - 2];
    if (!paragraphOpen || paragraphOpen.type !== "paragraph_open") continue;
    if (!itemOpen || itemOpen.type !== "list_item_open") continue;
    const child = tokens[i].children?.[0];
    if (!child || child.type !== "text") continue;
    child.content = child.content.replace(/^\[[ xX]\]\s+/, "");
    itemOpen.attrJoin("class", "dve-task");
    if (match[1] !== " ") itemOpen.attrJoin("class", "dve-taskDone");
  }
});

/* 源行标注：把块级 token 自带的 map（源码行区间，0 基左闭右开）写成 DOM 属性
   data-dve-line / data-dve-end（1 基闭区间）——markdown 渲染文本 ≠ 源文本，
   引用定位只能精确到行，选区映射按覆盖到的块求并集。 */
md.core.ruler.after("inline", "dve_source_lines", (state) => {
  for (const token of state.tokens) {
    if (!token.map || token.nesting === -1) continue;
    token.attrSet("data-dve-line", String(token.map[0] + 1));
    token.attrSet("data-dve-end", String(token.map[1]));
  }
});

/* ------------------------------------------------------------------ *
 * 选区 → 引用区间（预览页框选的两个映射器 + token 组装）
 * ------------------------------------------------------------------ */

/**
 * 文本类预览（逐行 span，行文本 = 原行 + "\n"）：把选区映射为 1 基行:列。
 * 列语义：选区起点落在第 o 个字符（0 基）→ col = o+1；起点压在行尾换行上
 * → 归一为下一行 col 1；选区终点 col = 被选中的最后一个字符的 1 基位置。
 * @returns {{start,end}|null} 无法映射（选区不在 pre 内）返回 null
 */
function codeSelectionRange(pre, content) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!pre.contains(range.startContainer) || !pre.contains(range.endContainer)) return null;
  const allLines = String(content ?? "").split("\n");
  const lineOf = (node) => {
    const el = node.nodeType === 3 ? node.parentElement : node instanceof Element ? node : null;
    const span = el?.closest?.(".dve-codeLine");
    return span ? { span, line: Number(span.dataset.line) } : null;
  };
  const s = lineOf(range.startContainer);
  const e = lineOf(range.endContainer);
  if (!s || !e) return null;
  const sLen = (allLines[s.line - 1] ?? "").length;
  let start;
  if (range.startOffset >= sLen) {
    /* 压在行尾换行上 → 下一行 col 1；末行则钳回行尾 */
    start = s.line < allLines.length ? { line: s.line + 1, col: 1, wholeLine: false } : { line: s.line, col: sLen + 1, wholeLine: false };
  } else {
    start = { line: s.line, col: range.startOffset + 1, wholeLine: false };
  }
  let end;
  if (range.endOffset === 0 && e.line > 1) {
    /* 终点在行首 → 上一行最后一个字符是真正被选中的终点 */
    end = { line: e.line - 1, col: (allLines[e.line - 2] ?? "").length, wholeLine: false };
  } else {
    const eLen = (allLines[e.line - 1] ?? "").length;
    end = { line: e.line, col: Math.min(range.endOffset, eLen), wholeLine: false };
  }
  if (start.line > end.line || (start.line === end.line && start.col > end.col)) return null;
  return { start, end };
}

/**
 * Markdown 预览：选区覆盖到的全部源行标注块求并集 → 整行粒度区间。
 * @returns {{start,end}|null}
 */
function mdSelectionRange(body) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  let first = Infinity;
  let last = 0;
  for (const el of body.querySelectorAll("[data-dve-line]")) {
    if (!range.intersectsNode(el)) continue;
    first = Math.min(first, Number(el.dataset.dveLine));
    last = Math.max(last, Number(el.dataset.dveEnd));
  }
  if (!Number.isFinite(first) || last < first) return null;
  return {
    start: { line: first, col: 1, wholeLine: true },
    end: { line: last, col: 1, wholeLine: true }
  };
}

/* ------------------------------------------------------------------ *
 * 文案（zh 为准，en 对齐键集）
 * ------------------------------------------------------------------ */

const zh = {
  "ex.title": "文件探索器",
  "ex.open": "打开所在目录",
  "ex.insert": "插入到会话",
  "ex.browse": "打开",
  "ex.preview": "点击预览",
  "ex.refresh": "刷新",
  "ex.close": "关闭",
  "ex.empty": "（空目录）",
  "ex.loading": "载入中…",
  "ex.noSession": "没有活动会话——打开一个会话后，这里会显示它的工作目录。",
  "ex.truncated": "文件超过 10MB，仅读取前 10MB",
  "ex.renderCap": "内容过大，仅渲染前 100 万字符",
  "ex.binary": "二进制文件，无法预览",
  "ex.minimize": "最小化",
  "ex.restore": "还原",
  "ex.toastOpened": "已在文件管理器中打开",
  "ex.toastBrowsed": "已在默认浏览器中打开",
  "ex.toastInserted": "已插入到会话输入框",
  "ex.toastInsertFallback": "无法直接插入，引用已复制到剪贴板",
  "ex.linkCopied": "路径已复制到剪贴板",
  "ex.sendRef": "发送引用到会话",
  "ex.copyRef": "复制引用",
  "ex.toastRefInserted": "引用已插入会话输入框",
  "ex.toastRefCopied": "引用已复制到剪贴板",
  "ex.toastRefFromSnapshot": "已保存选区快照，引用已插入会话输入框",
  "ex.refInvalid": "引用目标无法读取",
  "ex.toastFail": "操作失败",
  "ex.bookmarks": "书签",
  "ex.bmAdd": "加入书签",
  "ex.bmRemove": "移除书签",
  "ex.bmEmpty": "右键文件或文件夹即可加入书签",
  "ex.toastBookmarked": "已加入书签",
  "ex.toastUnbookmarked": "已移除书签"
};
const en = {
  "ex.title": "Explorer",
  "ex.open": "Open containing folder",
  "ex.insert": "Insert into session",
  "ex.browse": "Open in browser",
  "ex.preview": "Click to preview",
  "ex.refresh": "Refresh",
  "ex.close": "Close",
  "ex.empty": "(empty)",
  "ex.loading": "Loading…",
  "ex.noSession": "No active session — open one and its working directory shows up here.",
  "ex.truncated": "File over 10MB; showing first 10MB",
  "ex.renderCap": "Content too large; rendering first 1M characters",
  "ex.binary": "Binary file; preview unavailable",
  "ex.minimize": "Minimize",
  "ex.restore": "Restore",
  "ex.toastOpened": "Opened in file manager",
  "ex.toastBrowsed": "Opened in the default browser",
  "ex.toastInserted": "Inserted into the composer",
  "ex.toastInsertFallback": "Direct insert unavailable; reference copied to clipboard",
  "ex.linkCopied": "Link path copied to clipboard",
  "ex.sendRef": "Send reference to session",
  "ex.copyRef": "Copy reference",
  "ex.toastRefInserted": "Reference inserted into the composer",
  "ex.toastRefCopied": "Reference copied to clipboard",
  "ex.toastRefFromSnapshot": "Snapshot saved; reference inserted into the composer",
  "ex.refInvalid": "Reference target cannot be read",
  "ex.toastFail": "Action failed",
  "ex.bookmarks": "Bookmarks",
  "ex.bmAdd": "Add bookmark",
  "ex.bmRemove": "Remove bookmark",
  "ex.bmEmpty": "Right-click a file or folder to bookmark it",
  "ex.toastBookmarked": "Added to bookmarks",
  "ex.toastUnbookmarked": "Removed from bookmarks"
};

/* ------------------------------------------------------------------ *
 * 图标（内联 SVG，跟随 currentColor）
 * ------------------------------------------------------------------ */

function CaretIcon({ open }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1.5 4a1 1 0 011-1h3.6l1.5 1.8h5.9a1 1 0 011 1V12a1 1 0 01-1 1h-11a1 1 0 01-1-1V4z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FileIcon({ md }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 1.5h5L12.5 5v9a.5.5 0 01-.5.5H4a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {md ? <text x="8" y="11.5" textAnchor="middle" fontSize="6" fill="currentColor" stroke="none" fontFamily="monospace">M</text> : null}
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M13 8a5 5 0 11-1.5-3.5M13 2.5V5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconMinimize() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M4 11.5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconRestore() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M4 9.5h8M4 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * 共享 UI 状态（dock 条目持有；settings 区按钮经 sidebarToggle 调用）
 * ------------------------------------------------------------------ */

const uiStore = defineStore({
  init: () => ({
    open: savedOpen(), // 默认展开；用户关过则记住
    sessionId: undefined,
    cwd: undefined,
    preview: null, // { rel, name, previewer, content, truncated, binary }
    previewHighlight: null, // { startLine, endLine } | null — 打开预览时定位并脉冲的引用区间
    previewMin: false,
    previewPos: null, // { x, y } | null = 默认位置
    toast: null, // { text, kind: "ok"|"err", seq }
    bookmarks: [], // [{ path, addedAt, exists, isDir }] — 书签唯一事实来源（★ 角标与面板都从它派生，收起状态下同样生效）
    bookmarkOpen: savedBookmarkOpen(), // 书签区展开状态：无记忆默认收起
    bookmarkH: savedBookmarkH() // 书签区高度：null = 未记忆（布局用默认高度）
  }),
  actions: {
    toggle(d) {
      d.open = !d.open;
      rememberOpen(d.open);
    },
    setOpen(d, v) {
      d.open = !!v;
      rememberOpen(d.open);
    },
    setSession(d, id, cwd) {
      d.sessionId = id;
      d.cwd = cwd;
    },
    notify(d, text, kind) {
      d.toast = { text, kind, seq: (d.toast?.seq ?? 0) + 1 };
    },
    clearToast(d) {
      d.toast = null;
    },
    setBookmarks(d, list) {
      d.bookmarks = Array.isArray(list) ? list : [];
    },
    setBookmarkOpen(d, v) {
      d.bookmarkOpen = !!v;
      rememberBookmarkOpen(!!v);
    },
    setBookmarkH(d, h) {
      d.bookmarkH = h;
      rememberBookmarkH(h);
    },
    openPreview(d, file, highlight) {
      d.preview = file;
      d.previewHighlight = highlight ?? null;
      d.previewMin = false;
    },
    clearPreviewHighlight(d) {
      d.previewHighlight = null;
    },
    setPreviewMin(d, v) {
      d.previewMin = !!v;
    },
    setPreviewPos(d, pos) {
      d.previewPos = pos;
    },
    closePreview(d) {
      d.preview = null;
      d.previewPos = null;
      d.previewMin = false;
      d.previewHighlight = null;
    }
  }
});

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */

/** 复制文本：优先 async Clipboard API，非安全上下文回退 execCommand。 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到 execCommand 回退 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function ContextMenu({ t, menu, bookmarked, onClose, onAction }) {
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return undefined;
    const dismiss = (e) => {
      /* 只在点击目标位于菜单外时关闭——capture 监听比菜单项的 click 先跑，
         无条件关闭会把菜单项自己的点击一起杀掉。 */
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const isHtml = !menu.entry?.isDir && /\.(x?html?)$/i.test(menu.entry?.name || "");
  const x = Math.min(menu.x, window.innerWidth - 200);
  /* 弹出定位按条目数估算高度：书签条目使条目数恒 +1（原 130/168 未计它）。 */
  const y = Math.min(menu.y, window.innerHeight - ((isHtml ? 168 : 130) + 34));

  const item = (label, kind) => (
    <button
      type="button"
      className="dve-menuItem"
      onClick={() => {
        onClose();
        onAction(kind, menu);
      }}
    >
      {label}
    </button>
  );

  return (
    <div ref={menuRef} className="dve-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {isHtml && item(t("ex.browse"), "browse")}
      {item(t("ex.open"), "open")}
      {item(t("ex.insert"), "insert")}
      {/* 来源感知（D6）：「移除」只对书签根出现，「加入」对其它一切出现（toggle，
          已收藏行翻转为「移除」）。全部作用于原始 rel，既有条目语义零变化。 */}
      {item(menu.source === "bookmark-root" || bookmarked ? t("ex.bmRemove") : t("ex.bmAdd"), "bookmark")}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 选区右键菜单（预览框选 / 会话窗口框选共用的浮动菜单）
 * ------------------------------------------------------------------ */

function SelectionMenu({ menu, onClose }) {
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return undefined;
    const dismiss = (e) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const x = Math.min(menu.x, window.innerWidth - 210);
  const y = Math.min(menu.y, window.innerHeight - 96);
  return (
    <div ref={menuRef} className="dve-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {menu.items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="dve-menuItem"
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 预览浮窗（可拖拽 / 可最小化成一条 / Markdown + 文本类代码）
 *  - Markdown：markdown-it 渲染，Reader Pro 主题（.dve-md）
 *  - 文本类（txt/json/py/yaml/…）：<pre> 纯文本（React 文本子节点自动转义），
 *    标题栏语言徽章 + 每格式样式钩子（.dve-code--<id>，见 previewers.mjs）
 * ------------------------------------------------------------------ */

/** 把预览内的相对链接解析成会话 cwd 内的相对路径；解析不了返回 null。 */
function resolveRelative(base, href) {
  let path = href.split("#")[0].split("?")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* 非法编码就按原样解析 */
  }
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const parts = (path.startsWith("/") ? path.slice(1) : base + path).split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function PreviewWindow({ t, file, minimized, pos, highlight, onMinimize, onMove, onClose, onOpenFile, onBrowseFile, onRefContext, notify }) {
  /** 渲染保护：超过 100 万字符只渲染前缀（markdown-it 与超长文本节点都适用）。 */
  const RENDER_CAP = 1000000;
  const previewer = file.previewer ?? previewerFor(file.name) ?? CODE_FALLBACK;
  const isMarkdown = previewer.kind === "markdown";
  const badge = isMarkdown ? "" : badgeFor(previewer, file.name);
  const html = useMemo(() => {
    if (!isMarkdown || file.binary) return "";
    const content = file.content || "";
    return md.render(content.length > RENDER_CAP ? content.slice(0, RENDER_CAP) : content);
  }, [file, isMarkdown]);
  /** 文本类预览显示文本：JSON 等带 transform 的格式在此完成美化。 */
  const codeText = useMemo(() => {
    if (isMarkdown || file.binary) return "";
    const content = file.content || "";
    return displayTextFor(previewer, content.length > RENDER_CAP ? content.slice(0, RENDER_CAP) : content);
  }, [file, isMarkdown]);
  const renderCapped = !file.binary && (file.content?.length ?? 0) > RENDER_CAP;
  const defaultPos = useMemo(
    () => ({ x: Math.max(16, window.innerWidth - 716), y: 72 }),
    []
  );
  const p = pos ?? defaultPos;
  const bodyRef = useRef(null);

  /* 引用区间定位：打开时滚动到起点行，并给覆盖的行/块做一次底色脉冲。
     文本类按 data-line 逐行脉冲；markdown 按 data-dve-line/end 的块求交。 */
  useEffect(() => {
    if (!highlight || minimized || !file.content || file.binary) return undefined;
    const body = bodyRef.current;
    if (!body) return undefined;
    const targets = [];
    const first = body.querySelector(isMarkdown
      ? '[data-dve-line="' + highlight.startLine + '"]'
      : '[data-line="' + highlight.startLine + '"]');
    /* 超大区间（整文件快照）只滚动不逐行脉冲，避免数万次查询卡顿。 */
    const pulse = highlight.endLine - highlight.startLine <= 400;
    if (pulse && isMarkdown) {
      for (const el of body.querySelectorAll("[data-dve-line]")) {
        const s = Number(el.dataset.dveLine);
        const e = Number(el.dataset.dveEnd);
        if (e >= highlight.startLine && s <= highlight.endLine) targets.push(el);
      }
    } else if (pulse) {
      for (let n = highlight.startLine; n <= highlight.endLine; n++) {
        const el = body.querySelector('[data-line="' + n + '"]');
        if (el) targets.push(el);
      }
    }
    (first ?? targets[0])?.scrollIntoView?.({ block: "center" });
    for (const el of targets) el.classList.add("dve-refPulse");
    const timer = setTimeout(() => {
      for (const el of targets) el.classList.remove("dve-refPulse");
    }, 1600);
    return () => clearTimeout(timer);
  }, [highlight, minimized, file.content, file.rel, isMarkdown]);

  /** 预览内右键：有非空选区且能映射到源区间时，弹出「发送引用到会话」菜单。 */
  const onBodyContext = (e) => {
    if (file.binary || !onRefContext) return;
    const body = bodyRef.current;
    if (!body) return;
    const mapped = isMarkdown ? mdSelectionRange(body) : codeSelectionRange(body.querySelector("pre"), file.content);
    if (!mapped) return; // 无选区/映射不了 → 原生菜单
    e.preventDefault();
    onRefContext({
      token: buildRefToken({ path: file.rel, ...mapped }),
      x: e.clientX,
      y: e.clientY
    });
  };

  const onHeaderDown = (e) => {
    if (e.target.closest("button")) return;
    const ox = e.clientX - p.x;
    const oy = e.clientY - p.y;
    const move = (ev) => onMove({ x: Math.max(0, ev.clientX - ox), y: Math.max(0, ev.clientY - oy) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** 预览内链接：外链新开标签；相对 .html 用默认浏览器打开；相对可预览文件
      （md/json/py/…）继续预览；其余相对路径复制 @ 引用。 */
  const onBodyClick = (e) => {
    const anchor = e.target.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    if (!href) return;
    e.preventDefault();
    if (href.startsWith("#")) return; // 文内锚点（markdown-it 默认不生成标题 id，放行无意义）
    if (/^https?:/i.test(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    if (/^mailto:/i.test(href)) {
      window.location.href = href;
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // 其它协议一律忽略
    const base = file.rel.includes("/") ? file.rel.slice(0, file.rel.lastIndexOf("/") + 1) : "";
    const resolved = resolveRelative(base, href);
    if (!resolved) return;
    if (/\.(x?html?)$/i.test(resolved)) {
      onBrowseFile?.(resolved);
    } else if (previewerFor(resolved)) {
      onOpenFile?.(resolved);
    } else {
      copyText(referenceOf(resolved)).then((copied) => notify(t("ex.linkCopied"), copied ? "ok" : "err"));
    }
  };

  const banners = (
    <>
      {file.truncated && <div className="dve-truncated">{t("ex.truncated")}</div>}
      {renderCapped && <div className="dve-truncated">{t("ex.renderCap")}</div>}
    </>
  );

  return (
    <div className={"dve-preview" + (minimized ? " dve-previewMin" : "")} style={{ left: p.x, top: p.y }}>
      <div className="dve-previewHeader" onPointerDown={onHeaderDown} onDoubleClick={onMinimize}>
        <span className="dve-previewName" title={file.rel}>
          {minimized ? "▸ " : "▾ "}
          {file.name}
        </span>
        {!isMarkdown && badge ? <span className="dve-langTag" data-lang={badge}>{badge}</span> : null}
        <span className="dve-previewActions">
          <button type="button" className="dve-iconBtn" title={t(minimized ? "ex.restore" : "ex.minimize")} onClick={onMinimize}>
            {minimized ? <IconRestore /> : <IconMinimize />}
          </button>
          <button type="button" className="dve-iconBtn" title={t("ex.close")} onClick={onClose}>
            <IconClose />
          </button>
        </span>
      </div>
      {!minimized && (
        <div className="dve-previewBody" ref={bodyRef} onClick={onBodyClick} onContextMenu={onBodyContext}>
          {file.binary ? (
            <div className="dve-muted">{t("ex.binary")}</div>
          ) : isMarkdown ? (
            <>
              {banners}
              <div className="dve-md" dangerouslySetInnerHTML={{ __html: html }} />
            </>
          ) : (
            <>
              {banners}
              {/* 逐行 span：选区→行:列映射的定位锚点（行文本 = 原行 + 换行，
                  React 文本子节点自动转义，不进 dangerouslySetInnerHTML） */}
              <pre className={codeClassFor(previewer)} data-lang={badge}>
                {codeText.split("\n").map((line, i) => (
                  <span key={i} className="dve-codeLine" data-line={i + 1}>{line + "\n"}</span>
                ))}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 输入栏引用 chip 条（conversation.input.dock 列表 slot，order 10）
 *
 * 实时解析 composer 草稿里的 引用 token，渲染成官方行内引用同配方的小芯片：
 * 业务色文字 + 无胶囊 + hover 底色；目标不可读时呈现官方无效语义
 * （错误色 + 删除线）。交互：hover 浮出摘录预览卡、点击打开预览窗定位区间、
 * × 从草稿移除该 token。样式只用 --dsw-alias-* / --dsh-composer-* 官方令牌，
 * 风格插件改官方令牌时本条自动跟随。
 * ------------------------------------------------------------------ */

/* sessionId 是 conversation.input.dock slot 的标准 props（本条目无 store）。 */
function RefChipBar({ t, sessionId, openPreview, notify }) {
  const [draft, setDraft] = useState("");
  /** path → { ok, total?, content?, reason? }，按会话缓存（悬停预览与校验共用）。 */
  const cacheRef = useRef(new Map());
  const [, bumpValidity] = useState(0);
  const [pop, setPop] = useState(null); // { x, bottom, text }

  /* 草稿观察：document 捕获 input（React 的 onChange 会派发原生 input 事件）。 */
  useEffect(() => {
    const onInput = (e) => {
      if (e.target instanceof HTMLTextAreaElement && e.target.matches("textarea[data-phase]")) setDraft(e.target.value);
    };
    document.addEventListener("input", onInput, true);
    return () => document.removeEventListener("input", onInput, true);
  }, []);

  /* 会话切换：重读草稿 + 清缓存。 */
  useEffect(() => {
    cacheRef.current.clear();
    setPop(null);
    const ta = findComposer();
    if (ta) setDraft(ta.value);
  }, [sessionId]);

  const tokens = useMemo(() => parseRefTokens(draft), [draft]);

  /* 校验：防抖拉取每个未缓存的引用目标（存在性 + 行数），供无效态与悬停卡使用。 */
  useEffect(() => {
    if (!sessionId || tokens.length === 0) return undefined;
    const missing = [...new Set(tokens.map((tk) => tk.path))].filter((p) => !cacheRef.current.has(sessionId + "\n" + p));
    if (missing.length === 0) return undefined;
    const timer = setTimeout(async () => {
      for (const path of missing) {
        const key = sessionId + "\n" + path;
        try {
          const data = await api("/file", { sessionId, path });
          cacheRef.current.set(key, data.binary
            ? { ok: false, reason: t("ex.binary") }
            : { ok: true, total: String(data.content ?? "").split("\n").length, content: data.content ?? "" });
        } catch (error) {
          cacheRef.current.set(key, { ok: false, reason: String(error?.message || error) });
        }
      }
      bumpValidity((v) => v + 1);
    }, 350);
    return () => clearTimeout(timer);
  }, [tokens, sessionId, t]);

  if (tokens.length === 0) return null;

  const lookup = (tk) => cacheRef.current.get(sessionId + "\n" + tk.path);

  const chipClick = (tk) => {
    setPop(null);
    const cached = lookup(tk);
    if (!cached || !cached.ok) {
      notify(t("ex.refInvalid") + (cached?.reason ? ": " + cached.reason : ""), "err");
      return;
    }
    if (tk.start.line > cached.total) {
      notify(t("ex.refInvalid") + ": L" + tk.start.line + " > " + cached.total, "err");
      return;
    }
    const name = tk.path.split("/").pop();
    openPreview({
      rel: tk.path,
      name,
      previewer: previewerFor(name) ?? CODE_FALLBACK,
      content: cached.content,
      truncated: false,
      binary: false
    }, { startLine: tk.start.line, endLine: tk.end.line });
  };

  const chipRemove = (tk) => {
    setPop(null);
    const ta = findComposer();
    if (!ta || ta.value.slice(tk.index, tk.index + tk.raw.length) !== tk.raw) return;
    const next = ta.value.slice(0, tk.index) + ta.value.slice(tk.index + tk.raw.length);
    setComposerValue(ta, next.trimEnd() === "" ? "" : next);
  };

  const chipHover = (tk, el) => {
    const cached = lookup(tk);
    let text;
    if (!cached) text = "…";
    else if (!cached.ok) text = t("ex.refInvalid") + ": " + cached.reason;
    else {
      const sliced = sliceLines(cached.content, tk.start, tk.end);
      if (!sliced) text = t("ex.refInvalid") + ": L" + tk.start.line + " > " + cached.total;
      else {
        const width = String(sliced.lines[sliced.lines.length - 1]?.n ?? 0).length;
        text = sliced.lines.map((l) => String(l.n).padStart(width) + ": " + l.text).join("\n").slice(0, 2000);
      }
    }
    const rect = el.getBoundingClientRect();
    setPop({
      x: Math.min(rect.left, window.innerWidth - 440),
      bottom: window.innerHeight - rect.top + 6,
      text
    });
  };

  return (
    <div className="dve-refBar">
      <div className="dve-refBarInner">
        {tokens.map((tk, i) => {
          const cached = lookup(tk);
          const invalid = cached ? !cached.ok || tk.start.line > (cached.total ?? 0) : false;
          return (
            <span
              key={tk.index + ":" + tk.raw}
              className={"dve-refChip" + (invalid ? " dve-refChipInvalid" : "")}
              title={tk.raw}
              onMouseEnter={(e) => chipHover(tk, e.currentTarget)}
              onMouseLeave={() => setPop(null)}
            >
              <button type="button" className="dve-refChipMain" onClick={() => chipClick(tk)}>
                <span className="dve-refChipIcon"><FileIcon md={previewerFor(tk.path)?.kind === "markdown"} /></span>
                <span className="dve-refChipPath">{tk.path}</span>
                <span className="dve-refChipRange">#{tk.raw.slice(tk.raw.indexOf("#") + 1)}</span>
              </button>
              <button type="button" className="dve-refChipRemove" title="×" onClick={() => chipRemove(tk)}>×</button>
            </span>
          );
        })}
      </div>
      {pop && (
        <div className="dve-refPop" style={{ left: pop.x, bottom: pop.bottom }}>{pop.text}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 右侧 dock：文件树
 * ------------------------------------------------------------------ */

function ExplorerDock(props) {
  const { t, useStore, setSession, setOpen, openPreview, setPreviewMin, setPreviewPos, closePreview, notify, clearToast, setBookmarks, setBookmarkOpen, setBookmarkH } = props;
  const open = useStore((s) => s.open);
  const sessionId = useStore((s) => s.sessionId);
  const cwd = useStore((s) => s.cwd);
  const preview = useStore((s) => s.preview);
  const previewHighlight = useStore((s) => s.previewHighlight);
  const previewMin = useStore((s) => s.previewMin);
  const previewPos = useStore((s) => s.previewPos);
  const toast = useStore((s) => s.toast);
  const bookmarks = useStore((s) => s.bookmarks);
  const bookmarkOpen = useStore((s) => s.bookmarkOpen);
  const bookmarkH = useStore((s) => s.bookmarkH);

  /** 树节点缓存：rel → { entries, truncated, loading, error }（explorer 与书签面板共享） */
  const [nodes, setNodes] = useState({});
  /** 展开的目录集合，按树拆命名空间：`x:` + rel = explorer，`b:` + rel = 书签面板
      （同一 rel 可在一侧展开另一侧收起；缓存仍共享，key 前缀只影响展开状态） */
  const [expanded, setExpanded] = useState(() => new Set(["x:"]));
  const [menu, setMenu] = useState(null);
  /** 选区右键菜单：预览框选 / 会话窗口框选共用（items 在打开时决定）。 */
  const [selMenu, setSelMenu] = useState(null);
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage?.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= 220 && saved <= 560 ? saved : 300;
  });
  const [tick, setTick] = useState(0); // 手动刷新用
  const lastSession = useRef(undefined);
  const dockRef = useRef(null); // 书签区拖高的 clamp 需要 dock 实际高度

  /** 书签路径集合：★ 角标与右键 toggle 的成员判断（收起状态下同样生效）。 */
  const bookmarkSet = useMemo(() => new Set(bookmarks.map((b) => bookmarkKeyOf(b.path))), [bookmarks]);
  const bookmarkSetHas = (rel) => bookmarkSet.has(bookmarkKeyOf(rel));

  /* 镜像 ref：自动刷新在定时器/EventSource 回调里运行，读 state 会拿到闭包里的
     旧值——展开集合、节点缓存与当前会话都按镜像读取。 */
  const expandedRef = useRef(expanded);
  const nodesRef = useRef(nodes);
  const liveSessionRef = useRef(sessionId);
  const openRef = useRef(open);
  const cwdRef = useRef(cwd);
  const bookmarkOpenRef = useRef(bookmarkOpen);
  useEffect(() => {
    expandedRef.current = expanded;
    nodesRef.current = nodes;
    liveSessionRef.current = sessionId;
    openRef.current = open;
    cwdRef.current = cwd;
    bookmarkOpenRef.current = bookmarkOpen;
  }, [expanded, nodes, sessionId, open, cwd, bookmarkOpen]);

  /* 会话切换：重置树 + 同步 cwd。订阅在 dock 挂载期间始终存活（关面板也刷新）。 */
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx?.sessions) return undefined;
    const sync = () => {
      const snap = ctx.sessions.list.getSnapshot();
      const id = snap.current;
      const nextCwd = id !== undefined ? snap.byId[id]?.cwd : undefined;
      if (id !== lastSession.current) {
        lastSession.current = id;
        setNodes({});
        setExpanded(new Set(["x:"]));
        setMenu(null);
      }
      setSession(id, nextCwd);
    };
    sync();
    const off = ctx.sessions.list.subscribe(sync);
    return off;
  }, [setSession]);

  /* 开关状态反射到会话头部的方形按钮上。头部按钮可能晚于 dock 挂载，
     所以同时镜像到 dockOpenMirror，按钮注入时按镜像补高亮。 */
  useEffect(() => {
    dockOpenMirror.current = open;
    document.querySelector(".dve-toggleBtn")?.classList.toggle("dve-toggleBtnOn", open);
  }, [open]);

  /* 会话列让位：dock 是 fixed 浮层，直接盖在 AppFrame 中列（会话区）上会让
     会话看起来偏了。按「中列与 dock 的实际重叠量」给中列打 padding-right
     （body 状态类 dve-dockOpen + --dve-dock-w 变量），会话区在剩余可见空间里
     重新居中——details 列开着、dock 只压到它时重叠为 0，一行 CSS 都不加。
     窄屏（≤760px）dock 是全宽抽屉，CSS 侧整体不让位。 */
  useLayoutEffect(() => {
    const body = document.body;
    const update = () => {
      const col = document.querySelector('[class*="centerCol"]');
      if (!col) {
        body.classList.remove("dve-dockOpen");
        body.style.removeProperty("--dve-dock-w");
        return;
      }
      const rect = col.getBoundingClientRect();
      const pad = computeDockYield(rect.right, rect.width, window.innerWidth, width);
      body.classList.toggle("dve-dockOpen", pad > 0);
      if (pad > 0) body.style.setProperty("--dve-dock-w", Math.round(pad) + "px");
      else body.style.removeProperty("--dve-dock-w");
    };
    if (!open) {
      body.classList.remove("dve-dockOpen");
      body.style.removeProperty("--dve-dock-w");
      return undefined;
    }
    update();
    const ro = new ResizeObserver(update);
    const col = document.querySelector('[class*="centerCol"]');
    if (col) ro.observe(col, { box: "border-box" }); // 侧栏/详情列拖动（含动画帧）都会触发
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      body.classList.remove("dve-dockOpen");
      body.style.removeProperty("--dve-dock-w");
    };
  }, [open, width]);

  /* ------------------------------------------------------------------
   * 会话就绪重试：重启后客户端 store 可能已带 cwd，但宿主 live store 还没
   * 恢复该会话（持久层兜底也覆盖不到「已创建未落盘」的新会话），请求 404。
   * 根目录拉取与 SSE 订阅共用一个退避 tick——期间保持「载入中」而不是把
   * 404 画成错误，直到就绪或预算耗尽（之后照常显示错误，B 兜底仍可用）。
   * ------------------------------------------------------------------ */
  const readyAttemptRef = useRef(0);
  const readyTimerRef = useRef(null);
  const [readyTick, setReadyTick] = useState(0);
  const scheduleReadyRetry = () => {
    if (readyTimerRef.current || readyAttemptRef.current >= READY_RETRY_MAX) return;
    const delay = Math.min(READY_RETRY_BASE_MS * 2 ** readyAttemptRef.current, 5000);
    readyAttemptRef.current += 1;
    readyTimerRef.current = setTimeout(() => {
      readyTimerRef.current = null;
      setReadyTick((v) => v + 1);
    }, delay);
  };
  /* 会话或目录变化即复位重试预算（新会话是新的一次就绪等待）。 */
  useEffect(() => {
    readyAttemptRef.current = 0;
    if (readyTimerRef.current) {
      clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
  }, [sessionId, cwd]);

  /* 拉取一层目录。 */
  const loadDir = async (rel) => {
    setNodes((prev) => ({ ...prev, [rel]: { ...(prev[rel] ?? {}), loading: true, error: null } }));
    try {
      const data = await api("/list", { sessionId, path: rel });
      readyAttemptRef.current = 0; // 会话已就绪，复位重试预算
      setNodes((prev) => ({ ...prev, [rel]: { entries: data.entries, truncated: data.truncated, loading: false, error: null } }));
    } catch (error) {
      const message = String(error.message || error);
      /* 「会话未就绪」：保持载入态并退避重试（仅根目录——子目录只会在会话
         就绪后才被展开拉取，不存在此窗口）。 */
      if (rel === "" && /session not found/i.test(message)) {
        setNodes((prev) => ({ ...prev, [rel]: { ...(prev[rel] ?? {}), loading: true, error: null } }));
        scheduleReadyRetry();
        return;
      }
      setNodes((prev) => ({ ...prev, [rel]: { loading: false, error: message } }));
    }
  };

  /* 会话就绪且根未加载 → 拉根（404 未就绪时由 readyTick 驱动重试）。 */
  useEffect(() => {
    if (!open || sessionId === undefined || !cwd) return;
    const root = nodes[""];
    if (root?.entries !== undefined || root?.error) return; // 已加载 / 已终态失败
    loadDir("");
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [open, sessionId, cwd, tick, readyTick]);

  /* ------------------------------------------------------------------
   * 书签数据流：store.bookmarks 是唯一事实来源（★ 角标与面板都从它派生）。
   * 触发源四类，全部汇入下面这一个 250ms 去抖拉取（模式同 refreshExpanded）：
   *  - dock 打开且会话就绪 / 会话切换 / 展开书签区 → 普通拉取（总是执行；
   *    收起也拉一次——★ 角标与右键 toggle 依赖集合，且这是低频一次性 IO）
   *  - SSE fs-changed → 顺带重验 exists（门控：收起且有数据即跳过——收起时
   *    不渲染就不重验，逐条 stat 的 IO 不进高频路径）
   *  - SSE bookmarks-changed（其它标签页的增删）→ 同款重验门控（收起时跳过，
   *    展开动作本身触发拉取）
   * add/remove 的响应体直接落账 store（见 runMenu），SSE 只服务其它标签页。
   * ------------------------------------------------------------------ */
  const bookmarksLoadedRef = useRef(false);
  const bmPullTimer = useRef(null);
  const pullBookmarks = (opts) => {
    const revalidateOnly = !!(opts && opts.revalidate);
    if (bmPullTimer.current) clearTimeout(bmPullTimer.current);
    bmPullTimer.current = setTimeout(async () => {
      if (document.visibilityState === "hidden") return; // 隐藏页跳过，恢复可见时补刷
      const sid = liveSessionRef.current;
      if (!openRef.current || sid === undefined || !cwdRef.current) return;
      if (revalidateOnly && !bookmarkOpenRef.current && bookmarksLoadedRef.current) return;
      try {
        const data = await api("/bookmarks", { sessionId: sid });
        if (liveSessionRef.current !== sid) return; // 会话已切换，丢弃旧结果
        bookmarksLoadedRef.current = true;
        setBookmarks(Array.isArray(data.bookmarks) ? data.bookmarks : []);
      } catch (error) {
        /* 「会话未就绪」：复用既有退避基建（readyTick 驱动重拉），其余静默 */
        if (/session not found/i.test(String(error?.message || error))) scheduleReadyRetry();
      }
    }, 250);
  };

  /* dock 打开且会话就绪 → 拉一次书签；会话切换即重置并换书签集。 */
  useEffect(() => {
    if (!open || sessionId === undefined || !cwd) return;
    bookmarksLoadedRef.current = false;
    setBookmarks([]);
    pullBookmarks();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [open, sessionId, cwd, readyTick]);

  const toggleDir = (rel, ns = "x") => {
    const key = ns + ":" + rel;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        if (!nodes[rel]?.entries) loadDir(rel);
      }
      return next;
    });
  };

  const refresh = () => {
    readyAttemptRef.current = 0; // 手动刷新给一次全新的就绪等待窗口
    setNodes({});
    setExpanded(new Set(["x:"]));
    setTick((v) => v + 1);
    pullBookmarks(); // 书签列表同样补拉（重验 exists）
  };

  /* ------------------------------------------------------------------
   * 自动刷新（A + B 共用的静默刷新）
   *  - 静默：不打 loading 态，对当前展开的每一层并行重拉并替换缓存——
   *    展开状态与滚动位置全部保留；目录被删时保留旧内容，父层刷新后
   *    孤儿行自然消失。标签页隐藏时跳过（恢复可见时 B 兜底补刷）。
   *  - 触发源：SSE fs-changed（A）；dock 重开 / focus / visibilitychange /
   *    预览打开文件（B）。全部走 250ms 去抖合并。
   * ------------------------------------------------------------------ */
  const refreshTimer = useRef(null);
  const refreshExpanded = useMemo(() => {
    const run = () => {
      if (document.visibilityState === "hidden") return; // 隐藏页跳过，恢复可见时补刷
      /* 两棵树（explorer x: / 书签面板 b:）的展开并集按 rel 去重：同一目录双侧
         同展只发一次 /list——nodes 缓存共享，一处更新两处受益。 */
      const rels = new Set();
      for (const key of expandedRef.current) {
        const i = key.indexOf(":");
        if (i !== -1) rels.add(key.slice(i + 1));
      }
      for (const rel of rels) {
        api("/list", { sessionId, path: rel })
          .then((data) => {
            if (liveSessionRef.current !== sessionId) return; // 会话已切换，丢弃旧结果
            setNodes((prev) => ({ ...prev, [rel]: { entries: data.entries, truncated: data.truncated, loading: false, error: null } }));
          })
          .catch(() => {
            /* 目录被删/会话失效：保留旧内容，父层刷新后孤儿自然消失 */
          });
      }
    };
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(run, 250);
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [sessionId]);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
    if (bmPullTimer.current) clearTimeout(bmPullTimer.current);
  }, []);

  /* A：订阅宿主推送。连接只在 dock 打开且会话就绪时存在——关面板/切会话即
     断开，服务端随之释放 watcher。HTTP 404（会话未就绪）或网络错误会让
     EventSource 永久放弃/依赖自动重连，这里统一接管为退避重连（与根目录
     拉取共用预算，onopen 复位）。 */
  useEffect(() => {
    if (!open || sessionId === undefined || !cwd || typeof EventSource === "undefined") return undefined;
    let source = null;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      source = new EventSource(API + "/events?sessionId=" + encodeURIComponent(sessionId));
      source.onopen = () => {
        readyAttemptRef.current = 0; // 就绪：复位重试预算
      };
      source.onmessage = (event) => {
        try {
          const type = JSON.parse(event.data)?.type;
          if (type === "fs-changed") {
            refreshExpanded();
            pullBookmarks({ revalidate: true }); // 顺带重验 exists（门控见 pullBookmarks）
          } else if (type === "bookmarks-changed") {
            pullBookmarks({ revalidate: true }); // 其它标签页的增删 → 重拉书签列表
          }
        } catch {
          /* 坏帧忽略 */
        }
      };
      source.onerror = () => {
        if (disposed) return;
        source?.close();
        source = null;
        scheduleReadyRetry();
      };
    };
    connect();
    return () => {
      disposed = true;
      source?.close();
    };
  }, [open, sessionId, cwd, refreshExpanded, readyTick]);

  /* B：dock 重新打开（树已加载过）时、窗口重新聚焦或页面恢复可见时补刷。 */
  useEffect(() => {
    if (!open) return undefined;
    if (nodesRef.current[""]) refreshExpanded(); // 首开由 loadDir 负责，这里只补刷已有树
    const onWake = () => {
      if (document.visibilityState === "visible") {
        refreshExpanded();
        pullBookmarks({ revalidate: true }); // 恢复可见时书签 exists 同步补验
      }
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [open, refreshExpanded]);

  const openMenu = (e, entry, rel, source = "explorer") => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry, rel, source });
  };

  const runMenu = async (kind, m) => {
    try {
      if (kind === "browse") {
        await apiPost("/open-browser", { sessionId, path: m.rel });
        notify(t("ex.toastBrowsed"), "ok");
      } else if (kind === "open") {
        await apiPost("/open", { sessionId, path: m.rel });
        notify(t("ex.toastOpened"), "ok");
      } else if (kind === "insert") {
        const ref = referenceOf(m.rel);
        if (insertIntoComposer(ref)) {
          notify(t("ex.toastInserted"), "ok");
        } else {
          const copied = await copyText(ref);
          notify(copied ? t("ex.toastInsertFallback") : t("ex.toastFail"), copied ? "ok" : "err");
        }
      } else if (kind === "bookmark") {
        /* 来源感知（D6）：书签根 → 移除；其它（explorer 行 / 书签子行）→ toggle。
           始终传原始 rel；响应体携带更新后的书签数组，直接落账 store（免二次 GET）。 */
        const isRemove = m.source === "bookmark-root" || bookmarkSetHas(m.rel);
        const data = isRemove
          ? await apiPost("/bookmark-remove", { sessionId, path: m.rel })
          : await apiPost("/bookmark-add", { sessionId, path: m.rel });
        const list = Array.isArray(data.bookmarks) ? data.bookmarks : [];
        const grew = bookmarks.length === 0 && list.length > 0;
        bookmarksLoadedRef.current = true;
        setBookmarks(list);
        /* 首次加入自动展开一次（列表空转非空；该次展开写入记忆，与用户显式操作等效） */
        if (grew && !bookmarkOpen) setBookmarkOpen(true);
        notify(isRemove ? t("ex.toastUnbookmarked") : t("ex.toastBookmarked"), "ok");
      }
    } catch (error) {
      notify(t("ex.toastFail") + ": " + String(error?.message || error), "err");
    }
  };

  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const base = width;
    const move = (ev) => {
      const next = Math.min(560, Math.max(220, base + (startX - ev.clientX)));
      setWidth(next);
      localStorage?.setItem(WIDTH_KEY, String(next));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /* 书签区高度拖拽：复刻 startResize 换轴（ns-resize，向上拖 = 增高）。
     clamp 96px ～ dock 高度 - 160px（explorer 至少保留可用空间）。 */
  const startVResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const base = bookmarkH ?? BOOKMARK_DEFAULT_H;
    const dockH = dockRef.current?.getBoundingClientRect().height ?? 600;
    const max = Math.max(96, dockH - 160);
    const move = (ev) => {
      setBookmarkH(Math.min(max, Math.max(96, base + (startY - ev.clientY))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /**
   * 递归渲染一层已展开目录的条目（explorer 与书签面板共用）：
   *  - ns：展开命名空间（"x" explorer / "b" 书签面板），展开状态相互独立；
   *  - source：右键菜单来源（explorer 行 / 书签子行）；
   *  - nodes 缓存共享，懒加载、隐藏过滤、截断提示与 explorer 完全一致。
   */
  const renderEntries = (rel, depth, ns = "x", source = "explorer") => {
    const node = nodes[rel];
    if (!node) return null;
    if (node.loading) return <div className="dve-muted" style={{ paddingLeft: depth * 14 + 26 }}>{t("ex.loading")}</div>;
    if (node.error) return <div className="dve-error" style={{ paddingLeft: depth * 14 + 26 }}>{node.error}</div>;
    const entries = (node.entries ?? []).filter((e) => !e.hidden);
    if (entries.length === 0) return <div className="dve-muted" style={{ paddingLeft: depth * 14 + 26 }}>{t("ex.empty")}</div>;
    const out = [];
    for (const e of entries) {
      const childRel = rel ? rel + "/" + e.name : e.name;
      /* ★ 角标：仅 explorer 行显示（数据取自 uiStore 的书签集合，收起状态同样生效） */
      const star = source === "explorer" && bookmarkSetHas(childRel);
      if (e.isDir) {
        const isOpen = expanded.has(ns + ":" + childRel);
        out.push(
          <div key={"d:" + childRel}>
            <div
              className="dve-row"
              style={{ paddingLeft: depth * 14 + 8 }}
              onClick={() => toggleDir(childRel, ns)}
              onContextMenu={(ev) => openMenu(ev, e, childRel, source)}
            >
              <span className="dve-caret">
                <CaretIcon open={isOpen} />
              </span>
              <span className="dve-icon">
                <FolderIcon />
              </span>
              <span className="dve-name">{e.name}</span>
              {star && <span className="dve-bmStar" title={t("ex.bookmarks")}>★</span>}
            </div>
            {isOpen && renderEntries(childRel, depth + 1, ns, source)}
          </div>
        );
      } else {
        const previewer = previewerFor(e.name);
        out.push(
          <div
            key={"f:" + childRel}
            className={"dve-row" + (previewer ? " dve-rowPreview" : "")}
            style={{ paddingLeft: depth * 14 + 8 + 14 }}
            onClick={previewer ? () => openFilePreview({ rel: childRel, name: e.name }) : undefined}
            onContextMenu={(ev) => openMenu(ev, e, childRel, source)}
            title={previewer ? t("ex.preview") : undefined}
          >
            <span className="dve-icon">
              <FileIcon md={previewer?.kind === "markdown"} />
            </span>
            <span className="dve-name">{e.name}</span>
            {star && <span className="dve-bmStar" title={t("ex.bookmarks")}>★</span>}
          </div>
        );
      }
    }
    if (node.truncated) out.push(<div key="t" className="dve-muted" style={{ paddingLeft: depth * 14 + 26 }}>…</div>);
    return out;
  };

  /**
   * 书签面板根行：每个书签 = 一棵子树的虚拟根。
   *  - 文件夹：点击折叠箭头懒加载展开（与 explorer 共用 nodes 缓存与 b: 命名空间）；
   *  - 文件：可预览格式点击走 openFilePreview（与 explorer 点击一致）；
   *  - 根行显示完整 rel（原生 tooltip 区分 src/utils 与 lib/utils 同名根），
   *    下层行显示条目名（renderEntries）；
   *  - exists:false → 失效行（删除线 + 暗色，对齐引用失效 chip 视觉），仍可右键移除。
   */
  const renderBookmarkRoot = (b) => {
    const rel = b.path;
    const name = rel.split("/").pop();
    if (b.exists === false) {
      return (
        <div
          key={"b:" + rel}
          className="dve-row dve-bmInvalid"
          style={{ paddingLeft: 8 }}
          onContextMenu={(ev) => openMenu(ev, { name, isDir: b.isDir === true }, rel, "bookmark-root")}
          title={rel}
        >
          <span className="dve-icon">
            <FileIcon md={previewerFor(name)?.kind === "markdown"} />
          </span>
          <span className="dve-name">{rel}</span>
        </div>
      );
    }
    if (b.isDir) {
      const isOpen = expanded.has("b:" + rel);
      return (
        <div key={"b:" + rel}>
          <div
            className="dve-row"
            style={{ paddingLeft: 8 }}
            onClick={() => toggleDir(rel, "b")}
            onContextMenu={(ev) => openMenu(ev, { name, isDir: true }, rel, "bookmark-root")}
            title={rel}
          >
            <span className="dve-caret">
              <CaretIcon open={isOpen} />
            </span>
            <span className="dve-icon">
              <FolderIcon />
            </span>
            <span className="dve-name dve-bmRootPath">{rel}</span>
          </div>
          {isOpen && renderEntries(rel, 1, "b", "bookmark-child")}
        </div>
      );
    }
    const previewer = previewerFor(name);
    return (
      <div
        key={"b:" + rel}
        className={"dve-row" + (previewer ? " dve-rowPreview" : "")}
        style={{ paddingLeft: 8 }}
        onClick={previewer ? () => openFilePreview({ rel, name }) : undefined}
        onContextMenu={(ev) => openMenu(ev, { name, isDir: false }, rel, "bookmark-root")}
        title={previewer ? rel + " · " + t("ex.preview") : rel}
      >
        <span className="dve-icon">
          <FileIcon md={previewer?.kind === "markdown"} />
        </span>
        <span className="dve-name dve-bmRootPath">{rel}</span>
      </div>
    );
  };

  /* 文件点击（可预览格式）：先开窗再拉内容。渲染形态（markdown / 文本类）、
     语言徽章与每格式样式钩子都由 src/previewers.mjs 注册表决定。 */
  const openFilePreview = async (file) => {
    refreshExpanded(); // B 兜底：交互时机顺带补刷树
    const previewer = previewerFor(file.name);
    if (!previewer) return;
    openPreview({ ...file, previewer });
    try {
      const data = await api("/file", { sessionId, path: file.rel });
      openPreview({ ...file, previewer, content: data.content, truncated: data.truncated, binary: data.binary });
    } catch (error) {
      openPreview({ ...file, previewer, content: "// " + String(error.message || error), truncated: false, binary: false });
    }
  };

  /** html：用系统默认浏览器按 file 协议打开（宿主端限制在会话 cwd 内的 html 文件）。 */
  const browseFile = async (rel) => {
    try {
      await apiPost("/open-browser", { sessionId, path: rel });
      notify(t("ex.toastBrowsed"), "ok");
    } catch (error) {
      notify(t("ex.toastFail") + ": " + String(error?.message || error), "err");
    }
  };

  /* toast 自动消退。 */
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => clearToast(), 2400);
    return () => clearTimeout(timer);
  }, [toast, clearToast]);

  /* ------------------------------------------------------------------
   * 「发送引用到会话」：预览框选与会话窗口框选的共用发送逻辑
   * ------------------------------------------------------------------ */

  const sendRefToken = async (token) => {
    if (insertIntoComposer(token)) {
      notify(t("ex.toastRefInserted"), "ok");
      return;
    }
    const copied = await copyText(token);
    notify(copied ? t("ex.toastRefCopied") : t("ex.toastFail"), copied ? "ok" : "err");
  };

  /** 会话窗口选区：短选区直接内联文本；长选区物化快照后引用快照文件。 */
  const sendSelectionRef = async (text) => {
    if (text.length <= INLINE_SNIPPET_MAX_CHARS) {
      await sendRefToken(text);
      return;
    }
    if (sessionId === undefined) {
      notify(t("ex.toastFail") + ": " + t("ex.noSession"), "err");
      return;
    }
    try {
      const data = await apiPost("/snapshot", { sessionId, content: text });
      await sendRefToken(buildRefToken({
        path: data.path,
        start: { line: 1, col: 1, wholeLine: true },
        end: { line: data.lines, col: 1, wholeLine: true }
      }));
      notify(t("ex.toastRefFromSnapshot") + " (" + data.path + ")", "ok");
    } catch (error) {
      notify(t("ex.toastFail") + ": " + String(error?.message || error), "err");
    }
  };

  /* 预览框选：PreviewWindow 已把选区映射成 token，这里只负责弹菜单。 */
  const onPreviewRefContext = ({ token, x, y }) => {
    setSelMenu({
      x,
      y,
      items: [
        { label: t("ex.sendRef"), onClick: () => { sendRefToken(token); } },
        { label: t("ex.copyRef"), onClick: () => { copyText(token).then((ok) => notify(ok ? t("ex.toastRefCopied") : t("ex.toastFail"), ok ? "ok" : "err")); } }
      ]
    });
  };

  /* 会话窗口框选：文档级右键监听。仅当存在非空选区、目标在会话滚动区内、
     且不在 composer 输入框 / 预览浮窗（各自有自己的菜单）时接管。 */
  useEffect(() => {
    const onCtx = (e) => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString();
      if (!text.trim()) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest(".dve-preview") || target.closest(".dve-dock") || target.closest("textarea, input")) return;
      const scroll = document.querySelector("[data-conversation-scroll]");
      if (!scroll || !scroll.contains(target)) return;
      e.preventDefault();
      setSelMenu({
        x: e.clientX,
        y: e.clientY,
        items: [{ label: t("ex.sendRef"), onClick: () => { sendSelectionRef(text); } }]
      });
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, [sessionId, t]);

  /* 书签区收起/展开开关：展开动作本身触发拉取（收起期间的重验都被门控跳过）。 */
  const toggleBookmarkOpen = () => {
    const next = !bookmarkOpen;
    setBookmarkOpen(next);
    if (next) pullBookmarks();
  };

  const cwdName = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd : null;

  return (
    <>
      {open && (
        <div className="dve-dock" style={{ width }} ref={dockRef}>
          <div className="dve-dockHeader">
            <span className="dve-dockTitle" title={cwd ?? ""}>{cwdName ?? t("ex.title")}</span>
            <span className="dve-dockActions">
              <button type="button" className="dve-iconBtn" title={t("ex.refresh")} onClick={refresh}>
                <IconRefresh />
              </button>
              <button type="button" className="dve-iconBtn" title={t("ex.close")} onClick={() => setOpen(false)}>
                <IconClose />
              </button>
            </span>
          </div>
          <div className="dve-tree">
            {sessionId === undefined || !cwd ? (
              <div className="dve-muted dve-pad">{t("ex.noSession")}</div>
            ) : (
              renderEntries("", 0)
            )}
          </div>
          {/* dock 上下分层：explorer（flex:1）+ 水平分隔条 + 书签区块头 + 定高书签树。
              只动 dock 内部 flex——computeDockYield 与窄屏抽屉行为不受影响。 */}
          {bookmarkOpen && <div className="dve-vresize" onPointerDown={startVResize} />}
          <div className="dve-bmHead" onClick={toggleBookmarkOpen} title={t("ex.bookmarks")}>
            <span className="dve-caret">
              <CaretIcon open={bookmarkOpen} />
            </span>
            <span className="dve-bmTitle">{t("ex.bookmarks")}</span>
            <span className="dve-bmCount">({bookmarks.length})</span>
          </div>
          {bookmarkOpen && (
            <div className="dve-bmTree" style={{ height: bookmarkH ?? BOOKMARK_DEFAULT_H }}>
              {bookmarks.length === 0 ? (
                <div className="dve-muted dve-pad">{t("ex.bmEmpty")}</div>
              ) : (
                bookmarks.map((b) => renderBookmarkRoot(b))
              )}
            </div>
          )}
          <div className="dve-resize" onPointerDown={startResize} />
        </div>
      )}
      <ContextMenu t={t} menu={menu} bookmarked={menu ? bookmarkSetHas(menu.rel) : false} onClose={() => setMenu(null)} onAction={runMenu} />
      <SelectionMenu menu={selMenu} onClose={() => setSelMenu(null)} />
      {preview && (
        <PreviewWindow
          t={t}
          file={preview}
          minimized={previewMin}
          pos={previewPos}
          highlight={previewHighlight}
          onMinimize={() => setPreviewMin(!previewMin)}
          onMove={setPreviewPos}
          onClose={closePreview}
          onOpenFile={(rel) => openFilePreview({ rel, name: rel.split("/").pop() })}
          onBrowseFile={browseFile}
          onRefContext={onPreviewRefContext}
          notify={notify}
        />
      )}
      {toast && (
        <div key={toast.seq} className={"dve-toast" + (toast.kind === "err" ? " dve-toastErr" : "")}>
          {toast.text}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 会话头部右上角的 dock 开关按钮
 * （注入 ui-conversation 的 headerUtilities 容器，session log 按钮右侧）
 * ------------------------------------------------------------------ */

/** dock 开关图标：矩形 + 分隔线 + 右侧填充面板（VS Code toggle right-sidebar 风）。 */
const DOCK_ICON_SVG =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M9.5 2.5v11" stroke="currentColor" stroke-width="1.2"/><rect x="10.3" y="3.3" width="3.4" height="9.4" rx="0.8" fill="currentColor" opacity="0.55"/></svg>';

/** 由 dock 条目的 inject 回调写入：框架绑定动作的 toggle。 */
let sidebarToggle = null;

/* root 作用域 dock store 的绑定动作：shell.overlay（root）与
   conversation.input.dock（session）是两个作用域，同一 store handle 不能
   同时挂两处（one handle, one scope）——chip 条目不声明 store，动作经此
   转发（懒取值，规避 chip 先于 overlay 挂载的时序）。 */
let dockActions = null;

/** dock 开关状态镜像：头部按钮的注入时机晚于 dock 挂载时，用它对齐高亮。 */
const dockOpenMirror = { current: false };

/**
 * 把方形开关按钮注入会话头部右上角（session log 按钮右边）。
 * 目标容器 [class*="headerUtilities"] 由 React 拥有，且随会话切换整树重建、
 * 空白会话态整块不渲染——用 MutationObserver 两段式保活：body 级找容器 →
 * 容器级看住按钮，被清掉就补回；补挂时按 dockOpenMirror 恢复高亮。
 */
function injectHeaderButton(ctx) {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dve-toggleBtn";
    btn.title = "文件探索器 / Explorer";
    btn.setAttribute("aria-label", "文件探索器 / Explorer");
    btn.innerHTML = DOCK_ICON_SVG;
    btn.addEventListener("click", () => sidebarToggle?.());

    let stopped = false;
    let containerObserver = null;

    /** 容器内挂载：优先插在 session log 按钮右边，找不到就追加到容器末尾。 */
    const attach = (container) => {
      if (btn.isConnected) return;
      const logBtn = container.querySelector('[class*="sessionLogButton"]');
      if (logBtn) logBtn.after(btn);
      else container.appendChild(btn);
      /* 按钮注入可能晚于 dock 挂载（默认展开时尤其明显），按镜像补高亮。 */
      btn.classList.toggle("dve-toggleBtnOn", dockOpenMirror.current);
    };

    /** 多个头部并存时挑可见的那个；空白会话态没有头部，返回 null（按钮随空缺）。 */
    const findContainer = () => {
      const all = document.querySelectorAll('[class*="headerUtilities"]');
      for (const el of all) {
        if (el.querySelector('[class*="sessionLogButton"]') || el.offsetParent !== null) return el;
      }
      return all[0] ?? null;
    };

    const mountInto = (container) => {
      attach(container);
      containerObserver?.disconnect();
      containerObserver = new MutationObserver(() => {
        if (stopped) return;
        if (!btn.isConnected && container.isConnected) attach(container);
      });
      containerObserver.observe(container, { childList: true });
    };

    const bodyObserver = new MutationObserver(() => {
      if (stopped || btn.isConnected) return;
      const container = findContainer();
      if (container) mountInto(container);
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    const first = findContainer();
    if (first) mountInto(first);

    return () => {
      stopped = true;
      bodyObserver.disconnect();
      containerObserver?.disconnect();
      btn.remove();
    };
  }, "dsh-v-explorer: header toggle button");
}

/* ------------------------------------------------------------------ *
 * 样式
 *  - CSS：dock / 树 / 右键菜单 / toast 走宿主 --dsw-alias-* 令牌随主题；
 *    预览浮窗镶边与正文胶水走 Reader Pro 令牌（见下方 PREVIEW_CSS）
 *  - PREVIEW_CSS：src/markdown-reader-pro.css 的构建期作用域化产物
 *    （build.mjs 变换 → virtual:dve-reader-css），Deep Ocean 深色为基准，
 *    浅色覆盖挂在 body:not([data-ds-dark-theme]) 上
 *  - previewers.css：文本类预览（.dve-code）基础样式 + 每格式预留样式接口
 *    （src/previewers.mjs，installStyles 里汇总注入）
 * ------------------------------------------------------------------ */

const CSS = `
.dve-dock{position:fixed;top:0;right:0;bottom:0;z-index:900;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-8px 0 24px rgba(0,0,0,.25)}
.dve-dockHeader{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dve-dockTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dve-dockActions{display:flex;gap:2px;flex:none}
.dve-tree{flex:1;overflow:auto;padding:6px 0 24px;font-size:12.5px}
.dve-row{display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap;user-select:none}
.dve-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dve-rowPreview .dve-name{color:var(--dsw-alias-state-business-primary)}
.dve-caret{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.dve-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.dve-name{overflow:hidden;text-overflow:ellipsis}
.dve-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:6px 8px}
.dve-error{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 8px;word-break:break-all}
.dve-pad{padding:14px 12px;line-height:1.7}
.dve-resize{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:ew-resize;z-index:2}
.dve-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;background:transparent;border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dve-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dve-menu{position:fixed;z-index:10000;min-width:170px;padding:4px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv3)}
.dve-menuItem{display:block;width:100%;text-align:left;padding:7px 12px;border:none;background:transparent;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);border-radius:7px;cursor:pointer}
.dve-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dve-toggleBtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:none;background:transparent;border-radius:8px;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dve-toggleBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dve-toggleBtn svg{width:15px;height:15px;display:block}
.dve-toggleBtnOn{color:var(--dsw-alias-state-business-primary)}
.dve-toast{position:fixed;right:16px;bottom:16px;z-index:10001;max-width:360px;padding:8px 14px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-alias-label-primary);font-size:12px;border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv2);animation:dveToastIn .18s ease-out}
@keyframes dveToastIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dve-toastErr{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
/* ── 书签面板：dock 上下分层（explorer flex:1 + ns-resize 分隔条 + 区块头 + 定高树） ── */
.dve-vresize{flex:none;height:7px;cursor:ns-resize;position:relative;z-index:2}
.dve-vresize::after{content:"";display:block;height:1px;margin:3px 0;background:var(--dsw-alias-border-l1)}
.dve-vresize:hover::after{background:var(--dsw-alias-state-business-primary)}
.dve-bmHead{flex:none;display:flex;align-items:center;gap:6px;padding:5px 8px;border-top:1px solid var(--dsw-alias-border-l1);cursor:pointer;user-select:none;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dve-bmHead:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dve-bmTitle{font-weight:600}
.dve-bmCount{color:var(--dsw-alias-label-tertiary)}
.dve-bmTree{flex:none;overflow:auto;padding:4px 0 12px;font-size:12.5px;max-height:calc(100% - 160px)}
.dve-bmRootPath{font-family:var(--ds-font-family-code,var(--dsw-font-family,monospace));font-size:11.5px}
.dve-bmStar{flex:none;color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:1}
/* 失效书签：删除线 + 暗色（对齐 dve-refChipInvalid 的视觉语言），仍可右键移除 */
.dve-bmInvalid{opacity:.75}
.dve-bmInvalid .dve-name{color:var(--dsw-alias-state-error-primary);text-decoration:line-through}
/* ── 预览浮窗镶边：走 Reader Pro 令牌（PREVIEW_CSS 标签在前，令牌定义于 .dve-preview） ── */
.dve-preview{position:fixed;z-index:950;width:680px;max-width:calc(100vw - 32px);height:76vh;display:flex;flex-direction:column;background:var(--bg-primary);border:1px solid var(--border-default);border-radius:12px;box-shadow:var(--shadow-lg),0 24px 64px rgba(0,0,0,.28);overflow:hidden}
.dve-preview::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:var(--gradient-header);z-index:1;pointer-events:none}
.dve-previewMin{height:auto;min-height:0}
.dve-previewHeader{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px 8px 14px;background:var(--bg-secondary);border-bottom:1px solid var(--border-default);cursor:grab;user-select:none;flex:none}
.dve-previewMin .dve-previewHeader{border-bottom:none}
.dve-previewHeader:active{cursor:grabbing}
.dve-previewName{flex:1;min-width:0;font-size:12.5px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dve-previewActions{display:flex;gap:2px;flex:none}
.dve-preview .dve-iconBtn{color:var(--text-secondary)}
.dve-preview .dve-iconBtn:hover{background:var(--bg-tertiary);color:var(--text-primary)}
.dve-previewBody{flex:1;overflow:auto;padding:0}
.dve-preview .dve-muted{padding:24px;color:var(--text-tertiary)}
.dve-truncated{font-size:11.5px;color:var(--accent-warning);padding:6px 12px;background:rgba(210,153,34,.08);border-bottom:1px solid rgba(210,153,34,.25)}
/* ── Reader Pro 正文胶水：留白 / 长词换行 / 表格横向滚动（后装标签，压过主题里的 table 宽度） ── */
.dve-md{padding:22px 26px;overflow-wrap:break-word}
.dve-md table{display:block;width:max-content;max-width:100%;overflow-x:auto;border-radius:var(--radius-lg)}
/* ── 任务列表复选框：li::before 绘制，不注入原始 HTML（html:false 防线不动） ── */
.dve-md li.dve-task{list-style:none}
.dve-md li.dve-task::before{content:"";display:inline-block;width:16px;height:16px;box-sizing:border-box;border:2px solid var(--border-default);border-radius:5px;margin-right:8px;vertical-align:-3px;background:var(--bg-secondary);transition:all var(--transition-fast)}
.dve-md li.dve-task:hover::before{border-color:var(--accent-primary)}
.dve-md li.dve-taskDone::before{content:"✓";background:var(--accent-success);border-color:var(--accent-success);color:var(--bg-primary);font-size:11px;font-weight:700;line-height:12px;text-align:center}
/* ── 浅色主题适配：宿主 body 无 data-ds-dark-theme 时换浅色调色板（同名令牌，特异性更高） ── */
body:not([data-ds-dark-theme]) .dve-preview{
--bg-primary:#ffffff;--bg-secondary:#f6f8fa;--bg-tertiary:#eaeef2;--bg-elevated:#f6f8fa;--bg-overlay:rgba(255,255,255,.85);
--text-primary:#1f2328;--text-secondary:#59636e;--text-tertiary:#6e7781;--text-muted:#8c959f;--text-link:#0969da;--text-link-hover:#0550ae;
--accent-primary:#0969da;--accent-secondary:#8250df;--accent-success:#1a7f37;--accent-warning:#9a6700;--accent-danger:#cf222e;--accent-info:#1b7c83;
--gradient-primary:linear-gradient(135deg,#0969da 0%,#8250df 100%);--gradient-success:linear-gradient(135deg,#1a7f37 0%,#1b7c83 100%);--gradient-header:linear-gradient(90deg,#0969da,#8250df,#bf3989);
--border-default:#d1d9e0;--border-muted:#e7ecf0;--border-accent:rgba(9,105,218,.4);
--code-bg:#f6f8fa;--code-inline-bg:rgba(175,184,193,.2);--code-border:#d1d9e0;
--table-header-bg:#f6f8fa;--table-row-hover:rgba(9,105,218,.06);--table-stripe:rgba(129,139,152,.05);
--shadow-sm:0 1px 2px rgba(31,35,40,.08);--shadow-md:0 4px 12px rgba(31,35,40,.12);--shadow-lg:0 8px 24px rgba(31,35,40,.16);--shadow-glow:0 0 20px rgba(9,105,218,.12)}
/* ── dock 让位：宿主 AppFrame 中列（会话区）按实际重叠量让出宽度，会话在
      剩余可见空间重新居中；toast 同步左移不压在 dock 上。窄屏（≤760px）dock
      是全宽抽屉，整体不让位 ── */
@media (min-width:761px){
body.dve-dockOpen [class*="centerCol"]{padding-right:var(--dve-dock-w,0px)}
body.dve-dockOpen .dve-toast{right:calc(var(--dve-dock-w,0px) + 16px)}
}
/* 窄屏：dock 变全宽抽屉 */
@media (max-width:760px){.dve-dock{width:100vw !important}}
/* ── 引用 chip 条：官方行内引用同配方（业务色、无胶囊、无效删除线），
      颜色全部来自 --dsw-alias-* 别名层，风格插件改官方令牌时自动跟随；
      容器宽度公式对齐官方 QueueDock 的 dock 条 ── */
.dve-refBar{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,24px) - var(--dsh-composer-side-clearance,24px) - var(--dsh-composer-dock-inset,16px) - var(--dsh-composer-dock-inset,16px));max-width:calc(var(--dsh-composer-card-max-width,780px) - var(--dsh-composer-dock-inset,16px) - var(--dsh-composer-dock-inset,16px));margin:0 auto;padding:0 var(--dsh-composer-dock-inset,16px);flex:none}
.dve-refBarInner{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;justify-content:center;padding:2px 0 6px}
.dve-refChip{display:inline-flex;align-items:center;gap:2px;max-width:340px;padding:1px 4px 1px 6px;border:none;border-radius:6px;background:transparent;font-size:12px;line-height:20px;font-family:var(--dsw-font-family,inherit)}
.dve-refChip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dve-refChipInvalid{opacity:.7;color:var(--dsw-alias-state-error-primary)}
.dve-refChipInvalid .dve-refChipPath{text-decoration:line-through}
.dve-refChipMain{display:inline-flex;align-items:center;gap:5px;min-width:0;padding:0;border:none;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;cursor:pointer}
.dve-refChipInvalid .dve-refChipMain{color:var(--dsw-alias-state-error-primary)}
.dve-refChipIcon{display:inline-flex;flex:none}
.dve-refChipIcon svg{width:14px;height:14px}
.dve-refChipPath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,var(--dsw-font-family,monospace))}
.dve-refChipRange{flex:none;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,var(--dsw-font-family,monospace))}
.dve-refChipInvalid .dve-refChipRange{color:inherit}
.dve-refChipRemove{flex:none;width:16px;height:16px;display:grid;place-items:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;cursor:pointer;border-radius:999px;padding:0}
.dve-refChipRemove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dve-refPop{position:fixed;z-index:10002;max-width:440px;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv3);padding:8px 10px;font:400 11px/16px var(--ds-font-family-code,var(--dsw-font-family,monospace));color:var(--dsw-alias-label-secondary);white-space:pre;pointer-events:none}
/* ── 预览内引用定位：区间行的底色脉冲（预览窗走 Reader Pro 令牌域） ── */
@keyframes dveRefPulse{from{background:color-mix(in srgb,var(--accent-primary) 28%,transparent)}to{background:transparent}}
.dve-refPulse{animation:dveRefPulse 1.5s ease-out}
`;

/* ------------------------------------------------------------------ *
 * 样式注入 + 插件主体
 * ------------------------------------------------------------------ */

/**
 * 三张样式表，顺序即级联优先级（后者可覆盖前者）：
 *  1. preview-theme.css —— src/markdown-reader-pro.css 构建期作用域化产物，
 *     负责 .dve-md 排版与 .dve-preview 设计令牌
 *  2. previewers.css —— 文本类预览基础样式（.dve-code / .dve-langTag）+ 注册表
 *     各条目预留的每格式样式接口（src/previewers.mjs，collectPreviewerCss 汇总）
 *  3. explorer.css —— dock/树/菜单/toast（宿主令牌）+ 预览镶边与正文胶水
 */
function installStyles(ctx) {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tags = [
      ["preview-theme.css", PREVIEW_CSS],
      ["previewers.css", collectPreviewerCss()],
      ["explorer.css", CSS]
    ].map(([name, text]) => {
      const tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = PLUGIN_ID + "/" + name;
      tag.textContent = text;
      document.head.appendChild(tag);
      return tag;
    });
    return () => tags.forEach((tag) => tag.remove());
  }, "dsh-v-explorer: stylesheets");
}

/** 需要的服务：slots（注册）、locale（文案）、sessions（当前会话 cwd + composer 插入）。 */
export const inject = ["slots", "locale", "sessions"];

export function apply(ctx) {
  ctxRef.current = ctx;
  installStyles(ctx);

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-v-explorer: dictionaries");

  /* dock：shell.overlay 列表条目（浮层，含预览窗）。 */
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "dsh-v-explorer-dock",
        order: 50,
        store: uiStore,
        locale: NS,
        inject: (actions) => {
          /* settings 区方形按钮经此调用框架绑定的 toggle 动作。 */
          sidebarToggle = () => actions.toggle();
          /* chip 条（session 作用域 slot，不能复用本 store）经此转发动作。 */
          dockActions = actions;
          return {
            setSession: actions.setSession,
            setOpen: (v) => actions.setOpen(v),
            openPreview: (file) => actions.openPreview(file),
            setPreviewMin: (v) => actions.setPreviewMin(v),
            setPreviewPos: (pos) => actions.setPreviewPos(pos),
            closePreview: () => actions.closePreview(),
            notify: (text, kind) => actions.notify(text, kind),
            clearToast: () => actions.clearToast(),
            setBookmarks: (list) => actions.setBookmarks(list),
            setBookmarkOpen: (v) => actions.setBookmarkOpen(v),
            setBookmarkH: (h) => actions.setBookmarkH(h)
          };
        }
      },
      ExplorerDock
    )
  );

  /* 引用 chip 条：输入栏 dock 列表条目（order 10，介于 TodoDock 0 与 QueueDock 20 之间）。
     草稿里有 引用 token 时出现，官方行内引用同配方；容器对齐 composer 卡片。
     该 slot 是 session 作用域而 uiStore 已挂在 root 作用域的 shell.overlay 上——
     一个 store handle 只能挂一个作用域（one handle, one scope），所以本条目
     不声明 store：sessionId 走 slot 标准 props，动作经 dockActions 转发
     （官方 GoalDock 同为无 store 形态）。 */
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register(
      {
        name: "conversation.input.dock",
        id: "dsh-v-explorer-ref-chips",
        order: 10,
        locale: NS,
        inject: () => ({
          openPreview: (file, highlight) => dockActions?.openPreview(file, highlight),
          notify: (text, kind) => dockActions?.notify(text, kind)
        })
      },
      RefChipBar
    )
  );

  /* 开关按钮：注入会话头部 utilities 区（session log 按钮右侧的方形小按钮）。 */
  injectHeaderButton(ctx);
}
