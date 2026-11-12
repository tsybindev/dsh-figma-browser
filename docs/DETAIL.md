# Figma browser

Read Figma designs from the user's own Chrome session: exact node data and true renders, with no Figma API token, no paid seat, and no Dev Mode.

## What it does

The Figma web editor keeps the real plugin API reachable inside the page as `window.figma` — `getNodeById`, `root`, `currentPage`, `exportAsync`, `variables`, and the rest. This plugin starts Chrome on a **copy of the user's profile**, so that session is already signed in, attaches to the editor over the Chrome DevTools Protocol, and asks the editor for the data. That is why no Figma credential is needed and why designs stay readable on free plans.

Four tools are registered:

| Tool | Purpose |
|---|---|
| `figma_browser` | `status`, `start`, `stop`, and `open <url>` for the dedicated browser |
| `figma_list` | pages of the open file, node search by name, current selection |
| `figma_node` | one node: position, size, auto layout, radius, fills, gradients, strokes, effects, text and font, children; optional PNG or SVG render |
| `figma_view` | select a node and screenshot the editor, so the user sees what the agent touched |

`figma_eval` is registered only when `allowEval: true`; it runs custom JavaScript in the editor page.

## How it works

1. Chrome is started with `--remote-debugging-port` on a data directory seeded from the real profile (`Local State`, `Cookies`, `Local Storage`, `IndexedDB`, …). Since Chrome 136 the debugging switches are ignored on the default data directory, so a copy is the only way to keep cookies.
2. Headless launches use an ordinary Chrome User-Agent, because Figma's CDN answers `403 Request blocked` to the `HeadlessChrome` token.
3. The plugin attaches to the editor tab over CDP with the platform `WebSocket` and evaluates a small serializer against `window.figma`.
4. Renders come from `node.exportAsync`, so the PNG or SVG is produced by Figma itself.

There are no runtime dependencies: no Playwright, no Puppeteer, no downloaded browsers.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `port` | `9333` | DevTools port; only `127.0.0.1` is bound |
| `headless` | `false` | Launch without a visible window; the user cannot watch actions then |
| `autoStart` | `true` | Start the browser when a Figma tool runs and none is up |
| `allowEval` | `false` | Register `figma_eval` |
| `chromePath` | auto-detect | Chrome executable |
| `sourceProfile` | auto-detect | Real Chrome user-data directory to copy once |
| `profileDir` | `~/.dsh/figma-browser/profile` | Where the copy lives |
| `outputDir` | `~/.dsh/figma-browser/out` | Where JSON and renders are written |
| `userAgent` | auto-detect | Headless User-Agent override |
| `startupTimeoutMs` | `20000` | Browser start budget |
| `extraArgs` | `[]` | Extra Chrome switches, e.g. `--no-sandbox` in a container |

## Usage

```
figma_browser { "action": "open", "url": "https://www.figma.com/design/<file>?node-id=25-147" }
figma_list    { "action": "pages" }
figma_list    { "action": "search", "query": "Кнопка" }
figma_node    { "nodeId": "25:261" }
figma_node    { "nodeId": "25:148", "render": true, "scale": 2 }
figma_view    { "nodeId": "25:261" }
```

`figma_node` accepts the `?node-id=25-147` value as well as a full Figma link; a link also opens that file first.

## Limitations

- Figma only; the browser copy is dedicated to this plugin, not the user's live Chrome window.
- `window.figma` is an internal Figma interface, not a published API. If Figma removes it, only canvas screenshots and panel reading remain.
- The copy is seeded once. When the Figma session expires, delete `profileDir` and start again while Chrome is closed.
- One profile copy per machine; concurrent sessions share it through the same port.
- Editor state is not restored from the conversation: after a restart, reopen the file with figma_browser.

## Security

- The copied profile contains the user's cookies. Keep it out of repositories and backups you share.
- While the port is open, any local process can drive that browser. Use `figma_browser { "action": "stop" }` when finished.
- Prefer `allowEval: false` on shared machines.
