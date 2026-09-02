/**
 * 文件预览器注册表 —— 「哪些文件能像 .md 一样在浮窗里点开预览」的唯一事实来源，
 * 也是文本类预览的**样式扩展接口**。
 *
 * 两类条目：
 *  - MARKDOWN_PREVIEWER（kind:"markdown"）：markdown-it 渲染，样式走 Reader Pro
 *    主题（src/markdown-reader-pro.css，构建期作用域化注入）；
 *  - CODE_PREVIEWERS（kind:"code"）：<pre> 纯文本渲染（React 文本子节点自动
 *    转义，绝不进 dangerouslySetInnerHTML），可选 transform（如 JSON 美化）。
 *
 * ── 样式扩展接口（预留）──────────────────────────────────────────────
 * 每个条目带 styles 字段（CSS 字符串）。collectPreviewerCss() 把基础样式与全部
 * 条目样式汇总成 previewers.css，由 installStyles 注入（排在 Reader Pro 主题之后、
 * explorer.css 之前：可引用主题令牌，也可被 explorer.css 覆盖）。
 * 为某格式加显示样式 = 在它的 styles 里写规则，然后 `pnpm build`。可用钩子：
 *  - .dve-code--<id>          正文 <pre>（还带 data-lang 属性，可按值选择）
 *  - .dve-langTag[data-lang]  标题栏语言徽章
 * 例（给 JSON 预览换底色）：
 *   { id:"json", …, styles:".dve-code--json{background:var(--code-inline-bg)}" }
 *
 * html/htm/xhtml 有意不在预览表里：它们走右键菜单「打开」，由宿主端
 * /open-browser 路由用系统默认浏览器按 file 协议打开。
 */

/** JSON 美化上限：更大的文件跳过美化直接原文显示，避免解析/序列化卡顿。 */
const PRETTY_JSON_MAX_CHARS = 2 * 1024 * 1024;

/** JSON 预览变换：能解析则缩进 2 格重排，解析失败按原文显示。 */
function prettyJson(text) {
  if (!text || text.length > PRETTY_JSON_MAX_CHARS) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 条目自带的样式接口说明（钩子写明在条目里，加样式不用翻文档）。 */
function hookStyles(id) {
  return (
    "\n/* " + id + " 预览样式接口：为该格式定制显示样式时写在这里（pnpm build 后生效）。\n" +
    "   钩子：.dve-code--" + id + "（正文 pre，另带 data-lang 属性）、.dve-langTag[data-lang]（标题栏徽章）。 */\n"
  );
}

export const MARKDOWN_PREVIEWER = {
  id: "markdown",
  kind: "markdown",
  exts: ["md", "markdown"],
  lang: "markdown",
  /** Markdown 样式走 Reader Pro 主题，不需要条目级样式。 */
  styles: ""
};

/** 文本类预览条目（kind 统一补 "code"；lang 为空时徽章回落到文件扩展名）。 */
const CODE_ENTRIES = [
  {
    id: "text",
    exts: ["txt", "text", "log"],
    names: ["license", "notice", "changelog", "authors", "contributors"],
    styles: hookStyles("text")
  },
  {
    id: "json",
    exts: ["json", "jsonc", "json5", "webmanifest"],
    lang: "json",
    transform: prettyJson,
    styles: hookStyles("json")
  },
  { id: "yaml", exts: ["yml", "yaml"], lang: "yaml", styles: hookStyles("yaml") },
  { id: "toml", exts: ["toml"], styles: hookStyles("toml") },
  { id: "python", exts: ["py", "pyi", "pyw"], lang: "python", styles: hookStyles("python") },
  { id: "javascript", exts: ["js", "mjs", "cjs", "jsx"], lang: "javascript", styles: hookStyles("javascript") },
  { id: "typescript", exts: ["ts", "mts", "cts", "tsx"], lang: "typescript", styles: hookStyles("typescript") },
  { id: "css", exts: ["css", "scss", "sass", "less"], lang: "css", styles: hookStyles("css") },
  { id: "markup", exts: ["xml", "svg"], lang: "xml", styles: hookStyles("markup") },
  { id: "shell", exts: ["sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd"], styles: hookStyles("shell") },
  {
    id: "ini",
    exts: ["ini", "cfg", "conf", "properties", "env"],
    names: ["gitignore", "gitattributes", "editorconfig", "npmrc", "babelrc", "prettierrc", "eslintrc"],
    styles: hookStyles("ini")
  },
  {
    id: "source",
    exts: [
      "c", "h", "cpp", "hpp", "cc", "cxx", "hh", "cs", "java", "go", "rs", "rb", "php",
      "swift", "kt", "kts", "scala", "sql", "lua", "pl", "r", "dart", "vue", "svelte",
      "erl", "ex", "exs", "hs", "clj", "vim", "m", "mak", "gradle", "proto"
    ],
    names: ["dockerfile", "makefile"],
    styles: hookStyles("source")
  }
];

export const CODE_PREVIEWERS = CODE_ENTRIES.map((entry) => ({
  lang: null,
  names: null,
  transform: null,
  ...entry,
  kind: "code"
}));

export const PREVIEWERS = [MARKDOWN_PREVIEWER, ...CODE_PREVIEWERS];

/* 扩展名 / 特殊文件名 → 条目（先注册者优先；均按小写匹配）。 */
const BY_EXT = new Map();
const BY_NAME = new Map();
for (const previewer of PREVIEWERS) {
  for (const ext of previewer.exts ?? []) if (!BY_EXT.has(ext)) BY_EXT.set(ext, previewer);
  for (const name of previewer.names ?? []) if (!BY_NAME.has(name)) BY_NAME.set(name, previewer);
}

/** 无注册条目时的兜底（防御路径：openFilePreview 只对可预览名调用）。 */
export const CODE_FALLBACK = Object.freeze({ id: "text", kind: "code", lang: null, transform: null, styles: "" });

/**
 * 文件名 → 预览器条目；不可预览返回 null。
 * 前置点文件（.gitignore）按「去掉点后的名字」匹配，不算扩展名。
 * @param {string} name 文件名（含扩展名）
 * @returns {object|null}
 */
export function previewerFor(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const byExt = BY_EXT.get(lower.slice(dot + 1));
    if (byExt) return byExt;
  }
  return BY_NAME.get(lower.replace(/^\./, "")) ?? null;
}

/**
 * 标题栏语言徽章文案：条目声明了 lang 用 lang，否则回落到文件扩展名
 * （main.cpp → "cpp"，Makefile → "makefile"）。
 * @param {object} previewer
 * @param {string} name
 * @returns {string}
 */
export function badgeFor(previewer, name) {
  if (previewer?.lang) return previewer.lang;
  const lower = String(name ?? "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return (dot > 0 ? lower.slice(dot + 1) : lower.replace(/^\./, "")) || "text";
}

/** 正文 <pre> 的类名（含每格式样式钩子 .dve-code--<id>）。 */
export function codeClassFor(previewer) {
  return "dve-code dve-code--" + (previewer?.id ?? "text");
}

/** 显示文本：条目带 transform（如 JSON 美化）则应用，否则原文。 */
export function displayTextFor(previewer, content) {
  const text = content ?? "";
  return previewer?.transform ? previewer.transform(text) : text;
}

/** 文本类预览的基础样式（令牌定义于 .dve-preview，与 Reader Pro 主题同套）。 */
export const CODE_PREVIEW_CSS = `
/* ── 文本类预览（.dve-code）：与 Markdown 预览同窗、同套 Reader Pro 令牌 ── */
.dve-previewBody .dve-code{margin:0;padding:18px 22px 32px;min-height:100%;box-sizing:border-box;background:var(--code-bg);color:var(--text-primary);font-family:var(--font-mono);font-size:13px;line-height:1.7;white-space:pre;tab-size:4;border:none;border-radius:0;box-shadow:none;overflow:visible}
.dve-langTag{flex:none;margin-left:8px;padding:1px 7px;font-size:10px;font-weight:600;font-family:var(--font-sans);letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);background:var(--bg-tertiary);border:1px solid var(--border-muted);border-radius:5px}
`;

/** 汇总基础样式 + 全部条目的预留样式接口 → previewers.css。 */
export function collectPreviewerCss() {
  return [CODE_PREVIEW_CSS, ...PREVIEWERS.map((p) => p.styles)].filter(Boolean).join("\n");
}
