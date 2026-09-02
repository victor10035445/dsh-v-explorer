/**
 * dock 让位量计算（纯函数，供 src/client.jsx 与 tests/dock-yield-smoke.mjs 共用）。
 *
 * dock 是 fixed 右缘贴视口右缘的浮层；宿主 AppFrame 的会话中列（1fr track）
 * 打开 details 列时其右侧还有一列。只有中列与 dock 真正重叠的部分才需要让位：
 *
 *   overlap = max(0, 中列右缘 - (视口宽 - dock宽))
 *   yield   = clamp(overlap, 0, 中列宽 - 最小保留宽度)
 *
 * 最小保留宽度兜底：窗口太窄时宁可让 dock 压住一部分，也不把会话挤没。
 * @param {number} colRight 中列视口右缘（getBoundingClientRect().right）
 * @param {number} colWidth 中列宽度
 * @param {number} viewportWidth 视口宽度
 * @param {number} dockWidth dock 宽度
 * @param {number} [floor=320] 中列最小保留宽度（px）
 * @returns {number} 应让位的像素数（padding-right），≥ 0
 */
export function computeDockYield(colRight, colWidth, viewportWidth, dockWidth, floor = 320) {
  const overlap = Math.max(0, colRight - (viewportWidth - dockWidth));
  return Math.max(0, Math.min(overlap, colWidth - floor));
}
