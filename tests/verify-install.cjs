/* 模拟 client-modules 的 resolveMeta + 入口扫描，确认 explorer 包会被正确发现。
 * profile 路径：argv[2] 或环境变量 DSH_PROFILE，默认 ~/.dsh/profiles/web。
 * 运行：node tests/verify-install.cjs [profile 路径]
 */
const { createRequire } = require("module");
const { readFileSync, existsSync } = require("fs");
const { join, dirname } = require("path");
const { homedir } = require("os");

const profileDir =
  process.argv[2] ||
  process.env.DSH_PROFILE ||
  join(homedir(), ".dsh", "profiles", "web");
const require_ = createRequire(join(profileDir, "package.json"));
const pkgPath = require_.resolve("dsh-v-explorer/package.json");
console.log("package.json:", pkgPath);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const decl = pkg.dsh && pkg.dsh.client;
if (!decl || decl.platform !== "web") throw new Error("dsh.client invalid");
console.log("dsh.client:", JSON.stringify(decl));
const clientRel = typeof pkg.exports["./client"] === "string" ? pkg.exports["./client"] : pkg.exports["./client"].default;
const clientPath = join(dirname(pkgPath), clientRel);
if (!existsSync(clientPath)) throw new Error("client bundle missing");
console.log("client bundle:", clientPath, `(${readFileSync(clientPath).length} bytes)`);
const patchPath = join(dirname(pkgPath), pkg.dsh.bundle.patch);
if (!existsSync(patchPath)) throw new Error("patch missing");
if (!/id:\s*dsh-v-explorer/.test(readFileSync(patchPath, "utf8"))) throw new Error("patch entry malformed");
console.log("cordis.patch.yml: ok");
for (const dep of decl.inject || []) {
  require_.resolve(dep + "/package.json");
  console.log("inject dep resolvable:", dep);
}
console.log("\nHOST-SIDE DISCOVERY: PASS");
