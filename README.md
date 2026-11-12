# dsh-figma-browser

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent your Figma designs as **exact data and true renders**, using your own logged-in Chrome — no Figma API token, no paid seat, no Dev Mode.

```
figma_node { "nodeId": "25:148", "render": true, "scale": 2 }
→ PNG of the frame, exported by Figma itself
→ Inter Bold 19.51px, fill #33435E, radius 12, auto layout 16/24/4, …
```

## Why it works

The Figma **web editor** keeps the real plugin API reachable inside the page as `window.figma` — `getNodeById`, `root`, `currentPage`, `exportAsync`, `variables`. The plugin starts Chrome on a copy of your profile (so your session is already signed in), attaches over the Chrome DevTools Protocol, and reads the document through that API.

No Playwright, no Puppeteer, no downloaded browsers: CDP runs over the platform `WebSocket`.

Two constraints are handled for you:

- Chrome 136+ ignores `--remote-debugging-port` on the default data directory, so the profile is copied once and Chrome runs on that copy.
- Figma's CDN answers `403 Request blocked` to the `HeadlessChrome` User-Agent, so headless launches send an ordinary Chrome UA.

## Install

```bash
# from npm
dsh plugin add dsh-figma-browser

# or from a local checkout
dsh plugin add /path/to/dsh-figma-browser
```

In the Web GUI: **Plugins → Add plugin** → the package name or a local directory. The bundle is Host-only, so no build step and no extra services are involved.

Then start a new session and ask the agent to open a Figma file:

```
figma_browser { "action": "open", "url": "https://www.figma.com/design/<file>?node-id=25-147" }
```

## Tools

| Tool | Parameters | Result |
|---|---|---|
| `figma_browser` | `action: status \| start \| stop \| open`, `url` | browser state, or the opened tab |
| `figma_list` | `action: pages \| search \| selection`, `query`, `limit` | page ids, matching nodes, current selection |
| `figma_node` | `nodeId`, `depth`, `render`, `format`, `scale` | geometry, fills, gradients, effects, auto layout, text and font, children; optional PNG/SVG |
| `figma_view` | `nodeId?`, `format?` | screenshot of the editor, with the node selected first |
| `figma_eval` | `expression` | only with `allowEval: true` |

`nodeId` accepts `25:147`, `25-147`, or a full Figma link; a link also opens that file first.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `port` | `9333` | DevTools port; bound to `127.0.0.1` only |
| `headless` | `false` | Set `true` to hide the window, for servers and CI |
| `autoStart` | `true` | Start Chrome when a Figma tool runs and none is up |
| `allowEval` | `false` | Register `figma_eval` (arbitrary page JavaScript) |
| `chromePath` | auto-detect | Chrome/Chromium executable |
| `sourceProfile` | auto-detect | Real Chrome user-data directory copied once |
| `profileDir` | `~/.dsh/figma-browser/profile` | Where the copy lives |
| `outputDir` | `~/.dsh/figma-browser/out` | Where JSON and renders are written |
| `userAgent` | auto-detect | Headless User-Agent override |
| `startupTimeoutMs` | `20000` | Browser start budget |
| `extraArgs` | `[]` | Extra Chrome switches, e.g. `--no-sandbox` in a container |

Per-machine configuration goes into the profile patch layer, which survives plugin updates:

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- override:
    - id: figma-browser
      config:
        headless: true
        allowEval: true
```

macOS and Windows are supported by the same code (executable and profile paths are detected per platform).

## Limitations

- Figma only, and the browser copy is dedicated to this plugin rather than your live Chrome window.
- `window.figma` is an internal Figma interface. If Figma removes it, only canvas screenshots remain.
- The copy is seeded once. When the session expires, delete `profileDir`, close Chrome, and start again.
- Every session on the machine shares the one browser instance and port.
- Read-only by design: the plugin never writes to your file unless you ask the agent to, and `figma_eval` is off by default.

## Security

- The copied profile holds your cookies. Do not commit or share it.
- While the port is open, any local process can drive that browser. Stop it when you are done: `figma_browser { "action": "stop" }`.
- Prefer a dedicated Chrome profile if you do not want other sites' cookies copied.

## Development

```bash
npm run check   # syntax check every module
npm test        # smoke test against a browser already listening on :9333
```

Layout: `src/cdp.js` (CDP client), `src/browser.js` (Chrome lifecycle and profile copy), `src/figma.js` (in-page Figma operations), `src/index.js` (tool registration).

## По-русски

Плагин даёт агенту доступ к макетам Figma через твой собственный Chrome: он поднимает отдельный Chrome на копии твоего профиля (там уже есть авторизация), подключается по CDP и читает документ через `window.figma` — то есть отдаёт точные размеры, отступы, цвета, градиенты, шрифты и настоящий рендер. Токен Figma, подписка и Dev Mode не нужны.

Установка: `dsh plugin add dsh-figma-browser`, затем в новой сессии `figma_browser` → `open` со ссылкой на файл, дальше `figma_list` / `figma_node` / `figma_view`. По умолчанию окно Chrome видимое, чтобы было видно, что делает агент; для сервера поставь `headless: true`.

## License

MIT
