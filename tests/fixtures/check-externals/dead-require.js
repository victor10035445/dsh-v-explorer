/* fixture ①：死 require 未被声明覆盖 —— 配默认 package.json（无 dsh.client.inject）
 * 期望：退出码 1，指认 "@deepseek-ai/dsh-client-runtime/client" */
var react = require("react");
var store = require("@deepseek-ai/dsh-client-runtime/client");
export const unused = [react, store];
