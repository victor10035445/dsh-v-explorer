/**
 * row-menu.jsx — files 树身与书签 tab 共用的行级右键菜单 + 动作层。
 *
 * 菜单与存储规则的一致性（specs/files-explorer）：隐藏路径段（任一段以 `.`
 * 开头）的行不提供「加入书签」——宿主书签路由对隐藏段一律 400。
 * 全部动作作用于原始 rel 路径（插入引用 / 打开目录 / 浏览器打开 / 书签 toggle）。
 */
import { useEffect, useState } from "react";
import { apiPost, copyText } from "./api.mjs";
import { appendToDraft, ctxRef } from "./input-facade.mjs";
import { uiBus } from "./ui-bus.jsx";
import { bookmarkRepo } from "./bookmark-repo.mjs";
// 纯逻辑在 tree-utils.mjs（node 可直接测）；这里 re-export 保持旧入口。
import { compareEntries, hasHiddenSegment } from "./tree-utils.mjs";

export { compareEntries, hasHiddenSegment };

/**
 * 组装一个行的菜单条目列表。
 * @param {{t, sessionId, rel, name, isDir, isHtml}} row
 * @param {{bookmarked: boolean, actions: object}} state
 * @returns {Array<{key,label,danger?,onClick}>}
 */
export function buildRowMenuItems({ t, sessionId, rel, isDir, isHtml }, { bookmarked, actions }) {
  const hidden = hasHiddenSegment(rel);
  const items = [];
  items.push({ key: "openDir", label: t("menu.openDir"), onClick: () => actions.openDir(sessionId, rel) });
  items.push({ key: "copyPath", label: t("menu.copyPath"), onClick: () => actions.copyPath(rel) });
  items.push({ key: "insertRef", label: t("menu.insertRef"), onClick: () => actions.insertPathRef(sessionId, rel) });
  if (isHtml) items.push({ key: "browse", label: t("menu.browse"), onClick: () => actions.browseHtml(sessionId, rel) });
  if (!hidden) {
    items.push({
      key: "bookmark",
      label: bookmarked ? t("menu.removeBookmark") : t("menu.addBookmark"),
      onClick: () => actions.toggleBookmark(sessionId, rel, bookmarked)
    });
  }
  return items;
}

/** 动作层：宿主路由 + composer facade + 书签仓库。 */
export function createRowActions(t) {
  const notifyFail = (error) => uiBus.toast(t("ex.toastFail") + ": " + String(error?.message || error), "err");

  return {
    /** 在系统文件管理器中打开所在目录（explorer /select 在宿主端退化打开目录）。 */
    async openDir(sessionId, rel) {
      try {
        await apiPost("/open", { sessionId, path: rel });
      } catch (error) {
        notifyFail(error);
      }
    },
    /** 复制 rel 路径。 */
    async copyPath(rel) {
      const ok = await copyText(rel);
      uiBus.toast(ok ? t("ex.toastCopied") : t("ex.toastFail"), ok ? "ok" : "err");
    },
    /** 把 `@rel` 引用写进当前会话 composer（facade 不可达退化为复制）。 */
    async insertPathRef(sessionId, rel) {
      const token = "@" + quotePathIfNeeded(rel);
      if (appendToDraft(ctxRef.current, sessionId, token)) {
        uiBus.toast(t("ex.toastRefInserted"), "ok");
        return;
      }
      const ok = await copyText(token);
      uiBus.toast(ok ? t("ex.toastRefCopied") : t("ex.toastFail"), ok ? "ok" : "err");
    },
    /** 用系统默认浏览器按 file 协议打开 html（宿主转 file:///）。 */
    async browseHtml(sessionId, rel) {
      try {
        await apiPost("/open-browser", { sessionId, path: rel });
      } catch (error) {
        notifyFail(error);
      }
    },
    /** 加入/移除书签（toggle，幂等）；失败报 toast 不假成功。 */
    async toggleBookmark(sessionId, rel, bookmarked) {
      try {
        if (bookmarked) await bookmarkRepo.remove(ctxRef.current, sessionId, rel);
        else await bookmarkRepo.add(ctxRef.current, sessionId, rel);
      } catch (error) {
        notifyFail(error);
      }
    }
  };
}

/** 含空格的路径加引号（官方 @path 引用语法）。 */
export function quotePathIfNeeded(rel) {
  return /\s/.test(rel) ? `"${rel}"` : rel;
}

/** 右键菜单浮层（fixed 定位、点外/Esc 关闭、动作后关闭）。 */
export function RowMenu({ items, x, y, onClose }) {
  useEffect(() => {
    if (!items) return undefined;
    const dismiss = (e) => {
      if (e.target instanceof Element && e.target.closest(".dve-menu")) return;
      onClose();
    };
    const key = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", key);
    };
  }, [items, onClose]);
  if (!items || items.length === 0) return null;
  return (
    <div className="dve-menu" style={{ left: x, top: y }}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="dve-menuItem"
          onClick={() => {
            onClose();
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

/** React hook：管理一个行的菜单状态并返回打开器（null 关闭）。 */
export function useRowMenu() {
  const [state, setState] = useState(null);
  return [state, (items, x, y) => setState(items ? { items, x, y } : null)];
}
