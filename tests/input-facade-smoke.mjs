/**
 * input-facade 形态适配冒烟（specs/composer-integration，2026-09-25 rc.2 修订）：
 *  1. rc.2 形态：conversation.input 是 SessionInputResolver（for(actx) → 会话
 *     facade {setDraft, state}）——解析成功、追加带空格胶水、草稿读取走 state store
 *  2. 旧形态防御：input 本体带 setDraft + snapshot 时仍可用
 *  3. 不可达降级：scope 缺失 / setDraft 缺失 → null（动作层退化复制）
 * 运行：node tests/input-facade-smoke.mjs
 */
import { appendToDraft, readDraft, inputFacade } from "../src/input-facade.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};

/* rc.2 形态的 fake：resolver + 会话 facade + state store。 */
function makeRc2Ctx({ withScope = true, withSetDraft = true } = {}) {
  const store = {
    text: "",
    listeners: new Set(),
    getSnapshot: () => ({ draft: store.text }),
    subscribe: (fn) => {
      store.listeners.add(fn);
      return () => store.listeners.delete(fn);
    }
  };
  const facade = {
    setDraft: withSetDraft ? (text) => {
      store.text = text;
      for (const fn of [...store.listeners]) fn();
    } : undefined,
    state: store /* rc.2 SessionInput.state：SnapshotStore<InputState> */
  };
  const actx = {
    get: (name) => (name === "conversation" ? { input: { for: () => facade } } : undefined)
  };
  return {
    ctx: {
      sessions: {
        scope: (id) => (withScope && id === "s1" ? actx : undefined)
      }
    },
    store
  };
}

/* ── 1. rc.2 resolver 形态 ── */
{
  const { ctx, store } = makeRc2Ctx();
  const facade = inputFacade(ctx, "s1");
  assert(facade !== null, "rc.2 resolver shape must resolve");
  assert(readDraft(ctx, "s1") === "", "empty draft reads as empty string");
  assert(appendToDraft(ctx, "s1", "@a.md") === true, "append to empty draft succeeds");
  assert(store.text === "@a.md", "append writes token, got " + JSON.stringify(store.text));
  assert(appendToDraft(ctx, "s1", "@b.md#1-2") === true, "second append succeeds");
  assert(store.text === "@a.md @b.md#1-2", "append glues with one space, got " + JSON.stringify(store.text));
  assert(facade.state === store, "facade.state is the session state store");
  assert(typeof facade.state.subscribe === "function", "state is subscribable (chips draft mirror)");
}

/* ── 2. 旧形态防御（input 本体带 setDraft + snapshot） ── */
{
  const facade = {
    setDraft: (text) => { facade.snapshot = { draft: text }; },
    snapshot: { draft: "hello" }
  };
  const ctx = { sessions: { scope: (id) => ({ get: (name) => (name === "conversation" ? { input: facade } : undefined) }) } };
  assert(readDraft(ctx, "s1") === "hello", "legacy snapshot.draft reads");
  assert(appendToDraft(ctx, "s1", "@x") === true, "legacy shape append succeeds");
  assert(facade.snapshot.draft === "hello @x", "legacy shape append glues");
}

/* ── 3. 不可达降级 ── */
{
  const { ctx } = makeRc2Ctx({ withScope: false });
  assert(inputFacade(ctx, "s1") === null, "missing scope resolves null");
  const noDraft = makeRc2Ctx({ withSetDraft: false });
  assert(inputFacade(noDraft.ctx, "s1") === null, "facade without setDraft resolves null");
  assert(inputFacade(undefined, "s1") === null, "missing ctx resolves null");
  assert(appendToDraft(makeRc2Ctx({ withScope: false }).ctx, "s1", "@x") === false, "unreachable append reports failure");
}

console.log("\nALL INPUT-FACADE SMOKE TESTS PASSED");
process.exit(0);
