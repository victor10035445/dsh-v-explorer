/* fixture ④：非 seed require 被合法覆盖 —— require dsh-client-locale/client，
 * 配套 package.json inject 声明该裸名；落点（平台安装树）存在且带 client 半部
 * 期望：退出码 0 */
var react = require("react");
var locale = require("@deepseek-ai/dsh-client-locale/client");
export const unused = [react, locale];
