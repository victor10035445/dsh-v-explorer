/**
 * check-externals 自验证冒烟（tests/fixtures/check-externals 的三个最小包夹具）：
 *  1. covered-require：非 seed require 被 inject 覆盖、落点存在（DSH_EXTRA_PKG_DIRS
 *     指向 stub node_modules，内含声明 dsh.client 的假包）→ 退出码 0
 *  2. dangling-inject：全 seed bundle + inject 指向空解析路径中的包 → 退出码 1（R2）
 *  3. dead-require：非 seed require 未被声明覆盖（配仓库默认 package.json）→ 退出码 1（R1）
 *  4. 待检文件不存在 → 退出码 2
 *  5. 真实产物冒烟外的 R3 语义：无任何包解析路径（剔除 APPDATA/DSH_DIR/DSH_EXTRA_PKG_DIRS）
 *     且存在待解析声明 → 退出码 2「无法定位 DSH 安装」
 * 运行：node tests/check-externals-smoke.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const fixtures = join(root, "tests", "fixtures", "check-externals");
const checker = join(root, "check-externals.mjs");

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};

/** 以受控环境运行检查器，返回 { status, stderr }。 */
function run(target, pkgJson, envPatch) {
  const env = { ...process.env, ...envPatch };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key]; // undefined 键从子进程环境中剔除
  }
  const args = [checker];
  if (target) args.push(target);
  if (pkgJson) args.push(pkgJson);
  const r = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  return { status: r.status, stderr: String(r.stderr || "") + String(r.stdout || "") };
}

const temp = mkdtempSync(join(tmpdir(), "dve-checkext-"));
try {
  /* stub 落点：<stub>/@deepseek-ai/dsh-client-locale/package.json，带可用 client 半部 */
  const stub = join(temp, "stub");
  const stubPkg = join(stub, "@deepseek-ai", "dsh-client-locale", "package.json");
  mkdirSync(dirname(stubPkg), { recursive: true });
  writeFileSync(
    stubPkg,
    JSON.stringify({
      name: "@deepseek-ai/dsh-client-locale",
      dsh: { client: { platform: "web" } },
      exports: { "./client": "./client.js" }
    })
  );
  const emptyDir = join(temp, "empty");
  mkdirSync(emptyDir, { recursive: true });

  /* 1. 合法覆盖 → 0 */
  let r = run(join(fixtures, "covered-require", "client.js"), join(fixtures, "covered-require", "package.json"), {
    DSH_EXTRA_PKG_DIRS: stub
  });
  assert(r.status === 0, `covered-require 应通过，实得 ${r.status}：${r.stderr}`);

  /* 2. 悬空 inject（解析路径非空但包不存在）→ 1 */
  r = run(join(fixtures, "dangling-inject", "client.js"), join(fixtures, "dangling-inject", "package.json"), {
    DSH_EXTRA_PKG_DIRS: emptyDir
  });
  assert(r.status === 1, `dangling-inject 应漂移失败（1），实得 ${r.status}：${r.stderr}`);
  assert(r.stderr.includes("@deepseek-ai/dsh-client-runtime"), "错误消息应指认悬空声明条目");

  /* 3. 死 require（配仓库默认 package.json，无 inject）→ 1，指认说明符 */
  r = run(join(fixtures, "dead-require.js"), join(root, "package.json"), { DSH_EXTRA_PKG_DIRS: stub });
  assert(r.status === 1, `dead-require 应漂移失败（1），实得 ${r.status}：${r.stderr}`);
  assert(r.stderr.includes("@deepseek-ai/dsh-client-runtime/client"), "错误消息应指认死 require 说明符");

  /* 4. 待检文件不存在 → 2 */
  r = run(join(temp, "no-such-bundle.js"), join(root, "package.json"), {});
  assert(r.status === 2, `缺文件应退码 2，实得 ${r.status}：${r.stderr}`);

  /* 5. R3：包解析路径全空 + 存在待解析声明 → 2（不误报漂移） */
  r = run(join(fixtures, "dangling-inject", "client.js"), join(fixtures, "dangling-inject", "package.json"), {
    APPDATA: undefined,
    DSH_DIR: undefined,
    DSH_EXTRA_PKG_DIRS: undefined
  });
  assert(r.status === 2, `无解析路径应报环境不可用（2），实得 ${r.status}：${r.stderr}`);
  assert(r.stderr.includes("无法定位 DSH 安装"), "应输出「无法定位 DSH 安装」而非漂移指认");

  /* 真实产物可用性：lib/client.js 存在即对真实 bundle 跑一次（结果不判定，仅确认可执行不抛异常路径） */
  const realBundle = join(root, "lib", "client.js");
  if (existsSync(realBundle)) {
    r = run(realBundle, join(root, "package.json"), {});
    assert([0, 1, 2].includes(r.status), `真实产物检查应有确定退码，实得 ${r.status}`);
    console.log(`real lib/client.js → exit ${r.status}`);
  }

  console.log("\nALL CHECK-EXTERNALS SMOKE TESTS PASSED");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
