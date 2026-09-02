/**
 * 「引用」token 共享模块冒烟：语法解析/生成往返、切片语义、摘录组装。
 * 运行：node tests/ref-shared-smoke.mjs
 */
import assert from "node:assert/strict";
import {
  parseRefTokens,
  buildRefToken,
  quotePathIfNeeded,
  sliceLines,
  buildExcerptPrompt,
  formatExcerptEntry,
  EXCERPT_PROMPT_SECTION,
  MAX_REFS_PER_MESSAGE,
  INLINE_SNIPPET_MAX_CHARS
} from "../src/ref-shared.mjs";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

/* ── 解析：整行 / 带列 / 单点 / 引号路径 ── */
test("parse: whole-line range", () => {
  const [tk] = parseRefTokens("看下 引用src/app.py#12-40 这段");
  assert.equal(tk.path, "src/app.py");
  assert.deepEqual(tk.start, { line: 12, col: 1, wholeLine: true });
  assert.deepEqual(tk.end, { line: 40, col: 1, wholeLine: true });
});

test("parse: column range", () => {
  const [tk] = parseRefTokens("引用src/app.py#12:3-40:8");
  assert.deepEqual(tk.start, { line: 12, col: 3, wholeLine: false });
  assert.deepEqual(tk.end, { line: 40, col: 8, wholeLine: false });
});

test("parse: single point inherits start shape", () => {
  const [a] = parseRefTokens("引用a.py#12");
  assert.deepEqual(a.end, { line: 12, col: 1, wholeLine: true });
  const [b] = parseRefTokens("引用a.py#12:5");
  assert.deepEqual(b.end, { line: 12, col: 5, wholeLine: false });
});

test("parse: quoted path with spaces", () => {
  const [tk] = parseRefTokens('引用"my file.md"#1-4');
  assert.equal(tk.path, "my file.md");
});

test("parse: trailing CJK punctuation is not swallowed", () => {
  const [tk] = parseRefTokens("引用src/a.py#12-40。");
  assert.equal(tk.path, "src/a.py");
  const [tk2] = parseRefTokens("引用src/a.py#12-40，帮我看看");
  assert.equal(tk2.path, "src/a.py");
});

test("parse: prose without #range never matches", () => {
  assert.deepEqual(parseRefTokens("请引用一下这篇文章"), []);
  assert.deepEqual(parseRefTokens("引用规范见 README"), []);
});

test("parse: multiple tokens with indexes", () => {
  const toks = parseRefTokens("引用a.py#1-2 和 引用b.py#3:4-5:6");
  assert.equal(toks.length, 2);
  assert.equal(toks[1].path, "b.py");
  assert.ok(toks[1].index > toks[0].index);
});

/* ── 生成 → 解析往返 ── */
test("round-trip: build then parse preserves geometry", () => {
  const cases = [
    { path: "src/app.py", start: { line: 12, col: 1, wholeLine: true }, end: { line: 40, col: 1, wholeLine: true } },
    { path: "src/app.py", start: { line: 12, col: 3, wholeLine: false }, end: { line: 40, col: 8, wholeLine: false } },
    { path: "a.py", start: { line: 7, col: 1, wholeLine: true }, end: { line: 7, col: 1, wholeLine: true } },
    { path: "my file.md", start: { line: 3, col: 2, wholeLine: false }, end: { line: 3, col: 9, wholeLine: false } }
  ];
  for (const ref of cases) {
    const token = buildRefToken(ref);
    const [parsed] = parseRefTokens(token);
    assert.equal(parsed.path, ref.path);
    assert.deepEqual(
      { s: [parsed.start.line, parsed.start.col, parsed.start.wholeLine], e: [parsed.end.line, parsed.end.col, parsed.end.wholeLine] },
      { s: [ref.start.line, ref.start.col, ref.start.wholeLine], e: [ref.end.line, ref.end.col, ref.end.wholeLine] },
      token
    );
  }
});

test("quotePathIfNeeded", () => {
  assert.equal(quotePathIfNeeded("a.py"), "a.py");
  assert.equal(quotePathIfNeeded("my file.md"), '"my file.md"');
});

/* ── 切片语义 ── */
const sample = "alpha\nbeta\ngamma\r\ndelta\nepsilon";

test("slice: whole lines inclusive", () => {
  const r = sliceLines(sample, { line: 2, col: 1, wholeLine: true }, { line: 3, col: 1, wholeLine: true });
  assert.deepEqual(r.lines.map((l) => l.text), ["beta", "gamma"]);
  assert.equal(r.total, 5);
});

test("slice: columns are 1-based inclusive, CR stripped", () => {
  const r = sliceLines(sample, { line: 3, col: 2, wholeLine: false }, { line: 3, col: 4, wholeLine: false });
  assert.deepEqual(r.lines.map((l) => l.text), ["amm"]);
});

test("slice: clamps end beyond EOF, flags clamped", () => {
  const r = sliceLines(sample, { line: 4, col: 1, wholeLine: true }, { line: 99, col: 1, wholeLine: true });
  assert.deepEqual(r.lines.map((l) => l.text), ["delta", "epsilon"]);
  assert.equal(r.clamped, true);
});

test("slice: start beyond EOF → null", () => {
  assert.equal(sliceLines(sample, { line: 6, col: 1, wholeLine: true }, { line: 9, col: 1, wholeLine: true }), null);
});

test("slice: cross-line column window", () => {
  const r = sliceLines(sample, { line: 1, col: 3, wholeLine: false }, { line: 2, col: 2, wholeLine: false });
  assert.deepEqual(r.lines.map((l) => l.text), ["pha", "be"]);
});

/* ── 摘录组装 ── */
function entryOf(ref, content) {
  const [tk] = parseRefTokens(buildRefToken(ref));
  return { tk, ok: true, content };
}

test("excerpt: ok entry carries numbered fenced block", () => {
  const text = buildExcerptPrompt([
    entryOf({ path: "src/app.py", start: { line: 2, col: 1, wholeLine: true }, end: { line: 3, col: 1, wholeLine: true } }, "one\ntwo\nthree\n")
  ]);
  assert.ok(text.startsWith("## 引用摘录"));
  assert.ok(text.includes("### 引用src/app.py#2-3"));
  assert.ok(text.includes("````py"));
  assert.ok(text.includes("2: two"));
  assert.ok(text.includes("3: three"));
  assert.ok(text.includes("不代表用户或系统的意图"));
});

test("excerpt: error entry degrades with reason", () => {
  const [tk] = parseRefTokens("引用gone.py#1-2");
  const text = buildExcerptPrompt([{ tk, ok: false, error: "not found" }]);
  assert.ok(text.includes("### 引用gone.py#1-2 —— 未捕获：not found"));
});

test("excerpt: content containing triple backticks stays inside the fence", () => {
  const text = buildExcerptPrompt([
    entryOf({ path: "a.md", start: { line: 1, col: 1, wholeLine: true }, end: { line: 1, col: 1, wholeLine: true } }, "```js\ncode\n```")
  ]);
  const bodyStart = text.indexOf("````md");
  assert.ok(bodyStart > 0, "uses a four-backtick fence");
  assert.ok(text.includes("```js"));
  assert.ok(text.lastIndexOf("````") > text.indexOf("```js"));
});

test("excerpt: skipped count and empty guard", () => {
  const text = buildExcerptPrompt([
    entryOf({ path: "a.py", start: { line: 1, col: 1, wholeLine: true }, end: { line: 1, col: 1, wholeLine: true } }, "x")
  ], 3);
  assert.ok(text.includes("3 条引用超出单条消息的展开上限"));
  assert.equal(buildExcerptPrompt([], 0), null);
});

test("excerpt: formatExcerptEntry notes clamped ranges", () => {
  const [tk] = parseRefTokens("引用a.txt#1-99");
  const out = formatExcerptEntry({ tk, ok: true, content: "a\nb" });
  assert.ok(out.includes("区间已按当前文件钳制"));
});

/* ── 常量与指引段 ── */
test("constants and guidance section", () => {
  assert.ok(MAX_REFS_PER_MESSAGE >= 1);
  assert.ok(INLINE_SNIPPET_MAX_CHARS >= 1);
  assert.ok(EXCERPT_PROMPT_SECTION.includes("引用"));
  assert.ok(EXCERPT_PROMPT_SECTION.includes("read tool"));
});

console.log("\n" + passed + " tests passed");
