/**
 * 屏上会话读取助手冒烟（src/on-screen-session.mjs，
 * change port-dsh-0-2-1-sidebar-yield · 0.2.1-rc.5 换源）：
 *  1. 快照返回屏上会话 id（getSnapshot 读出）
 *  2. 无 sidebarRight / 无 mounted / getSnapshot 非函数 → 安全返回 undefined
 *  3. getSnapshot 抛错 → 安全返回 undefined
 *  4. 订阅：subscribe 被调用、退订函数透传；缺席/非函数/抛错 → undefined
 *  5. canRead / canSubscribe 形状探针
 *
 * 运行：node tests/on-screen-session-smoke.mjs
 */
import {
  canReadOnScreenSession,
  canSubscribeOnScreenSession,
  onScreenSessionId,
  subscribeOnScreenSession
} from "../src/on-screen-session.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};

/* ── 1. 读数 ── */
{
  let current = "s1";
  const ctx = { sidebarRight: { mounted: { getSnapshot: () => current } } };
  assert(onScreenSessionId(ctx) === "s1", "must read the on-screen session id from the mounted snapshot");
  current = undefined;
  assert(onScreenSessionId(ctx) === undefined, "no on-screen session must read undefined");
  current = "s2";
  assert(onScreenSessionId(ctx) === "s2", "must follow later snapshot values");
}
{
  /* getSnapshot 返回 null（未来形状漂移）也按无会话处理 */
  const ctx = { sidebarRight: { mounted: { getSnapshot: () => null } } };
  assert(onScreenSessionId(ctx) === undefined, "null snapshot must normalize to undefined");
}

/* ── 2. 形状缺席 ── */
assert(onScreenSessionId(undefined) === undefined, "undefined ctx must read undefined");
assert(onScreenSessionId({}) === undefined, "ctx without sidebarRight must read undefined");
assert(onScreenSessionId({ sidebarRight: {} }) === undefined, "sidebarRight without mounted must read undefined");
assert(
  onScreenSessionId({ sidebarRight: { mounted: { getSnapshot: "nope" } } }) === undefined,
  "non-function getSnapshot must read undefined"
);

/* ── 3. 抛错自愈 ── */
{
  const ctx = {
    sidebarRight: {
      mounted: {
        getSnapshot: () => {
          throw new Error("snapshot exploded");
        }
      }
    }
  };
  assert(onScreenSessionId(ctx) === undefined, "throwing getSnapshot must degrade to undefined");
}

/* ── 4. 订阅 ── */
{
  let notified = 0;
  let unsubscribed = 0;
  let seen;
  const ctx = {
    sidebarRight: {
      mounted: {
        getSnapshot: () => "s1",
        subscribe: (fn) => {
          seen = fn;
          return () => {
            unsubscribed += 1;
          };
        }
      }
    }
  };
  const off = subscribeOnScreenSession(ctx, () => {
    notified += 1;
  });
  assert(typeof seen === "function", "subscribe must receive the listener");
  assert(typeof off === "function", "subscribe must return the official unsubscribe function");
  seen();
  seen();
  assert(notified === 2, "listener must fire for every snapshot change");
  off();
  assert(unsubscribed === 1, "unsubscribe must be forwarded exactly once");
}
assert(
  subscribeOnScreenSession({ sidebarRight: {} }, () => {}) === undefined,
  "missing mounted must yield no subscription"
);
assert(
  subscribeOnScreenSession({ sidebarRight: { mounted: { subscribe: "nope" } } }, () => {}) === undefined,
  "non-function subscribe must yield no subscription"
);
assert(
  subscribeOnScreenSession(
    {
      sidebarRight: {
        mounted: {
          subscribe: () => {
            throw new Error("subscribe exploded");
          }
        }
      }
    },
    () => {}
  ) === undefined,
  "throwing subscribe must degrade to undefined"
);
assert(
  subscribeOnScreenSession(
    {
      sidebarRight: {
        mounted: {
          subscribe: () => undefined
        }
      }
    },
    () => {}
  ) === undefined,
  "non-function return value must not be treated as an unsubscribe handle"
);

/* ── 5. 形状探针 ── */
assert(canReadOnScreenSession({ sidebarRight: { mounted: { getSnapshot: () => undefined } } }), "probe must accept a readable mounted face");
assert(!canReadOnScreenSession({ sidebarRight: { mounted: {} } }), "probe must reject a mounted face without getSnapshot");
assert(!canReadOnScreenSession({}), "probe must reject a ctx without sidebarRight");
assert(canSubscribeOnScreenSession({ sidebarRight: { mounted: { subscribe: () => () => {} } } }), "probe must accept a subscribable mounted face");
assert(!canSubscribeOnScreenSession({ sidebarRight: { mounted: { getSnapshot: () => undefined } } }), "probe must reject a mounted face without subscribe");

console.log("\nALL ON-SCREEN-SESSION SMOKE TESTS PASSED");
process.exit(0);
