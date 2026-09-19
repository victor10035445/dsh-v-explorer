/**
 * workspace-path 冒烟测试：会话资源地址与路径显示工具（对齐官方
 * @deepseek-ai/dsh-util-workspace-path 语义的本地实现）。
 * 运行：node tests/workspace-path-smoke.mjs
 */
import {
  FILE_ADDRESS_PREFIX,
  fileAddressFor,
  sessionFileAddress,
  pathPartsOf,
  isAbsoluteWorkspacePath,
  isWindowsStylePath,
  joinWorkspacePath
} from "../src/workspace-path.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};
const eq = (actual, expected, message) => assert(actual === expected, message + `（actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}）`);

/* session 地址：相对路径、逐段编码、盘符冒号保留 */
eq(
  sessionFileAddress("sess-1", "src/lib/a.md"),
  "dsh-resource://file/session/sess-1/src/lib/a.md",
  "相对路径直构"
);
eq(
  sessionFileAddress("sess 1", "a b/文#件.md"),
  "dsh-resource://file/session/sess%201/a%20b/%E6%96%87%23%E4%BB%B6.md",
  "空格与 # 编码"
);
eq(sessionFileAddress("s", "C:\\repo\\x.md"), "dsh-resource://file/session/s/C:/repo/x.md", "盘符冒号保留、反斜杠归一");
eq(sessionFileAddress("s", "./a.md"), "dsh-resource://file/session/s/a.md", "./ 前缀剥离");

/* fileAddressFor：cwd 内绝对路径折叠为相对形态 */
eq(fileAddressFor("s", "C:\\repo", "C:\\repo\\src\\a.md"), "dsh-resource://file/session/s/src/a.md", "cwd 内绝对→相对");
eq(fileAddressFor("s", "C:\\repo", "src/a.md"), "dsh-resource://file/session/s/src/a.md", "相对直构");
eq(fileAddressFor("s", "C:\\repo", "C:\\other\\x.md"), "dsh-resource://file/session/s/C:/other/x.md", "cwd 外绝对保留绝对");
eq(fileAddressFor("s", undefined, "a.md"), "dsh-resource://file/session/s/a.md", "cwd 缺失时相对可用");

/* joinWorkspacePath */
eq(joinWorkspacePath("C:\\repo", "src\\a.md"), "C:/repo/src/a.md", "rel→abs");
eq(joinWorkspacePath("C:\\repo", "C:\\abs\\x"), "C:/abs/x", "abs 原样");
eq(joinWorkspacePath("C:\\repo", ""), "C:/repo", "空 rel → 根");
eq(joinWorkspacePath(undefined, "a.md"), "a.md", "无 cwd 原样");

/* pathPartsOf / 判定 */
eq(pathPartsOf("a/b/c.md").name, "c.md", "name 提取");
eq(pathPartsOf("a/b/c.md").directory, "a/b/", "directory 含尾分隔");
eq(pathPartsOf("a\\b.md").name, "b.md", "反斜杠拆分");
eq(isAbsoluteWorkspacePath("/tmp/x"), true, "POSIX 绝对");
eq(isAbsoluteWorkspacePath("C:\\x"), true, "盘符绝对");
eq(isAbsoluteWorkspacePath("src/x"), false, "相对");
eq(isWindowsStylePath("\\\\srv\\share"), true, "UNC");
eq(FILE_ADDRESS_PREFIX, "dsh-resource://file/", "前缀常量");

console.log("\nALL WORKSPACE-PATH SMOKE TESTS PASSED");
