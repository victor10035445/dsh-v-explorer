/**
 * check-externals.mjs — 构建期 externals 漂移检查（0.1.5-rc.2 模块表适配，规格 platform-compat）。
 *
 * 对 bundle 产物的全部裸 require 说明符与 package.json 的 dsh.client 声明做
 * 双向交叉校验（运行时对应物：dsh-client-modules 的 makeRequire 三级解析与
 * arriveGraphRow 的 inject 到达）：
 *
 *   R1 · require 覆盖 —— 说明符 ∈ seed 允许表 → 放行；其余 @deepseek-ai/* 按
 *        stripClientSuffix 剥掉 /client 后必须被 dsh.client.inject / external
 *        覆盖（到达保证）；其它裸说明符（相对路径、漏打包的第三方裸名）→ 失败。
 *   R2 · 声明落点 —— 每条 inject/external 声明必须是裸包名（带子路径的条目永远
 *        匹配不上以裸包名为键的启动图，属静默死声明），且 ∈ seed 允许表，或其
 *        包目录在包解析路径中可找到且声明了 dsh.client（platform "web" +
 *        exports["./client"]）。
 *   R3 · 无法定位安装 —— 包解析路径全空时报「无法定位 DSH 安装」，不误报漂移。
 *
 * 用法：node check-externals.mjs [待检文件=lib/client.js] [package.json 路径]
 *       （第二参数供 fixture 验证使用；默认取本包根的 package.json）
 *
 * 退出码：0 通过；1 漂移失败（R1/R2）；2 环境不可用（文件缺失 / R3）。
 *
 * seed 允许表再推导方法（DSH 升级后务必刷新）：在
 *   C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\
 *     node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\*.js
 * 中搜 `staticModules`，其 create 调用旁的字面量函数（如 `by()`）即平台 seed 表。
 * 0.1.5-rc.2 实测：0.1.2 表 + `@deepseek-ai/dsh-client-ui-dockkit`。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const TARGET_FILE = process.argv[2] ?? join(PKG_ROOT, "lib", "client.js");
const PKG_JSON = process.argv[3] ?? join(PKG_ROOT, "package.json");

/** 平台 seed word 允许表（0.1.5-rc.2；来源与再推导方法见文件头注释）。 */
const SEED_WORDS = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit"
]);

/** 与平台 dsh-client-modules 同款：/client 子路径别名到裸包名。 */
const stripClientSuffix = (spec) => (spec.endsWith("/client") ? spec.slice(0, -7) : spec);

/** 平台同款裸包名形态（scoped 恰两段；非 scoped 无 /）。 */
function exactPackageSpecifier(name) {
  if (name.startsWith("@")) {
    const parts = name.split("/");
    return parts.length === 2 && parts.every(Boolean) ? name : undefined;
  }
  return name.length > 0 && !name.includes("/") ? name : undefined;
}

/** 包解析路径：DSH_DIR → 全局 npm 下的 @deepseek-ai/dsh → DSH_EXTRA_PKG_DIRS。 */
function packageResolutionDirs() {
  const dirs = [];
  if (process.env.DSH_DIR) dirs.push(join(process.env.DSH_DIR, "node_modules"));
  const appData = process.env.APPDATA;
  if (appData) dirs.push(join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules"));
  for (const extra of (process.env.DSH_EXTRA_PKG_DIRS ?? "").split(";")) {
    if (extra.trim()) dirs.push(resolve(extra.trim()));
  }
  return dirs;
}

/** 读 dsh.client 声明；缺失/畸形返回 null（缺 dsh.client 的包不配作为到达落点）。 */
function readDshClient(pkgPath) {
  if (!existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const client = pkg?.dsh?.client;
  if (client === null || typeof client !== "object") return null;
  const exportsMap = pkg?.exports;
  const clientExport = exportsMap === null || typeof exportsMap !== "object" ? undefined : exportsMap["./client"];
  const clientExportStr = typeof clientExport === "string" ? clientExport : clientExport && typeof clientExport === "object" ? clientExport.default : undefined;
  return {
    platform: typeof client.platform === "string" ? client.platform : undefined,
    inject: Array.isArray(client.inject) ? client.inject : [],
    external: Array.isArray(client.external) ? client.external : [],
    hasClientExport: typeof clientExportStr === "string"
  };
}

const fail = (errors, message) => errors.push(`check-externals: ${message}`);
const missed = (kind, name, reason) =>
  `${kind}("${name}") missed the module table — ${reason}`;

// ── 环境与输入 ────────────────────────────────────────────────────────────
const errors = [];
if (!existsSync(TARGET_FILE)) {
  console.error(`check-externals: 待检文件不存在：${TARGET_FILE}（先 pnpm build）`);
  process.exit(2);
}
const code = readFileSync(TARGET_FILE, "utf8");
const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
const decl = pkg?.dsh?.client;
const inject = decl && Array.isArray(decl.inject) ? decl.inject : [];
const external = decl && Array.isArray(decl.external) ? decl.external : [];
const declared = new Set([...inject, ...external].map(stripClientSuffix));

// ── R1：require 覆盖 ─────────────────────────────────────────────────────
const specs = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
const bareSpecs = [...new Set(specs)].filter((s) => !s.startsWith(".") && !s.startsWith("node:"));
const unresolvedRequires = [];
for (const spec of bareSpecs) {
  if (SEED_WORDS.has(spec)) continue;
  if (spec.startsWith("@deepseek-ai/")) {
    if (declared.has(stripClientSuffix(spec))) continue;
    unresolvedRequires.push(spec);
    fail(
      errors,
      missed(
        "require",
        spec,
        "非 seed 平台依赖，且未被 dsh.client.inject/external 覆盖（build-time externals drift，或缺少到达声明）"
      )
    );
    continue;
  }
  fail(
    errors,
    missed("require", spec, "bundle 产物不应出现裸第三方/相对说明符（应打包进产物或使用平台模块）")
  );
}

// ── R2：声明落点 ─────────────────────────────────────────────────────────
const resolvableDirs = packageResolutionDirs();
const needResolution = [];
for (const name of new Set([...inject, ...external])) {
  if (exactPackageSpecifier(name) === undefined) {
    fail(
      errors,
      missed(
        "inject",
        name,
        "声明必须是裸包名（exactPackageSpecifier 形态）——带子路径的条目永远匹配不上启动图，属静默死声明"
      )
    );
    continue;
  }
  if (SEED_WORDS.has(name)) continue;
  needResolution.push(name);
}

for (const name of needResolution) {
  let landing = null;
  for (const base of resolvableDirs) {
    const pkgPath = join(base, name, "package.json");
    const meta = readDshClient(pkgPath);
    if (meta === null) continue;
    if (meta.platform !== "web" || !meta.hasClientExport) {
      fail(
        errors,
        missed(
          "inject",
          name,
          `落点 ${pkgPath} 存在但缺少可用 client 半部（dsh.client.platform==="web" 且 exports["./client"]）`
        )
      );
      landing = "invalid";
      break;
    }
    landing = "ok";
    break;
  }
  if (landing === null) {
    if (resolvableDirs.length === 0) {
      console.error(
        "check-externals: 无法定位 DSH 安装（设 DSH_DIR 指向 @deepseek-ai/dsh 包根，或用 DSH_EXTRA_PKG_DIRS 提供附加 node_modules 目录）——不据此判定漂移"
      );
      process.exit(2);
    }
    fail(
      errors,
      missed("inject", name, "声明指向的包在包解析路径中不存在（悬空声明——运行时会被启动图静默跳过）")
    );
  }
}

// ── 结果 ─────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error(`check-externals: ${errors.length} 处漂移（${TARGET_FILE}）：`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}
const seedHits = bareSpecs.filter((s) => SEED_WORDS.has(s));
const covered = bareSpecs.filter((s) => !SEED_WORDS.has(s));
console.log(
  `check-externals: OK — ${bareSpecs.length} 个裸说明符（seed ${seedHits.length}：${seedHits.join(", ") || "无"}；声明覆盖 ${covered.length}：${covered.join(", ") || "无"}）；声明 ${inject.length + external.length} 条全部可落地`
);
