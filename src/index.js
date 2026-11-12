/**
 * dsh-figma-browser — Figma design data through the user's own logged-in Chrome.
 *
 * Registers five model tools:
 *   figma_browser  start/stop/status/open the dedicated Chrome instance
 *   figma_list     pages, node search, current selection
 *   figma_node     exact node properties (geometry, fills, effects, layout, text) + render
 *   figma_view     select a node and screenshot the editor so the user sees the action
 *   figma_eval     run custom JavaScript in the editor (only when `allowEval` is set)
 *
 * The browser runs on a copy of the user's Chrome profile, so the Figma session is
 * already signed in; no Figma token, API, paid seat, or Dev Mode is involved.
 * @module
 */
import Schema from '@deepseek-ai/schemastery'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachPage, captureScreenshot, evaluate } from './cdp.js'
import { browserState, ensureBrowser, openUrl, resolvePaths, startBrowser, stopBrowser } from './browser.js'
import { figmaUrlOf, isFigmaEditor, normalizeNodeId, openFigmaFile, runPageOperation } from './figma.js'

export const name = 'dsh-figma-browser'

export const inject = ['tools']

export const Config = Schema.object({
  port: Schema.number().default(9333).description('DevTools port for the dedicated browser; only 127.0.0.1 is bound.'),
  headless: Schema.boolean().default(false).description('Launch without a visible window. The user cannot watch the actions in headless mode.'),
  autoStart: Schema.boolean().default(true).description('Start the browser automatically when a Figma tool runs and none is up.'),
  allowEval: Schema.boolean().default(false).description('Register figma_eval, which runs arbitrary JavaScript in the editor page.'),
  chromePath: Schema.string().default('').description('Chrome executable. Empty means auto-detect for this platform.'),
  sourceProfile: Schema.string().default('').description('The real Chrome user-data directory copied once for the session cookies. Empty means auto-detect.'),
  profileDir: Schema.string().default('').description('Where the isolated profile copy lives. Empty means ~/.dsh/figma-browser/profile.'),
  outputDir: Schema.string().default('').description('Where node JSON and renders are written. Empty means ~/.dsh/figma-browser/out.'),
  userAgent: Schema.string().default('').description('Headless User-Agent override. Figma answers 403 to the HeadlessChrome token, so empty means an ordinary Chrome UA.'),
  startupTimeoutMs: Schema.number().default(20000).description('How long a browser start may take before it fails.'),
  extraArgs: Schema.array(Schema.string()).default([]).description('Additional Chrome command-line switches, for example --no-sandbox in a container.'),
})

/** Tool values must be canonical JSON: drop undefined members and non-finite numbers. */
function jsonSafe(value) {
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = jsonSafe(item)
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

/** Attach to the Figma tab, starting the browser when allowed. */
async function attach(config) {
  const state = await ensureBrowser(config)
  const session = await attachPage(state.endpoint, isFigmaEditor)
  return { session, state }
}

/** Paths and a ready output directory for generated files. */
async function outputPaths(config) {
  const { output } = resolvePaths(config)
  await mkdir(output, { recursive: true })
  return output
}

/** Save bytes next to the JSON, and register an image attachment when one is available. */
async function saveImage(ctx, config, bytes, fileName, mediaType) {
  const output = await outputPaths(config)
  const path = join(output, fileName)
  await writeFile(path, bytes)
  const attachments = ctx.get('attachments')
  let attachment
  if (attachments !== undefined) {
    try {
      attachment = await attachments.saveImage({ data: bytes, mediaType, name: fileName })
    } catch { /* an unavailable attachment store only costs the inline preview */ }
  }
  return { path, attachment }
}

/** Shrink a serialized node for the model-facing result, keeping ids for follow-up calls. */
function summarizeNode(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    width: node.width,
    height: node.height,
    x: node.x,
    y: node.y,
    text: node.text,
    font: node.font,
    fills: node.fills,
    radius: node.radius,
    layout: node.layout,
    children: Array.isArray(node.children) ? node.children.length : 0,
  }
}

/** The figma_browser lifecycle tool. */
function makeBrowserTool(config) {
  return {
    name: 'figma_browser',
    description: 'Manage the dedicated Chrome instance that this plugin drives on a copy of the user\'s profile, and open Figma files in it. The copy keeps the user\'s Figma session, so no login or token is needed. Use action "open" with a Figma file URL before reading nodes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop', 'open'], description: 'Operation to run.' },
        url: { type: 'string', description: 'For action "open": a Figma file URL, usually copied from the browser with the frame selected (?node-id=...).' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 60000,
    async execute(args) {
      switch (args.action) {
        case 'status': return jsonSafe(await browserState(config))
        case 'start': return jsonSafe(await startBrowser(config))
        case 'stop': return jsonSafe(await stopBrowser(config))
        case 'open': {
          if (!args.url) throw new Error('url is required for action "open"')
          const url = figmaUrlOf(args.url)
          if (url === undefined) throw new Error('url must be a Figma file URL')
          return jsonSafe(await openUrl(config, url))
        }
        default: throw new Error(`unknown action: ${String(args.action)}`)
      }
    },
  }
}

/** Pages, node search, and the current selection. */
function makeListTool(config) {
  return {
    name: 'figma_list',
    description: 'List the pages of the open Figma file, search nodes by name, or report the current selection. Search returns ids to pass to figma_node. Unnamed layers are usually named after their content ("Vector", "Frame 12"), so search by the visible text or a component name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['pages', 'search', 'selection'], description: 'Operation to run.' },
        query: { type: 'string', description: 'For action "search": case-insensitive part of a layer name.' },
        limit: { type: 'number', description: 'For action "search": maximum hits, 1 to 200; defaults to 40.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (Array.isArray(value.pages)) {
          const lines = [`# ${value.file}`, `Current page: ${value.currentPage}`, '']
          for (const page of value.pages) lines.push(`- ${page.name} — ${page.id} (${page.children} top-level nodes)`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (Array.isArray(value.hits)) {
          if (value.hits.length === 0) return [{ type: 'text', text: `No node name contains "${value.query}".` }]
          const lines = [`${value.hits.length}${value.truncated ? '+' : ''} nodes match "${value.query}":`, '']
          for (const hit of value.hits) {
            const size = hit.width === undefined ? '' : ` ${hit.width}×${hit.height}`
            lines.push(`- ${hit.name} — ${hit.type}${size} — ${hit.id}`)
          }
          lines.push('', 'Read one with figma_node.')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (Array.isArray(value.selection)) {
          return [{ type: 'text', text: value.selection.length === 0 ? 'Nothing is selected in the editor.' : value.selection.map((item) => `- ${item.name} (${item.type}) — ${item.id}`).join('\n') }]
        }
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    timeoutMs: 60000,
    async execute(args) {
      const { session } = await attach(config)
      try {
        if (args.action === 'pages') return jsonSafe(await runPageOperation(session, { op: 'pages' }))
        if (args.action === 'selection') return jsonSafe(await runPageOperation(session, { op: 'selection' }))
        if (args.action === 'search') {
          if (!args.query) throw new Error('query is required for action "search"')
          const limit = Math.min(Math.max(Number(args.limit ?? 40), 1), 200)
          return jsonSafe(await runPageOperation(session, { op: 'search', query: args.query, limit }))
        }
        throw new Error(`unknown action: ${String(args.action)}`)
      } finally { session.close() }
    },
  }
}

/** Node data plus an optional render. */
function makeNodeTool(ctx, config) {
  return {
    name: 'figma_node',
    description: 'Read one Figma node: position, size, auto layout, corner radius, fills, gradients, strokes, effects, text and font, plus its children. Pass a node id from figma_list. With render=true it also exports the node as a PNG or SVG, and the result includes the image so you can look at the design instead of guessing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nodeId: { type: 'string', description: 'Node id from figma_list or a Figma link with ?node-id=25-147. A link also opens that file first.' },
        depth: { type: 'number', description: 'How many child levels to serialize, 0 to 8; defaults to 3.' },
        render: { type: 'boolean', description: 'Export the node as an image and include it in the result.' },
        format: { type: 'string', enum: ['PNG', 'SVG'], description: 'Render format; defaults to PNG.' },
        scale: { type: 'number', description: 'PNG scale factor, 0.5 to 4; defaults to 1.' },
      },
      required: ['nodeId'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const blocks = []
        if (value.attachment !== undefined) blocks.push({ type: 'image', attachment: value.attachment })
        const summary = value.summary ?? {}
        const lines = [`${summary.type} "${summary.name}" (${summary.id})`, `Size ${summary.width}×${summary.height} at ${summary.x},${summary.y}`]
        if (summary.text) lines.push(`Text: ${JSON.stringify(summary.text)}${summary.font ? ` — ${summary.font.family} ${summary.font.style} ${summary.font.size}px` : ''}`)
        if (value.dataPath) lines.push(`Full data: ${value.dataPath}`)
        if (value.renderPath) lines.push(`Render: ${value.renderPath}`)
        if (value.exportError) lines.push(`Render failed: ${value.exportError}`)
        blocks.push({ type: 'text', text: lines.join('\n') })
        return blocks
      },
    },
    timeoutMs: 120000,
    async execute(args) {
      const { session } = await attach(config)
      try {
        const url = figmaUrlOf(args.nodeId)
        if (url !== undefined) await openFigmaFile(session, url)
        const id = normalizeNodeId(args.nodeId)
        const depth = Math.min(Math.max(Number(args.depth ?? 3), 0), 8)
        const format = args.format === 'SVG' ? 'SVG' : 'PNG'
        const scale = Math.min(Math.max(Number(args.scale ?? 1), 0.5), 4)
        const result = await runPageOperation(session, { op: 'node', id, depth, export: Boolean(args.render), format, scale })
        const output = await outputPaths(config)
        const dataPath = join(output, `node-${id.replace(':', '-')}.json`)
        await writeFile(dataPath, JSON.stringify(result.node, null, 2))
        const value = { summary: summarizeNode(result.node), dataPath }
        if (typeof result.image === 'string') {
          const bytes = Buffer.from(result.image, 'base64')
          const extension = format === 'SVG' ? 'svg' : 'png'
          const saved = await saveImage(ctx, config, bytes, `node-${id.replace(':', '-')}.${extension}`, format === 'SVG' ? 'image/svg+xml' : 'image/png')
          value.renderPath = saved.path
          if (saved.attachment !== undefined && format !== 'SVG') value.attachment = saved.attachment
        }
        if (result.exportError) value.exportError = result.exportError
        return jsonSafe(value)
      } finally { session.close() }
    },
  }
}

/** Select a node and show the editor, so the user can see what the agent touched. */
function makeViewTool(ctx, config) {
  return {
    name: 'figma_view',
    description: 'Screenshot the Figma editor as the user sees it, optionally selecting a node first. Use it to confirm what changed on screen or to show the user which layer you are reading.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nodeId: { type: 'string', description: 'Optional node id or Figma link to select and zoom to before the screenshot.' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format; defaults to png.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const blocks = []
        if (value.attachment !== undefined) blocks.push({ type: 'image', attachment: value.attachment })
        const lines = [value.selected ? `Selected ${value.selected.name} (${value.selected.type}) — ${value.selected.id}` : 'Editor viewport', `Screenshot: ${value.path}`]
        blocks.push({ type: 'text', text: lines.join('\n') })
        return blocks
      },
    },
    timeoutMs: 60000,
    async execute(args) {
      const { session } = await attach(config)
      try {
        let selected
        if (args.nodeId) {
          const url = figmaUrlOf(args.nodeId)
          if (url !== undefined) await openFigmaFile(session, url)
          const id = normalizeNodeId(args.nodeId)
          selected = (await runPageOperation(session, { op: 'select', id })).selected
          await new Promise((resolve) => setTimeout(resolve, 900))
        }
        const format = args.format === 'jpeg' ? 'jpeg' : 'png'
        const bytes = await captureScreenshot(session, { format, quality: format === 'jpeg' ? 80 : undefined })
        const saved = await saveImage(ctx, config, bytes, `view-${Date.now()}.${format}`, format === 'jpeg' ? 'image/jpeg' : 'image/png')
        return jsonSafe({ path: saved.path, selected, attachment: saved.attachment })
      } finally { session.close() }
    },
  }
}

/** Arbitrary page JavaScript, for problems the typed tools do not cover. */
function makeEvalTool(config) {
  return {
    name: 'figma_eval',
    description: 'Evaluate JavaScript inside the attached Figma editor tab and return the value. The editor exposes window.figma (the plugin API). Use it only for reads that figma_node and figma_list cannot express, and never mutate the user\'s file without being asked.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expression: { type: 'string', description: 'JavaScript expression; promises are awaited and the result must be JSON-serializable.' },
      },
      required: ['expression'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.result, null, 2).slice(0, 20000) }],
    },
    timeoutMs: 60000,
    async execute(args) {
      const { session } = await attach(config)
      try {
        const result = await evaluate(session, `(async () => (${args.expression}))()`)
        return jsonSafe({ result })
      } finally { session.close() }
    },
  }
}

/**
 * Register the tools once the Host tool registry is available.
 * @param ctx - Host plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:figma-browser',
      order: 118,
      text: 'figma_browser / figma_list / figma_node / figma_view read Figma designs from the user\'s own signed-in Chrome. Open the file with figma_browser action "open", locate layers with figma_list, read them with figma_node (render=true to see the design), and use figma_view to show what is on screen. The data comes from the Figma editor, not from the public API.',
    }), 'dsh-figma-browser: system prompt section')
  }
  ctx.effect(() => ctx.tools.register(makeBrowserTool(settings)), 'dsh-figma-browser: figma_browser')
  ctx.effect(() => ctx.tools.register(makeListTool(settings)), 'dsh-figma-browser: figma_list')
  ctx.effect(() => ctx.tools.register(makeNodeTool(ctx, settings)), 'dsh-figma-browser: figma_node')
  ctx.effect(() => ctx.tools.register(makeViewTool(ctx, settings)), 'dsh-figma-browser: figma_view')
  if (settings.allowEval === true) {
    ctx.effect(() => ctx.tools.register(makeEvalTool(settings)), 'dsh-figma-browser: figma_eval')
  }
}
