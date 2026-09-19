/* fixture ②：悬空 inject 声明 —— client.js 本身全 seed，
 * 但配套 package.json 声明 inject 指向安装树中不存在的包
 * 期望：退出码 1，指认 "@deepseek-ai/dsh-client-runtime" */
var react = require("react");
export const unused = react;
