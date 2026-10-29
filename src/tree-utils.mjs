/**
 * tree-utils.mjs — files 树身/书签 tab 共用的纯逻辑（无 JSX，node 可直接测）。
 */

/** 隐藏路径段：任一段以 `.` 开头（与宿主书签路由的 400 语义一致）。 */
export function hasHiddenSegment(rel) {
  return String(rel)
    .split(/[\\/]/)
    .some((segment) => segment.startsWith("."));
}

/** 目录优先 + 名称自然序（大小写不敏感）——对齐官方树排序。 */
export function compareEntries(a, b) {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  const an = String(a.name ?? "");
  const bn = String(b.name ?? "");
  return an.localeCompare(bn, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * 行类型标志：按文件名派生「可用扩展名门控动作」的开关
 * （files 树身与书签 tab 共用，避免两处重复正则）。
 *  - html：`.html/.htm/.xhtml` → 菜单「用浏览器打开」
 *  - batch：`.bat/.cmd` → 菜单「启动」（语义见 specs/batch-launch）
 * 仅为 UI 便利；权威校验在宿主端（BROWSABLE_EXT / LAUNCHABLE_EXT 白名单）。
 */
export function rowKinds(name) {
  const value = String(name ?? "");
  return {
    html: /\.(html?|xhtml)$/i.test(value),
    batch: /\.(bat|cmd)$/i.test(value)
  };
}

/** cwd（绝对）+ abs → 工作区相对路径（书签 rel 与隐藏段判定用）。 */
export function relFromAbs(cwd, abs) {
  const root = String(cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const norm = String(abs).replace(/\\/g, "/");
  if (root && norm.startsWith(`${root}/`)) return norm.slice(root.length + 1);
  if (root && norm === root) return "";
  return norm;
}
