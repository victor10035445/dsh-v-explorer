/**
 * dsh-v-explorer — 宿主端（官方侧栏接管形态）。
 *
 * 目录列表/文件读取已由官方 workspaceFiles Remote 承担（GET /list、GET /file
 * 与 fs.watch + fs-changed SSE 在 change official-sidebar-adoption 中退役）。
 * 保留的路由（全部限定在会话工作目录内）：
 *  - POST /api/dsh-v-explorer/open  {sessionId,path}  在系统文件管理器中打开所在目录
 *  - POST /api/dsh-v-explorer/open-browser {sessionId,path}  用默认浏览器打开 html
 *    文件（转成 file 协议 URL；仅 .html/.htm/.xhtml）
 *  - POST /api/dsh-v-explorer/snapshot {sessionId,content}  把会话选区物化为
 *    .dsh-v-explorer/refs/ 下的快照文本文件（会话内容没有文件身份，引用需要可指的路径）
 *  - GET  /api/dsh-v-explorer/bookmarks?sessionId=   书签列表：cwd 内
 *    .dsh-v-explorer/bookmarks.json（读失败按空降级）+ 逐条 stat 标注 exists/isDir
 *  - POST /api/dsh-v-explorer/bookmark-add {sessionId,path}    加入书签
 *    （containedPath 双重校验、归一化去重幂等、上限 100，响应体携带更新后的列表）
 *  - POST /api/dsh-v-explorer/bookmark-remove {sessionId,path} 移除书签（幂等，
 *    响应体携带更新后的列表）
 *  - GET  /api/dsh-v-explorer/events?sessionId=  SSE：书签增删广播
 *    {type:"bookmarks-changed"}（多标签页同步；连接归零即释放，插件卸载统一清理）
 *
 * cwd 解析：优先 live 会话 header；重启后 live store 尚未恢复该会话时，回退到
 * 持久化快照 header（sessionPersistence.listSnapshots，正结果按 id 缓存——会话
 * cwd 与 id 绑定不可变）。客户端对「会话未就绪」404 另有退避重试兜底。
 *
 * 「引用」摘录解析器（对齐官方 dsh-session-reference 的 pre-step 形态）：
 * 监听 agent/pre-step，在消息进入模型步骤的时刻解析直接用户消息里的
 * 引用<路径>#起-止 token，此刻读文件切片，把摘录作为独立的 user 角色上下文
 * 消息插在引用者紧后——捕获即定格，之后原文如何变化与本条请求无关。
 * 摘录失败只降级为摘录消息里的错误说明，绝不失败整轮。
 *
 * 安全边界：所有路径先 resolve 到会话 cwd，再对两侧做 realpath 包含校验，
 * 逃出工作目录一律 403；摘录读取有 10MB 上限与二进制检测。
 */

import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, realpath, writeFile } from "node:fs/promises";
import { resolve as pathResolve, sep, dirname, extname, isAbsolute } from "node:path";
import {
  parseRefTokens,
  buildExcerptPrompt,
  EXCERPT_PROMPT_SECTION,
  MAX_REFS_PER_MESSAGE
} from "./ref-shared.js";

export const name = "dsh-v-explorer";

/* agents：installExcerptGuidance 需要遍历存量 agent（ctx.agents.list()）；
   sessionPersistence：重启窗口期兜底要调 listSnapshots()（persistedSessionCwd）。
   cordis 的 Context 代理对未在 inject 中声明的服务取值直接抛
   "cannot get property ... without inject"，可选链也拦不住（getter 同步 throw）——
   漏声明一条，对应访问点就会静默退化为「服务不存在」（0.3.0 的快照兜底即栽于此，
   见 persistedSessionCwd）。 */
export const inject = ["webServer", "sessions", "agents", "sessionPersistence"];

const API_PREFIX = "/api/dsh-v-explorer";
/** 单文件读取上限：10MB（「引用」摘录捕获用）。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 允许「用默认浏览器打开」的扩展名（html 族；预览浮窗不渲染 html）。 */
const BROWSABLE_EXT = new Set(["html", "htm", "xhtml"]);
/** 书签存储：格式版本与容量上限（超限 413）。 */
const BOOKMARKS_VERSION = 1;
const MAX_BOOKMARKS = 100;
const BOOKMARKS_FILE = ".dsh-v-explorer/bookmarks.json";

/** JSON 响应。 */
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 读取并解析 JSON 请求体（空/坏体返回 {}）。 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 会话工作目录；无会话或解析失败返回 null。 */
function sessionCwd(ctx, sessionId) {
  if (!sessionId) return null;
  try {
    const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd;
    if (typeof headerCwd === "string" && headerCwd) return headerCwd;
  } catch {
    /* 会话不存在等情况 */
  }
  return null;
}

/* 重启窗口期兜底：SessionStore 只持有 live 会话，而会话是懒恢复的——页面先于
 * 恢复发起请求时 sessions.get 查不到（404 session not found）。持久化 backend
 * 的 header 记着同一个 cwd（会话 cwd 与 id 绑定、不可变），按 id 兜底并缓存
 * 正结果。sessionPersistence 必须在顶部 inject 中声明（cordis Context 代理对
 * 未声明服务取值即同步抛——0.3.0 因漏声明导致本兜底永不生效，冷会话一律 404）；
 * 未注册该服务的宿主里仍会抛——整体 try/catch 按未找到处理。 */
const persistedCwdCache = new Map();

async function persistedSessionCwd(ctx, sessionId) {
  if (!sessionId) return null;
  const cached = persistedCwdCache.get(sessionId);
  if (cached !== undefined) return cached;
  try {
    const snapshots = await ctx.sessionPersistence?.listSnapshots?.();
    const hit = (snapshots ?? []).find((snapshot) => snapshot?.header?.id === sessionId);
    if (typeof hit?.header?.cwd === "string" && hit.header.cwd) {
      persistedCwdCache.set(sessionId, hit.header.cwd);
      return hit.header.cwd;
    }
  } catch {
    /* 服务缺失/后端故障：回退为未找到 */
  }
  return null;
}

/**
 * 把客户端相对路径安全解析到 cwd 内：先按词法 resolve 拒绝 `..` 逃逸，
 * 再对两侧 realpath，防符号链接穿越。返回绝对路径。
 * 词法逃逸/绝对路径抛 "escapes"/"absolute"（映射 403）；不存在抛 ENOENT（404）。
 */
async function containedPath(cwd, rel) {
  if (rel !== undefined && rel !== "" && typeof rel !== "string") throw new Error("bad path");
  if (rel !== undefined && rel !== "" && isAbsolute(rel)) throw new Error("absolute paths are not allowed");
  const withSep = (p) => (p.endsWith(sep) ? p : p + sep);
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

  /* 第一道：词法包含（相对原始 cwd，防 `..` 序列） */
  const lexicon = pathResolve(cwd, rel === undefined || rel === "" ? "." : rel);
  const lex = norm(lexicon);
  const cwdNorm = norm(cwd);
  if (lex !== cwdNorm && !lex.startsWith(withSep(cwdNorm))) throw new Error("path escapes the session workspace");

  /* 第二道：realpath 包含（防符号链接把路径引出工作目录） */
  const realCwd = await realpath(cwd);
  const realTarget = await realpath(lexicon);
  const target = norm(realTarget);
  const realCwdNorm = norm(realCwd);
  if (target !== realCwdNorm && !target.startsWith(withSep(realCwdNorm))) throw new Error("path escapes the session workspace");
  return realTarget;
}

/** 读文本文件（上限 + 二进制检测）——「引用」摘录捕获专用。 */
async function readTextFile(abs) {
  const s = await stat(abs);
  if (s.isDirectory()) throw new Error("is a directory");
  const size = s.size;
  const cap = Math.min(size, MAX_FILE_BYTES);
  const handle = await import("node:fs/promises").then((m) => m.open(abs, "r"));
  try {
    const buf = Buffer.alloc(cap);
    await handle.read(buf, 0, cap, 0);
    if (buf.subarray(0, Math.min(cap, 8192)).includes(0)) {
      return { content: null, binary: true, size, truncated: false };
    }
    return { content: buf.toString("utf8"), binary: false, size, truncated: size > cap };
  } finally {
    await handle.close();
  }
}

/** 递归深冻结：手工构造的上下文消息与官方 createUserMessage 同为不可变形态。 */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * 解析单条引用 → 摘录条目。任何失败都降级为带 error 说明的条目，
 * 绝不向上抛——摘录是引文，失败不该失败整轮。
 */
async function excerptEntry(cwd, tk) {
  try {
    const rel = tk.path.replace(/\\/g, "/");
    const abs = await containedPath(cwd, rel);
    const { content, binary } = await readTextFile(abs);
    if (binary) return { tk, ok: false, error: "二进制文件，无法摘录" };
    return { tk, ok: true, content };
  } catch (error) {
    const message = String(error?.message || error);
    return { tk, ok: false, error: message.includes("escapes") || message.includes("absolute") ? "路径越出会话工作目录" : message };
  }
}

/**
 * pre-step 消息变换：扫直接用户消息里的 引用 token，此刻捕获摘录，
 * 返回 [原消息, 摘录上下文消息]；无引用或出错时原样返回。
 */
async function attachExcerpts(agent, messages) {
  const cwd = agent?.session?.header?.cwd;
  if (!cwd || !Array.isArray(messages)) return messages;
  let changed = false;
  const out = [];
  for (const message of messages) {
    out.push(message);
    if (changed || message?.source?.kind !== "user" || !Array.isArray(message?.content)) continue;
    const refs = [];
    for (const block of message.content) {
      if (block?.type === "text" && typeof block.text === "string") refs.push(...parseRefTokens(block.text));
    }
    if (refs.length === 0) continue;
    changed = true;
    /* 去重（同路径同区间只捕获一次），超上限的只计数 */
    const seen = new Set();
    const unique = [];
    for (const tk of refs) {
      const key = tk.path + "#" + tk.start.line + ":" + tk.start.col + "-" + tk.end.line + ":" + tk.end.col;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(tk);
    }
    const expand = unique.slice(0, MAX_REFS_PER_MESSAGE);
    const skipped = unique.length - expand.length;
    const entries = [];
    for (const tk of expand) entries.push(await excerptEntry(cwd, tk));
    const prompt = buildExcerptPrompt(entries, skipped);
    if (prompt === null) continue;
    out.push(deepFreeze({
      id: randomUUID(),
      role: "user",
      source: {
        kind: "dsh-v-excerpt",
        version: 1,
        refs: entries.map((e) => ({ raw: e.tk.raw, ok: e.ok, ...(e.ok ? {} : { error: e.error }) }))
      },
      content: [{ type: "text", text: prompt }]
    }));
  }
  return changed ? out : messages;
}

/* ------------------------------------------------------------------ *
 * 「引用」语法指引：给每个 agent 注入一段稳定的 system prompt 段
 * （形态照搬官方 dsh-file-reference-local；仅在 read 工具存在时给出文本）。
 * ------------------------------------------------------------------ */

function installExcerptGuidance(ctx) {
  if (typeof ctx.on !== "function") return; // 极简 mock/嵌入环境：无事件总线则跳过
  const fibers = new WeakMap();
  const install = (agent) => {
    if (!agent || fibers.has(agent)) return;
    try {
      fibers.set(agent, agent.ctx.inject(["systemPrompt", "tools"], (scope) => {
        scope.systemPrompt.section({
          name: "context:dsh-v-excerpt",
          order: 100,
          text: () => (agent.ctx.tools?.get?.("read", agent) === undefined ? "" : EXCERPT_PROMPT_SECTION)
        });
      }));
    } catch (error) {
      console.warn("[dsh-v-explorer] excerpt guidance install failed:", String(error?.message || error));
    }
  };
  for (const agent of ctx.agents?.list?.() ?? []) install(agent);
  ctx.on("agent/created", ({ agent }) => install(agent));
  ctx.on("agent/disposed", ({ agent }) => {
    fibers.get(agent)?.();
    fibers.delete(agent);
  });
}

/**
 * 在系统文件管理器中打开文件所在目录并选中（跨平台）。
 *
 * Windows 注意：`explorer /select,路径` 的无引号形式不可靠——路径含空格时
 * explorer 会把空格后的部分当独立参数而静默失败。可靠形态是 shell exec 的
 * 引号形式 `/select,"路径"`（引号在 Windows 路径里是保留字符，无需转义）。
 */
function revealInFileManager(abs) {
  return new Promise((resolvePromise) => {
    const done = () => resolvePromise(true);
    const fail = () => resolvePromise(false);
    if (process.platform === "win32") {
      const safe = abs.replace(/"/g, "");
      /* explorer 退出码无意义（成功也常为 1），短延迟后即视为已发起；
         仅在进程根本无法启动时退化。 */
      const child = exec(`explorer /select,"${safe}"`, { windowsHide: true }, () => {});
      child.on("error", () => {
        const fallback = exec(`explorer "${dirname(safe)}"`, { windowsHide: true }, () => {});
        fallback.on("error", fail);
        setTimeout(done, 800).unref?.();
      });
      setTimeout(done, 800).unref?.();
    } else if (process.platform === "darwin") {
      execFile("open", ["-R", abs], { windowsHide: true }, (err) => (err ? fail() : done()));
    } else {
      execFile("xdg-open", [dirname(abs)], { windowsHide: true }, (err) => (err ? fail() : done()));
    }
  });
}

/**
 * 绝对路径 → file 协议 URL（跨平台）：
 *  - POSIX /home/u/a b.html → file:///home/u/a%20b.html
 *  - Win   C:\u\a b.html    → file:///C:/u/a%20b.html
 * 逐段 encodeURIComponent（空格 / # / ? / & 等全部转义，URL 内不会再出现
 * shell 元字符），盘符冒号（%3A）还原为 ":"——file URL 路径段里冒号合法。
 */
function toFileUrl(abs) {
  const segments = pathResolve(abs)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"));
  return "file:///" + segments.join("/");
}

/** 用系统默认浏览器打开 file URL（跨平台；URL 已转义无空格/元字符）。 */
function openInBrowser(abs) {
  const url = toFileUrl(abs);
  return new Promise((resolvePromise) => {
    const done = () => resolvePromise(true);
    const fail = () => resolvePromise(false);
    if (process.platform === "win32") {
      /* start 的首个引号参数是窗口标题，必须占位 ""；失败时退回 rundll32
         的 FileProtocolHandler（同样走默认浏览器关联）。 */
      const child = exec(`start "" "${url}"`, { windowsHide: true }, () => {});
      child.on("error", () => {
        const fallback = exec(`rundll32 url.dll,FileProtocolHandler "${url}"`, { windowsHide: true }, () => {});
        fallback.on("error", fail);
        setTimeout(done, 800).unref?.();
      });
      setTimeout(done, 800).unref?.();
    } else if (process.platform === "darwin") {
      execFile("open", [url], { windowsHide: true }, (err) => (err ? fail() : done()));
    } else {
      execFile("xdg-open", [url], { windowsHide: true }, (err) => (err ? fail() : done()));
    }
  });
}

/* ------------------------------------------------------------------ *
 * 书签存储：<cwd>/.dsh-v-explorer/bookmarks.json
 * （{version:1, bookmarks:[{path, addedAt}]}，平铺数组、插入顺序即显示顺序）
 *  - 读失败（缺失/损坏）按空书签列表降级，查询路由不得 5xx
 *  - 写失败向调用方报错（只失败该请求，绝不以假成功响应、不外溢其它路由）
 *  - 同 cwd 的写操作（add/remove）经每 cwd 队列串行化（promise 链），
 *    并发的读-改-写不互吞条目
 *  - 文件 version 大于本实现支持版本：查询 best-effort 兼容返回（未知字段
 *    忽略不写回），增删 409 拒写——防止本版本把未来格式降级覆写
 *  - 写入时确保插件数据目录对用户项目的 git 完全隐身：写 <cwd>/.git/info/exclude
 *    （仓库本地排除，见 ensureGitExcluded），而非数据目录内的 .gitignore
 * ------------------------------------------------------------------ */

/** 路径比较键：win32 文件系统大小写不敏感。 */
function pathKey(abs) {
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * 书签去重键集合：词法解析形态 + realpath 归一化形态（目标存在时）。
 * 去重比较一律用归一化形态——win32 下 `Src` 与 `src` 不产生双份书签，
 * 符号链接与其真实路径也视作同一条目；存储仍保留客户端的词法 rel（显示友好）。
 */
async function bookmarkKeys(cwd, rel) {
  const abs = pathResolve(cwd, rel);
  const keys = new Set([pathKey(abs)]);
  try {
    keys.add(pathKey(await realpath(abs)));
  } catch {
    /* 目标已不存在：只有词法键可用（失效书签仍可被精确移除） */
  }
  return keys;
}

/** 读书签文件；缺失/损坏按空降级（查询不 5xx）。无效条目过滤，未知字段忽略。 */
async function loadBookmarks(cwd) {
  try {
    const parsed = JSON.parse(await readFile(pathResolve(cwd, BOOKMARKS_FILE), "utf8"));
    return {
      version: typeof parsed?.version === "number" ? parsed.version : BOOKMARKS_VERSION,
      bookmarks: (Array.isArray(parsed?.bookmarks) ? parsed.bookmarks : []).filter(
        (b) => b && typeof b.path === "string" && b.path
      )
    };
  } catch {
    return { version: BOOKMARKS_VERSION, bookmarks: [] };
  }
}

/**
 * 确保插件数据目录 .dsh-v-explorer/ 对用户项目的 git 完全隐身。
 *
 * 写 <cwd>/.git/info/exclude（仓库本地排除文件）：它天然不入库、不出现在
 * git status，也零改动用户工作区文件——比往用户 .gitignore 里追加（会弄脏
 * 可能已跟踪的文件）或写数据目录内的 .gitignore（会让目录本身在 status 里
 * 露头）都干净。每个用户的 clone 在首次书签/快照写入时自动补齐，天然自愈。
 *
 *  - 仅当 <cwd> 自身是 git 仓库（.git 存在；worktree/submodule 的 .git 为
 *    指向 gitdir 的文件，同样支持）时操作；cwd 是仓库子目录的情况跳过
 *  - 幂等：exclude 已含条目即跳过，不重复追加
 *  - 全程失败静默——隐身失败只影响 git status 观感，绝不影响书签/快照主流程
 */
async function ensureGitExcluded(cwd) {
  try {
    const dotGit = pathResolve(cwd, ".git");
    const dotGitStat = await stat(dotGit);
    let gitDir = dotGit;
    if (!dotGitStat.isDirectory()) {
      /* worktree/submodule：.git 是文本文件，内容 "gitdir: <路径>" */
      const pointer = await readFile(dotGit, "utf8");
      const target = /^gitdir:\s*(.+)\s*$/m.exec(pointer)?.[1];
      if (!target) return;
      gitDir = pathResolve(cwd, target);
    }
    const excludePath = pathResolve(gitDir, "info", "exclude");
    let text = "";
    try {
      text = await readFile(excludePath, "utf8");
    } catch {
      /* 无 exclude 文件：新建（info/ 目录可能也缺，下方 mkdir 兜住） */
    }
    if (/^\.dsh-v-explorer\/?$/m.test(text)) return; // 已排除：幂等跳过
    await mkdir(pathResolve(gitDir, "info"), { recursive: true });
    const prefix = text && !text.endsWith("\n") ? "\n" : "";
    await writeFile(
      excludePath,
      text + prefix + "# dsh-v-explorer plugin data (bookmarks / ref snapshots)\n.dsh-v-explorer/\n"
    ).catch(() => {});
  } catch {
    /* 非 git 目录 / .git 不可写 / 指针格式异常：静默放弃 */
  }
}

/** 写书签文件（先确保 .dsh-v-explorer/ 目录与 git 隐身）。写失败向上抛给调用方。 */
async function saveBookmarks(cwd, bookmarks) {
  const dataDir = pathResolve(cwd, ".dsh-v-explorer");
  await mkdir(dataDir, { recursive: true });
  await ensureGitExcluded(cwd);
  await writeFile(
    pathResolve(cwd, BOOKMARKS_FILE),
    JSON.stringify({ version: BOOKMARKS_VERSION, bookmarks }, null, 2) + "\n",
    "utf8"
  );
}

/** 每 cwd 写队列：读-改-写整段入队串行化。返回的 promise 带出任务结果/异常
 *  （写失败必须向调用方报错），队列尾部吞掉异常保证后续写不被阻塞。 */
const bookmarkWriteQueues = new Map();

function enqueueBookmarkWrite(cwd, task) {
  const tail = bookmarkWriteQueues.get(cwd) ?? Promise.resolve();
  const run = tail.then(task, task);
  bookmarkWriteQueues.set(cwd, run.then(() => {}, () => {}));
  return run;
}

/** 逐条 stat 标注 exists/isDir（书签上限内有界）。失效书签保留并标记，绝不清理。 */
async function annotateBookmarks(cwd, bookmarks) {
  const out = [];
  for (const b of bookmarks) {
    let exists = false;
    let isDir = false;
    try {
      isDir = (await stat(pathResolve(cwd, b.path))).isDirectory();
      exists = true;
    } catch {
      /* 失效：exists:false（删除/移动后保留标记，目标恢复即自动摘标） */
    }
    out.push({ path: b.path, addedAt: b.addedAt, exists, isDir });
  }
  return out;
}

/** 词法包含预检（不碰文件系统，镜像 containedPath 的第一道）：`..` 逃逸或
 *  绝对路径返回 true。bookmark-add 用它把「越界 403」排在「隐藏段 400」之前，
 *  让 `../outside` → 403 与 `.dsh-v-explorer/…`（无论是否存在）→ 400 两个语义各自成立，
 *  且不借 stat 泄露隐藏路径的存在性。 */
function lexicallyEscapes(cwd, rel) {
  const withSep = (p) => (p.endsWith(sep) ? p : p + sep);
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const lex = norm(pathResolve(cwd, rel));
  const cwdNorm = norm(cwd);
  return lex !== cwdNorm && !lex.startsWith(withSep(cwdNorm));
}

/** 隐藏路径段：任一路径段以 `.` 开头（`..`、`.dsh-v-explorer/…`、`sub/.h.txt` 均命中）。
 *  与树的隐藏过滤一致——explorer 产生不了这种书签，API 也不放行。 */
function hasHiddenSegment(rel) {
  return rel.split(process.platform === "win32" ? /[\\/]/ : "/").some((seg) => seg.startsWith("."));
}

/* ------------------------------------------------------------------ *
 * SSE 连接登记：只承载书签多标签页同步（bookmarks-changed）。目录文件
 * 变更推送（fs.watch + fs-changed）已退役——变更感知由官方 workspaceFiles
 * Remote 的 changes 流承担。
 * ------------------------------------------------------------------ */

/** cwd realpath → 该目录上的 SSE 连接集合。 */
const sseConnections = new Map();

/** 向挂在某 cwd 上的全部连接广播一次 bookmarks-changed。 */
function broadcastChanged(cwdReal) {
  const connections = sseConnections.get(cwdReal);
  if (!connections) return;
  const line = "data: " + JSON.stringify({ type: "bookmarks-changed" }) + "\n\n";
  for (const res of connections) {
    try {
      res.write(line);
    } catch {
      /* 写失败由 close 事件统一清理 */
    }
  }
}

/** 挂载一条 SSE 连接；返回连接清理函数。 */
function connectEvents(res, cwdReal) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive"
  });
  res.write("retry: 3000\n\n"); // 断线后 EventSource 的重连间隔
  res.write(": connected\n\n");
  let connections = sseConnections.get(cwdReal);
  if (!connections) {
    connections = new Set();
    sseConnections.set(cwdReal, connections);
  }
  connections.add(res);
  return () => {
    const set = sseConnections.get(cwdReal);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) sseConnections.delete(cwdReal);
  };
}

/** 插件主体：注册 /api/dsh-v-explorer 前缀路由 + 「引用」摘录解析器。 */
export function apply(ctx) {
  /* 「引用」语法指引：每个 agent 的 system prompt 稳定段。 */
  installExcerptGuidance(ctx);

  /* pre-step 捕获：消息进入模型步骤的时刻，解析引用 token 并附摘录上下文。
     形态对齐官方 dsh-session-reference（prepend + next() 后变换消息批次）；
     任何异常都只记录不传播——摘录失败不失败整轮。 */
  ctx.effect(() => ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision?.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    if (signal?.aborted) return decision;
    try {
      const messages = await attachExcerpts(agent, decision.messages);
      return messages === decision.messages ? decision : { ...decision, messages };
    } catch (error) {
      console.warn("[dsh-v-explorer] excerpt capture failed:", String(error?.message || error));
      return decision;
    }
  }, { prepend: true }), "dsh-v-explorer: pre-step excerpt capture");

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: API_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const route = url.pathname.slice(API_PREFIX.length) || "/";
        try {
          if (req.method !== "GET" && req.method !== "POST") {
            json(res, 405, { error: "method not allowed" });
            return;
          }

          /* ── 打开所在目录 ── */
          if (route === "/open" && req.method === "POST") {
            const body = await readJsonBody(req);
            const cwd = sessionCwd(ctx, body.sessionId) ?? (await persistedSessionCwd(ctx, body.sessionId));
            if (!cwd) {
              json(res, 404, { error: "session not found or has no cwd" });
              return;
            }
            const abs = await containedPath(cwd, typeof body.path === "string" ? body.path : "");
            const ok = await revealInFileManager(abs);
            json(res, ok ? 200 : 500, { ok, path: abs });
            return;
          }

          /* ── 用默认浏览器打开（file 协议；仅 html 族） ── */
          if (route === "/open-browser" && req.method === "POST") {
            const body = await readJsonBody(req);
            const cwd = sessionCwd(ctx, body.sessionId) ?? (await persistedSessionCwd(ctx, body.sessionId));
            if (!cwd) {
              json(res, 404, { error: "session not found or has no cwd" });
              return;
            }
            const abs = await containedPath(cwd, typeof body.path === "string" ? body.path : "");
            if ((await stat(abs)).isDirectory()) {
              json(res, 400, { error: "not a file" });
              return;
            }
            if (!BROWSABLE_EXT.has(extname(abs).slice(1).toLowerCase())) {
              json(res, 400, { error: "only .html/.htm/.xhtml can be opened in a browser" });
              return;
            }
            const ok = await openInBrowser(abs);
            json(res, ok ? 200 : 500, { ok, url: toFileUrl(abs), path: abs });
            return;
          }

          /* ── 会话选区快照：把选中文本物化为 .dsh-v-explorer/refs/ 下的引用目标 ── */
          if (route === "/snapshot" && req.method === "POST") {
            const body = await readJsonBody(req);
            const cwd = sessionCwd(ctx, body.sessionId) ?? (await persistedSessionCwd(ctx, body.sessionId));
            if (!cwd) {
              json(res, 404, { error: "session not found or has no cwd" });
              return;
            }
            const content = typeof body.content === "string" ? body.content : "";
            if (!content.trim()) {
              json(res, 400, { error: "empty snapshot content" });
              return;
            }
            if (content.length > MAX_FILE_BYTES) {
              json(res, 413, { error: "snapshot content too large" });
              return;
            }
            /* .dsh-v-explorer/refs/ 固定在 cwd 内（路径由服务端构造，不经客户端输入）；
               ensureGitExcluded 让整个数据目录对 git 隐身。 */
            const refsDir = pathResolve(cwd, ".dsh-v-explorer", "refs");
            await mkdir(refsDir, { recursive: true });
            await ensureGitExcluded(cwd);
            const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
            const name = "ref-" + stamp + "-" + Math.random().toString(36).slice(2, 6) + ".txt";
            const abs = pathResolve(refsDir, name);
            await writeFile(abs, content, "utf8");
            const rel = ".dsh-v-explorer/refs/" + name;
            await containedPath(cwd, rel); // 防御性自检：产物必须仍在 cwd 内
            const lines = content.split("\n").length;
            json(res, 200, { path: rel, lines, bytes: Buffer.byteLength(content, "utf8") });
            return;
          }

          /* ── 书签查询：.dsh-v-explorer/bookmarks.json + 逐条 exists/isDir 标注（读失败按空降级，
                未来版本 best-effort 兼容：忽略未知字段照常返回） ── */
          if (route === "/bookmarks" && req.method === "GET") {
            const cwd = sessionCwd(ctx, url.searchParams.get("sessionId")) ?? (await persistedSessionCwd(ctx, url.searchParams.get("sessionId")));
            if (!cwd) {
              json(res, 404, { error: "session not found or has no cwd" });
              return;
            }
            const { bookmarks } = await loadBookmarks(cwd);
            json(res, 200, { cwd, bookmarks: await annotateBookmarks(cwd, bookmarks) });
            return;
          }

          /* ── 加入书签。校验顺序即 spec 语义：
                1) 非空字符串、非 `.`（工作区根）→ 400
                2) 词法逃逸 / 绝对路径 → 403（../outside 先于隐藏段报告）
                3) 任一路径段以 `.` 开头 → 400（缺失也不泄露存在性）
                4) containedPath 双重校验 → 403（符号链接逃逸）/ 404（不存在）
              写经每 cwd 队列串行化；归一化去重幂等；上限 413；成功广播 bookmarks-changed ── */
          if (route === "/bookmark-add" && req.method === "POST") {
            const body = await readJsonBody(req);
            const cwd = sessionCwd(ctx, body.sessionId) ?? (await persistedSessionCwd(ctx, body.sessionId));
            if (!cwd) {
              json(res, 404, { error: "session not found or has no cwd" });
              return;
            }
            const rel = body.path;
            if (typeof rel !== "string" || !rel.trim() || rel === ".") {
              json(res, 400, { error: "bookmark path must be a non-empty relative path" });
              return;
            }
            if (isAbsolute(rel)) throw new Error("absolute paths are not allowed");
            if (lexicallyEscapes(cwd, rel)) throw new Error("path escapes the session workspace");
            if (hasHiddenSegment(rel)) {
              json(res, 400, { error: "bookmark path contains hidden path segments" });
              return;
            }
            const realTarget = await containedPath(cwd, rel); // 符号链接逃逸 403 / 不存在 404
            const result = await enqueueBookmarkWrite(cwd, async () => {
              const { version, bookmarks } = await loadBookmarks(cwd);
              if (version > BOOKMARKS_VERSION) return { conflict: true };
              const incoming = await bookmarkKeys(cwd, rel);
              incoming.add(pathKey(realTarget));
              for (const b of bookmarks) {
                let dup = false;
                for (const key of await bookmarkKeys(cwd, b.path)) {
                  if (incoming.has(key)) {
                    dup = true;
                    break;
                  }
                }
                if (dup) return { bookmarks: await annotateBookmarks(cwd, bookmarks) }; // 幂等：重复加入 no-op
              }
              if (bookmarks.length >= MAX_BOOKMARKS) return { limit: true };
              bookmarks.push({ path: rel, addedAt: new Date().toISOString() });
              await saveBookmarks(cwd, bookmarks); // 写失败向上抛 → 该请求报错，不假成功
              return { bookmarks: await annotateBookmarks(cwd, bookmarks), added: true };
            });
            if (result.conflict) {
              json(res, 409, { error: "bookmarks file version is newer than supported; refusing to write" });
              return;
            }
            if (result.limit) {
              json(res, 413, { error: "bookmark limit reached (" + MAX_BOOKMARKS + ")" });
              return;
            }
            if (result.added) {
              try {
                broadcastChanged(await realpath(cwd));
              } catch {
                /* 广播失败不影响响应 */
              }
            }
            json(res, 200, { ok: true, bookmarks: result.bookmarks });
            return;
          }

          /* ── 移除书签：幂等（不存在也 200 且不广播）；响应体携带更新后的书签数组；
                实际移除后广播 bookmarks-changed。不校验目标存在性——失效书签必须可移除 ── */
          if (route === "/bookmark-remove" && req.method === "POST") {
            const body = await readJsonBody(req);
            const cwd = sessionCwd(ctx, body.sessionId) ?? (await persistedSessionCwd(ctx, body.sessionId));
            if (!cwd) {
              json(res, 404, { error: "session not found or has no cwd" });
              return;
            }
            if (typeof body.path !== "string") {
              json(res, 400, { error: "bad path" });
              return;
            }
            const result = await enqueueBookmarkWrite(cwd, async () => {
              const { version, bookmarks } = await loadBookmarks(cwd);
              if (version > BOOKMARKS_VERSION) return { conflict: true };
              if (!body.path) return { bookmarks: await annotateBookmarks(cwd, bookmarks), removed: false };
              const incoming = await bookmarkKeys(cwd, body.path);
              const remaining = [];
              let removed = false;
              for (const b of bookmarks) {
                let hit = false;
                for (const key of await bookmarkKeys(cwd, b.path)) {
                  if (incoming.has(key)) {
                    hit = true;
                    break;
                  }
                }
                if (hit) removed = true;
                else remaining.push(b);
              }
              if (removed) {
                await saveBookmarks(cwd, remaining);
                return { bookmarks: await annotateBookmarks(cwd, remaining), removed: true };
              }
              return { bookmarks: await annotateBookmarks(cwd, bookmarks), removed: false };
            });
            if (result.conflict) {
              json(res, 409, { error: "bookmarks file version is newer than supported; refusing to write" });
              return;
            }
            if (result.removed) {
              try {
                broadcastChanged(await realpath(cwd));
              } catch {
                /* 广播失败不影响响应 */
              }
            }
            json(res, 200, { ok: true, bookmarks: result.bookmarks });
            return;
          }

          /* ── SSE：书签多标签页同步（长连接，不 end） ── */
          if (route === "/events" && req.method === "GET") {
            const cwd = sessionCwd(ctx, url.searchParams.get("sessionId")) ?? (await persistedSessionCwd(ctx, url.searchParams.get("sessionId")));
            if (!cwd) {
              json(res, 404, { error: "session not found or has no cwd" });
              return;
            }
            let cwdReal;
            try {
              cwdReal = await realpath(cwd);
            } catch (error) {
              json(res, 404, { error: "cwd not found: " + String(error?.message || error) });
              return;
            }
            const disconnect = connectEvents(res, cwdReal);
            res.on("close", disconnect);
            return;
          }

          json(res, 404, { error: "unknown route" });
        } catch (error) {
          const message = String(error?.message || error);
          if (error?.code === "ENOENT") json(res, 404, { error: "not found: " + message });
          else if (message.includes("escapes") || message.includes("absolute")) json(res, 403, { error: message });
          else json(res, 400, { error: message });
        }
      }
    });
    return () => {
      dispose();
      /* 断开全部 SSE 连接（插件卸载/重载）。 */
      for (const connections of sseConnections.values()) {
        for (const res of connections) {
          try {
            res.end();
          } catch {
            /* 已断开 */
          }
        }
      }
      sseConnections.clear();
    };
  }, "dsh-v-explorer: api routes");
}
