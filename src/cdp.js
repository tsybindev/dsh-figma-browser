/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Uses only platform APIs (global fetch + global WebSocket, Node >= 22), so the
 * plugin has no runtime dependencies: no puppeteer/playwright download, no
 * browser binaries. It talks to an ordinary Chrome that is already running with
 * --remote-debugging-port, which is what lets it reuse the user's real profile
 * and therefore the user's logged-in Figma session.
 * @module
 */

/** How long a single CDP request may wait for its reply. */
const REQUEST_TIMEOUT_MS = 30000

/** Build `http://host:port` from a port number or an already-formed URL. */
export function endpointOf(config) {
  if (config.endpoint) return String(config.endpoint).replace(/\/+$/u, '')
  return `http://127.0.0.1:${config.port}`
}

/** @returns whether a DevTools endpoint answers on `baseUrl`. */
export async function isBrowserUp(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/json/version`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/** @returns the browser version document, or undefined when nothing listens. */
export async function browserVersion(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/json/version`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  }
}

/** Every page target of the browser, in the order DevTools reports them. */
export async function listPages(baseUrl) {
  const res = await fetch(`${baseUrl}/json/list`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`DevTools target list failed with HTTP ${res.status}`)
  const targets = await res.json()
  return targets.filter((target) => target.type === 'page')
}

/** Open `url` in a new tab through the DevTools HTTP endpoint. */
export async function openTab(baseUrl, url) {
  const res = await fetch(`${baseUrl}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`DevTools could not open a tab: HTTP ${res.status}`)
  return await res.json()
}

/**
 * Attach to the Figma editor tab, or to the first page when `allowAnyPage` is set.
 * @param baseUrl - DevTools endpoint such as `http://127.0.0.1:9333`.
 * @param match - predicate over `{ url, title }` selecting the page to drive.
 * @returns a CDP session with `send`, `close`, and the attached target.
 */
export async function attachPage(baseUrl, match) {
  const pages = await listPages(baseUrl)
  const target = pages.find((page) => match(page))
  if (!target) {
    const seen = pages.map((page) => page.url).join('\n') || '(none)'
    throw new Error(`No matching page is open. Open the Figma file first (figma_browser open <url>). Open pages:\n${seen}`)
  }
  return { ...(await openSocket(target.webSocketDebuggerUrl)), target }
}

/** Open a raw CDP socket and multiplex request ids. */
async function openSocket(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('DevTools socket connection failed')), { once: true })
  })
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    let message
    try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  ws.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('DevTools socket closed'))
    pending.clear()
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, REQUEST_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { try { ws.close() } catch { /* already closed */ } },
  }
}

/**
 * Evaluate an expression in the page and return its value.
 * @param session - attached CDP session.
 * @param expression - JavaScript source; async expressions are awaited.
 */
export async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: false,
  })
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(`In-page evaluation failed: ${detail}`)
  }
  return result.result.value
}

/** Navigate the attached tab, then poll until the document reports it is ready. */
export async function navigate(session, url, timeoutMs = 60000) {
  await session.send('Page.enable')
  await session.send('Page.navigate', { url })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      const state = await evaluate(session, 'document.readyState')
      if (state === 'complete') return
    } catch { /* navigating: evaluation briefly fails */ }
  }
}

/** Capture the visible viewport as PNG or JPEG bytes. */
export async function captureScreenshot(session, { format = 'png', quality, fromSurface = true } = {}) {
  await session.send('Page.enable')
  const result = await session.send('Page.captureScreenshot', {
    format,
    ...format === 'jpeg' && quality !== undefined ? { quality } : {},
    fromSurface,
  })
  return Buffer.from(result.data, 'base64')
}
