/**
 * workspace-path.mjs — 会话资源地址与路径显示工具（纯函数，零依赖）。
 *
 * 语义对齐官方 @deepseek-ai/dsh-util-workspace-path（官方把它打进各自 bundle，
 * 不经平台模块表对插件开放——见 design Spike 结论，故本地实现同语义）：
 *  - session 资源地址逐段 encodeURIComponent，仅盘符冒号（%3A）还原为 ":"
 *  - 相对路径直构 `dsh-resource://file/session/<sessionId>/<path>`（宿主按
 *    session cwd 解析）；绝对路径若在 cwd 内则转为相对形态
 */

/** 文件资源地址前缀（scheme + type）。 */
export const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

/** 组件编码一个 id 或路径段，盘符冒号保持字面量。 */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}

/** 逐段编码一个 `/` 分隔的路径。 */
function encodePath(path) {
  return path.split("/").map(encodeSegment).join("/");
}

/** 是否 Windows 盘符或 UNC 前缀路径。 */
export function isWindowsStylePath(value) {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
}

/** 宿主接受的两种绝对路径形态：POSIX `/a/b` 或 Windows 盘符/UNC。 */
export function isAbsoluteWorkspacePath(path) {
  return path.startsWith("/") || isWindowsStylePath(path);
}

/** 显示拆分：目录前缀（含尾分隔符）与末段；两种分隔符都认。 */
export function pathPartsOf(path) {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed === "") return { directory: "", name: path };
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1;
  return { directory: trimmed.slice(0, cut), name: trimmed.slice(cut) };
}

/** 构造经某个 Session 读取的文件地址（绝对或工作区相对路径均可）。 */
export function sessionFileAddress(sessionId, path) {
  const normalized = String(path).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
}

/**
 * 按调用方所持形态构造地址：相对路径（或 cwd 内的绝对路径）→ session 相对
 * 地址；cwd 未知的绝对路径保持绝对形态（仍在该 Session 地址内）。
 */
export function fileAddressFor(sessionId, cwd, path) {
  const normalized = String(path).replace(/\\/g, "/");
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
  const root = cwd === undefined || cwd === null ? "" : String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
  if (root !== "" && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
  return sessionFileAddress(sessionId, normalized);
}

/** 会话 cwd（绝对）+ 工作区相对路径 → 绝对路径；rel 已绝对时原样（分隔符归一）。 */
export function joinWorkspacePath(cwd, rel) {
  const normalized = String(rel).replace(/\\/g, "/");
  if (isAbsoluteWorkspacePath(normalized)) return normalized;
  const root = String(cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return normalized;
  if (normalized === "" || normalized === ".") return root;
  return `${root}/${normalized.replace(/^(?:\.\/)+/, "")}`;
}
