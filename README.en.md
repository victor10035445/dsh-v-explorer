# dsh-v-explorer · V Explorer

[简体中文](README.md) | **English**

An **official side-panel extension** for DeepSeek Harness Web: takes over the official files tab as an extension to provide an enhanced file tree, and adds a bookmarks tab plus line-range reference excerpts. Purely additive — uninstalling or degrading restores the official tree. **Minimum DSH version: 0.1.5-rc.2**.

## Features

- **files tab** (takes over the official file tree): lazy directory loading, clicking a file opens the official preview via `openResource`, clicking a directory only expands; context menu — reveal in file manager / copy path / insert into session / add bookmark ★ / open HTML in default browser; dot-prefixed hidden entries are shown (no bookmarking)
- **bookmarks tab** (new tab): session-scoped bookmark list, each bookmark a virtual subtree root (lazy loading, independent expansion); stale bookmarks kept with strikethrough; shares one repository with the files tree (★ badge + right-click toggle); persisted at `<cwd>/.dsh-v-explorer/bookmarks.json` (limit 100, idempotent dedup), multi-tab sync via SSE
- **Change-feed auto refresh**: a managed stream following the official ChangeFeed semantics, 500ms debounced silent re-pull of expanded directories; visibility/focus fallbacks; directory reads handled by the official workspaceFiles Remote
- **Auto-expand** the official side panel for new sessions (low-frequency polling, only while installed)
- **"Reference" excerpts**: `引用<path>#start-end` syntax indexes a file range into the prompt; frozen at send time (`agent/pre-step` capture, failures degrade without failing the turn); send from session selection, managed by the composer chip bar (drafts via the official input facade)
- **Preview renderers**: Markdown Reader Pro theme and JSON prettify, rendered inside the official preview

## Install

```sh
dsh plugin --profile web add "github:victor10035445/dsh-v-explorer"        # direct install (recommended)
dsh plugin --profile web add "github:victor10035445/dsh-v-explorer#<sha>"  # pinned version
```

Local development:

```sh
git clone https://github.com/victor10035445/dsh-v-explorer.git
dsh plugin --profile web add "link:<clone path>"
```

**Restart `dsh web`** afterwards and refresh the page. For an installed environment, add `- insert: [{id: dsh-v-explorer, name: dsh-v-explorer}]` to `~/.dsh/profiles/web/cordis.patch.yml` to hot-reload (`patchReload: live`).

## Build from source

```sh
pnpm install
pnpm build        # esbuild: src/client.jsx → lib/client.js
pnpm check        # syntax check + externals drift check (check-externals.mjs)
```

## Architecture

| Module | Content |
|---|---|
| Host `lib/index.js` | remaining `/api/dsh-v-explorer/*` routes (open / open-browser / snapshot / bookmarks / events) + `agent/pre-step` excerpt capture; path safety: lexical + realpath double containment, escapes are 403 |
| Client `src/` | official side-panel tab takeover (files / bookmarks) + change-feed hub + reference excerpts + preview renderers, split into focused modules |
| `check-externals.mjs` | build-time externals drift check: every bare require in the bundle must resolve against the platform module table (seed word or declared), `dsh.client` declarations must not dangle |
| `build.mjs` | esbuild bundles into a factory; react and other seed deps stay external |

## Security

- Remaining routes and excerpt reads confined to the session cwd: lexical + realpath double validation, escapes 403; 10MB cap + binary detection
- The `.dsh-v-explorer/` data directory is fully hidden from git via the project's `.git/info/exclude` (idempotent, silent on failure, zero working-tree changes)
- SSE broadcasts bookmark-change events only — no file paths or other session information

## Files & validation

```
package.json / cordis.patch.yml   plugin manifest & loader insert entry
lib/                              host + client bundle + shared module (committed)
src/                              client sources (tabs / change feed / excerpts / renderers)
tests/                            runnable checks (Node, no browser)
```

```
pnpm check                           # syntax + externals drift check
node tests/check-externals-smoke.mjs # externals checker self-verification
node tests/auto-open-smoke.mjs       # side-panel auto-expand smoke
node tests/workspace-path-smoke.mjs  # session resource path utils smoke
node tests/renderer-logic-smoke.mjs  # preview renderer logic smoke
node tests/css-transform-smoke.mjs   # theme scope transform smoke
node tests/host-smoke.cjs            # host routes + excerpt capture + SSE smoke
node tests/bookmarks-smoke.mjs       # bookmark storage/API/SSE smoke
node tests/ref-shared-smoke.mjs      # reference syntax parse/slice smoke
node tests/verify-install.cjs        # install discovery check (requires profile install)
```

## License

MIT
