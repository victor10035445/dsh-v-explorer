/**
 * tab-definitions.mjs — 右侧栏页型的注册元数据（无 JSX，node 可直接测）。
 * icon 组件由调用方传入（files/bookmarks 各自的 glyph 组件留在 .jsx）。
 */

export const FILES_TAB_ID = "dsh-v-explorer/files";
export const BOOKMARKS_TAB_ID = "dsh-v-explorer/bookmarks";

/** files 页型定义：kind "files" 的 extension 接管官方内置，guide 顺序 10。 */
export function filesTabDefinition(t, icons) {
  return {
    id: FILES_TAB_ID,
    kind: "files",
    priority: "extension",
    title: () => t("files.typeLabel"),
    guide: [
      {
        order: 10,
        title: () => t("files.guideTitle"),
        description: () => t("files.guideDescription"),
        icon: icons?.folder
      }
    ]
  };
}

/** bookmarks 页型定义：guide 顺序 20（排在 files 之后）。 */
export function bookmarksTabDefinition(t, icons) {
  return {
    id: BOOKMARKS_TAB_ID,
    kind: "bookmarks",
    priority: "extension",
    title: () => t("bm.typeLabel"),
    guide: [
      {
        order: 20,
        title: () => t("bm.guideTitle"),
        description: () => t("bm.guideDescription"),
        icon: icons?.bookmark
      }
    ]
  };
}
