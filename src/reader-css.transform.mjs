/**
 * Reader Pro CSS 作用域变换（供 build.mjs 与 tests/css-transform-smoke.mjs 共用）。
 *
 * `src/markdown-reader-pro.css` 原本也给 VS Code / PyCharm 整页预览用的全局样式
 * （:root/html/body/全局滚动条）。本插件把它装进一个浮动预览窗里，必须：
 *
 *  1. 作用域化——所有选择器收进渲染器体，绝不泄漏到宿主页面：
 *     - `:root`（设计令牌）→ `.dve-rp`（挂在渲染器体根元素上，官方预览 tab
 *       的 body 由本插件渲染器接管）
 *     - `html`（scroll-behavior）→ `.dve-rpBody`（渲染器自己的滚动容器，
 *       经 scrollportRef 交给官方宿主托管 load-more）
 *     - `body`（正文排版）→ `.dve-md`；并过滤掉 max-width/margin/padding
 *       （整页版式由渲染器体自己控制留白）
 *     - 其余选择器一律加 `.dve-md ` 前缀；裸 `::-webkit-scrollbar*` 同时
 *       交给 `.dve-rpBody` 与 `.dve-md` 两个滚动宿主
 *  2. 裁剪——本插件渲染不出来/不适用的段落直接丢弃（见 DROP_SELECTOR）：
 *     mermaid / TOC / KaTeX·math / 全屏 diagram 浮层 / @media print /
 *     原生 `input[type="checkbox"]`（任务列表改由 li 类 + ::before 绘制，
 *     保持 html:false 不注入任何原始 HTML）/ `h1..h6:hover::before|after`
 *     的 VS Code 悬停修复（在这里只会误杀 h1/h2 自带的渐变伪元素下划线）/
 *     孤儿 `@keyframes fadeIn`（唯一使用方是被裁掉的全屏浮层）
 *  3. 明暗自适应——浅色令牌覆盖由 src/client.jsx 追加（挂在宿主的
 *     `body:not([data-ds-dark-theme])` 钩子上），本变换保持与原文件同构。
 */

/** 含这些模式的选择器整条丢弃（命中任一即丢该选择器，同规则其余选择器照常保留）。 */
export const DROP_SELECTOR = [
  /mermaid/i, // mermaid 图表段落（本插件不做 mermaid 渲染）
  /\.toc|markdown-toc/, // 目录段落（markdown-it 不生成 TOC）
  /\.katex|\.math-/, // 数学公式段落（无 KaTeX）
  /\.diagram-fullscreen/, // 全屏看图浮层（依赖 mermaid）
  /^input\[type="checkbox"\]/i, // 原生复选框（任务列表走 li::before 方案）
  /^h[1-6]:hover::/i // VS Code 悬停弹框修复（会误杀本主题的渐变下划线）
];

/** 把顶层逗号拆开（忽略括号/属性选择器内的逗号）。 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** i 指向 `{`，返回 [块体, 块后下标]（花括号配平计数）。 */
function readBlock(source, i) {
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return [source.slice(i + 1, j), j + 1];
    }
  }
  throw new Error("reader-css: unbalanced braces");
}

/** 单个选择器 → 作用域化后的选择器数组。 */
function mapSelector(selector) {
  if (selector === ":root") return [".dve-rp"];
  if (selector === "html") return [".dve-rpBody"];
  if (selector === "body") return [".dve-md"];
  if (/^::-webkit-scrollbar/.test(selector)) {
    return [".dve-rpBody" + selector, ".dve-md" + selector];
  }
  return [".dve-md " + selector];
}

/** body 映射规则里丢掉整页版式声明，留白交给浮窗。 */
function filterBodyDeclarations(body) {
  return body
    .split(";")
    .filter((decl) => {
      const prop = (decl.split(":")[0] ?? "").trim().toLowerCase();
      return decl.trim() !== "" && !/^(max-width|margin|padding)$/.test(prop);
    })
    .join(";");
}

/**
 * 变换入口：整页样式 → 预览窗作用域样式（单行压缩输出）。
 * @param {string} source 原始 CSS 全文
 * @returns {string}
 */
export function transformReaderCss(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, ""); // 注释不进产物
  const out = [];

  const emitRule = (prelude, body, sink) => {
    const mapped = [];
    let isBody = false;
    for (const selector of splitTopLevel(prelude)) {
      if (DROP_SELECTOR.some((re) => re.test(selector))) continue;
      if (selector === "body") isBody = true;
      mapped.push(...mapSelector(selector));
    }
    if (mapped.length === 0) return;
    sink.push(mapped.join(",") + "{" + (isBody ? filterBodyDeclarations(body) : body) + "}");
  };

  const walk = (fragment, sink) => {
    let i = 0;
    for (;;) {
      while (i < fragment.length && /\s/.test(fragment[i])) i++;
      if (i >= fragment.length) return;
      if (fragment[i] === "}") {
        i++; // 容错：多余的闭括号
        continue;
      }
      if (fragment[i] === "@") {
        const start = i;
        while (i < fragment.length && fragment[i] !== "{" && fragment[i] !== ";") i++;
        const prelude = fragment.slice(start, i).trim();
        if (fragment[i] === ";") {
          i++; // @charset/@import 之类：本文件没有，跳过
          continue;
        }
        const [body, next] = readBlock(fragment, i);
        i = next;
        if (/^@media\b/i.test(prelude)) {
          if (/\bprint\b/i.test(prelude)) continue; // 浮窗不打印
          const inner = [];
          walk(body, inner);
          if (inner.length > 0) sink.push(prelude + "{" + inner.join("") + "}");
        } else if (/^@keyframes\s+fadeIn$/i.test(prelude)) {
          continue; // 唯一使用方（全屏浮层）已被裁掉
        } else {
          sink.push(prelude + "{" + body + "}");
        }
      } else {
        const start = i;
        while (i < fragment.length && fragment[i] !== "{") i++;
        const prelude = fragment.slice(start, i).trim();
        const [body, next] = readBlock(fragment, i);
        i = next;
        emitRule(prelude, body, sink);
      }
    }
  };

  walk(css, out);
  return out.join("").replace(/\s+/g, " ").trim();
}
