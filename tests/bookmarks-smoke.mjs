/**
 * dsh-v-explorer 书签能力冒烟测试（对齐 host-smoke.cjs 的 mock 宿主模式：
 * 打桩 exec/execFile 后动态 import lib/index.js，用临时目录 + mock ctx 驱动路由）。
 *
 * 覆盖（bookmark-storage 规格）：
 *  1. 存储读写往返：add → .dsh-v-explorer/bookmarks.json（version 1 + path/addedAt）+
 *     .dsh-v-explorer/ 经 .git/info/exclude 对 git 完全隐身；GET 顺序与存储一致
 *  2. 读失败按空降级（文件损坏 → GET 200 空列表，add 可重建）
 *  3. 幂等/去重（含 win32 大小写变体，存储保留词法 rel）
 *  4. 400（空/`.`/隐藏路径段，且不泄露存在性）、403（../outside / ..）、404（不存在）
 *  5. exists/isDir 标注：删除 → exists:false，恢复 → exists:true
 *  6. remove 幂等：不存在也 200 且不广播
 *  7. 上限 413
 *  8. 409：version 高于支持版本时 GET 兼容 / 增删拒写
 *  9. 增删响应体携带更新后的书签数组（客户端免二次 GET）
 * 10. 并发 add 不互吞（每 cwd 写队列串行化）
 * 11. SSE：书签增删广播 bookmarks-changed；fs-changed 已退役——任何文件写入
 *     与 .dsh-v-explorer/ 写入都不再产生任何广播帧
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 临时工作目录 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dve-bm-"));
fs.writeFileSync(path.join(tmp, "readme.md"), "# hello\n\nworld\n");
fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><html><body>hi</body></html>\n");
fs.mkdirSync(path.join(tmp, "sub"));
fs.writeFileSync(path.join(tmp, "sub", "note.txt"), "note\n");
fs.mkdirSync(path.join(tmp, ".hidden"));
/* 让 fixture 成为 git 仓库形态：ensureGitExcluded 只在 .git 存在时写排除条目 */
fs.mkdirSync(path.join(tmp, ".git", "info"), { recursive: true });
const bookmarksFile = path.join(tmp, ".dsh-v-explorer", "bookmarks.json");

/* ---------- 打补丁并动态加载（同 host-smoke.cjs） ---------- */
const source = fs.readFileSync(path.join(here, "..", "lib", "index.js"), "utf8");
const patched = source.replace(
  'import { exec, execFile } from "node:child_process";',
  'const exec = () => ({ on(ev, fn) { if (ev === "spawn") setImmediate(fn); } });\nconst execFile = () => ({ on(ev, fn) { if (ev === "spawn") setImmediate(fn); } });'
);
if (patched === source) throw new Error("patch failed");
const tmpModule = path.join(tmp, "host-under-test.mjs");
fs.writeFileSync(tmpModule, patched);
fs.copyFileSync(path.join(here, "..", "lib", "ref-shared.js"), path.join(tmp, "ref-shared.js"));

/* ---------- mock ctx（cordis Context 代理语义模拟，同 host-smoke.cjs） ---------- */
const routes = new Map();
const handlers = {};
const services = {
  sessions: { get: (id) => (id === "s1" ? { header: { cwd: tmp } } : undefined) },
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
  agents: { list: () => [] }
};
let declaredInjects = null;
const ctx = new Proxy(
  {
    on: (event, handler) => {
      (handlers[event] = handlers[event] || []).push(handler);
      return () => {};
    },
    effect: (fn) => fn()
  },
  {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (!declaredInjects || !declaredInjects.includes(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      }
      return services[prop];
    },
    set(target, prop, value) {
      if (typeof prop !== "symbol" && !Reflect.has(target, prop)) {
        services[prop] = value;
        return true;
      }
      return Reflect.set(target, prop, value, target);
    }
  }
);

function request(method, url, body) {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url);
    const req = {
      method,
      url: u.pathname + u.search,
      [Symbol.asyncIterator]: async function* () {
        if (body !== undefined) yield JSON.stringify(body);
      }
    };
    let status = null;
    const chunks = [];
    const res = {
      writeHead: (s) => {
        status = s;
      },
      end: (data) => {
        chunks.push(String(data));
        resolvePromise({ status, body: JSON.parse(chunks.join("") || "{}") });
      }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const api = (method, route, body) => request(method, "http://x/api/dsh-v-explorer" + route, body);
const add = (p) => api("POST", "/bookmark-add", { sessionId: "s1", path: p });
const remove = (p) => api("POST", "/bookmark-remove", { sessionId: "s1", path: p });
const listBookmarks = () => api("GET", "/bookmarks?sessionId=s1");

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

let handler = null;

(async () => {
  const keepAlive = setInterval(() => {}, 60000);

  const mod = await import(pathToFileURL(tmpModule));
  declaredInjects = mod.inject;
  mod.apply(ctx);
  handler = routes.get("/api/dsh-v-explorer");
  if (!handler) throw new Error("route not registered");

  /* ---------- 1. 查询：空列表（尚无存储文件） ---------- */
  let r = await listBookmarks();
  expect(r.status === 200 && Array.isArray(r.body.bookmarks) && r.body.bookmarks.length === 0, "empty GET failed: " + JSON.stringify(r.body));
  expect(typeof r.body.cwd === "string", "GET must return cwd");

  /* ---------- 2. add：目录书签 + 存储往返 + git exclude 隐身 ---------- */
  r = await add("sub");
  expect(r.status === 200, "add sub failed: " + JSON.stringify(r.body));
  expect(Array.isArray(r.body.bookmarks) && r.body.bookmarks.length === 1, "add response must carry updated array");
  expect(r.body.bookmarks[0].path === "sub" && r.body.bookmarks[0].isDir === true && r.body.bookmarks[0].exists === true, "add annotation wrong: " + JSON.stringify(r.body.bookmarks[0]));
  expect(typeof r.body.bookmarks[0].addedAt === "string", "addedAt missing");
  const stored = JSON.parse(fs.readFileSync(bookmarksFile, "utf8"));
  expect(stored.version === 1 && stored.bookmarks.length === 1 && stored.bookmarks[0].path === "sub" && typeof stored.bookmarks[0].addedAt === "string", "storage roundtrip failed: " + JSON.stringify(stored));
  const excludeText = fs.readFileSync(path.join(tmp, ".git", "info", "exclude"), "utf8");
  expect(/^\.dsh-v-explorer\/?$/m.test(excludeText), "git exclude entry not ensured");

  /* ---------- 3. add：文件书签，顺序 = 插入顺序 ---------- */
  r = await add("readme.md");
  expect(r.status === 200 && r.body.bookmarks.length === 2, "add readme failed");
  expect(r.body.bookmarks[0].path === "sub" && r.body.bookmarks[1].path === "readme.md", "insertion order broken");
  expect(r.body.bookmarks[1].isDir === false, "file isDir wrong");

  /* ---------- 4. 幂等：重复 add no-op ---------- */
  r = await add("sub");
  expect(r.status === 200 && r.body.bookmarks.length === 2, "duplicate add must be idempotent");
  expect(fs.readFileSync(path.join(tmp, ".git", "info", "exclude"), "utf8").match(/^\.dsh-v-explorer\/?$/gm)?.length === 1, "exclude entry must not be appended twice");

  /* ---------- 5. 去重：win32 大小写变体（存储保留词法 rel） ---------- */
  r = await add("SUB");
  if (process.platform === "win32") {
    expect(r.status === 200 && r.body.bookmarks.length === 2, "win32 case-variant must dedup: " + JSON.stringify(r.body));
    expect(!r.body.bookmarks.some((b) => b.path === "SUB"), "storage must keep lexical rel, not the variant");
  } else {
    expect(r.status === 404, "case-sensitive platform has no SUB: got " + r.status);
  }

  /* ---------- 6. 400：空 / 根 / 隐藏路径段（缺失也不泄露存在性） ---------- */
  for (const bad of ["", ".", ".dsh-v-explorer/bookmarks.json", "sub/.h.txt", ".hidden", "./readme.md"]) {
    r = await add(bad);
    expect(r.status === 400, "path " + JSON.stringify(bad) + " must 400, got " + r.status);
  }

  /* ---------- 7. 403：词法逃逸（先于隐藏段语义） ---------- */
  for (const esc of ["../outside", ".."]) {
    r = await add(esc);
    expect(r.status === 403, "escape " + JSON.stringify(esc) + " must 403, got " + r.status);
  }

  /* ---------- 8. 404：不存在 ---------- */
  r = await add("nope.md");
  expect(r.status === 404, "missing path must 404, got " + r.status);

  /* ---------- 9. exists 标注：删除 → false，恢复 → true ---------- */
  fs.writeFileSync(path.join(tmp, "gone.md"), "temp\n");
  r = await add("gone.md");
  expect(r.status === 200 && r.body.bookmarks.length === 3, "add gone.md failed");
  fs.rmSync(path.join(tmp, "gone.md"));
  r = await listBookmarks();
  const goneEntry = r.body.bookmarks.find((b) => b.path === "gone.md");
  expect(goneEntry && goneEntry.exists === false, "deleted bookmark must be annotated exists:false");
  fs.writeFileSync(path.join(tmp, "gone.md"), "temp again\n");
  r = await listBookmarks();
  expect(r.body.bookmarks.find((b) => b.path === "gone.md").exists === true, "restored bookmark must be exists:true");
  r = await remove("gone.md");
  expect(r.status === 200 && r.body.bookmarks.length === 2, "cleanup remove failed");

  /* ---------- 10. remove：幂等（不存在也 200 且不广播，见 SSE 段） ---------- */
  r = await remove("sub");
  expect(r.status === 200 && Array.isArray(r.body.bookmarks) && r.body.bookmarks.length === 1 && r.body.bookmarks[0].path === "readme.md", "remove failed: " + JSON.stringify(r.body));
  r = await remove("sub");
  expect(r.status === 200 && r.body.bookmarks.length === 1, "remove must be idempotent");

  /* ---------- 11. SSE：bookmarks-changed 广播 + .dsh-v-explorer/ 子树不触发 fs-changed ---------- */
  function openEventStream(sessionId) {
    return new Promise((resolvePromise, reject) => {
      const writes = [];
      const res = {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        write(chunk) { writes.push(String(chunk)); return true; },
        end() { this.ended = true; },
        on(ev, fn) { if (ev === "close") this.closeHandler = fn; }
      };
      const req = {
        method: "GET",
        url: "/api/dsh-v-explorer/events?sessionId=" + encodeURIComponent(sessionId),
        [Symbol.asyncIterator]: async function* () {}
      };
      Promise.resolve(handler(req, res)).then(() => resolvePromise({ res, writes }), reject);
    });
  }
  const wait = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));

  const stream = await openEventStream("s1");
  expect(stream.res.status === 200, "events must 200");

  /* add → bookmarks-changed */
  let marked = stream.writes.length;
  r = await add("index.html");
  expect(r.status === 200 && r.body.bookmarks.length === 2, "add index.html failed");
  expect(stream.writes.slice(marked).some((w) => w.includes("bookmarks-changed")), "bookmarks-changed not broadcast");

  /* fs-changed 已退役：普通文件写入与快照写入都不再产生任何广播帧 */
  marked = stream.writes.length;
  fs.writeFileSync(path.join(tmp, "watched.txt"), "hello\n");
  r = await api("POST", "/snapshot", { sessionId: "s1", content: "snap" });
  expect(r.status === 200, "snapshot failed");
  await wait(900);
  expect(stream.writes.length === marked, "no broadcast frames expected for fs writes: " + JSON.stringify(stream.writes.slice(marked)));
  expect(!stream.writes.some((w) => w.includes("fs-changed")), "fs-changed must be retired");

  /* remove 实际移除 → 广播；幂等 remove → 不广播 */
  marked = stream.writes.length;
  r = await remove("index.html");
  expect(r.status === 200 && r.body.bookmarks.length === 1, "remove index.html failed");
  expect(stream.writes.slice(marked).some((w) => w.includes("bookmarks-changed")), "remove must broadcast bookmarks-changed");
  marked = stream.writes.length;
  r = await remove("index.html");
  expect(r.status === 200, "idempotent remove must 200");
  expect(!stream.writes.slice(marked).some((w) => w.includes("bookmarks-changed")), "no-op remove must NOT broadcast");
  stream.res.closeHandler();

  /* ---------- 12. 读失败按空降级，且 add 可重建 ---------- */
  fs.writeFileSync(bookmarksFile, "{corrupted!!");
  r = await listBookmarks();
  expect(r.status === 200 && r.body.bookmarks.length === 0, "corrupt file must degrade to empty list");
  r = await add("readme.md");
  expect(r.status === 200 && r.body.bookmarks.length === 1, "add must rebuild after corruption");
  expect(JSON.parse(fs.readFileSync(bookmarksFile, "utf8")).version === 1, "rebuilt file must be valid");

  /* ---------- 13. 409：version 高于支持版本 → GET 兼容 / 增删拒写 ---------- */
  const future = { version: 99, bookmarks: [{ path: "future-note.md", addedAt: "2030-01-01T00:00:00.000Z", group: "v2" }] };
  fs.writeFileSync(bookmarksFile, JSON.stringify(future));
  r = await listBookmarks();
  expect(r.status === 200 && r.body.bookmarks.length === 1 && r.body.bookmarks[0].path === "future-note.md", "GET must best-effort return future version entries");
  r = await add("sub");
  expect(r.status === 409, "add on future version must 409, got " + r.status);
  r = await remove("future-note.md");
  expect(r.status === 409, "remove on future version must 409, got " + r.status);
  expect(JSON.parse(fs.readFileSync(bookmarksFile, "utf8")).version === 99, "future file must not be downgraded");

  /* ---------- 14. 上限 413 ---------- */
  const hundred = Array.from({ length: 100 }, (_, i) => ({ path: "f" + i + ".txt", addedAt: "2025-01-01T00:00:00.000Z" }));
  fs.writeFileSync(bookmarksFile, JSON.stringify({ version: 1, bookmarks: hundred }));
  fs.writeFileSync(path.join(tmp, "f100.txt"), "x\n");
  r = await add("f100.txt");
  expect(r.status === 413, "101st bookmark must 413, got " + r.status);
  expect(JSON.parse(fs.readFileSync(bookmarksFile, "utf8")).bookmarks.length === 100, "413 must not mutate storage");

  /* ---------- 15. 并发 add 不互吞（每 cwd 写队列串行化） ---------- */
  fs.writeFileSync(bookmarksFile, JSON.stringify({ version: 1, bookmarks: [] }));
  const [a, b] = await Promise.all([add("readme.md"), add("index.html")]);
  expect(a.status === 200 && b.status === 200, "concurrent adds must both succeed");
  const lens = [a.body.bookmarks.length, b.body.bookmarks.length].sort().join(",");
  expect(lens === "1,2", "serialized responses must be length 1 then 2, got " + lens);
  const finalStored = JSON.parse(fs.readFileSync(bookmarksFile, "utf8"));
  const paths = finalStored.bookmarks.map((x) => x.path).sort();
  expect(finalStored.version === 1 && paths.join("|") === "index.html|readme.md", "concurrent adds must both persist: " + JSON.stringify(finalStored));

  /* ---------- 16. 未知会话 404 ---------- */
  r = await request("GET", "http://x/api/dsh-v-explorer/bookmarks?sessionId=nope");
  expect(r.status === 404, "unknown session must 404");

  clearInterval(keepAlive);
  console.log("\nALL BOOKMARKS SMOKE TESTS PASSED");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
