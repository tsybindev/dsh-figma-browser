/**
 * Figma design data, read inside the logged-in web editor.
 *
 * The Figma web editor keeps the real plugin API reachable as `window.figma`
 * (`getNodeById`, `root`, `currentPage`, `exportAsync`, `variables`, ...). Driving
 * that API from the page gives exact design data — geometry, fills, gradients,
 * effects, auto layout, text and fonts — plus true renders, without a Figma API
 * token, a paid seat, or Dev Mode. It is an internal Figma interface, not a
 * published one, so `figma_list`, `figma_node`, and `figma_view` are the stable
 * surface and everything else here is an implementation detail.
 * @module
 */
import { evaluate, navigate } from './cdp.js'

/** Recognise a node id in `25:147`, `25-147`, or a Figma URL. */
export function normalizeNodeId(input) {
  const text = String(input ?? '').trim()
  if (text === '') throw new Error('A node id is required, for example 25:147 or a Figma link with ?node-id=25-147')
  const urlMatch = /[?&]node-id=(\d+)[-:](\d+)/u.exec(text)
  if (urlMatch !== null) return `${urlMatch[1]}:${urlMatch[2]}`
  const plain = /^(\d+)[-:](\d+)$/u.exec(text)
  if (plain !== null) return `${plain[1]}:${plain[2]}`
  throw new Error(`"${text}" is not a Figma node id. Use the ?node-id=25-147 value from the file URL.`)
}

/** Extract a Figma file URL from arbitrary text, or undefined. */
export function figmaUrlOf(input) {
  const match = /https?:\/\/[\w.-]*figma\.com\/[^\s"']+/u.exec(String(input ?? ''))
  return match?.[0]
}

/**
 * The in-page operation. Serialized with `toString` and evaluated in the editor,
 * so it must stay self-contained: no imports, no closure over this module, and no
 * template literals of its own.
 */
const PAGE_OPERATION = `async function (opts) {
  const figma = window.figma;
  if (!figma || typeof figma.getNodeById !== 'function') {
    return { error: 'This page does not expose the Figma editor API. Open the file in a regular Figma tab and let it finish loading.' };
  }
  const round = function (value) { return typeof value === 'number' ? Math.round(value * 100) / 100 : value; };
  const color = function (paint) {
    return { r: round(paint.r), g: round(paint.g), b: round(paint.b) };
  };
  const paints = function (list) {
    if (!Array.isArray(list)) return undefined;
    const visible = list.filter(function (paint) { return paint.visible !== false; });
    if (visible.length === 0) return undefined;
    return visible.map(function (paint) {
      if (paint.type === 'SOLID') return { type: 'solid', color: color(paint.color), opacity: round(paint.opacity === undefined ? 1 : paint.opacity) };
      if (String(paint.type).indexOf('GRADIENT') === 0) {
        return {
          type: paint.type,
          stops: (paint.gradientStops || []).map(function (stop) {
            return { position: round(stop.position), color: color(stop.color), alpha: stop.color.a };
          })
        };
      }
      if (paint.type === 'IMAGE') return { type: 'image', scaleMode: paint.scaleMode };
      return { type: paint.type };
    });
  };
  const serialize = function (node, depth) {
    const out = { id: node.id, name: node.name, type: node.type };
    if (node.visible === false) out.visible = false;
    if (typeof node.x === 'number') { out.x = round(node.x); out.y = round(node.y); }
    if (typeof node.width === 'number') { out.width = round(node.width); out.height = round(node.height); }
    if (node.rotation) out.rotation = round(node.rotation);
    if (node.opacity !== undefined && node.opacity !== 1) out.opacity = round(node.opacity);
    if (node.layoutMode && node.layoutMode !== 'NONE') {
      out.layout = {
        mode: node.layoutMode,
        padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
        gap: node.itemSpacing,
        align: [node.primaryAxisAlignItems, node.counterAxisAlignItems],
        sizing: [node.layoutSizingHorizontal, node.layoutSizingVertical]
      };
    }
    if (node.cornerRadius !== undefined) {
      if (typeof node.cornerRadius === 'number') { if (node.cornerRadius) out.radius = node.cornerRadius; }
      else if (node.topLeftRadius || node.topRightRadius || node.bottomLeftRadius || node.bottomRightRadius) {
        out.radius = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
      }
    }
    const fills = paints(node.fills); if (fills) out.fills = fills;
    const strokes = paints(node.strokes);
    if (strokes) { out.strokes = strokes; if (node.strokeWeight) out.strokeWeight = node.strokeWeight; }
    if (Array.isArray(node.effects)) {
      const effects = node.effects.filter(function (effect) { return effect.visible !== false; });
      if (effects.length > 0) {
        out.effects = effects.map(function (effect) {
          return {
            type: effect.type,
            radius: round(effect.radius),
            spread: effect.spread,
            color: effect.color ? { r: round(effect.color.r), g: round(effect.color.g), b: round(effect.color.b), a: effect.color.a } : undefined,
            offset: effect.offset ? { x: round(effect.offset.x), y: round(effect.offset.y) } : undefined
          };
        });
      }
    }
    if (typeof node.characters === 'string') {
      out.text = node.characters;
      out.font = {
        family: node.fontName ? node.fontName.family : undefined,
        style: node.fontName ? node.fontName.style : undefined,
        size: round(node.fontSize),
        lineHeight: node.lineHeight && node.lineHeight.unit === 'AUTO' ? 'auto' : round(node.lineHeight && node.lineHeight.value),
        letterSpacing: round(node.letterSpacing && node.letterSpacing.value),
        align: node.textAlignHorizontal
      };
    }
    if (node.componentId) out.componentId = node.componentId;
    if (Array.isArray(node.children) && depth < opts.depth) {
      out.children = node.children.map(function (child) { return serialize(child, depth + 1); });
    }
    return out;
  };
  const findNode = function (id) {
    const direct = figma.getNodeById(id);
    if (direct) return direct;
    const pages = figma.root.children;
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const hit = page && page.findOne ? page.findOne(function (candidate) { return candidate.id === id; }) : null;
      if (hit) return hit;
    }
    return null;
  };
  if (opts.op === 'pages') {
    return {
      file: figma.root.name,
      currentPage: figma.currentPage ? figma.currentPage.name : undefined,
      pages: figma.root.children.map(function (page) { return { id: page.id, name: page.name, children: page.children.length }; })
    };
  }
  if (opts.op === 'search') {
    const needle = String(opts.query || '').toLowerCase();
    const limit = opts.limit || 40;
    const hits = [];
    const walk = function (node) {
      if (hits.length >= limit) return;
      const name = node.name || '';
      if (name.toLowerCase().indexOf(needle) !== -1) {
        hits.push({ id: node.id, name: name, type: node.type, width: typeof node.width === 'number' ? round(node.width) : undefined, height: typeof node.height === 'number' ? round(node.height) : undefined });
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    figma.root.children.forEach(function (page) { if (Array.isArray(page.children)) page.children.forEach(walk); });
    return { query: opts.query, count: hits.length, truncated: hits.length >= limit, hits: hits };
  }
  const node = opts.id ? findNode(opts.id) : null;
  if (opts.op === 'select') {
    if (!node) return { error: 'Node not found: ' + opts.id };
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    return { selected: { id: node.id, name: node.name, type: node.type, width: round(node.width), height: round(node.height) } };
  }
  if (opts.op === 'selection') {
    const names = figma.currentPage.selection.map(function (item) { return { id: item.id, name: item.name, type: item.type }; });
    return { selection: names };
  }
  if (!node) return { error: 'Node not found: ' + opts.id };
  const out = { file: figma.root.name, node: serialize(node, 0) };
  if (opts.export) {
    try {
      const constraint = opts.format === 'SVG' ? undefined : { type: 'SCALE', value: opts.scale || 1 };
      const bytes = await node.exportAsync({ format: opts.format, constraint: constraint });
      let binary = '';
      for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
      out.image = btoa(binary);
      out.imageFormat = opts.format;
    } catch (error) {
      out.exportError = error && error.message ? error.message : String(error);
    }
  }
  return out;
}`

/** Run one operation in the attached Figma editor tab. */
export async function runPageOperation(session, operation) {
  const expression = `(${PAGE_OPERATION})(${JSON.stringify(operation)})`
  const result = await evaluate(session, expression)
  if (result === undefined || result === null) throw new Error('The Figma editor returned no data.')
  if (typeof result.error === 'string') throw new Error(result.error)
  return result
}

/** True when the page looks like a loaded Figma editor. */
export function isFigmaEditor(page) {
  return /figma\.com\/(design|file|proto|board|make)\//u.test(page.url ?? '')
}

/** Navigate the attached tab to a Figma file URL and wait for the editor. */
export async function openFigmaFile(session, url) {
  await navigate(session, url)
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(session, 'Boolean(window.figma && window.figma.root && window.figma.root.children.length > 0)')
      if (ready) return
    } catch { /* still loading */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
