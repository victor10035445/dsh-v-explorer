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
 * @returns {{actions, snapshot, state}|null} facade 不可达返回 null（降级路径）
 */
export function inputFacade(ctx, sessionId) {
  if (!ctx || sessionId === undefined) return null;
  try {
    const actx = ctx.sessions?.scope?.(sessionId);
    const conversation = actx?.get?.("conversation");
    const input = conversation?.input;
    if (!input) return null;
    const actions = input.actions ?? input;
    if (typeof actions?.setDraft !== "function") return null;
    return {
      actions,
      snapshot: typeof input.snapshot === "function" ? input.snapshot() : input.snapshot,
      state: input.state
    };
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
