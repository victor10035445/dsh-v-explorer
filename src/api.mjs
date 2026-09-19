/**
 * api.mjs — 宿主路由客户端（仅保留未退役路由；/list /file 已由官方
 * workspaceFiles Remote 取代，见 change official-sidebar-adoption）。
 * 全部路径限定在会话 cwd 内（宿主端 containedPath 双重校验）。
 */

const API = "/api/dsh-v-explorer";

/** GET（查询参数对象）。 */
export async function apiGet(route, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const res = await fetch(API + route + (query.toString() ? "?" + query.toString() : ""));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || res.statusText || "request failed");
  return data;
}

/** POST（JSON 体）。 */
export async function apiPost(route, body) {
  const res = await fetch(API + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || res.statusText || "request failed");
  return data;
}

/** 复制文本：优先 async Clipboard API，非安全上下文回退 execCommand。 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到 execCommand 回退 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
