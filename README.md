# dsh-v-explorer · V 文件探索器

**简体中文** | [English](README.en.md)

DeepSeek Harness Web 的**官方右侧栏扩展插件**：以 extension 接管官方 files 页型提供增强文件树，新增书签页型与行区间引用摘录。纯增量——卸载/降级即恢复官方树。**最低 DSH 版本：0.1.5-rc.2**。

## 功能

- **files tab**（接管官方文件树）：目录懒加载、点文件 `openResource` 进官方预览、点目录仅展开；右键菜单——打开所在目录 / 复制路径 / 插入到会话 / 加书签★ / 默认浏览器打开 HTML；`. 开头`隐藏段照常显示（不提供书签）
- **bookmarks tab**（新增页型）：会话作用域书签列表，每个书签是子树虚拟根（懒加载、展开状态独立）；失效书签保留并删除线标记；与 files 树身共享同一仓库（★ 角标 + 右键 toggle 双入口）；持久化 `<cwd>/.dsh-v-explorer/bookmarks.json`（上限 100、幂等去重），多标签页经 SSE 实时同步；书签子树随变更流同步（展开层静默重拉 + absent 即时摘除，与文件树同一节奏）
- **变更流自动刷新**：经官方 ChangeFeed 语义自建托管流，500ms 去抖静默重拉展开目录（files 树身与书签 tab 共用同一编排）；absent 即时摘除、可见性 / focus 兜底；目录读取由官方 workspaceFiles Remote 承担
- **进入会话自动展开**官方右侧栏并常开 files + bookmarks 两页（最常用页型随展开就位，files 保持前台）：每次进入（新建/切入/切回/刷新恢复）都展开，状态驱动 + 重试对挂载时序健壮；无跨会话关闭记忆——手动收起仅作用于当前会话，停留期间不被争抢（低频轮询，仅存续期运行）；**默认宽度**落定契约最小 300px（官方首开播种视口 45% 过宽，经官方同路写入口预置，会话内拖拽宽度照常被尊重）
- **「引用」摘录**：`引用<路径>#起-止` 语法把文件区间索引进提示词；`agent/pre-step` 捕获即定格，失败只降级不失败整轮；会话框选发送，composer chip 条实时管理（经官方 input facade 读写草稿）
- **预览渲染器**：Markdown Reader Pro 主题与 JSON 美化，供官方预览渲染

## 安装

```sh
dsh plugin --profile web add "github:victor10035445/dsh-v-explorer"        # 直装（推荐）
dsh plugin --profile web add "github:victor10035445/dsh-v-explorer#<sha>"  # 锁定版本
```

本地开发：

```sh
git clone https://github.com/victor10035445/dsh-v-explorer.git
dsh plugin --profile web add "link:<克隆路径>"
```

装完**重启 `dsh web`**，刷新页面生效。已装环境也可在 `~/.dsh/profiles/web/cordis.patch.yml` 加 `- insert: [{id: dsh-v-explorer, name: dsh-v-explorer}]` 热重载（`patchReload: live`）。

## 从源码构建

```sh
pnpm install
pnpm build        # esbuild: src/client.jsx → lib/client.js
pnpm check        # 语法检查 + externals 漂移检查（check-externals.mjs）
```

## 架构

| 模块 | 内容 |
|---|---|
| 宿主 `lib/index.js` | `/api/dsh-v-explorer/*` 保留路由（open / open-browser / snapshot / bookmarks / events）+ `agent/pre-step` 摘录捕获；路径安全：词法 + realpath 双重包含校验，越界一律 403 |
| 客户端 `src/` | 官方侧栏 tab 接管（files / bookmarks）+ 变更流枢纽 + 引用摘录 + 预览渲染器；按职责拆分为独立模块 |
| `check-externals.mjs` | 构建期 externals 漂移检查：bundle 的全部裸 require 必须命中平台模块表（seed word 或已声明），`dsh.client` 声明不得悬空 |
| `build.mjs` | esbuild 打包成 factory 形式；react 等 seed 依赖 external |

## 安全

- 保留路由与摘录读取限定会话 cwd 内：词法 + realpath 双重校验，逃逸 403；10MB 上限 + 二进制检测
- 数据目录 `.dsh-v-explorer/` 经项目 `.git/info/exclude` 对 git 完全隐身（幂等、失败静默、零工作区改动）
- SSE 只广播书签变更事件，不携带文件路径等会话信息

## 文件与校验

```
package.json / cordis.patch.yml   插件清单与 loader 插入条目
lib/                              宿主端 + 客户端 bundle + 共享模块（随仓库提交）
src/                              客户端源码（tab / 变更流 / 引用 / 渲染器等模块）
tests/                            可运行校验（Node，无浏览器）
```

```
pnpm check                           # 语法检查 + externals 漂移检查
node tests/check-externals-smoke.mjs # externals 检查器自验证
node tests/auto-open-smoke.mjs       # 侧栏自动展开冒烟
node tests/workspace-path-smoke.mjs  # 会话资源地址/路径工具冒烟
node tests/renderer-logic-smoke.mjs  # 预览渲染器逻辑冒烟
node tests/css-transform-smoke.mjs   # 主题作用域变换冒烟
node tests/host-smoke.cjs            # 宿主端路由 + 摘录捕获 + SSE 冒烟
node tests/bookmarks-smoke.mjs       # 书签存储/API/SSE 冒烟
node tests/ref-shared-smoke.mjs      # 引用语法解析/切片冒烟
node tests/verify-install.cjs        # 安装发现校验（需 profile 已装本包）
```

## License

MIT
