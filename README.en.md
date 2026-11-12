# dsh-figma-browser

[Русский](README.md) | **English**

[![ci](https://github.com/tsybindev/dsh-figma-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/tsybindev/dsh-figma-browser/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent your Figma designs as **exact data and true renders**, using your own logged-in Chrome. No Figma API token, no paid seat, no Dev Mode, no API rate limits.

```
figma_node { "nodeId": "25:148", "render": true, "scale": 2 }
→ PNG of the frame, exported by Figma itself
→ Inter Bold 19.51px, fill #33435E, radius 12, auto layout 16/24/4, …
```

## Why

The public Figma REST API needs a token and a plan, the Figma MCP server needs OAuth, a client allowlist, and the desktop app, and Dev Mode needs a paid seat. Meanwhile the Figma **web editor** keeps the real plugin API reachable inside the page as `window.figma` — `getNodeById`, `root`, `currentPage`, `exportAsync`, `variables`. The plugin opens the file in Chrome under your session, attaches to the tab over the Chrome DevTools Protocol, and reads the document through that API. That is why it works on a free plan.

## How it works

1. Chrome is started with `--remote-debugging-port` on a **copy** of the profile (`Local State`, `Cookies`, `Local Storage`, `IndexedDB`, …). Since Chrome 136 the debugging switches are ignored on the default data directory, so a copy is the only way to keep cookies and the signed-in session.
2. Headless launches send an ordinary Chrome User-Agent: Figma's CDN answers `403 Request blocked` to the `HeadlessChrome` token.
3. The plugin attaches to the editor tab over CDP (the platform `WebSocket`) and evaluates a small serializer against `window.figma`.
4. Renders come from `node.exportAsync`, so the image is produced by Figma itself.

No runtime dependencies: no Playwright, no Puppeteer, no downloaded browsers.

## Install

```bash
# from npm
dsh plugin add dsh-figma-browser

# from a local checkout
dsh plugin add /path/to/dsh-figma-browser
```

In the Web GUI: **Plugins → Add plugin** → the package name or a local directory. The bundle is host-only, so no build step is involved.

Then, in a new session:

```
figma_browser { "action": "open", "url": "https://www.figma.com/design/<file>?node-id=25-147" }
```

## Tools

| Tool | Parameters | Result |
|---|---|---|
| `figma_browser` | `action: status \| start \| stop \| open`, `url` | browser state, or the opened tab |
| `figma_list` | `action: pages \| search \| selection`, `query`, `limit` | pages, matching nodes, current selection |
| `figma_node` | `nodeId`, `depth`, `render`, `format`, `scale` | geometry, fills, gradients, effects, auto layout, text and font, children; optional PNG/SVG |
| `figma_view` | `nodeId?`, `format?` | editor screenshot, with the node selected first |
| `figma_eval` | `expression` | only with `allowEval: true` |

`nodeId` accepts `25:147`, `25-147`, or a full Figma link; a link also opens that file first.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `port` | `9333` | DevTools port, bound to `127.0.0.1` only |
| `headless` | `false` | run without a window; actions are invisible in headless |
| `autoStart` | `true` | start the browser when a Figma tool runs and none is up |
| `allowEval` | `false` | register `figma_eval` (arbitrary page JavaScript) |
| `chromePath` | auto-detect | Chrome/Chromium executable |
| `sourceProfile` | auto-detect | real Chrome user-data directory, copied once |
| `profileDir` | `~/.dsh/figma-browser/profile` | where the profile copy lives |
| `outputDir` | `~/.dsh/figma-browser/out` | where JSON and renders are written |
| `userAgent` | auto-detect | headless User-Agent override |
| `startupTimeoutMs` | `20000` | browser start budget |
| `extraArgs` | `[]` | extra Chrome switches, e.g. `--no-sandbox` in a container |

Set `headless: true` when the window is not wanted; on a machine without a display the plugin falls back to headless by itself.

Per-machine settings live in the profile patch and survive plugin updates:

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- override:
    - id: figma-browser
      config:
        headless: true
        allowEval: true
```

## Development

```bash
npm run check   # syntax check every module
npm test        # smoke test against a browser already listening on :9333
```

## Limitations

- Figma only; the browser copy is dedicated to this plugin rather than your live Chrome window.
- `window.figma` is an internal Figma interface, not a published API. If Figma removes it, only canvas screenshots remain.
- The copy is seeded once. When the session expires, delete `profileDir` while Chrome is closed and start again.
- Every session on the machine shares the one browser instance and port.
- The plugin never changes your file by itself: writing requires an explicit request, and `figma_eval` is off by default.

## Security

- The copied profile holds your cookies. Do not commit or share it.
- While the port is open, any local process can drive that browser. Stop it when finished: `figma_browser { "action": "stop" }`.
- Prefer a dedicated Chrome profile if you do not want every site's cookies copied.

## Layout

```
src/cdp.js      CDP client on the platform WebSocket
src/browser.js  Chrome lifecycle and profile copy
src/figma.js    in-editor operations (window.figma)
src/index.js    tool registration
test/smoke.mjs  smoke test against a live browser
```

## License

MIT
