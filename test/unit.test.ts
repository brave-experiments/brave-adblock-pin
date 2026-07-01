/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  preprocess,
  enforceBraveDirectives,
  isComponentId,
  isCommitHash,
  md5,
  mirrorUrl,
  compareVersions,
  versionDirs,
  highestVersionDir,
  resolveUserDataDir,
  getDefaultEntries,
  parseArgs
} from '../src/pin-adblock.ts'

const ID_A = 'a'.repeat(32)
const ID_B = 'b'.repeat(32)
const ID_C = 'c'.repeat(32)
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'abp-unit-'))

const expectExit = (fn: () => unknown) => {
  const real = process.exit
  let exited = false
  // @ts-expect-error test stub
  process.exit = () => {
    exited = true
    throw new Error('__exit__')
  }
  try {
    fn()
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e
  } finally {
    process.exit = real
  }
  return exited
}

// ---- preprocess ----

test('preprocess: keeps a true branch and strips directive lines', () => {
  assert.equal(preprocess('t', 'a\n!#if env_chromium\nb\n!#endif\nc'), 'a\nb\nc')
})
test('preprocess: drops a false branch', () => {
  assert.equal(preprocess('t', '!#if env_firefox\nx\n!#endif\ny'), 'y')
})
test('preprocess: negation flips the condition', () => {
  assert.equal(preprocess('t', '!#if !env_firefox\nkeep\n!#endif'), 'keep')
  assert.equal(preprocess('t', '!#if !env_chromium\ndrop\n!#endif'), '')
})
test('preprocess: !#else toggles the active branch', () => {
  assert.equal(preprocess('t', '!#if env_firefox\nno\n!#else\nyes\n!#endif'), 'yes')
})
test('preprocess: unknown variable keeps the block', () => {
  assert.equal(preprocess('t', '!#if env_totally_unknown\nkeepme\n!#endif'), 'keepme')
})
test('preprocess: nested !#if inside a false branch stays dropped', () => {
  assert.equal(preprocess('t', '!#if env_firefox\nouter\n!#if env_chromium\ninner\n!#endif\nmore\n!#endif\nkeep'), 'keep')
})
test('preprocess: throws on unbalanced !#endif', () => {
  assert.throws(() => preprocess('t', '!#endif'), /preprocessor error/)
})
test('preprocess: throws when stack not empty at end', () => {
  assert.throws(() => preprocess('t', '!#if env_chromium\nx'), /stack not empty/)
})

// ---- enforceBraveDirectives ----

test('enforceBraveDirectives: strips brave scriptlets from non-Brave lists', () => {
  assert.equal(enforceBraveDirectives('EasyList', 'a\nfoo##+js(brave-x)\nb'), 'a\nb')
})
test('enforceBraveDirectives: keeps content for "Brave " lists', () => {
  const data = 'a\nfoo##+js(brave-x)\nb'
  assert.equal(enforceBraveDirectives('Brave Specific', data), data)
})
test('enforceBraveDirectives: keeps content for "Experimental ad blocker"', () => {
  const data = 'foo##+js(brave-y)'
  assert.equal(enforceBraveDirectives('Experimental ad blocker', data), data)
})

// ---- validators ----

test('validators: isComponentId / isCommitHash', () => {
  assert.ok(isComponentId('a'.repeat(32)))
  assert.ok(isComponentId('iodkpdagapdfkphljnddpjlldadblomo'))
  assert.ok(!isComponentId('abc'))
  assert.ok(!isComponentId('z'.repeat(32)))
  assert.ok(!isComponentId('../../etc/passwd'))

  assert.ok(isCommitHash('d2d0243c'))
  assert.ok(isCommitHash('d2d0243c32146ca27b95807d4a36d44664e9b714'))
  assert.ok(!isCommitHash('refs/heads/lists'))
  assert.ok(!isCommitHash('../../other'))
})

// ---- versions ----

test('compareVersions: numeric, not lexicographic', () => {
  assert.ok(compareVersions('99.0.0', '1.0.20509') > 0)
  assert.ok(compareVersions('1.0.2', '1.0.10') < 0)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
})

// ---- mirror URL ----

test('md5 + mirrorUrl: known digest and path', () => {
  assert.equal(md5('https://easylist.to/easylist/easylist.txt'), '17ba74de8f13543dbff29e37b3ce125d')
  assert.equal(
    mirrorUrl('abc123', 'https://easylist.to/easylist/easylist.txt'),
    'https://raw.githubusercontent.com/brave/adblock-lists-mirror/abc123/lists/17ba74de8f13543dbff29e37b3ce125d.txt'
  )
})

// ---- getDefaultEntries ----

test('getDefaultEntries: keeps default_enabled && hidden with a valid component id', () => {
  const catalog = [
    { uuid: 'a', title: 'Default', default_enabled: true, hidden: true, list_text_component: { component_id: ID_A } },
    { uuid: 'b', title: 'Regional', default_enabled: false, hidden: false, list_text_component: { component_id: ID_B } },
    { uuid: 'c', title: 'Visible default', default_enabled: true, hidden: false, list_text_component: { component_id: ID_C } },
    { uuid: 'd', title: 'No component', default_enabled: true, hidden: true },
    { uuid: 'e', title: 'Bad id', default_enabled: true, hidden: true, list_text_component: { component_id: '../escape' } }
  ] as any
  assert.deepEqual(getDefaultEntries(catalog).map(e => e.uuid), ['a'])
})

// ---- version dir helpers (filesystem) ----

test('versionDirs / highestVersionDir', () => {
  const dir = mkTmp()
  try {
    for (const v of ['1.0.0', '1.0.20509', '99.0.0', 'not-a-version']) fs.mkdirSync(path.join(dir, v))
    assert.deepEqual(versionDirs(dir), ['1.0.0', '1.0.20509', '99.0.0'])
    assert.equal(highestVersionDir(dir), '99.0.0')
    assert.equal(highestVersionDir(path.join(dir, 'nope')), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- resolveUserDataDir ----

test('resolveUserDataDir: accepts a user-data dir or a profile dir, dies otherwise', () => {
  const dir = mkTmp()
  try {
    fs.writeFileSync(path.join(dir, 'Local State'), '{}')
    assert.equal(resolveUserDataDir(dir), path.resolve(dir))
    const profile = path.join(dir, 'Default')
    fs.mkdirSync(profile)
    assert.equal(resolveUserDataDir(profile), path.resolve(dir))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const bare = mkTmp()
  try {
    assert.ok(expectExit(() => resolveUserDataDir(bare)), 'expected process.exit')
  } finally {
    fs.rmSync(bare, { recursive: true, force: true })
  }
})

// ---- parseArgs ----

test('parseArgs: --key value, --key=value, boolean flags, positional command', () => {
  const a = parseArgs(['pin', '--profile', '/x', '--commit', 'abc', '--dry-run'])
  assert.equal(a.command, 'pin')
  assert.equal(a.args.profile, '/x')
  assert.equal(a.args.commit, 'abc')
  assert.equal(a.args['dry-run'], true)

  const b = parseArgs(['pin', '--profile=/x', '--commit=abc123'])
  assert.equal(b.args.profile, '/x')
  assert.equal(b.args.commit, 'abc123')
})
