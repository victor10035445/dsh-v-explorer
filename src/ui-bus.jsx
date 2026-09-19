/**
 * ui-bus.jsx — 跨窗口 UI 的小型 imperative 总线 + 宿主组件。
 *
 * 旧 dock 承载的两块全局 UI（toast 栈、会话窗口框选→引用菜单）在 dock 退役后
 * 仍需宿主：挂在 root 作用域 shell.overlay 的一个零尺寸条目上（这不是旧 dock，
 * 不画任何面板）。模块级总线 + useSyncExternalStore，任何组件/非组件代码
 * （右键菜单动作、chip 动作）都能弹 toast / 开选区菜单。
 */
import { useEffect, useSyncExternalStore } from "react";
import { apiPost, copyText } from "./api.mjs";
import { appendToDraft } from "./input-facade.mjs";
import { INLINE_SNIPPET_MAX_CHARS, buildRefToken } from "./ref-shared.mjs";

/* ------------------------------------------------------------------ *
 * 总线
 * ------------------------------------------------------------------ */

let toastSeq = 0;
let toastState = [];
let selMenuState = null;
const busListeners = new Set();

function emitBus() {
  for (const listener of busListeners) {
    try {
      listener();
    } catch {
      /* 单订阅者异常不拖垮 */
    }
  }
}

function busSubscribe(listener) {
  busListeners.add(listener);
  return () => busListeners.delete(listener);
}

function getBusSnapshot() {
  return busVersion;
}

let busVersion = 0;
function bump() {
  busVersion += 1;
  emitBus();
}

export const uiBus = {
  /** 弹一条 toast（kind: "ok" | "err" | "info"），默认 2.6s 自动消退。 */
  toast(text, kind = "info", ms = 2600) {
    const id = ++toastSeq;
    toastState = [...toastState, { id, text, kind }];
    bump();
    setTimeout(() => {
      toastState = toastState.filter((t) => t.id !== id);
      bump();
    }, ms);
  },
  /** 打开会话框选菜单（{x, y, items:[{label, onClick}]}）；点外关闭。 */
  openSelectionMenu(menu) {
    selMenuState = menu;
    bump();
  },
  closeSelectionMenu() {
    if (selMenuState !== null) {
      selMenuState = null;
      bump();
    }
  },
  /** React 订阅面。 */
  subscribe: busSubscribe,
  getSnapshot: getBusSnapshot,
  get toastList() {
    return toastState;
  },
  get selectionMenu() {
    return selMenuState;
  }
};

/* ------------------------------------------------------------------ *
 * 「发送引用到会话」：会话窗口框选的共用发送逻辑（短选区内联、
 * 长选区物化 /snapshot 快照后引用）
 * ------------------------------------------------------------------ */

/** 把一段引用 token 写进当前会话草稿；facade 不可达退化为复制。 */
export async function sendRefToken(ctx, sessionId, token, t) {
  if (appendToDraft(ctx, sessionId, token)) {
    uiBus.toast(t("ex.toastRefInserted"), "ok");
    return;
  }
  const copied = await copyText(token);
  uiBus.toast(copied ? t("ex.toastRefCopied") : t("ex.toastFail"), copied ? "ok" : "err");
}

/** 会话窗口选区：短选区直接内联；长选区物化快照后引用快照文件。 */
export async function sendSelectionRef(ctx, sessionId, text, t) {
  if (text.length <= INLINE_SNIPPET_MAX_CHARS) {
    await sendRefToken(ctx, sessionId, text, t);
    return;
  }
  if (sessionId === undefined) {
    uiBus.toast(t("ex.toastFail") + ": " + t("ex.noSession"), "err");
    return;
  }
  try {
    const data = await apiPost("/snapshot", { sessionId, content: text });
    await sendRefToken(
      ctx,
      sessionId,
      buildRefToken({
        path: data.path,
        start: { line: 1, col: 1, wholeLine: true },
        end: { line: data.lines, col: 1, wholeLine: true }
      }),
      t
    );
    uiBus.toast(t("ex.toastRefFromSnapshot") + " (" + data.path + ")", "ok");
  } catch (error) {
    uiBus.toast(t("ex.toastFail") + ": " + String(error?.message || error), "err");
  }
}

/* ------------------------------------------------------------------ *
 * 宿主组件：shell.overlay 上的零尺寸条目（toast 栈 + 框选菜单宿主）
 * ------------------------------------------------------------------ */

export function OverlayUi() {
  return (
    <>
      <ToastStack />
      <SelectionMenuHost />
    </>
  );
}

function ToastStack() {
  useSyncExternalStore(uiBus.subscribe, uiBus.getSnapshot, uiBus.getSnapshot);
  const list = uiBus.toastList;
  if (list.length === 0) return null;
  return (
    <div className="dve-toasts" role="status">
      {list.map((item) => (
        <div key={item.id} className={"dve-toast dve-toast--" + item.kind}>
          {item.text}
        </div>
      ))}
    </div>
  );
}

function SelectionMenuHost() {
  useSyncExternalStore(uiBus.subscribe, uiBus.getSnapshot, uiBus.getSnapshot);
  const menu = uiBus.selectionMenu;
  useEffect(() => {
    if (!menu) return undefined;
    const dismiss = (e) => {
      if (e.target instanceof Element && e.target.closest(".dve-selMenu")) return;
      uiBus.closeSelectionMenu();
    };
    const key = (e) => {
      if (e.key === "Escape") uiBus.closeSelectionMenu();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);
  if (!menu) return null;
  return (
    <div className="dve-selMenu" style={{ left: menu.x, top: menu.y }}>
      {menu.items.map((item, index) => (
        <button
          key={index}
          type="button"
          className="dve-selItem"
          onClick={() => {
            uiBus.closeSelectionMenu();
            try {
              item.onClick();
            } catch (error) {
              uiBus.toast(String(error?.message || error), "err");
            }
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 会话窗口框选：文档级右键监听（仅当存在非空选区、目标在会话滚动区内、
 * 且不在 composer 输入框 / 本插件菜单内时接管）。菜单项由 t 与当前会话驱动。
 */
export function installConversationSelection(ctx, ctxRef, t) {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const handler = (e) => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString();
      if (!text.trim()) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest(".dve-selMenu") || target.closest(".dve-menu") || target.closest("[data-composer-input], textarea, input")) return;
      const scroll = document.querySelector("[data-conversation-scroll]");
      if (!scroll || !scroll.contains(target)) return;
      e.preventDefault();
      const sessionId = currentSessionId(ctxRef);
      uiBus.openSelectionMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: t("ex.sendRef"),
            onClick: () => {
              sendSelectionRef(ctxRef.current, sessionId, text, t);
            }
          },
          {
            label: t("ex.copyRef"),
            onClick: () => {
              copyText(text).then((ok) => uiBus.toast(ok ? t("ex.toastCopied") : t("ex.toastFail"), ok ? "ok" : "err"));
            }
          }
        ]
      });
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, "dsh-v-explorer: conversation selection menu");
}

/** 读当前会话 id（sessions.list 的 current）。 */
export function currentSessionId(ctxRef) {
  try {
    const list = ctxRef.current?.sessions?.list;
    const snap = typeof list?.getSnapshot === "function" ? list.getSnapshot() : null;
    return snap?.current;
  } catch {
    return undefined;
  }
}
