/**
 * services.mjs — apply 装配期的单例容器（组件层从这里取跨模块依赖）。
 * 树身/书签 tab 与右键菜单动作层共享：变更流枢纽、locale 字典、动作层、
 * 客户端 ctx 引用、registry 探测结果（降级形态判定）。
 */
export const services = {
  /** createChangesHub() 实例（client.jsx 装配）。 */
  hub: null,
  /** locale t 函数（ctx.locale.bind(NS) 产物）。 */
  t: null,
  /** createRowActions(t) 动作层。 */
  actions: null,
  /** 客户端根 ctx（apply 写入）。 */
  ctxRef: { current: null },
  /** sidebar 面可用性探测结果（client.jsx 装配后置位）。 */
  sidebarAvailable: false
};

export function provideServices(patch) {
  Object.assign(services, patch);
}
