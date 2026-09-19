/**
 * dsh-v-explorer 宿主端冒烟测试（官方侧栏接管形态）：
 * 把 lib/index.js 的 execFile 换成桩后动态 import，用临时目录 + mock ctx
 * 驱动路由 handler，验证：
 *  1. 退役路由：/list 与 /file 一律 404（目录/读取由官方 workspaceFiles Remote 承担）
 *  2. open：路径逃逸 403（不真开 explorer）；未知会话 404
 *  3. open-browser：html → 200 + file:// URL（exec 已打桩，不会真开浏览器）；
 *     非 html / 目录 → 400；逃逸 → 403；不存在 → 404
 *  4. snapshot：选区物化到 .dsh-v-explorer/refs/（经 .git/info/exclude 隐身）、空内容 400、未知会话 404
 *  5. pre-step 摘录捕获：引用 token → 原消息后附加冻结摘录上下文；无引用零开销
 *     通过；注入消息不重复处理；逃逸路径降级为「未捕获」说明而不失败整轮
 *  6. events：SSE 握手（content-type/retry）；书签增删广播 bookmarks-changed；
 *     连接关闭后不再广播；未知会话 404（fs.watch / fs-changed 已退役）
 *  7. 持久层兜底：live store 查不到的会话（重启窗口期）从 sessionPersistence
 *     快照 header 解析 cwd，/bookmarks 与 /events 都可用；两边都没有仍 404
 *  8. cordis 语义守卫：mock ctx 模拟 Context 代理——服务必须经插件 inject
 *     声明才可取、未声明同步抛（漏声明 sessionPersistence 曾让兜底永不生效）
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/* ---------- 临时工作目录 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dve-test-"));
fs.writeFileSync(path.join(tmp, "readme.md"), "# hello\n\nworld\n");
fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><html><body>hi</body></html>\n");
fs.mkdirSync(path.join(tmp, "sub"));
/* git 仓库形态：snapshot 的 ensureGitExcluded 只在 .git 存在时写排除条目 */
fs.mkdirSync(path.join(tmp, ".git", "info"), { recursive: true });

/* ---------- 打补丁并动态加载 ---------- */
const source = fs.readFileSync(path.join(__dirname, "..", "lib", "index.js"), "utf8");
const patched = source.replace(
  'import { exec, execFile } from "node:child_process";',
  'const exec = () => ({ on(ev, fn) { if (ev === "spawn") setImmediate(fn); } });\nconst execFile = () => ({ on(ev, fn) { if (ev === "spawn") setImmediate(fn); } });'
);
if (patched === source) throw new Error("patch failed");
const tmpModule = path.join(tmp, "host-under-test.mjs");
fs.writeFileSync(tmpModule, patched);
/* lib/index.js import 的共享模块随行拷贝（相对导入需同目录可得）。 */
fs.copyFileSync(path.join(__dirname, "..", "lib", "ref-shared.js"), path.join(tmp, "ref-shared.js"));

/* ---------- mock ctx（cordis Context 代理语义模拟） ---------- */
const routes = new Map();
const handlers = {};
/* 服务袋：真实宿主里服务不是插件 ctx 的自有属性，必须经插件 inject 声明才能
   从 Context 代理上取到。本 mock 复刻该语义——未声明的服务取值同步抛
   "cannot get property ... without inject"。 */
const services = {
  sessions: { get: (id) => (id === "s1" ? { header: { cwd: tmp } } : undefined) },
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
  agents: { list: () => [] }
};
/* import 后由 mod.inject 填充；在此之前任何服务取值都视为未声明。 */
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
      /* 自有成员（on/effect 等）对应真实 ctx 上的方法，无需声明。 */
      if (typeof prop === "symbol" || Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (!declaredInjects || !declaredInjects.includes(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      }
      return services[prop];
    },
    set(target, prop, value) {
      /* 服务赋值（测试中途挂 sessionPersistence）进服务袋，保持「非自有属性」语义。 */
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

let handler = null;

(async () => {
  /* open-browser 成功路径等待的是宿主端 unref 过的 800ms 计时器——
     用一个常驻 interval 保住事件循环，等响应回来。 */
  const keepAlive = setInterval(() => {}, 60000);

  const mod = await import(pathToFileURL(tmpModule));
  /* cordis 语义守卫：漏声明 sessionPersistence 会让快照兜底在真实宿主里
     同步抛、被 try/catch 吞成 404（0.3.0 的 bug）；这里显式拦下。 */
  if (!Array.isArray(mod.inject) || !mod.inject.includes("sessionPersistence")) {
    throw new Error('plugin inject must declare "sessionPersistence" (cordis Context proxy throws on undeclared services)');
  }
  declaredInjects = mod.inject;
  mod.apply(ctx);
  handler = routes.get("/api/dsh-v-explorer");
  if (!handler) throw new Error("route not registered");

  /* ── 退役路由：/list 与 /file 一律 404 ── */
  let r = await request("GET", "http://x/api/dsh-v-explorer/list?sessionId=s1");
  if (r.status !== 404) throw new Error("retired /list must 404, got " + r.status);
  r = await request("GET", "http://x/api/dsh-v-explorer/file?sessionId=s1&path=readme.md");
  if (r.status !== 404) throw new Error("retired /file must 404, got " + r.status);

  /* open：路径逃逸 → 403（不真开窗口） */
  r = await request("POST", "http://x/api/dsh-v-explorer/open", { sessionId: "s1", path: ".." });
  if (r.status !== 403) throw new Error("open escape must 403, got " + r.status);

  /* open-browser：html → 200 + file:// URL（exec 已打桩，不会真开浏览器） */
  r = await request("POST", "http://x/api/dsh-v-explorer/open-browser", { sessionId: "s1", path: "index.html" });
  if (r.status !== 200 || r.body.ok !== true) throw new Error("open-browser failed: " + JSON.stringify(r.body));
  if (!/^file:\/\/\//.test(r.body.url) || !/index\.html$/.test(r.body.url)) throw new Error("file url malformed: " + r.body.url);

  /* open-browser：非 html / 目录 → 400 */
  r = await request("POST", "http://x/api/dsh-v-explorer/open-browser", { sessionId: "s1", path: "readme.md" });
  if (r.status !== 400) throw new Error("non-html must 400, got " + r.status);
  r = await request("POST", "http://x/api/dsh-v-explorer/open-browser", { sessionId: "s1", path: "sub" });
  if (r.status !== 400) throw new Error("directory must 400, got " + r.status);

  /* open-browser：逃逸 → 403；不存在 → 404 */
  r = await request("POST", "http://x/api/dsh-v-explorer/open-browser", { sessionId: "s1", path: ".." });
  if (r.status !== 403) throw new Error("open-browser escape must 403, got " + r.status);
  r = await request("POST", "http://x/api/dsh-v-explorer/open-browser", { sessionId: "s1", path: "nope.html" });
  if (r.status !== 404) throw new Error("missing html must 404, got " + r.status);

  /* 未知会话 → 404（open-browser 路径上的会话解析） */
  r = await request("POST", "http://x/api/dsh-v-explorer/open-browser", { sessionId: "nope", path: "index.html" });
  if (r.status !== 404) throw new Error("unknown session must 404");

  /* snapshot：会话选区物化到 .dsh-v-explorer/refs/，返回引用所需的路径与行数 */
  r = await request("POST", "http://x/api/dsh-v-explorer/snapshot", { sessionId: "s1", content: "hello\nworld" });
  if (r.status !== 200 || r.body.lines !== 2 || !/^\.dsh-v-explorer\/refs\/ref-/.test(r.body.path)) {
    throw new Error("snapshot failed: " + JSON.stringify(r.body));
  }
  if (!fs.existsSync(path.join(tmp, r.body.path))) throw new Error("snapshot file not written");
  if (!/^\.dsh-v-explorer\/?$/m.test(fs.readFileSync(path.join(tmp, ".git", "info", "exclude"), "utf8"))) throw new Error("git exclude entry not written");
  r = await request("POST", "http://x/api/dsh-v-explorer/snapshot", { sessionId: "s1", content: "   " });
  if (r.status !== 400) throw new Error("empty snapshot must 400, got " + r.status);
  r = await request("POST", "http://x/api/dsh-v-explorer/snapshot", { sessionId: "nope", content: "x" });
  if (r.status !== 404) throw new Error("snapshot unknown session must 404");

  /* pre-step 摘录捕获：直接用户消息里的 引用 token → 原消息后附加摘录上下文 */
  const preStep = (handlers["agent/pre-step"] || [])[0];
  if (!preStep) throw new Error("pre-step handler not registered");
  const agent = { session: { header: { cwd: tmp } } };
  const userMessage = {
    id: "m1",
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "看看 引用readme.md#1-1 这段" }]
  };
  const nextOk = async () => ({ kind: "enter", messages: [userMessage] });
  const decision = await preStep({ agent, signal: undefined }, nextOk);
  if (decision.messages.length !== 2) throw new Error("excerpt message not attached");
  if (decision.messages[0] !== userMessage) throw new Error("original message must stay untouched");
  const excerpt = decision.messages[1];
  if (excerpt.source.kind !== "dsh-v-excerpt" || excerpt.role !== "user") throw new Error("excerpt source malformed");
  if (!excerpt.content[0].text.includes("## 引用摘录")) throw new Error("excerpt header missing");
  if (!excerpt.content[0].text.includes("1: # hello")) throw new Error("excerpt body missing");
  if (!Object.isFrozen(excerpt) || !Object.isFrozen(excerpt.content)) throw new Error("excerpt must be frozen");

  /* 无引用消息原样通过（同一数组引用，零开销路径） */
  const plain = { id: "m2", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你好" }] };
  const d2 = await preStep({ agent, signal: undefined }, async () => ({ kind: "enter", messages: [plain] }));
  if (d2.messages.length !== 1) throw new Error("plain message must pass through");
  if (d2.messages[0] !== plain) throw new Error("plain message identity must be preserved");

  /* 非直接用户消息（注入上下文等）不解析引用 */
  const injected = { id: "m3", role: "user", source: { kind: "session-reference" }, content: [{ type: "text", text: "引用readme.md#1-1" }] };
  const d3 = await preStep({ agent, signal: undefined }, async () => ({ kind: "enter", messages: [injected] }));
  if (d3.messages.length !== 1 || d3.messages[0] !== injected) throw new Error("injected message must not be re-processed");

  /* 逃逸路径引用降级为错误说明，不失败整轮 */
  const escapeMsg = { id: "m4", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "引用..\\..\\etc\\passwd#1-2" }] };
  const d4 = await preStep({ agent, signal: undefined }, async () => ({ kind: "enter", messages: [escapeMsg] }));
  if (d4.messages.length !== 2) throw new Error("escape ref must still attach a context message");
  if (!d4.messages[1].content[0].text.includes("未捕获")) throw new Error("escape ref must degrade with a note");

  /* ---------- events：SSE（仅书签同步） ---------- */

  /* events：未知会话 → 404（json 短响应，request() 兼容） */
  r = await request("GET", "http://x/api/dsh-v-explorer/events?sessionId=nope");
  if (r.status !== 404) throw new Error("events unknown session must 404, got " + r.status);

  /* events：连接 → SSE 头 + retry 握手 */
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
      /* 等路由分支跑完（realpath 是真实线程池调用）再返回，否则 writeHead 尚未发生。 */
      Promise.resolve(handler(req, res)).then(() => resolvePromise({ res, writes }), reject);
    });
  }

  const stream = await openEventStream("s1");
  if (stream.res.status !== 200) throw new Error("events must 200, got " + stream.res.status);
  if (!String(stream.res.headers["content-type"]).includes("text/event-stream")) throw new Error("events content-type wrong");
  if (!stream.writes.some((w) => w.startsWith("retry:"))) throw new Error("events retry hint missing");

  /* 文件写入不再触发任何广播（fs-changed 已退役） */
  fs.writeFileSync(path.join(tmp, "watched.txt"), "hello\n");
  await new Promise((resolve2) => setTimeout(resolve2, 900));
  if (stream.writes.some((w) => w.includes("fs-changed"))) throw new Error("fs-changed must be retired");
  if (stream.writes.length !== 2) throw new Error("no data frames expected after handshake, got " + JSON.stringify(stream.writes));

  /* 书签加入 → 立即广播 bookmarks-changed */
  const writesBefore = stream.writes.length;
  r = await request("POST", "http://x/api/dsh-v-explorer/bookmark-add", { sessionId: "s1", path: "readme.md" });
  if (r.status !== 200 || r.body.ok !== true) throw new Error("bookmark-add failed: " + JSON.stringify(r.body));
  await new Promise((resolve2) => setTimeout(resolve2, 200));
  if (!stream.writes.slice(writesBefore).some((w) => w.includes("bookmarks-changed"))) {
    throw new Error("bookmarks-changed not broadcast: " + JSON.stringify(stream.writes));
  }

  /* 连接关闭 → 不再广播 */
  stream.res.closeHandler();
  const writesAfterClose = stream.writes.length;
  r = await request("POST", "http://x/api/dsh-v-explorer/bookmark-remove", { sessionId: "s1", path: "readme.md" });
  if (r.status !== 200) throw new Error("bookmark-remove failed");
  await new Promise((resolve2) => setTimeout(resolve2, 200));
  if (stream.writes.length !== writesAfterClose) throw new Error("closed connection still received events");

  /* ---------- 持久层兜底：重启窗口期 live store 查不到会话 ---------- */
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "dve-restore-"));
  fs.writeFileSync(path.join(tmp2, "restored.md"), "restored\n");
  /* 会话 s2 不在 live store（sessions.get 查不到），只在持久化快照 header 里。 */
  ctx.sessionPersistence = {
    listSnapshots: async () => [{ header: { id: "s2", cwd: tmp2 }, revision: 1 }]
  };
  r = await request("GET", "http://x/api/dsh-v-explorer/bookmarks?sessionId=s2");
  if (r.status !== 200) throw new Error("persisted cwd fallback failed: " + JSON.stringify(r.body));
  if (!Array.isArray(r.body.bookmarks)) throw new Error("persisted fallback wrong shape");

  /* /events 同样走兜底；live 与持久层都没有的会话仍 404 */
  const stream2 = await openEventStream("s2");
  if (stream2.res.status !== 200) throw new Error("events persisted fallback must 200, got " + String(stream2.res.status));
  stream2.res.closeHandler();
  r = await request("GET", "http://x/api/dsh-v-explorer/bookmarks?sessionId=nope2");
  if (r.status !== 404) throw new Error("unknown session (with persistence) must 404, got " + r.status);

  clearInterval(keepAlive);
  console.log("\nALL HOST SMOKE TESTS PASSED");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
