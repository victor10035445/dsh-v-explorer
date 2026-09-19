/**
 * chips.jsx — composer 输入栏的引用 chip 条（conversation.input.dock，保留项）。
 *
 * 变化（specs/composer-integration）：chip 点击由旧「开浮窗定位」改为官方
 * openResource——ctx.sidebarRight.openResource(fileAddressFor(...), {params:
 * {line}})，行号导航由 Reader Pro 渲染器消费；降级（服务缺失/动作失败）退为
 * 复制引用文本并提示。
 *
 * 校验变化：旧实现拉 /file 全文做行数校验——/file 已退役。改用
 * remote.workspaceFiles.read 按需读目标行区间（offset 起始、limit 行数），
 * RemoteFailure 即无效 chip（删除线），同时该结果直接供悬停摘录卡。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { parseRefTokens } from "./ref-shared.mjs";
import { inputFacade, readDraft, writeDraft, ctxRef } from "./input-facade.mjs";
import { copyText } from "./api.mjs";
import { uiBus } from "./ui-bus.jsx";
import { services } from "./services.mjs";
import { fileAddressFor, joinWorkspacePath } from "./workspace-path.mjs";

/** 悬停/校验读出的区间行集：绝对行号自算（range 读的行窗从 1 计数）。 */
function rangeLinesOf(text, start, end) {
  const raw = String(text ?? "").split("\n");
  const lines = [];
  for (let i = 0; i < raw.length && start.line + i <= end.line; i++) {
    lines.push({ n: start.line + i, t: raw[i] });
  }
  return lines;
}

/** 读目标行区间；失败语义交给 Remote 失败。返回 {lines, eof}。 */
async function readRange(sessionId, cwd, rel, start, end) {
  const remote = ctxRef.current?.remote?.workspaceFiles;
  if (!remote) throw new Error("remote unavailable");
  const abs = joinWorkspacePath(cwd, rel);
  const limit = Math.max(1, end.line - start.line + 1);
  const result = await remote.read(sessionId, abs, { offset: start.line - 1, limit });
  if (!result.ok) {
    const failure = result.error ?? {};
    const error = new Error(failure.message ?? failure.code ?? "read failed");
    error.code = failure.code;
    throw error;
  }
  const text = result.value?.text ?? "";
  const eof = result.value?.eof !== false;
  const lines = rangeLinesOf(text, start, end);
  if (lines.length === 0 && eof && !text) {
    const error = new Error("line out of range");
    error.code = "workspace-file/line-out-of-range";
    throw error;
  }
  return { lines, eof };
}

/** 文件行数为 0（空文件/目录）时补一次 stat 判定（目录引用无效）。 */
async function isDirectory(sessionId, cwd, rel) {
  try {
    const result = await ctxRef.current?.remote?.workspaceFiles?.stat(sessionId, joinWorkspacePath(cwd, rel));
    return result?.ok ? result.value?.type === "directory" : false;
  } catch {
    return false;
  }
}

export function RefChipBar({ sessionId }) {
  const t = services.t;
  const [draft, setDraft] = useState("");
  /** path → {ok, text?, total?, reason?, dir?}，按会话缓存。 */
  const cacheRef = useRef(new Map());
  const [, bumpValidity] = useState(0);
  const [pop, setPop] = useState(null); // {x, bottom, lines}

  useEffect(() => {
    const facade = inputFacade(ctxRef.current, sessionId);
    if (facade === null) return undefined;
    setDraft(facade.snapshot?.draft ?? "");
    return facade.state?.subscribe?.(() => {
      setDraft(facade.state.getSnapshot()?.draft ?? "");
    });
  }, [sessionId]);

  useEffect(() => {
    cacheRef.current.clear();
    setPop(null);
  }, [sessionId]);

  const tokens = useMemo(() => (sessionId !== undefined ? parseRefTokens(draft) : []), [draft, sessionId]);

  /* 校验：防抖读每个未缓存的引用目标区间（存在性 + 行内容）。 */
  useEffect(() => {
    if (!sessionId || tokens.length === 0) return undefined;
    const cwd = currentCwd(sessionId);
    const keysOf = (tk) => sessionId + "\n" + tk.path + "#" + tk.start.line + "-" + tk.end.line;
    const missing = [...new Set(tokens.map(keysOf))].filter((key) => !cacheRef.current.has(key));
    if (missing.length === 0) return undefined;
    const timer = setTimeout(async () => {
      for (const tk of tokens) {
        const key = keysOf(tk);
        if (cacheRef.current.has(key)) continue;
        try {
          const data = await readRange(sessionId, cwd, tk.path, tk.start, tk.end);
          cacheRef.current.set(key, { ok: true, lines: data.lines });
        } catch (error) {
          const dir = error.code === "workspace-file/not-file" || (await isDirectory(sessionId, cwd, tk.path));
          cacheRef.current.set(key, { ok: false, dir, reason: String(error?.message || error) });
        }
      }
      bumpValidity((v) => v + 1);
    }, 350);
    return () => clearTimeout(timer);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [tokens, sessionId]);

  if (!t || tokens.length === 0) return null;

  const lookup = (tk) => cacheRef.current.get(sessionId + "\n" + tk.path + "#" + tk.start.line + "-" + tk.end.line);

  /* chip 点击：官方 openResource + 行号参数；降级复制引用文本。 */
  const chipClick = async (tk) => {
    setPop(null);
    const sidebarRight = ctxRef.current?.sidebarRight;
    const token = tk.raw;
    if (!sidebarRight || sessionId === undefined) {
      const copied = await copyText(token);
      uiBus.toast(copied ? t("ex.toastRefCopied") : t("ex.toastFail"), copied ? "ok" : "err");
      return;
    }
    try {
      const cwd = currentCwd(sessionId);
      sidebarRight.openResource(fileAddressFor(sessionId, cwd, tk.path), { params: { line: tk.start.line } });
    } catch (error) {
      uiBus.toast(t("ex.refInvalid") + ": " + String(error?.message || error), "err");
    }
  };

  const chipRemove = (tk) => {
    setPop(null);
    const current = readDraft(ctxRef.current, sessionId);
    if (current === null || current.slice(tk.index, tk.index + tk.raw.length) !== tk.raw) return;
    const next = current.slice(0, tk.index) + current.slice(tk.index + tk.raw.length);
    writeDraft(ctxRef.current, sessionId, next.trimEnd() === "" ? "" : next);
  };

  const chipHover = (tk, el) => {
    const cached = lookup(tk);
    const lines = cached?.ok ? cached.lines : null;
    if (!lines || lines.length === 0) {
      setPop(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setPop({ x: rect.left, bottom: window.innerHeight - rect.top + 6, lines });
  };

  return (
    <div className="dve-chipBar">
      {tokens.map((tk) => {
        const cached = lookup(tk);
        const invalid = cached ? !cached.ok || cached.dir : false;
        return (
          <button
            key={tk.index}
            type="button"
            className={"dve-chip" + (invalid ? " dve-chipInvalid" : "")}
            onClick={() => chipClick(tk)}
            onMouseEnter={(e) => chipHover(tk, e.currentTarget)}
            onMouseLeave={() => setPop(null)}
            title={invalid && cached?.reason ? t("ex.refInvalid") + ": " + cached.reason : tk.raw}
          >
            <span className="dve-chipName">{tk.path.split("/").pop()}</span>
            <span className="dve-chipRange">
              #{tk.start.line}
              {tk.end.line !== tk.start.line ? "-" + tk.end.line : ""}
            </span>
            <span
              className="dve-chipX"
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                chipRemove(tk);
              }}
            >
              ×
            </span>
          </button>
        );
      })}
      {pop && (
        <div className="dve-chipPop" style={{ left: pop.x, bottom: pop.bottom }}>
          {pop.lines.map((line) => (
            <div key={line.n} className="dve-chipPopLine">
              <span className="dve-chipPopN">{line.n}</span>
              <span className="dve-chipPopT">{line.t || " "}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 当前会话 cwd（sessions.list 快照）。 */
function currentCwd(sessionId) {
  try {
    const snap = ctxRef.current?.sessions?.list?.getSnapshot?.();
    return snap?.byId?.[sessionId]?.cwd;
  } catch {
    return undefined;
  }
}
