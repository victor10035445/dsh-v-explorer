/**
 * reader-markdown.jsx — Markdown Reader Pro 渲染器（官方 documentPreviews 的
 * extension 实现）。
 *
 * 契约（design Spike 结论）：
 *  - 元数据：{id, extensions:["md","markdown"], priority:"extension", loading:"text-pages"}
 *    extension 带默认胜出官方 markdown；官方渲染器留在下拉可切回
 *  - 体 props：{resourceAddress, content, wrap, scrollportRef, useTabInfo, t}；
 *    content = {kind:"text", text, pages, eof}（累积前缀）
 *  - load-more 由官方宿主托管：把滚动容器经 scrollportRef 交给宿主，滚到
 *    末尾宿主自动 loadNext——渲染器只消费累积文本
 *  - 行号导航：useTabInfo().tab.navigation.params.line 自消费（官方 markdown
 *    无行锚点；本渲染器按 markdown-it 源行标注定位 + 脉冲），所需页未加载时
 *    把滚动容器压到底触发宿主续载，直至该行入 DOM 或 eof（越界无害忽略）；
 *    navigation.revision 递增重新定位
 */
import { useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "./markdown-core.mjs";
// 纯逻辑/元数据在 reader-shared.mjs（node 可直接测）；这里 re-export 保持旧入口。
import { READER_MARKDOWN_ID, RENDER_CHAR_LIMIT, pickBlockForLine, readerMarkdownDefinition } from "./reader-shared.mjs";

export { READER_MARKDOWN_ID, RENDER_CHAR_LIMIT, pickBlockForLine, readerMarkdownDefinition };

/** 从滚动容器内收集源行标注块（DOM 顺序）。 */
export function collectBlocks(root) {
  const out = [];
  for (const el of root.querySelectorAll("[data-dve-line]")) {
    const start = Number(el.dataset.dveLine);
    const end = Number(el.dataset.dveEnd);
    if (Number.isFinite(start) && Number.isFinite(end)) out.push({ el, start, end });
  }
  return out;
}

export function ReaderMarkdownBody({ content, scrollportRef, useTabInfo }) {
  const scrollRef = useRef(null);
  const pendingRef = useRef(null);

  const tabInfo = typeof useTabInfo === "function" ? useTabInfo() : null;
  const navigation = tabInfo?.tab?.navigation;
  const line = navigation?.params?.line;
  const revision = navigation?.revision ?? 0;

  const isText = content?.kind === "text";
  const truncated = isText && content.text.length > RENDER_CHAR_LIMIT;
  const renderText = isText ? (truncated ? content.text.slice(0, RENDER_CHAR_LIMIT) : content.text) : "";
  const html = useMemo(() => renderMarkdown(renderText), [renderText]);

  /* 导航参数到达/变化 → 记待办；正文（含宿主续载后的增长）变化 → 尝试定位。 */
  useEffect(() => {
    if (typeof line !== "number" || line < 1 || !isText) return;
    const pending = pendingRef.current;
    if (!pending || pending.revision !== revision || pending.line !== line) {
      pendingRef.current = { line, revision, attempts: 0 };
    }
    const scroller = scrollRef.current;
    if (!scroller) return;
    const block = pickBlockForLine(collectBlocks(scroller), pendingRef.current.line);
    if (block) {
      pendingRef.current = null;
      block.el.scrollIntoView({ block: "center" });
      block.el.classList.add("dve-linePulse");
      const timer = setTimeout(() => block.el.classList.remove("dve-linePulse"), 1700);
      return () => clearTimeout(timer);
    }
    /* 行还没进 DOM：未到 eof 时把滚动容器压到底——宿主检测到滚动容器触底会
       续载下一页；内容增长后本 effect 重跑，直至该行入 DOM 或 eof。 */
    if (!content.eof && pendingRef.current.attempts < 120) {
      pendingRef.current.attempts += 1;
      scroller.scrollTop = scroller.scrollHeight;
    } else {
      pendingRef.current = null;
    }
  }, [line, revision, isText, content?.text, content?.eof]);

  if (!isText) return null;
  return (
    <div className="dve-rp">
      <div
        className="dve-rpBody"
        ref={(el) => {
          scrollRef.current = el;
          scrollportRef?.(el);
        }}
      >
        <article className="dve-md" data-dve-reader="markdown" dangerouslySetInnerHTML={{ __html: html }} />
        {truncated && <p className="dve-rpNote">…</p>}
      </div>
    </div>
  );
}
