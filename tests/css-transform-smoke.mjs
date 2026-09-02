/**
 * dsh-v-explorer 预览主题冒烟测试：
 *  1. transformReaderCss(src/markdown-reader-pro.css)：
 *     - 作用域化：每条规则的选择器都必须落在 .dve-preview / .dve-previewBody / .dve-md 内
 *     - 裁剪：mermaid / toc / katex / 全屏浮层 / print / 原生 checkbox / fadeIn 全部消失
 *     - body→.dve-md 丢整页版式（max-width/margin/padding），排版保留
 *     - 裸滚动条选择器双宿主；@media 块保留且内部同样作用域化
 *  2. markdown-it 渲染管线（与 src/client.jsx 同配置）：
 *     - fence → pre[data-lang] 徽章属性
 *     - 任务列表 → li.dve-task / li.dve-taskDone，标记文本被剥掉
 *     - html:false 原始 HTML 转义；linkify 生效
 * 运行：node tests/css-transform-smoke.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import MarkdownIt from "markdown-it";
import { transformReaderCss } from "../src/reader-css.transform.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = transformReaderCss(readFileSync(join(root, "src", "markdown-reader-pro.css"), "utf8"));

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};
const includes = (needle, message) => assert(css.includes(needle), message + "（应包含 " + JSON.stringify(needle) + "）");
const excludes = (needle, message) => assert(!css.includes(needle), message + "（不应包含 " + JSON.stringify(needle) + "）");

/* ---- 1. 作用域化与令牌 ---- */
includes(".dve-preview{ --bg-primary: #0d1117", "设计令牌挂在浮窗根");
includes(".dve-previewBody{ scroll-behavior: smooth", "html→滚动容器");
includes(".dve-md{ background: var(--bg-primary)", "body→正文容器");
includes("font-size: 16px", "正文排版保留");
excludes("max-width: 900px", "整页 max-width 丢弃");
excludes("margin: 0 auto", "整页 margin 丢弃");
excludes("padding: var(--space-xl)", "整页 padding 丢弃");
includes(".dve-md h1{", "h1 加前缀");
includes(".dve-md table:not(.table-wrapper table)", "复杂选择器加前缀");
includes(".dve-previewBody::-webkit-scrollbar", "滚动条宿主 1");
includes(".dve-md::-webkit-scrollbar", "滚动条宿主 2");
includes(".dve-md ::selection", "选区作用域化");

/* ---- 2. 裁剪 ---- */
for (const gone of [".mermaid", "markdown-toc", ".katex", ".math-", ".diagram-fullscreen", "@media print", 'input[type="checkbox"]', "@keyframes fadeIn", "h1:hover::after"]) {
  excludes(gone, "裁剪 " + gone);
}
includes("@media (prefers-reduced-motion: reduce)", "无障碍媒体查询保留");
includes("@media (max-width: 768px)", "响应式媒体查询保留");

/* ---- 3. 每条规则的选择器都必须在预览窗作用域内 ---- */
{
  let checked = 0;
  const blockEnd = (source, open) => {
    let depth = 0;
    for (let j = open; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") {
        depth--;
        if (depth === 0) return j;
      }
    }
    throw new Error("FAIL: 输出花括号不配平");
  };
  const checkFragment = (fragment, depth) => {
    let i = 0;
    while (i < fragment.length) {
      while (i < fragment.length && /\s/.test(fragment[i])) i++;
      if (i >= fragment.length) return;
      if (fragment[i] === "}") {
        i++;
        continue;
      }
      if (fragment[i] === "@") {
        const open = fragment.indexOf("{", i);
        assert(open !== -1, "at-rule 缺少块体");
        const prelude = fragment.slice(i, open).trim();
        const end = blockEnd(fragment, open);
        if (/^@media/i.test(prelude)) checkFragment(fragment.slice(open + 1, end), depth + 1);
        i = end + 1; // @keyframes 内部是百分比选择器，跳过
        continue;
      }
      const open = fragment.indexOf("{", i);
      const prelude = fragment.slice(i, open).trim();
      assert(depth <= 1, "选择器嵌套深度超出预期: " + prelude);
      assert(/^\.dve-(preview|previewBody|md)(\s|:|,|\[|$)/.test(prelude), "选择器必须作用域化: " + prelude);
      checked++;
      i = blockEnd(fragment, open) + 1;
    }
  };
  checkFragment(css, 0);
  assert(checked > 60, "应检查到足量规则（实际 " + checked + "）");
}

/* ---- 4. markdown-it 渲染管线（与 src/client.jsx 同配置的规则副本） ---- */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = (tokens[idx].info || "").trim().split(/\s+/)[0] || "";
  const html = defaultFence(tokens, idx, options, env, self);
  return info ? html.replace("<pre>", '<pre data-lang="' + md.utils.escapeHtml(info) + '">') : html;
};
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

const rendered = md.render(
  ['# Hello', '', '```js', 'const a = 1;', '```', '', '- [x] done', '- [ ] todo', '', '<script>alert(1)</script>', '', 'https://example.com', ''].join("\n")
);
const rHas = (needle, message) => assert(rendered.includes(needle), message + "（应包含 " + JSON.stringify(needle) + "）");
const rNo = (needle, message) => assert(!rendered.includes(needle), message + "（不应包含 " + JSON.stringify(needle) + "）");
rHas('<pre data-lang="js">', "代码语言徽章属性");
rHas('<li class="dve-task dve-taskDone">done', "已完成任务项");
rHas('<li class="dve-task">todo', "未完成任务项");
rNo("[ ]", "任务标记文本被剥掉");
rNo("<script>", "原始 HTML 被转义");
rHas('<a href="https://example.com"', "linkify 生效");

console.log("transformed css:", css.length, "chars");
console.log("\nALL PREVIEW-THEME SMOKE TESTS PASSED");
