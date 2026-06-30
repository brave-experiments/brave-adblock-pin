#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * adblock-pin: point a local Brave install at an older version of the adblock
 * filter lists, by commit hash from brave/adblock-lists-mirror. For local
 * testing of adblock incidents. See README.md.
 *
 * Model: Brave ships each filter list as a component-updater component under
 *   <user-data>/<component_id>/<version>/list.txt
 * and loads the highest version. `pin` rebuilds the default lists from the
 * chosen commit and writes them as a sentinel version (99.0.0) that outranks
 * anything the update server publishes, so Brave loads them and never updates
 * over them. `unpin` deletes those dirs; Brave re-downloads the current lists
 * on next launch. The pinned commit is stored in the pinned manifest.json, so
 * the filesystem is the only source of truth (no separate state file).
 *
 * We do NOT use --disable-component-update: in brave-core that skips component
 * registration, which is also what loads the list, so it turns adblock off.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline/promises'

const MIRROR_REPO = 'brave/adblock-lists-mirror'
const CATALOG_COMPONENT_ID = 'gkboaolpopklhgplhaaiboijnklogmbc'
const PINNED_VERSION = '99.0.0' // sentinel: higher than any real component version
const LIST_FILE = 'list.txt'
const BRAVE_SOFTWARE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'BraveSoftware')

interface CatalogEntry {
  uuid: string
  title: string
  default_enabled?: boolean
  hidden?: boolean
  list_text_component?: { component_id: string }
  sources?: { url: string; title?: string }[]
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = (m = '') => console.log(m)
const info = (m: string) => console.log(`  ${m}`)
const warn = (m: string) => console.warn(`\x1b[33m! ${m}\x1b[0m`)
const ok = (m: string) => console.log(`\x1b[32m✓ ${m}\x1b[0m`)
const die = (m: string): never => {
  console.error(`\x1b[31mx ${m}\x1b[0m`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Validation (anything reaching a filesystem path is format-checked) & IO
// ---------------------------------------------------------------------------

const isComponentId = (s: string): boolean => /^[a-p]{32}$/.test(s) // Chromium component id
const isCommitHash = (s: string): boolean => /^[0-9a-f]{7,40}$/i.test(s) // git short/full SHA

const readJson = <T>(file: string, label: string): T => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch (e) {
    return die(`could not read ${label} (${file}): ${(e as Error).message}`)
  }
}

// User-level config (the saved default profile), separate from per-profile state.
interface Config {
  defaultProfile?: string
}

const configPath = (): string => {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'adblock-pin', 'config.json')
}

/** Read the config; missing or corrupt file yields {} (never throws). */
const readConfig = (): Config => {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Config
  } catch {
    return {}
  }
}

const writeConfig = (cfg: Config): void => {
  const p = configPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
}

// ---------------------------------------------------------------------------
// List preprocessing (faithful ports of crx-packager lib/adBlockRustUtils.js)
// ---------------------------------------------------------------------------

// Resolve `!#if`/`!#else`/`!#endif` directives the way crx-packager does.
const IF_CONDITIONS = new Map<string, boolean>([
  ['ext_ublock', true],
  ['ext_devbuild', false],
  ['env_devbuild', false],
  ['env_chromium', true],
  ['env_edge', false],
  ['env_firefox', false],
  ['env_legacy', false],
  ['env_safari', false],
  ['cap_html_filtering', false],
  ['cap_user_stylesheet', true],
  ['false', false],
  ['ext_abp', false],
  ['adguard', false],
  ['adguard_app_android', false],
  ['adguard_app_ios', false],
  ['adguard_app_mac', false],
  ['adguard_app_windows', false],
  ['adguard_ext_android_cb', false],
  ['adguard_ext_chromium', true],
  ['adguard_ext_edge', false],
  ['adguard_ext_firefox', false],
  ['adguard_ext_opera', true],
  ['adguard_ext_safari', false]
])

/** Resolve `!#if` preprocessor directives, dropping branches that don't apply to Brave. */
const preprocess = (title: string, data: string): string => {
  const [NORMAL, IF_BRAVE, IF_NOT_BRAVE, IF_WHATEVER] = [0, 1, 2, 3]
  const negateIfState = (s: number) => (s === IF_WHATEVER ? s : s === IF_BRAVE ? IF_NOT_BRAVE : IF_BRAVE)
  const stack: number[] = []
  const popStack = () => {
    if (stack.length === 0) throw new Error(`${title} preprocessor error. Check for corrupted list contents.`)
    return stack.pop() as number
  }

  const out = data
    .split('\n')
    .filter(rawLine => {
      const line = rawLine.trim()
      const peek = stack.length === 0 ? NORMAL : stack[stack.length - 1]
      const ifMatch = line.match(/^!#if (!?)(.*)$/)
      if (ifMatch !== null) {
        if (peek === IF_NOT_BRAVE) {
          stack.push(IF_NOT_BRAVE)
          return false
        }
        const [, negate, variable] = ifMatch
        const value = IF_CONDITIONS.get(variable)
        if (value === undefined) {
          stack.push(IF_WHATEVER)
          return false
        }
        stack.push((negate === '!' ? !value : value) ? IF_BRAVE : IF_NOT_BRAVE)
        return false
      }
      if (line === '!#else') {
        stack.push(negateIfState(popStack()))
        return false
      }
      if (line === '!#endif') {
        popStack()
        return false
      }
      return peek !== IF_NOT_BRAVE
    })
    .join('\n')

  if (stack.length !== 0) throw new Error(`${title} preprocessor stack not empty at end. Check for corrupted list contents.`)
  return out
}

/** Strip Brave-specific scriptlet injections from non-Brave lists. */
const enforceBraveDirectives = (title: string, data: string): string =>
  title && (title.startsWith('Brave ') || title === 'Experimental ad blocker')
    ? data
    : data.split('\n').filter(line => !line.includes('+js(brave-')).join('\n')

// NOTE: crx-packager also runs `removeIncompatibleRules` (an adblock-rust 0.8.6
// WASM compat check) and a network sanity check, which protect *older* clients
// from certain scriptlet syntax. The current desktop engine parses those rules
// fine, so we skip them to stay dependency-free; the result is a faithful
// superset for modern Brave.

// ---------------------------------------------------------------------------
// Mirror fetching
// ---------------------------------------------------------------------------

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')

const mirrorUrl = (commit: string, sourceUrl: string) =>
  `https://raw.githubusercontent.com/${MIRROR_REPO}/${commit}/lists/${md5(sourceUrl)}.txt`

const fetchText = async (url: string): Promise<string> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (res.status !== 200) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
  return res.text()
}

/** Rebuild a list's list.txt from the pinned commit (sources fetched concurrently, order preserved). */
const buildListText = async (entry: CatalogEntry, commit: string): Promise<string> => {
  const parts = await Promise.all(
    (entry.sources ?? []).map(async source => {
      const title = source.title || entry.title
      info(`fetch ${source.title || source.url}`)
      let raw: string
      try {
        raw = await fetchText(mirrorUrl(commit, source.url))
      } catch (e) {
        throw new Error(
          `failed to fetch source "${source.url}" at commit ${commit}: ${(e as Error).message}\n` +
            `      (is the commit on the 'lists' branch of ${MIRROR_REPO}?)`
        )
      }
      return enforceBraveDirectives(title, preprocess(title, raw))
    })
  )
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Profiles & components
// ---------------------------------------------------------------------------

/** Resolve a path to a Brave user-data dir (accepting a profile subdir like ".../Default"), or null. */
const tryResolveUserDataDir = (input: string): string | null => {
  const abs = path.resolve(input.replace(/^~(?=$|\/)/, os.homedir()))
  if (fs.existsSync(path.join(abs, 'Local State'))) return abs
  if (fs.existsSync(path.join(path.dirname(abs), 'Local State'))) return path.dirname(abs)
  return null
}

/** Like tryResolveUserDataDir, but dies with guidance when the path isn't a Brave user-data dir. */
const resolveUserDataDir = (input: string): string =>
  tryResolveUserDataDir(input) ??
  die(
    `could not find a Brave "Local State" at "${input}" or its parent.\n` +
      `  Pass the Brave user-data dir, e.g. "~/Library/Application Support/BraveSoftware/Brave-Browser".`
  )

// Detect Brave user-data dirs (those with a "Local State"), stable channel first.
const CHANNEL_ORDER = ['Brave-Browser', 'Brave-Browser-Beta', 'Brave-Browser-Nightly', 'Brave-Browser-Dev', 'Brave-Browser-Development']
const detectUserDataDirs = (): string[] => {
  if (!fs.existsSync(BRAVE_SOFTWARE_DIR)) return []
  return fs
    .readdirSync(BRAVE_SOFTWARE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(BRAVE_SOFTWARE_DIR, d.name, 'Local State')))
    .map(d => d.name)
    .sort((a, b) => {
      const rank = (n: string) => (CHANNEL_ORDER.indexOf(n) + 1 || CHANNEL_ORDER.length + 1)
      return rank(a) - rank(b) || a.localeCompare(b)
    })
    .map(name => path.join(BRAVE_SOFTWARE_DIR, name))
}

/** Interactively pick one of the detected user-data dirs (TTY only). */
const pickUserDataDir = async (): Promise<string> => {
  const dirs = detectUserDataDirs()
  if (dirs.length === 0) return die(`no Brave profiles found under\n  ${BRAVE_SOFTWARE_DIR}\n  Launch Brave once, or pass --profile.`)
  log('Select a Brave profile:\n')
  dirs.forEach((d, i) => info(`${i + 1}) ${path.basename(d)}${i === 0 ? '  (default)' : ''}`))
  log('')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`Choice [1-${dirs.length}, default 1]: `)).trim()
    if (answer === '') return dirs[0]
    const n = Number.parseInt(answer, 10)
    if (!Number.isInteger(n) || n < 1 || n > dirs.length) return die(`invalid choice "${answer}"`)
    return dirs[n - 1]
  } finally {
    rl.close()
  }
}

const promptYesNo = async (question: string): Promise<boolean> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

/**
 * Resolve the --profile argument. Precedence:
 *   1. explicit --profile (one-off; never saved)
 *   2. a saved default profile that still exists
 *   3. interactive picker (TTY), optionally saving the choice
 *   4. otherwise error
 */
const resolveProfileArg = async (args: Args): Promise<string> => {
  const v = args.profile
  if (typeof v === 'string' && v.length > 0) return resolveUserDataDir(v)

  const saved = readConfig().defaultProfile
  if (saved) {
    const resolved = tryResolveUserDataDir(saved)
    if (resolved) {
      log(`Using saved profile: ${path.basename(resolved)}  (override with --profile, clear with 'adblock-pin forget')`)
      return resolved
    }
    warn(`saved default profile no longer exists, ignoring: ${saved}`)
  }

  if (!process.stdin.isTTY) return die('missing required --profile (no interactive terminal to select one).')
  const chosen = await pickUserDataDir()
  if (await promptYesNo('Remember this as the default profile? [y/N]: ')) {
    writeConfig({ ...readConfig(), defaultProfile: chosen })
    info(`saved default profile: ${path.basename(chosen)}`)
  }
  return chosen
}

const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/** Version subdirectories of a component dir, ascending. */
const versionDirs = (componentDir: string): string[] =>
  !fs.existsSync(componentDir)
    ? []
    : fs
        .readdirSync(componentDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^\d+(\.\d+)*$/.test(d.name))
        .map(d => d.name)
        .sort(compareVersions)

const highestVersionDir = (componentDir: string): string | null => versionDirs(componentDir).at(-1) ?? null

/** Read the filter list catalog from the installed catalog component. */
const readCatalog = (userDataDir: string): CatalogEntry[] => {
  const componentDir = path.join(userDataDir, CATALOG_COMPONENT_ID)
  const version = highestVersionDir(componentDir)
  if (!version) {
    return die(
      `filter list catalog component (${CATALOG_COMPONENT_ID}) not found under\n  ${userDataDir}\n` +
        `  Launch Brave at least once so the adblock components are installed, then retry.`
    )
  }
  return readJson<CatalogEntry[]>(path.join(componentDir, version, 'list_catalog.json'), 'list_catalog.json')
}

/** The default lists: enabled-by-default + hidden, with a well-formed component id. */
const getDefaultEntries = (catalog: CatalogEntry[]): CatalogEntry[] =>
  catalog.filter(
    e => e.default_enabled === true && e.hidden === true && !!e.list_text_component && isComponentId(e.list_text_component.component_id)
  )

/** Component dirs that currently hold our pinned (sentinel) version — the source of truth for "pinned". */
const pinnedComponentIds = (userDataDir: string): string[] =>
  !fs.existsSync(userDataDir)
    ? []
    : fs
        .readdirSync(userDataDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && isComponentId(d.name) && fs.existsSync(path.join(userDataDir, d.name, PINNED_VERSION, LIST_FILE)))
        .map(d => d.name)

/** Read the pinned commit/timestamp from the pinned manifest, or null if not pinned. */
const readPinInfo = (userDataDir: string): { commit: string; pinnedAt: string } | null => {
  const [id] = pinnedComponentIds(userDataDir)
  if (!id) return null
  const m = readJson<Record<string, string>>(path.join(userDataDir, id, PINNED_VERSION, 'manifest.json'), 'pinned manifest.json')
  return { commit: m._pinnedCommit ?? 'unknown', pinnedAt: m._pinnedAt ?? 'unknown' }
}

/** Write the pinned version dir: list.txt + a manifest copied from the live version (key preserved). */
const writePinnedComponent = (componentDir: string, sourceVersion: string, commit: string, listText: string) => {
  const target = path.join(componentDir, PINNED_VERSION)
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, LIST_FILE), listText)

  const srcManifest = path.join(componentDir, sourceVersion, 'manifest.json')
  const manifest: Record<string, unknown> = fs.existsSync(srcManifest)
    ? readJson<Record<string, unknown>>(srcManifest, 'manifest.json')
    : { manifest_version: 2, name: 'Brave Ad Block Updater' }
  manifest.version = PINNED_VERSION
  manifest._pinnedCommit = commit
  manifest._pinnedAt = new Date().toISOString()
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // Carry over the fingerprint, unless the source is the pin itself (a re-pin),
  // which would copy the file onto itself.
  const fp = path.join(componentDir, sourceVersion, 'manifest.fingerprint')
  if (sourceVersion !== PINNED_VERSION && fs.existsSync(fp)) fs.copyFileSync(fp, path.join(target, 'manifest.fingerprint'))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const cmdPin = async (userDataDir: string, commit: string, dryRun: boolean) => {
  if (!isCommitHash(commit)) die(`invalid --commit "${commit}": expected a 7-40 character hex commit hash from ${MIRROR_REPO}.`)

  log(`Brave user-data dir : ${userDataDir}`)
  log(`Mirror commit       : ${commit}`)
  if (dryRun) warn('dry run: no files will be written')
  if (pinnedComponentIds(userDataDir).length > 0) warn('already pinned; run "unpin" first to switch commits cleanly.')

  const targets = getDefaultEntries(readCatalog(userDataDir)).filter(e => {
    const installed = highestVersionDir(path.join(userDataDir, e.list_text_component!.component_id))
    if (!installed) info(`skip "${e.title}": not installed on this platform`)
    return installed
  })
  if (targets.length === 0) die('no installed default list components to pin.')

  log(`\nPinning ${targets.length} default list component(s):`)
  for (const entry of targets) {
    const id = entry.list_text_component!.component_id
    const componentDir = path.join(userDataDir, id)
    log(`\n• ${entry.title} (${id})`)
    const listText = await buildListText(entry, commit)
    info(`built list.txt (${entry.sources?.length ?? 0} sources, ${(Buffer.byteLength(listText) / 1024).toFixed(0)} KB)`)
    if (dryRun) {
      info(`would write ${id}/${PINNED_VERSION}/${LIST_FILE}`)
    } else {
      writePinnedComponent(componentDir, highestVersionDir(componentDir)!, commit, listText)
      info(`wrote ${id}/${PINNED_VERSION}/`)
    }
  }

  log('')
  if (dryRun) return warn('dry run complete; no files written.')
  ok(`pinned ${targets.length} component(s) to mirror commit ${commit.slice(0, 12)}`)
  log('\nNext: fully quit Brave (Cmd-Q), relaunch it normally (NOT with --disable-component-update),')
  log(`then confirm brave://components shows the "Brave Ad Block Updater" lists at ${PINNED_VERSION}.`)
  log('Revert with:  adblock-pin unpin --profile <dir>')
}

const cmdUnpin = (userDataDir: string, dryRun: boolean) => {
  const ids = pinnedComponentIds(userDataDir)
  if (ids.length === 0) return warn('not pinned; nothing to unpin.')
  log(`Removing pin from ${userDataDir}\n`)
  for (const id of ids) {
    if (dryRun) info(`would remove ${id}/${PINNED_VERSION}`)
    else {
      fs.rmSync(path.join(userDataDir, id, PINNED_VERSION), { recursive: true, force: true })
      info(`removed ${id}/${PINNED_VERSION}`)
    }
  }
  log('')
  ok('unpinned. Fully quit and relaunch Brave; it will re-download the current lists on next launch.')
}

const cmdStatus = (userDataDir: string) => {
  log(`Brave user-data dir : ${userDataDir}\n`)
  const pin = readPinInfo(userDataDir)
  if (pin) ok(`PINNED to mirror commit ${pin.commit} since ${pin.pinnedAt}`)
  else log('Not pinned.')
  log('\nDefault list components:')
  for (const e of getDefaultEntries(readCatalog(userDataDir))) {
    const id = e.list_text_component!.component_id
    const dirs = versionDirs(path.join(userDataDir, id))
    if (dirs.length === 0) {
      info(`${e.title} (${id}): not installed`)
      continue
    }
    const selected = dirs.at(-1)!
    info(`${e.title} (${id}): ${dirs.join(', ')}  → loads ${selected}${selected === PINNED_VERSION ? '  [PINNED]' : ''}`)
  }
}

const cmdList = () => {
  const dirs = detectUserDataDirs()
  if (dirs.length === 0) return warn(`no Brave profiles found under ${BRAVE_SOFTWARE_DIR}.`)
  const saved = readConfig().defaultProfile
  log(`Brave profiles under ${BRAVE_SOFTWARE_DIR}:\n`)
  for (const dir of dirs) {
    const pin = readPinInfo(dir)
    const isDefault = dir === saved ? '  (saved default)' : ''
    info(`${path.basename(dir)}${isDefault}  —  ${pin ? `pinned → ${pin.commit.slice(0, 12)}` : 'not pinned'}`)
  }
}

/** Clear the saved default profile, if any. */
const cmdForget = () => {
  const cfg = readConfig()
  if (!cfg.defaultProfile) return info('no saved default profile.')
  const was = cfg.defaultProfile
  delete cfg.defaultProfile
  if (Object.keys(cfg).length === 0) fs.rmSync(configPath(), { force: true })
  else writeConfig(cfg)
  ok(`cleared saved default profile (was: ${was})`)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Args = Record<string, string | boolean>

const USAGE = `adblock-pin — point local Brave at an older version of the adblock lists

Usage:
  adblock-pin pin    [--profile <dir>] --commit <hash> [--dry-run]
  adblock-pin unpin  [--profile <dir>] [--dry-run]
  adblock-pin status [--profile <dir>]
  adblock-pin list
  adblock-pin forget

Options:
  --profile <dir>   Brave user-data dir (the one with "Local State"), or a profile dir
                    like ".../Default". If omitted on a terminal, you're prompted to pick,
                    and offered to save the choice as the default for future runs.
                    Explicit --profile is always a one-off and never changes the default.
  --commit <hash>   Commit hash from github.com/brave/adblock-lists-mirror (lists branch)
  --dry-run         Show what would happen without writing files

"forget" clears the saved default profile.

Pins the "default" lists (Brave Default Adblock/Privacy/First-Party) at version ${PINNED_VERSION}.
Quit Brave before running and start it normally afterwards — do NOT use --disable-component-update.`

const parseArgs = (argv: string[]) => {
  const args: Args = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const body = a.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      args[body.slice(0, eq)] = body.slice(eq + 1) // --key=value
    } else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      args[body] = true // boolean flag
    } else {
      args[body] = argv[++i] // --key value
    }
  }
  return { command: positional[0], args }
}

const requireStr = (args: Args, key: string): string => {
  const v = args[key]
  if (typeof v !== 'string' || v.length === 0) die(`missing required --${key}`)
  return v as string
}

const main = async () => {
  const { command, args } = parseArgs(process.argv.slice(2))
  if (!command || command === 'help' || args.help) {
    log(USAGE)
    process.exit(command === 'help' || args.help === true ? 0 : 1)
  }
  const dryRun = args['dry-run'] === true
  switch (command) {
    case 'pin':
      return cmdPin(await resolveProfileArg(args), requireStr(args, 'commit'), dryRun)
    case 'unpin':
      return cmdUnpin(await resolveProfileArg(args), dryRun)
    case 'status':
      return cmdStatus(await resolveProfileArg(args))
    case 'list':
      return cmdList()
    case 'forget':
      return cmdForget()
    default:
      die(`unknown command "${command}". Run with --help.`)
  }
}

// Exported for tests. The CLI below only runs when invoked directly.
export {
  preprocess,
  enforceBraveDirectives,
  isComponentId,
  isCommitHash,
  md5,
  mirrorUrl,
  fetchText,
  buildListText,
  compareVersions,
  versionDirs,
  highestVersionDir,
  tryResolveUserDataDir,
  resolveUserDataDir,
  detectUserDataDirs,
  pickUserDataDir,
  resolveProfileArg,
  configPath,
  readConfig,
  writeConfig,
  getDefaultEntries,
  readCatalog,
  pinnedComponentIds,
  readPinInfo,
  writePinnedComponent,
  cmdPin,
  cmdUnpin,
  cmdStatus,
  cmdList,
  cmdForget,
  parseArgs,
  requireStr,
  die,
  PINNED_VERSION
}

if (import.meta.main) {
  // Our thrown errors carry a clear, actionable message; show that rather than a stack.
  main().catch(e => die(e instanceof Error ? e.message : String(e)))
}
