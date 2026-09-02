# dsh-v-explorer · V Explorer

[简体中文](README.md) | **English**

A **VS Code-style side-panel file tree** plugin for DeepSeek Harness Web. Browse the current session's working directory, right-click quick actions, a **bookmark panel** (aggregate frequently used files/directories, persisted + multi-tab sync), Markdown / text / code floating previews, and open HTML in the default browser.

Purely additive plugin: replaces or disables nothing from the official set.

## Features

- **Side-panel file tree**: a square toggle button (side-panel icon) next to the **session log button** in the session header opens the right dock; **open by default** (remembered once manually closed); while open, the host center column yields by the **actual overlap amount** (padding) so the session area re-centers in the remaining visible space instead of being covered (no yield when the details column is open and covers the dock; no yield in narrow-screen full-width drawer mode); lazy-loading tree (fetch on directory expand), directories first, hidden files filtered out
- **Bookmark panel** (modeled after PyCharm Bookmarks — **never moves or copies files**; references and insertions always use original paths):
  - **Layered dock**: explorer tree on top (flex:1), bookmark panel below (fixed height), with a **draggable horizontal splitter** (ns-resize, 96px to dock height −160px, height remembered in localStorage); the bookmark section header (title + count + collapse arrow) **is collapsible** (state remembered; defaults to collapsed without memory, auto-expands once on first bookmark)
  - **Tree mapping**: every bookmark (file or folder) is a virtual root of a subtree — folders lazy-expand (sharing the **same directory cache** as explorer), file bookmarks open the preview window on click; root rows show the **full relative path** (tooltip), child rows show entry names; expansion state is independent from explorer (`x:`/`b:` namespaces), and simultaneously expanding the same directory on both sides sends only one request
  - **Right-click add/remove (toggle, idempotent)**: explorer rows and bookmark child rows can "add bookmark" as a new root; bookmark roots can "remove bookmark"; existing actions (reveal in file manager / insert into session / open html) all operate on the **original rel path**, semantically identical to the explorer menu; bookmarked explorer rows show a **★ badge** (updated instantly)
  - **Persistence**: stored at `<cwd>/.dsh-v-explorer/bookmarks.json` (travels with the project, across browsers/devices); the whole data directory is fully hidden from git via the project's `.git/info/exclude` (repo-local exclude); flat array, insertion order = display order, limit 100 entries (413 beyond); read failures (missing/corrupt) degrade to empty, write failures report to the caller without fake success; writes per cwd are serialized so concurrent add/remove never lose entries
  - **Stale markers**: bookmarks whose target was deleted/moved are **kept and marked** (strikethrough + dimmed); the marker disappears automatically once the file returns; never auto-cleaned; still removable via right-click
  - **Multi-tab sync**: bookmark add/remove broadcasts `bookmarks-changed` over SSE, other tabs on the same cwd refresh in real time; bookmark/snapshot writes are filtered out by fs.watch (`.dsh-v-explorer/` subtree), **never triggering a full tree re-pull**
- **Follows the session**: tree contents = current session's working directory (cwd); switching sessions resets and refreshes automatically. **Restart-window self-healing**: host live sessions are lazily restored, so requests issued before recovery get 404 from `/list` and `/events` — the server falls back to the persisted snapshot header to resolve cwd (`sessionPersistence.listSnapshots`, positive results cached by id), and the client retries "session not ready" 404s with backoff (0.6s start, 5s cap, ≈24s window, showing "loading" instead of an error), never stuck on *session not found*
- **Auto refresh**: external file changes (AI writes files, moves/renames/deletes in an editor) require **no manual refresh**
  - **A · Push**: the host `fs.watch`es (recursive) the session cwd and broadcasts an `fs-changed` signal via SSE (`GET /api/dsh-v-explorer/events`, native `EventSource`, auto-reconnect) after a **500ms debounce**; the client silently re-pulls **currently expanded directories** in parallel — no loading state, no loss of expansion or scroll position; skips re-pull while the tab is hidden, catches up when visible again; the connection exists only while the dock is open and the session is ready, closing it (and releasing the server watcher) when the panel closes or the session switches
  - **B · Fallback**: dock re-open (tree already loaded), window re-focus, page becoming visible, preview opening a file — all trigger the same silent refresh; covers periods when `EventSource` is unavailable or disconnected
- **Context menu**:
  - **Reveal in file manager** — opens the system file manager with the file selected (Windows `explorer /select` / macOS `open -R` / Linux `xdg-open`; falls back to opening the directory if /select fails)
  - **Copy path** — copies the relative path (falls back to execCommand when the Clipboard API is unavailable)
  - **Insert into session** — writes `@relative/path` into the current session composer (official `@path` reference syntax; the host prepares file context on send; paths with spaces are quoted automatically; degrades to copy when the composer is unreachable)
  - **Open** (only `.html`/`.htm`/`.xhtml`) — opens the page in the **system default browser** via the **file protocol** (host converts to a `file:///` URL then calls `start`/`open`/`xdg-open`, falling back to `rundll32 url.dll,FileProtocolHandler`)
- **File preview** (clicking a previewable file opens a floating preview window — **draggable** (title-bar drag/double-click) and **minimizable to a strip** (click the title bar to restore)). Previewable formats are decided by the `src/previewers.mjs` registry:
  - **Markdown** (`.md`/`.markdown`): rendered by markdown-it (`html:false` against XSS). Theme = **Markdown Reader Pro** (`src/markdown-reader-pro.css`, scope-transformed at build time, see below): Deep Ocean dark baseline, light themes automatically switch to a light palette of the same tokens; gradient headings, code language badges, grid-bordered tables, task-list checkboxes, callout quotes
  - **Text formats** (`.txt`/`.log`, `.json`, `.yml`/`.yaml`, `.toml`, `.py`, `.js`/`.ts`/`.jsx`/`.tsx`, `.css`/`.scss`/`.less`, `.xml`/`.svg`, shell/batch, `.ini`/`.env`, C/Java/Go/Rust sources, plus special filenames like `Dockerfile`/`Makefile`/`.gitignore`): plain `<pre>` rendering (auto-escaped as React text children, never `dangerouslySetInnerHTML`), language badge in the title bar (falls back to extension), automatic JSON prettify (≤2MB)
  - **Per-format CSS style interface (reserved)**: each registry entry carries a `styles` field (CSS string); `collectPreviewerCss()` aggregates them into `previewers.css` injected with the plugin — to customize a format's display, write rules into that entry's `styles` and run `pnpm build`; hook selectors `.dve-code--<id>` (body) and `.dve-langTag[data-lang]` (badge)
  - Links inside previews are uniformly intercepted — external links open in a new tab with `noopener`, relative previewable files continue in-preview, relative `.html` opens in the default browser, other relative paths copy the `@` reference
- **"Reference" excerpt index**: index a specific range of a file into the prompt instead of pasting the whole thing
  - **Syntax**: `引用<path>#<start>-<end>`, 1-based line numbers, optional `:col`; quote paths containing spaces. Examples: `引用src/app.py#12-40`, `引用src/app.py#12:3-40:8`, `引用"my file.md"#12:5` (implementation in `src/ref-shared.mjs`, shared by client and host)
  - **Frozen at send time**: the host listens on `agent/pre-step` (shaped after the official `dsh-session-reference`) and reads the referenced range at the moment the message **enters the model step**, inserting the line-numbered excerpt as a separate user-role context message right after the referrer; the excerpt is persisted with the session log, so later changes to the source don't affect this request. Excerpt failures (file deleted, out-of-range) degrade to an "uncaptured" note — never failing the whole turn
  - **Model guidance**: a stable syntax note is injected into every agent's system prompt (only when the `read` tool exists), shaped after the official `FILE_REFERENCE_PROMPT`
  - **Two entry points**: select-then-right-click "send reference to session" inside the preview window — text formats map precisely to line:column via per-line rendering, markdown takes whole-line granularity from markdown-it source annotations; the same gesture works in the session window — selections ≤200 chars are inlined directly, longer selections are materialized as `.dsh-v-explorer/refs/` snapshots referenced by file
  - **Composer chip bar**: when the draft contains references, a chip bar appears above the input (`conversation.input.dock`) — same recipe as official inline references (business-color text, no capsule, error color + strikethrough when unreadable), colors all via `--dsw-alias-*` tokens following the official theme; hover shows an excerpt preview card, click opens the preview window with a location pulse, × removes it from the draft
- The dock's left edge is drag-resizable (220–560px, remembered in localStorage); narrow screens switch to a full-width drawer

## Install

**Option 1 · Install from GitHub (recommended)** — `lib/` is committed to the repo, so git installs need no build authorization:

```sh
dsh plugin --profile web add "github:victor10035445/dsh-v-explorer"
```

To pin a version (later pushes won't silently change the running code):

```sh
dsh plugin --profile web add "github:victor10035445/dsh-v-explorer#<commit-sha>"
```

**Option 2 · Local clone + link** (live edits after restarting `dsh web`, good for development):

```sh
git clone https://github.com/victor10035445/dsh-v-explorer.git
dsh plugin --profile web add "link:<clone path>"
```

**Option 3 · tgz package install**:

```sh
npm pack   # produces dsh-v-explorer-<version>.tgz
dsh plugin --profile web add "<absolute path to the tgz>"
```

`add` registers `dsh-v-explorer` into the profile's bundle list. **Restart `dsh web`** afterwards and refresh the page.

## Build from source

`lib/` is committed, so installation needs no build; rebuild after changing sources:

```sh
pnpm install
pnpm build        # esbuild: src/client.jsx → lib/client.js (factory form)
pnpm check        # node --check on both entry points
```

## Markdown preview theme (Markdown Reader Pro)

`src/markdown-reader-pro.css` is the **single source** of the preview styles — edit it and run `pnpm build`. At build time `src/reader-css.transform.mjs` scope-transforms it and injects it via the virtual module `virtual:dve-reader-css`:

- `:root` design tokens → `.dve-preview` (floating window root, shared by window chrome); `html` → `.dve-previewBody` (scroll container); `body` → `.dve-md` content (page-level max-width/margin/padding dropped, whitespace controlled by the window); all other selectors are scoped under `.dve-md`, never leaking into the host page
- Sections this plugin can't render are dropped: mermaid / TOC / KaTeX / fullscreen image overlay / print styles / native checkboxes (task-list checkboxes are drawn by `li.dve-task::before`, no raw HTML injected)
- Dark (Deep Ocean) is the baseline; when the host switches to a light theme (`body:not([data-ds-dark-theme])`) the palette switches automatically, token names unchanged

## Architecture

| Side | Content |
|---|---|
| Host `lib/index.js` | `/api/dsh-v-explorer/list` (list directory), `/file` (read text, 10MB cap + binary detection), `/open` (system file manager), `/open-browser` (open html via file protocol in default browser), `/snapshot` (materialize session selections into `.dsh-v-explorer/refs/`), `/bookmarks` (bookmark list + per-entry exists/isDir), `/bookmark-add` / `/bookmark-remove` (add/remove, idempotent dedup, limit 100, response carries updated list), `/events` (SSE: `fs.watch` recursive on session cwd, debounced `fs-changed`; bookmark changes also broadcast `bookmarks-changed`; `.dsh-v-explorer/` subtree events filtered, watcher released when connections drop to zero). Also `agent/pre-step` excerpt capture and the agent system-prompt guidance section (`lib/ref-shared.js` provides the shared syntax). Path safety: lexical containment + two-sided realpath containment; escaping the session cwd is always 403 |
| Client `src/client.jsx` | `shell.overlay` dock/preview window + session-header dock toggle + `conversation.input.dock` reference chip bar; session subscription via `sessions.list`; path/reference insertion via prototype setter + input events |
| Preview registry `src/previewers.mjs` | Single source of truth for "what is previewable": markdown entry + text entries (extension/filename matching, language badges, JSON prettify transform), each entry carrying a `styles` field as the **per-format CSS display interface** (aggregated by `collectPreviewerCss()`) |
| Build `build.mjs` | esbuild bundles into a `window.__ModuleLoader__.load` factory; react/@deepseek-ai/* external, markdown-it bundled in; `src/markdown-reader-pro.css` scope-transformed and injected as a virtual module |

## Security notes

- All file access is confined to **the current session's working directory**: lexical resolve first rejects `..` escapes, then both sides are `realpath`ed against symlink traversal
- File reads are capped at 10MB (larger files mostly choke browser-side JSON parsing and markdown rendering anyway); the first 8KB containing `\0` is treated as binary and refused
- Preview rendering has a 1M-character cap; beyond it only a prefix renders with a notice, preventing markdown-it from freezing the tab
- Markdown rendering disables raw HTML (`html:false`); file content never injects scripts; task-list checkboxes are drawn with CSS `::before`, no raw HTML injected. Text previews go through React text-child auto-escaping, also never `dangerouslySetInnerHTML`
- Link clicks inside previews are uniformly intercepted: http(s) external links open in a new tab with `noopener,noreferrer`, other protocols like `javascript:` are ignored; relative `.md`/`.json` etc. links become in-plugin previews, still constrained by session cwd validation
- "Open in default browser" only accepts `.html`/`.htm`/`.xhtml` files inside the session cwd: converted to a per-segment-escaped `file:///` URL (spaces and special characters percent-encoded, no shell injection surface) handed to the system association
- The "reference" excerpt parser reads paths through the same lexical + realpath double containment as normal routes; escapes degrade to "uncaptured: path escapes the session workspace"; the excerpt context message explicitly declares itself as reference data (instructions within do not represent user intent); any excerpt failure only writes a note, never blocking the model turn
- `/snapshot` target paths are constructed server-side (fixed `.dsh-v-explorer/refs/` prefix, never from client input), content capped at 10MB; `.dsh-v-explorer/` is added to the project's `.git/info/exclude` so the whole data directory is fully invisible to git (never in git status, zero working-tree file changes)
- **Bookmark paths go through the same `containedPath` lexical + realpath double containment**; escaping the session cwd is 403; empty paths, `.` (workspace root) and hidden path segments (any segment starting with `.`, e.g. `.dsh-v-explorer/…`, `.hidden`) are 400 — bookmarks can only come from explorer-visible entries, with zero leakage of hidden-path existence; dedup compares realpath-normalized forms (case-insensitive on win32), storage keeps the lexical rel; the whole `.dsh-v-explorer/` data directory is fully hidden from git via `.git/info/exclude`; `version` newer than supported refuses writes with 409 (anti-downgrade overwrite), queries are best-effort compatible
- The auto-refresh SSE signal **broadcasts only the fact that "the cwd changed", carrying no file paths**; the bookmark change signal (`bookmarks-changed`) likewise carries only the event type and no session information beyond bookmark contents; the watcher is strictly limited to the session cwd's realpath (reusing the same session-ownership validation), the listening handle is released when the last connection closes, and plugin unmount cleans up everything

## Files

```
package.json                plugin manifest (dsh.bundle.patch + dsh.client declaration + repo metadata)
cordis.patch.yml            loader insert entry
lib/index.js                host side: /api/dsh-v-explorer/* routes + pre-step excerpt capture
lib/client.js               client bundle (factory form, esbuild output, committed)
lib/ref-shared.js           "reference" syntax shared implementation (copied verbatim from src/ref-shared.mjs)
src/                        client sources (client.jsx / previewers.mjs / reader-css.transform.mjs /
                            dock-yield.mjs / ref-shared.mjs / markdown-reader-pro.css)
tests/                      runnable checks (Node, no browser)
```

Validation commands (run each after changes/releases):

```
pnpm check                          # syntax check lib/*.js
node tests/css-transform-smoke.mjs  # preview theme scope transform + render pipeline smoke
node tests/previewers-smoke.mjs     # preview format registry + style interface smoke
node tests/dock-yield-smoke.mjs     # dock yield boundary smoke
node tests/host-smoke.cjs           # host routes + snapshot + pre-step excerpt capture + SSE push smoke
node tests/bookmarks-smoke.mjs      # bookmark storage/API/dedup/limit/SSE broadcast + .dsh-v-explorer filter smoke
node tests/ref-shared-smoke.mjs     # reference syntax parse/build round-trip + slicing + excerpt assembly smoke
node tests/verify-install.cjs       # install discovery check (requires the package installed in a profile;
                                    # profile path via argv[2] or DSH_PROFILE env, default ~/.dsh/profiles/web)
```

## License

MIT
