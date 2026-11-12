// Smoke test against a browser that is already running.
//   FIGMA_CDP=http://127.0.0.1:9333 node test/smoke.mjs
// Optional: FIGMA_NODE=25:261 to read one known node.
import assert from 'node:assert/strict'
import { attachPage, captureScreenshot, isBrowserUp } from '../src/cdp.js'
import { isFigmaEditor, normalizeNodeId, runPageOperation, figmaUrlOf } from '../src/figma.js'

const endpoint = process.env.FIGMA_CDP ?? 'http://127.0.0.1:9333'
const passed = []
const check = (label, condition) => {
  if (!condition) throw new Error(`failed: ${label}`)
  passed.push(label)
}

assert.equal(normalizeNodeId('25-147'), '25:147')
assert.equal(normalizeNodeId('https://www.figma.com/design/abc/x?node-id=25-147'), '25:147')
assert.equal(figmaUrlOf('see https://www.figma.com/design/abc/x?node-id=1-2 for details'), 'https://www.figma.com/design/abc/x?node-id=1-2')
check('node id normalization', true)

check('browser answers on ' + endpoint, await isBrowserUp(endpoint))

const pages = await (await fetch(`${endpoint}/json/list`)).json()
const figma = pages.filter((page) => page.type === 'page' && isFigmaEditor(page))
if (figma.length === 0) {
  console.log('SKIP: no Figma tab is open; open a file first')
  process.exit(0)
}

const session = await attachPage(endpoint, isFigmaEditor)
try {
  const listing = await runPageOperation(session, { op: 'pages' })
  check('pages with ids', listing.pages.length > 0 && typeof listing.pages[0].id === 'string')
  console.log('file:', listing.file, '| pages:', listing.pages.map((page) => page.name).join(', '))

  const search = await runPageOperation(session, { op: 'search', query: '', limit: 3 })
  check('search returns ids', Array.isArray(search.hits))

  const nodeId = process.env.FIGMA_NODE ?? search.hits[0]?.id
  if (nodeId !== undefined) {
    const data = await runPageOperation(session, { op: 'node', id: normalizeNodeId(nodeId), depth: 1 })
    check('node data', typeof data.node?.id === 'string' && typeof data.node.width === 'number')
    const rendered = await runPageOperation(session, { op: 'node', id: normalizeNodeId(nodeId), depth: 0, export: true, format: 'PNG', scale: 1 })
    check('png export', typeof rendered.image === 'string' && Buffer.from(rendered.image, 'base64').length > 100)
    console.log('node:', data.node.name, data.node.width + '×' + data.node.height)
  }

  const shot = await captureScreenshot(session)
  check('editor screenshot', shot.length > 1000)
} finally {
  session.close()
}

console.log(`\n${passed.length} checks passed`)
