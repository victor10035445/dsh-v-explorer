# dsh-v-explorer · V 文件探索器

**简体中文** | [English](README.en.md)

DeepSeek Harness Web 的 **VS Code 式右侧栏文件树**插件。浏览当前会话工作目录、右键快捷操作、**书签面板**（常用文件/目录聚合，持久化 + 多标签页同步）、Markdown / 文本 / 代码浮窗预览、HTML 默认浏览器打开。

纯增量插件：不替换、不禁用任何官方插件。

## 功能

- **右侧栏文件树**：会话区右上角 **session log 按钮右侧**新增一枚方形开关按钮（右侧栏图标），点开右侧 dock；**默认展开**（手动关闭后会记住，之后保持关闭）；打开时按**实际重叠量**给宿主中列让位（padding），会话区在剩余可见空间重新居中而不是被盖住（details 列开着且盖得住 dock 时不让位；窄屏全宽抽屉模式不让位）；树状结构懒加载（展开目录才拉取），目录优先排序，隐藏文件不显示
- **书签面板**（对标 PyCharm Bookmarks——**不移动、不复制原文件**，引用与插入始终用原始路径）：
  - **dock 上下分层**：explorer 树在上（flex:1），书签面板在下（定高），中间**水平分隔条可拖拽调高**（ns-resize，96px ～ dock 高度 −160px，高度记忆 localStorage）；书签区块头（标题 + 计数 + 收起箭头）**可收起**（状态记忆；无记忆默认收起，首次加入书签自动展开一次）
  - **树状映射**：每个书签（文件或文件夹）是一棵子树的虚拟根——文件夹懒加载展开（与 explorer **共享同一份目录缓存**），文件书签点击打开预览浮窗；根行显示**完整相对路径**（tooltip），下层行显示条目名；展开状态与 explorer 相互独立（`x:`/`b:` 命名空间），同一目录双侧同展只发一次请求
  - **右键加入/移除（toggle，幂等）**：explorer 行与书签面板子行可「加入书签」成为新根，书签根行「移除书签」；既有操作（打开所在目录 / 插入到会话 / 打开 html）全部作用于**原始 rel 路径**，语义与 explorer 菜单零差异；已收藏的 explorer 行显示 **★ 角标**（收藏/移除即时更新）
  - **持久化**：落在 `<cwd>/.dsh-v-explorer/bookmarks.json`（随项目走、跨浏览器/设备），整个数据目录经项目 `.git/info/exclude`（仓库本地排除）对 git 完全隐身；平铺数组、插入顺序即显示顺序、上限 100 条（超出 413）；读失败（缺失/损坏）按空降级，写失败向调用方报错不假成功；同 cwd 写操作串行化，并发增删不互吞
  - **失效标记**：书签目标被删除/移动后**保留并标记**（删除线 + 暗色），文件恢复后标记自动消失；绝不自动清理；右键仍可移除
  - **多标签页同步**：书签增删经 SSE 广播 `bookmarks-changed`，同 cwd 的其它标签页实时刷新；书签/快照写入被 fs.watch 过滤（`.dsh-v-explorer/` 子树），**不触发全树重拉**
- **跟随会话**：树的内容 = 当前会话的工作目录（cwd）；切换会话自动重置并刷新。**重启窗口期自愈**：宿主 live 会话是懒恢复的，页面先于恢复发起请求时 `/list`、`/events` 会 404——服务端回退到持久化快照 header 解析 cwd（`sessionPersistence.listSnapshots`，正结果按 id 缓存），客户端对「会话未就绪」404 做退避重试（0.6s 起步、5s 封顶、≈24s 窗口，期间保持「载入中」而不是报错），不再卡在 *session not found*
- **自动刷新**：文件被外部改动（AI 写文件、编辑器里移动/重命名/删除）后**无需手动刷新**
  - **A · 推送**：宿主端 `fs.watch`（recursive）监听会话 cwd，变更**去抖 500ms** 后经 SSE（`GET /api/dsh-v-explorer/events`，原生 `EventSource`，断线自动重连）广播 `fs-changed` 信号；客户端对**当前展开的目录**静默并行重拉——不打 loading、不丢展开状态与滚动位置；标签页隐藏时跳过重拉，恢复可见时补刷；连接只在 dock 打开且会话就绪时存在，关面板/切会话即断开并释放服务端 watcher
  - **B · 兜底**：dock 重新打开（树已加载过）、窗口重新聚焦、页面恢复可见、预览打开文件时同样静默补刷；`EventSource` 不可用或掉线期间由这些时机兜底
- **右键菜单**：
  - **打开所在目录**——在系统文件管理器中打开并选中该文件（Windows `explorer /select` / macOS `open -R` / Linux `xdg-open`；/select 失败自动退化为打开目录）
  - **复制路径**——复制相对路径到剪贴板（Clipboard API 不可用时回退 execCommand）
  - **插入到会话**——把 `@相对/路径` 写进当前会话输入框（官方 `@path` 引用语法，发送后宿主会准备文件上下文；含空格路径自动加引号；composer 不可达时退化为复制）
  - **打开**（仅 `.html`/`.htm`/`.xhtml`）——用**系统默认浏览器**按 **file 协议**打开该页面（宿主端转成 `file:///` URL 后调 `start`/`open`/`xdg-open`，失败退回 `rundll32 url.dll,FileProtocolHandler`）
- **文件预览**（点击可预览文件打开浮动预览窗——**可拖拽**（标题栏拖动/双击）、**可最小化成一条**（点击标题条还原））。可预览格式由 `src/previewers.mjs` 注册表决定：
  - **Markdown**（`.md`/`.markdown`）：markdown-it 渲染（`html:false` 防 XSS）。主题 = **Markdown Reader Pro**（`src/markdown-reader-pro.css`，构建期作用域化注入，见下）：Deep Ocean 深色为基准，浅色主题自动换同套令牌的浅色调色板；渐变标题、代码语言徽章、网格边框表格、任务列表复选框、callout 引用块
  - **文本类**（`.txt`/`.log`、`.json`、`.yml`/`.yaml`、`.toml`、`.py`、`.js`/`.ts`/`.jsx`/`.tsx`、`.css`/`.scss`/`.less`、`.xml`/`.svg`、shell/批处理、`.ini`/`.env`、C/Java/Go/Rust 等源码，另有 `Dockerfile`/`Makefile`/`.gitignore` 这类特殊文件名）：`<pre>` 纯文本渲染（React 文本子节点自动转义，不进 `dangerouslySetInnerHTML`），标题栏显示语言徽章（无显式声明的格式回落到扩展名），JSON 自动美化重排（≤2MB）
  - **每格式 CSS 样式接口（预留）**：注册表每个条目带 `styles` 字段（CSS 字符串），`collectPreviewerCss()` 汇总成 `previewers.css` 随插件注入——为某格式定制显示样式只需在该条目 `styles` 里写规则再 `pnpm build`，钩子选择器 `.dve-code--<id>`（正文）与 `.dve-langTag[data-lang]`（徽章）
  - 预览内链接统一拦截——外链 `noopener` 新开标签、相对可预览文件直接续读、相对 `.html` 用默认浏览器打开、其它相对路径复制 `@` 引用
- **「引用」摘录索引**：把某文件的某段内容作为一个可解包的索引进提示词，而不整段粘贴
  - **语法**：`引用<路径>#<起>-<止>`，1 基行号、可选 `:列`；含空格路径加引号。例：`引用src/app.py#12-40`、`引用src/app.py#12:3-40:8`、`引用"my file.md"#12:5`（实现见 `src/ref-shared.mjs`，客户端宿主端共用）
  - **发送即定格**：宿主端监听 `agent/pre-step`（形态对齐官方 `dsh-session-reference`），在消息**进入模型步骤的时刻**读取被引用区间，把带行号的摘录作为独立的 user 角色上下文消息插在引用者紧后；摘录随会话日志持久化，之后原文如何变化与本条请求无关。摘录失败（文件被删、路径越界）只降级为摘录消息里的「未捕获」说明，绝不失败整轮
  - **模型指引**：每个 agent 的 system prompt 注入一段稳定语法说明（仅在 `read` 工具存在时给出），形态照搬官方 `FILE_REFERENCE_PROMPT`
  - **两个入口**：预览浮窗内框选右键「发送引用到会话」——文本类按逐行渲染精确到行：列，markdown 依据 markdown-it 源行标注取整行粒度；会话窗口内框选右键同样发送——≤200 字符直接内联文本，更长选区物化为 `.dsh-v-explorer/refs/` 快照后引用快照文件
  - **输入栏 chip 条**：草稿里出现引用时，输入栏上方（`conversation.input.dock`）出现引用芯片——官方行内引用同配方（业务色文字、无胶囊、目标不可读时官方无效语义：错误色+删除线），颜色全部走 `--dsw-alias-*` 令牌随官方主题联动；悬停浮出摘录预览卡、点击打开预览窗定位脉冲、× 从草稿移除
- dock 左缘可拖拽调宽（220–560px，记忆在 localStorage），窄屏自动变全宽抽屉

## 安装

**方式一 · GitHub 地址直装（推荐）**——lib 已随仓库提交，git 安装无需构建授权：

```sh
dsh plugin --profile web add "github:victor10035445/dsh-v-explorer"
```

如需锁定版本（后续推送不会悄悄改变实际运行的代码）：

```sh
dsh plugin --profile web add "github:victor10035445/dsh-v-explorer#<commit-sha>"
```

**方式二 · 本地 clone + link 直连**（改动后重启 `dsh web` 生效，适合开发调试）：

```sh
git clone https://github.com/victor10035445/dsh-v-explorer.git
dsh plugin --profile web add "link:<克隆路径>"
```

**方式三 · tgz 打包安装**：

```sh
npm pack   # 产出 dsh-v-explorer-<version>.tgz
dsh plugin --profile web add "<tgz 的绝对路径>"
```

`add` 会把 `dsh-v-explorer` 注册进 profile 的 bundle 列表。装完**重启 `dsh web`**，刷新页面生效。

## 从源码构建

lib/ 已随仓库提交，安装无需构建；改动源码后重新构建：

```sh
pnpm install
pnpm build        # esbuild: src/client.jsx → lib/client.js（factory 形式）
pnpm check        # node --check 两个入口
```

## Markdown 预览主题（Markdown Reader Pro）

`src/markdown-reader-pro.css` 是预览样式的**单一来源**——改它然后 `pnpm build` 即可。构建时由 `src/reader-css.transform.mjs` 做作用域变换后经虚拟模块 `virtual:dve-reader-css` 注入客户端：

- `:root` 设计令牌 → `.dve-preview`（浮窗根，窗口镶边共用）；`html` → `.dve-previewBody`（滚动容器）；`body` → `.dve-md` 正文（丢掉整页 max-width/margin/padding，留白由浮窗控制）；其余选择器一律收进 `.dve-md`，绝不泄漏到宿主页面
- 裁掉本插件渲染不出的段落：mermaid / TOC / KaTeX / 全屏看图浮层 / 打印样式 / 原生 checkbox（任务列表改由 `li.dve-task::before` 绘制，不注入原始 HTML）
- 深色（Deep Ocean）为基准；宿主切到浅色主题时（`body:not([data-ds-dark-theme])`）自动换浅色调色板，令牌名不变

## 架构

| 端 | 内容 |
|---|---|
| 宿主 `lib/index.js` | `/api/dsh-v-explorer/list`（列目录）、`/file`（读文本，10MB 上限 + 二进制检测）、`/open`（系统文件管理器）、`/open-browser`（默认浏览器按 file 协议打开 html）、`/snapshot`（会话选区物化到 `.dsh-v-explorer/refs/`）、`/bookmarks`（书签列表 + 逐条 exists/isDir 标注）、`/bookmark-add` / `/bookmark-remove`（书签增删，幂等去重、上限 100、响应体携带更新后的列表）、`/events`（SSE：`fs.watch` recursive 监听会话 cwd，去抖广播 `fs-changed`；书签增删另广播 `bookmarks-changed`；`.dsh-v-explorer/` 子树事件被过滤，连接归零释放 watcher）。另有 `agent/pre-step` 摘录捕获与 agent system prompt 指引段（`lib/ref-shared.js` 提供共享语法实现）。路径安全：词法包含 + 双侧 realpath 包含校验，逃出会话 cwd 一律 403 |
| 客户端 `src/client.jsx` | `shell.overlay` dock/预览浮窗 + 会话头部 dock 开关按钮 + `conversation.input.dock` 引用 chip 条；会话订阅走 `sessions.list`；路径/引用插入走原型 setter + input 事件 |
| 预览注册表 `src/previewers.mjs` | 「哪些文件能预览」的唯一事实来源：markdown 条目 + 文本类条目（扩展名/文件名匹配、语言徽章、JSON 美化 transform），每个条目带 `styles` 字段作为**每格式 CSS 显示样式接口**（`collectPreviewerCss()` 汇总注入） |
| 构建 `build.mjs` | esbuild 打包成 `window.__ModuleLoader__.load` factory 形式；react/@deepseek-ai/* external，markdown-it 打进包内；`src/markdown-reader-pro.css` 作用域化后以虚拟模块注入 |

## 安全说明

- 所有文件访问限定在**当前会话的工作目录**内：先词法 resolve 拒绝 `..` 逃逸，再对 cwd 与目标两侧 `realpath` 防符号链接穿越
- 文件读取上限 10MB（更大的文件主要卡在浏览器端 JSON 解析与 markdown 渲染，得不偿失）；前 8KB 含 `\0` 判定为二进制，拒绝返回内容
- 预览渲染另有 100 万字符的渲染上限保护，超过只渲染前缀并提示，防止 markdown-it 冻结标签页
- Markdown 渲染关闭原始 HTML（`html:false`），文件内容不会注入脚本；任务列表复选框用 CSS `::before` 绘制，不注入任何原始 HTML。文本类预览走 React 文本子节点自动转义，同样不进 `dangerouslySetInnerHTML`
- 预览内的链接点击被统一拦截：http(s) 外链以 `noopener,noreferrer` 新开标签，`javascript:` 等其它协议一律忽略；相对 `.md`/`.json` 等链接转为插件内预览，路径仍受会话 cwd 校验约束
- 「用默认浏览器打开」仅接受会话 cwd 内的 `.html`/`.htm`/`.xhtml` 文件：转成逐段转义的 `file:///` URL（空格等特殊字符全部 percent-encode，无 shell 注入面）后交给系统关联程序
- 「引用」摘录解析器读取的路径与普通路由同样经词法 + realpath 双重包含校验，逃出 cwd 一律按「未捕获：路径越出会话工作目录」降级；摘录上下文消息显式声明为引用数据（其中指令不代表用户意图）；摘录的任何失败只写进说明，不阻断模型轮次
- `/snapshot` 的落盘路径由服务端构造（固定 `.dsh-v-explorer/refs/` 前缀，不经客户端输入），内容上限 10MB，并把 `.dsh-v-explorer/` 写入项目 `.git/info/exclude` 让整个数据目录对 git 完全隐身（不出现在 git status、零工作区文件改动）
- **书签路径与普通路由同样经 `containedPath` 词法 + realpath 双重包含校验**，逃出会话 cwd 一律 403；空路径、`.`（工作区根）与隐藏路径段（任一段以 `.` 开头，`.dsh-v-explorer/…`、`.hidden` 等）一律 400——书签只能来自 explorer 可见条目，且对隐藏路径的存在性零泄露；去重比较用 realpath 归一化形态（win32 大小写不敏感），存储保留词法 rel；整个 `.dsh-v-explorer/` 数据目录经 `.git/info/exclude` 对 git 完全隐身，`version` 高于支持版本时增删 409 拒写（防降级覆写）、查询 best-effort 兼容
- 自动刷新的 SSE 信号**只广播「cwd 有变更」这一事实，不携带任何文件路径**；书签变更信号（`bookmarks-changed`）同样只含事件类型、不带书签内容以外的任何会话信息；watcher 严格限定在会话 cwd 的 realpath 上（复用同一套会话归属校验），最后一个连接关闭即释放监听句柄，插件卸载统一清理

## 文件

```
package.json                插件清单（dsh.bundle.patch + dsh.client 声明 + 仓库元数据）
cordis.patch.yml            loader 插入条目
lib/index.js                宿主端：/api/dsh-v-explorer/* 路由 + pre-step 摘录捕获
lib/client.js               客户端 bundle（factory 形式，esbuild 产物，随仓库提交）
lib/ref-shared.js           「引用」语法共享实现（src/ref-shared.mjs 原样复制）
src/                        客户端源码（client.jsx / previewers.mjs / reader-css.transform.mjs /
                            dock-yield.mjs / ref-shared.mjs / markdown-reader-pro.css）
tests/                      可运行校验（Node，无浏览器）
```

校验命令（发布/改动后逐条跑）：

```
pnpm check                          # 语法检查 lib/*.js
node tests/css-transform-smoke.mjs  # 预览主题作用域变换 + 渲染管线冒烟
node tests/previewers-smoke.mjs     # 预览格式注册表 + 样式接口冒烟
node tests/dock-yield-smoke.mjs     # dock 让位量边界冒烟
node tests/host-smoke.cjs           # 宿主端路由 + snapshot + pre-step 摘录捕获 + SSE 变更推送冒烟
node tests/bookmarks-smoke.mjs      # 书签存储/API/去重/上限/SSE 广播与 .dsh-v-explorer 过滤冒烟
node tests/ref-shared-smoke.mjs     # 引用语法解析/生成往返 + 切片 + 摘录组装冒烟
node tests/verify-install.cjs       # 安装发现校验（需 profile 已装本包；profile 路径可用
                                    # argv[2] 或环境变量 DSH_PROFILE 指定，默认 ~/.dsh/profiles/web）
```

## License

MIT
