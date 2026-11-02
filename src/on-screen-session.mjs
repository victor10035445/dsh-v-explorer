/**
 * on-screen-session.mjs — 屏上会话标识的统一读取面（DSH 0.2.1-rc.5 换源，
 * change port-dsh-0-2-1-sidebar-yield）。
 *
 * 0.2.1-rc.5 删除了 `SessionListState.current`（官方契约：navigation belongs to
 * view owners），选中态移交视图层；插件原先的 `ctx.sessions.list.current` 三处
 * 消费者因此全部读成 undefined 且静默失效。替代品是官方新增的公共观察口
 * `ctx.sidebarRight.mounted`（`ISidebarRight.mounted`,
 * `ObservableSnapshot<SessionId | undefined>`）：
 *  - getSnapshot() 读「哪个会话在屏上」；无会话（全局面板占主列 / 未选中）为
 *    undefined，store 尚未被 seat 铸造时也为 undefined。
 *  - subscribe(fn) 在屏上会话变化时通知（官方在 React 渲染前发布，`fn` 无参，
 *    调用方自己重读快照）。
 *  - 语义正是插件想问的问题（"哪个会话在屏上"），比 list 的提交信号更贴切；
 *    且随 sidebarRight 服务注入，无额外依赖声明。
 *
 * 本模块只做形状防护 + 安全读数，不依赖 JSX / React（可被 node 测试直接 import），
 * 供三处消费者复用：auto-open 会话判定（轮询拍 getSnapshot）、client 侧书签 SSE
 * 的会话作用域（读 + 订阅双换）、ui-bus 的框选引用会话 id。
 *
 * 降级（design D9 哲学）：观察口缺席/形状不符/读数抛错时一律安全返回
 * undefined（订阅返回 undefined = 未订阅），由各消费点决定「警告一次并跳过」的
 * 具体语义；本模块不自行打日志，避免多消费者重复告警。
 */

/** 能不能读：`ctx.sidebarRight.mounted.getSnapshot` 可调用。 */
export function canReadOnScreenSession(ctx) {
  return typeof ctx?.sidebarRight?.mounted?.getSnapshot === "function";
}

/** 能不能订阅：`ctx.sidebarRight.mounted.subscribe` 可调用。 */
export function canSubscribeOnScreenSession(ctx) {
  return typeof ctx?.sidebarRight?.mounted?.subscribe === "function";
}

/**
 * 读屏上会话 id。
 * @returns {string|undefined} 屏上会话；无会话、观察口缺席或读数抛错时 undefined。
 */
export function onScreenSessionId(ctx) {
  const mounted = ctx?.sidebarRight?.mounted;
  const read = mounted?.getSnapshot;
  if (typeof read !== "function") return undefined;
  try {
    return read.call(mounted) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 订阅屏上会话变化（`fn` 无参；调用方自己重读快照）。
 * @returns {(() => void)|undefined} 退订函数；观察口缺席/形状不符/订阅抛错时 undefined。
 */
export function subscribeOnScreenSession(ctx, listener) {
  const mounted = ctx?.sidebarRight?.mounted;
  const subscribe = mounted?.subscribe;
  if (typeof subscribe !== "function") return undefined;
  try {
    const off = subscribe.call(mounted, listener);
    return typeof off === "function" ? off : undefined;
  } catch {
    return undefined;
  }
}
