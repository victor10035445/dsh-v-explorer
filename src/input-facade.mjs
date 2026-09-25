/**
 * input-facade.mjs — 会话 composer 草稿的官方 facade 读写（composer-integration）。
 * 从旧 client.jsx 原样迁移：解析当前会话的 conversation 服务，走
 * actions.setDraft / snapshot.draft / state.subscribe；不依赖 composer DOM 形态。
 */
import { buildRefToken } from "./ref-shared.mjs";

/** 客户端根 ctx 的模块级引用（apply 时写入；动作层懒取值）。 */
export const ctxRef = { current: null };

/**
 * 解析当前会话的 input facade。
 *
 * rc.2 形态（composer-integration）：`conversation.input` 是 SessionInputResolver
 * ——`for(actx)` 解析出会话 facade（`setDraft` + `state: SnapshotStore<InputState>`，
 * 草稿读 `state.getSnapshot().draft`）。旧形态（`input.actions` / input 本体直接带
 * `setDraft` + `snapshot`）已随 composer 机器改形移除——右键「插入到会话」曾因
 * setDraft 判空失败而恒走"不可达"降级。这里对两种形态都做适配（旧形态仅防御保留）。
 *
 * @returns {{actions, snapshot, state}|null} facade 不可达返回 null（降级路径）
 */
export function inputFacade(ctx, sessionId) {
  if (!ctx || sessionId === undefined) return null;
  try {
    const actx = ctx.sessions?.scope?.(sessionId);
    if (!actx) return null;
    const input = actx.get?.("conversation")?.input;
    const facade =
      typeof input?.for === "function" ? input.for(actx)
      : (typeof input?.actions?.setDraft === "function" ? input.actions : input);
    if (typeof facade?.setDraft !== "function") return null;
    const state = facade.state ?? null;
    const snapshot =
      state && typeof state.getSnapshot === "function" ? state.getSnapshot()
      : (typeof facade.snapshot === "function" ? facade.snapshot() : facade.snapshot);
    return { actions: facade, snapshot, state };
  } catch {
    return null;
  }
}

/** 读当前草稿；facade 不可达返回 null。 */
export function readDraft(ctx, sessionId) {
  const facade = inputFacade(ctx, sessionId);
  if (!facade) return null;
  try {
    return facade.snapshot?.draft ?? "";
  } catch {
    return null;
  }
}

/** 全量重写草稿；成功返回 true。 */
export function writeDraft(ctx, sessionId, text) {
  const facade = inputFacade(ctx, sessionId);
  if (!facade) return false;
  try {
    facade.actions.setDraft(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 组装一个引用 token（1 基行:列；列不可用时整行粒度）。
 * @param {{rel: string, start?: {line, col?}, end?: {line, col?}}} spec
 */
export function referenceOf(rel, start, end) {
  return buildRefToken({
    path: rel,
    start: start ?? { line: 1, col: 1, wholeLine: true },
    end: end ?? { line: 1, col: 1, wholeLine: true }
  });
}

/** 追加一段文本到当前草稿落尾（等同真实键入的追加语义）。 */
export function appendToDraft(ctx, sessionId, text) {
  const current = readDraft(ctx, sessionId);
  if (current === null) return false;
  const glue = current.length > 0 && !/\s$/.test(current) ? " " : "";
  return writeDraft(ctx, sessionId, current + glue + text);
}
