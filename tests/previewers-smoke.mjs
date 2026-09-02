/**
 * dsh-v-explorer 预览格式注册表冒烟测试（src/previewers.mjs）：
 *  1. previewerFor：md/markdown → markdown；json/py/yaml/js/… → 对应条目；
 *     特殊文件名（Dockerfile/.gitignore）按名字匹配；大小写不敏感
 *  2. html 族与未知扩展不可预览（html 走右键「默认浏览器打开」，不做浮窗预览）
 *  3. 徽章回落：条目无 lang 时用扩展名（main.cpp → cpp）；kind 字段齐全
 *  4. JSON 美化 transform：合法 JSON 重排、非法原文、超 2MB 跳过、空内容
 *  5. 样式接口：collectPreviewerCss 含基础 .dve-code/.dve-langTag 样式与
 *     每个条目的 .dve-code--<id> 钩子说明（预留 CSS 显示样式的入口）
 * 运行：node tests/previewers-smoke.mjs
 */
import { MARKDOWN_PREVIEWER, CODE_PREVIEWERS, previewerFor, badgeFor, codeClassFor, displayTextFor, collectPreviewerCss } from "../src/previewers.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};
const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`FAIL: ${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
};

/* ---- 1. 扩展名 / 文件名匹配 ---- */
eq(previewerFor("readme.md"), MARKDOWN_PREVIEWER, "md → markdown 预览器");
eq(previewerFor("notes.markdown"), MARKDOWN_PREVIEWER, "markdown → markdown 预览器");
eq(previewerFor("a.json").id, "json", "json");
eq(previewerFor("deep/path/x.PY").id, "python", "py（大小写不敏感）");
eq(previewerFor("config.YML").id, "yaml", "yml");
eq(previewerFor("cfg.toml").id, "toml", "toml");
eq(previewerFor("app.jsx").id, "javascript", "jsx");
eq(previewerFor("app.tsx").id, "typescript", "tsx");
eq(previewerFor("style.scss").id, "css", "scss");
eq(previewerFor("doc.xml").id, "markup", "xml");
eq(previewerFor("run.bat").id, "shell", "bat");
eq(previewerFor("deploy.ps1").id, "shell", "ps1");
eq(previewerFor("settings.ini").id, "ini", "ini");
eq(previewerFor("main.cpp").id, "source", "cpp");
eq(previewerFor("Dockerfile").id, "source", "Dockerfile 按名字匹配");
eq(previewerFor("Makefile").id, "source", "Makefile 按名字匹配");
eq(previewerFor(".gitignore").id, "ini", ".gitignore 前置点按名字匹配");
eq(previewerFor("package.webmanifest").id, "json", "webmanifest");
eq(previewerFor("LICENSE").id, "text", "LICENSE 按名字匹配");

/* ---- 2. 不可预览 ---- */
for (const name of ["index.html", "page.htm", "doc.xhtml", "photo.png", "app.exe", "archive.tar.gz", "", undefined, null]) {
  eq(previewerFor(name), null, "不可预览: " + String(name));
}

/* ---- 3. 徽章回落与 kind ---- */
eq(MARKDOWN_PREVIEWER.kind, "markdown", "markdown 条目 kind");
for (const p of CODE_PREVIEWERS) eq(p.kind, "code", p.id + " 条目 kind");
eq(badgeFor(previewerFor("a.json"), "a.json"), "json", "json 徽章");
eq(badgeFor(previewerFor("x.py"), "x.py"), "python", "python 徽章");
eq(badgeFor(previewerFor("a.YML"), "a.YML"), "yaml", "yml 徽章映射 yaml");
eq(badgeFor(previewerFor("main.cpp"), "main.cpp"), "cpp", "无 lang 条目回落扩展名");
eq(badgeFor(previewerFor("run.log"), "run.log"), "log", "text 条目回落扩展名");
eq(badgeFor(previewerFor("Makefile"), "Makefile"), "makefile", "无扩展名回落文件名");
eq(badgeFor(previewerFor(".gitignore"), ".gitignore"), "gitignore", "前置点文件徽章");
eq(codeClassFor(previewerFor("a.json")), "dve-code dve-code--json", "code 类名含格式钩子");
eq(codeClassFor(null), "dve-code dve-code--text", "空条目兜底钩子");

/* ---- 4. JSON 美化 transform ---- */
const jsonEntry = previewerFor("a.json");
eq(displayTextFor(jsonEntry, '{"a":1}'), '{\n  "a": 1\n}', "合法 JSON 美化重排");
eq(displayTextFor(jsonEntry, "not json {"), "not json {", "非法 JSON 原文显示");
eq(displayTextFor(jsonEntry, ""), "", "空内容");
eq(displayTextFor(previewerFor("a.py"), "print(1)"), "print(1)", "无 transform 条目原文");
const big = '"' + "x".repeat(3 * 1024 * 1024) + '"';
eq(displayTextFor(jsonEntry, big), big, "超 2MB 跳过美化");

/* ---- 5. 样式扩展接口 ---- */
const css = collectPreviewerCss();
assert(css.includes(".dve-previewBody .dve-code{"), "基础 .dve-code 样式");
assert(css.includes(".dve-langTag{"), "标题栏徽章基础样式");
const ids = new Set();
for (const p of CODE_PREVIEWERS) {
  ids.add(p.id);
  assert(css.includes("dve-code--" + p.id), p.id + " 条目的样式钩子说明");
}
eq(ids.size, CODE_PREVIEWERS.length, "条目 id 唯一");

console.log("previewers:", CODE_PREVIEWERS.length + 1, "entries; previewers.css:", css.length, "chars");
console.log("\nALL PREVIEWER REGISTRY SMOKE TESTS PASSED");
