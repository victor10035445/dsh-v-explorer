/**
 * markdown-core.mjs — markdown-it 实例与渲染规则（Reader Pro 渲染器与选区
 * 映射共用）。从旧 client.jsx 原样迁移：
 *  - html:false：原始 HTML 一律不注入（XSS 防线），任务列表复选框由 CSS 绘制
 *  - fence 语言徽章：pre[data-lang] 供 Reader Pro 主题 ::before 使用
 *  - 源行标注：块级 token map → data-dve-line/data-dve-end（1 基闭区间），
 *    行号导航与选区映射都靠它
 */
import MarkdownIt from "markdown-it";

export const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/* 代码块语言徽章。 */
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = (tokens[idx].info || "").trim().split(/\s+/)[0] || "";
  const html = defaultFence(tokens, idx, options, env, self);
  return info ? html.replace("<pre>", '<pre data-lang="' + md.utils.escapeHtml(info) + '">') : html;
};

/* 任务列表：`- [ ]` / `- [x]` → li.dve-task / li.dve-taskDone，标记剥掉，复选框 CSS 绘制。 */
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

/* 源行标注：块级 token 自带 map（0 基左闭右开）→ DOM 属性（1 基闭区间）。 */
md.core.ruler.after("inline", "dve_source_lines", (state) => {
  for (const token of state.tokens) {
    if (!token.map || token.nesting === -1) continue;
    token.attrSet("data-dve-line", String(token.map[0] + 1));
    token.attrSet("data-dve-end", String(token.map[1]));
  }
});

/** 渲染 markdown 文本为 HTML（html:false；调用方以 dangerouslySetInnerHTML 注入）。 */
export function renderMarkdown(text) {
  return md.render(String(text ?? ""));
}
