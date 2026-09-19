/**
 * reader-shared.mjs — 文档渲染器的元数据与纯逻辑（无 JSX，node 可直接测）。
 */

export const READER_MARKDOWN_ID = "dsh-v-explorer/markdown";
export const READER_JSON_ID = "dsh-v-explorer/json";

/** markdown 渲染上限：超过只渲染前缀并提示，防冻结标签页。 */
export const RENDER_CHAR_LIMIT = 1_000_000;

/** JSON 美化上限（字符数）。 */
export const PRETTIFY_CHAR_LIMIT = 2_000_000;

/** Markdown 渲染器定义元数据（extension 胜官方默认；title 须为 () => string
 *  的 locale 函数——官方 DocumentPreviewDefinition 契约，工具栏渲染时求值）。 */
export function readerMarkdownDefinition(title) {
  return {
    id: READER_MARKDOWN_ID,
    extensions: ["md", "markdown"],
    priority: "extension",
    title,
    loading: "text-pages",
    wrap: false
  };
}

/** JSON 渲染器定义元数据（wrap:true 消费官方 wrap 偏好；title 同上须为函数）。 */
export function readerJsonDefinition(title) {
  return {
    id: READER_JSON_ID,
    extensions: ["json"],
    priority: "extension",
    title,
    loading: "text-pages",
    wrap: true
  };
}

/**
 * 在源行标注块序列里找目标行对应的块：覆盖该行的块优先，否则最后一个
 * 起始行 ≤ 目标行的块；全部块起始行都在目标行之后时取第一块。纯函数。
 */
export function pickBlockForLine(blocks, line) {
  let candidate = null;
  for (const block of blocks) {
    if (line >= block.start && line <= block.end) return block;
    if (block.start > line) return candidate ?? block;
    candidate = block;
  }
  return candidate;
}

/**
 * JSON 美化决策（纯函数）：未到 eof / 超限 / 解析失败 → 原文；
 * 否则 2 空格缩进美化（JSON.parse 不接受 undefined 之外的写法，parse 后
 * 为 function 不可能，但防御性保留原文分支）。
 */
export function prettifyDecision(text, eof) {
  const raw = String(text ?? "");
  if (!eof) return { text: raw, pretty: false };
  if (raw.length > PRETTIFY_CHAR_LIMIT) return { text: raw, pretty: false };
  try {
    const parsed = JSON.parse(raw);
    if (parsed === undefined) return { text: raw, pretty: false };
    return { text: JSON.stringify(parsed, null, 2) + "\n", pretty: true };
  } catch {
    return { text: raw, pretty: false };
  }
}
