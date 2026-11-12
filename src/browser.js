/**
 * Chrome lifecycle on a copy of the user's browser profile.
 *
 * Why a copy: since Chrome 136 a debugging switch is ignored on the default data
 * directory (https://developer.chrome.com/blog/remote-debugging-port), so the
 * only way to keep the user's cookies — and with them the Figma session — is to
 * start Chrome on a separate data directory that was seeded from the real one.
 * @module
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { browserVersion, endpointOf, isBrowserUp, openTab, listPages } from './cdp.js'

/** Files and directories that carry cookies, storage, and profile preferences. */
const PROFILE_PARTS = [
  'Local State',
  join('Default', 'Cookies'),
  join('Default', 'Preferences'),
  join('Default', 'Local Storage'),
  join('Default', 'Session Storage'),
  join('Default', 'IndexedDB'),
  join('Default', 'Web Data'),
  join('Default', 'Extension Cookies'),
  join('Default', 'Extension State'),
  join('Default', 'Extension Rules'),
  join('Default', 'Extension Scripts'),
]

/** Configuration text, treating the empty string as "not set" (Schemastery string defaults are ""). */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Candidate browsers per platform, most preferred first. */
function chromeCandidates() {
  switch (platform()) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]
    case 'win32':
      return [
        join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    default:
      return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
  }
}

/** User data directories of the real browsers, most preferred first. */
function sourceProfileCandidates() {
  switch (platform()) {
    case 'darwin':
      return [join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')]
    case 'win32':
      return [join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data')]
    default:
      return [join(homedir(), '.config', 'google-chrome'), join(homedir(), '.config', 'chromium')]
  }
}

/** The browser executable this plugin will launch. */
export function resolveChromePath(config) {
  const configured = text(config.chromePath)
  if (configured !== undefined) return configured
  const found = chromeCandidates().find((candidate) => candidate !== '' && existsSync(candidate))
  if (found === undefined) {
    throw new Error('Google Chrome was not found. Set the plugin config `chromePath` to the browser executable.')
  }
  return found
}

/** The user's real profile directory, used only as a copy source. */
export function resolveSourceProfile(config) {
  const configured = text(config.sourceProfile)
  if (configured !== undefined) return configured
  const found = sourceProfileCandidates().find((candidate) => existsSync(candidate))
  if (found === undefined) {
    throw new Error('No Chrome profile was found. Set the plugin config `sourceProfile` to the browser user-data directory.')
  }
  return found
}

/** Where this plugin keeps its isolated copy and generated renders. */
export function resolvePaths(config) {
  const base = resolve(text(config.dataDir) ?? join(homedir(), '.dsh', 'figma-browser'))
  return {
    base,
    profile: resolve(text(config.profileDir) ?? join(base, 'profile')),
    output: resolve(text(config.outputDir) ?? join(base, 'out')),
  }
}

/** Read `Google Chrome <version>` from the browser, or undefined when it cannot run. */
function chromeVersion(chromePath) {
  try {
    const result = spawnSync(chromePath, ['--version'], { encoding: 'utf8', timeout: 10000 })
    const match = /(\d+\.\d+\.\d+\.\d+)/u.exec(result.stdout ?? '')
    return match?.[1]
  } catch {
    return undefined
  }
}

/**
 * A browser User-Agent for headless launches.
 * Figma's CDN answers `403 Request blocked` to the literal `HeadlessChrome` token,
 * so a headless launch has to look like an ordinary window.
 */
function headlessUserAgent(config, chromePath) {
  const configured = text(config.userAgent)
  if (configured !== undefined) return configured
  const version = chromeVersion(chromePath) ?? '131.0.0.0'
  const os = platform() === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : platform() === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
}

/** Copy the real profile into the isolated data directory, if it is not there yet. */
export async function seedProfile(config) {
  const { profile } = resolvePaths(config)
  if (existsSync(join(profile, 'Default', 'Cookies'))) return { profile, seeded: false }
  const source = resolveSourceProfile(config)
  await mkdir(join(profile, 'Default'), { recursive: true })
  let copied = 0
  for (const part of PROFILE_PARTS) {
    const from = join(source, part)
    if (!existsSync(from)) continue
    await mkdir(dirname(join(profile, part)), { recursive: true })
    await cp(from, join(profile, part), { recursive: true, force: true })
    copied += 1
  }
  if (copied === 0) {
    await rm(profile, { recursive: true, force: true })
    throw new Error(`Nothing was copied from ${source}. Close Chrome, check the path, or set the plugin config \`sourceProfile\`.`)
  }
  return { profile, seeded: true, source, parts: copied }
}

/** Current browser state for this plugin's endpoint. */
export async function browserState(config) {
  const endpoint = endpointOf(config)
  const up = await isBrowserUp(endpoint)
  if (!up) return { running: false, endpoint, port: config.port }
  const version = await browserVersion(endpoint)
  const pages = await listPages(endpoint).catch(() => [])
  return {
    running: true,
    endpoint,
    port: config.port,
    browser: version?.Browser,
    pages: pages.length,
    figmaPages: pages.filter((page) => /figma\.com\//u.test(page.url)).map((page) => page.url),
  }
}

/**
 * Start Chrome on the isolated profile, or report the one already running.
 * @returns the browser state plus whether this call started it.
 */
export async function startBrowser(config) {
  const endpoint = endpointOf(config)
  if (await isBrowserUp(endpoint)) return { ...(await browserState(config)), started: false }
  const { profile } = await seedProfile(config)
  if (config.headless === false) {
    // A visible window needs a display; servers and CI have none. Fall back instead of failing.
    try {
      return await launch(config, { headless: false, profile })
    } catch (error) {
      const state = await launch(config, { headless: true, profile, signal: error.message })
      return { ...state, headless: true, fellBackToHeadless: true, headlessReason: error.message }
    }
  }
  return await launch(config, { headless: true, profile })
}

/** Spawn one Chrome generation and wait for its DevTools endpoint. */
async function launch(config, options) {
  const endpoint = endpointOf(config)
  const chromePath = resolveChromePath(config)
  const { profile } = options
  const headless = options.headless
  const args = [
    `--user-data-dir=${profile}`,
    '--profile-directory=Default',
    `--remote-debugging-port=${config.port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,1000',
    '--disable-blink-features=AutomationControlled',
  ]
  if (headless) args.push('--headless', `--user-agent=${headlessUserAgent(config, chromePath)}`)
  if (Array.isArray(config.extraArgs)) args.push(...config.extraArgs.filter((arg) => typeof arg === 'string' && arg !== ''))
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' })
  child.unref()
  const deadline = Date.now() + (config.startupTimeoutMs ?? 20000)
  while (Date.now() < deadline) {
    await new Promise((stop) => setTimeout(stop, 250))
    if (await isBrowserUp(endpoint)) {
      return { ...(await browserState(config)), started: true, headless, profile }
    }
  }
  throw new Error(`${chromePath} did not expose ${endpoint} within ${config.startupTimeoutMs ?? 20000} ms${options.signal === undefined ? '' : ` (${options.signal})`}. Run it once by hand to see the error.`)
}

/** Stop the browser this plugin started, matched by its data directory. */
export async function stopBrowser(config) {
  const { profile } = resolvePaths(config)
  if (!(await isBrowserUp(endpointOf(config)))) return { running: false, stopped: false }
  await new Promise((resolve) => {
    const child = spawn('pkill', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
    child.on('exit', resolve)
    child.on('error', resolve)
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!(await isBrowserUp(endpointOf(config)))) return { running: false, stopped: true }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { running: true, stopped: false, error: 'the browser did not exit; close the window by hand' }
}

/** Start the browser when needed, honouring `autoStart`. */
export async function ensureBrowser(config) {
  const state = await browserState(config)
  if (state.running) return state
  if (config.autoStart === false) {
    throw new Error(`Chrome is not running on ${state.endpoint}. Call the figma_browser tool with action "start".`)
  }
  return await startBrowser(config)
}

/** Open a URL in a new tab of the plugin's browser. */
export async function openUrl(config, url) {
  const state = await ensureBrowser(config)
  const target = await openTab(state.endpoint, url)
  return { opened: url, targetId: target.id ?? null, endpoint: state.endpoint }
}
