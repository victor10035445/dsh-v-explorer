/**
 * 渲染器/树身纯逻辑冒烟测试（不依赖 DOM）：
 *  1. pickBlockForLine：行号导航的块选择（覆盖优先 → 前一个块 → 第一块）
 *  2. prettifyDecision：JSON 美化决策（eof / 2MB 上限 / 解析失败）
 *  3. compareEntries / hasHiddenSegment：files 树排序与隐藏段判定
 * 运行：node tests/renderer-logic-smoke.mjs
 */
import { pickBlockForLine, RENDER_CHAR_LIMIT, readerMarkdownDefinition, READER_MARKDOWN_ID, prettifyDecision, PRETTIFY_CHAR_LIMIT, readerJsonDefinition, READER_JSON_ID } from "../src/reader-shared.mjs";
import { compareEntries, hasHiddenSegment } from "../src/tree-utils.mjs";
import { filesTabDefinition, FILES_TAB_ID, bookmarksTabDefinition, BOOKMARKS_TAB_ID } from "../src/tab-definitions.mjs";
import { createChangesHub } from "../src/changes-hub.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};
const eq = (actual, expected, message) => assert(actual === expected, message + `（actual=${JSON.stringify(actual)}）`);

/* ---- 1. pickBlockForLine ---- */
const blocks = [
  { id: "b1", start: 1, end: 3 },
  { id: "b2", start: 5, end: 8 },
  { id: "b3", start: 10, end: 12 }
];
eq(pickBlockForLine(blocks, 2).id, "b1", "覆盖行取所在块");
eq(pickBlockForLine(blocks, 6).id, "b2", "覆盖行取所在块 2");
eq(pickBlockForLine(blocks, 4).id, "b1", "行间空隙取前块");
eq(pickBlockForLine(blocks, 9).id, "b2", "行间空隙取前块 2");
eq(pickBlockForLine(blocks, 99).id, "b3", "越界取最后块");
eq(pickBlockForLine([], 3), null, "空块集安全");

/* ---- 2. prettifyDecision ---- */
const pretty = prettifyDecision('{"a":1}', true);
eq(pretty.pretty, true, "eof 内美化");
eq(pretty.text, '{\n  "a": 1\n}\n', "美化格式");
eq(prettifyDecision('{"a":1}', false).pretty, false, "未 eof 不美化（原文展示）");
eq(prettifyDecision("{bad json}", true).pretty, false, "解析失败原文展示");
const big = "x".repeat(PRETTIFY_CHAR_LIMIT + 1);
eq(prettifyDecision(big, true).pretty, false, "超 2MB 不美化");
eq(prettifyDecision("[1,2]", true).text, "[\n  1,\n  2\n]\n", "数组也美化");

/* 渲染上限 sanity */
assert(RENDER_CHAR_LIMIT === 1_000_000, "markdown 渲染上限 1M");

/* ---- 3. 树排序与隐藏段 ---- */
const entries = [
  { name: "readme.md", type: "file" },
  { name: "Sub", type: "directory" },
  { name: "apple", type: "file" },
  { name: ".dot", type: "file" },
  { name: "src2", type: "directory" }
];
const sorted = [...entries].sort(compareEntries);
assert(sorted[0].type === "directory" && sorted[1].type === "directory", "目录优先");
eq(sorted.map((e) => e.name).slice(0, 2).join(","), "src2,Sub", "目录内自然序（大小写不敏感）");
eq(sorted[sorted.length - 1].name, "readme.md", "文件在后");
const fileNames = sorted.filter((e) => e.type === "file").map((e) => e.name);
eq(fileNames.join(","), ".dot,apple,readme.md", "文件名自然序大小写不敏感");
eq(hasHiddenSegment(".dsh-v-explorer/bookmarks.json"), true, "隐藏段命中");
eq(hasHiddenSegment("sub/.h.txt"), true, "深层隐藏段命中");
eq(hasHiddenSegment("a.md"), false, "普通路径不命中");
eq(hasHiddenSegment("..\\x"), true, ".. 视为隐藏段（与书签规则一致）");

/* ---- 4. 注册面定义（元数据形状） ---- */
const t = (key) => "T:" + key;
const stubIcon = () => null;
const fd = filesTabDefinition(t, { folder: stubIcon });
eq(fd.id, FILES_TAB_ID, "files id");
eq(fd.kind, "files", "files kind");
eq(fd.priority, "extension", "files extension 接管");
eq(fd.guide[0].order, 10, "files guide 顺序 10");
eq(fd.title(), "T:files.typeLabel", "title 为 locale 函数");
eq(fd.guide[0].title(), "T:files.guideTitle", "guide title 为 locale 函数");
eq(fd.guide[0].icon, stubIcon, "guide icon 透传");

const bd = bookmarksTabDefinition(t, { bookmark: stubIcon });
eq(bd.kind, "bookmarks", "bookmarks kind");
eq(bd.guide[0].order, 20, "bookmarks guide 顺序 20");

const mdDef = readerMarkdownDefinition(() => t("rd.markdown"));
eq(mdDef.id, READER_MARKDOWN_ID, "markdown renderer id");
eq(mdDef.extensions.join(","), "md,markdown", "markdown extensions");
eq(mdDef.priority, "extension", "markdown extension 胜默认");
eq(mdDef.loading, "text-pages", "markdown loading text-pages");
eq(mdDef.title(), "T:rd.markdown", "markdown title 为 locale 函数（官方契约 () => string）");
const jsonDef = readerJsonDefinition(() => t("rd.json"));
eq(jsonDef.extensions.join(","), "json", "json extensions");
eq(jsonDef.wrap, true, "json 消费 wrap");
eq(jsonDef.title(), "T:rd.json", "json title 为 locale 函数");

/* ---- 5. changes hub：follow 计数与归零 dispose ---- */
{
  let disposed = 0;
  const frames = [];
  const remote = {
    /* $stream 契约的最小测试替身：open(signal) → 原始帧生成器；dispose 中止。 */
    $stream: ({ open }) => {
      const controller = new AbortController();
      return {
        async *[Symbol.asyncIterator]() {
          for await (const value of open(controller.signal)) {
            yield { value, accept: () => {} };
          }
        },
        dispose: () => {
          controller.abort();
          return Promise.resolve();
        }
      };
    },
    workspaceFiles: {
      changes: (sessionId, signal) => ({
        async *[Symbol.asyncIterator]() {
          try {
            yield { kind: "ready" };
            yield { kind: "change", change: { absolutePath: "C:/r/a.md", version: 1 } };
            /* 挂起直到 dispose */
            await new Promise((resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("disposed")), { once: true });
            });
          } finally {
            disposed += 1;
          }
        }
      })
    }
  };
  const hub = createChangesHub(() => remote);
  const off1 = hub.follow("s1", (frame) => frames.push(frame));
  const off2 = hub.follow("s1", (frame) => frames.push(frame));
  await new Promise((resolve) => setTimeout(resolve, 30));
  eq(frames.length, 4, "两个 follower 各收两帧");
  eq(frames[0].kind, "ready", "ready 帧分发");
  off1();
  off2();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(disposed >= 1, "最后一个 follower 离开即 dispose");
}

console.log("\nALL RENDERER-LOGIC SMOKE TESTS PASSED");
