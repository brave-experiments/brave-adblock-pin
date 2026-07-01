/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// End-to-end tests of pin/unpin/status against a temp user-data dir, with
// `fetch` stubbed so no network (and no real Brave) is required.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  cmdPin,
  cmdUnpin,
  fetchText,
  buildListText,
  md5,
  pinnedComponentIds,
  readPinInfo,
  PINNED_VERSION
} from '../src/pin-adblock.ts'

const CATALOG_ID = 'gkboaolpopklhgplhaaiboijnklogmbc'
const INSTALLED_ID = 'iodkpdagapdfkphljnddpjlldadblomo'
const NOT_INSTALLED_ID = 'eaokkjgnlhceblfhbhpeoebmfldocmnc'
const ORIG_VERSION = '1.0.100'
const ORIG_KEY = 'TEST_PUBLIC_KEY_BASE64'
const COMMIT = 'abc123def456'
const SOURCE_A = 'https://example.com/a.txt'
const SOURCE_B = 'https://example.com/b.txt'
const EXPECTED_LIST = 'rule-a\nrule-b'

const makeProfile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abp-int-'))
  fs.writeFileSync(path.join(dir, 'Local State'), '{}')
  const catalog = [
    {
      uuid: 'default',
      title: 'Brave Default Adblock Filters',
      default_enabled: true,
      hidden: true,
      list_text_component: { component_id: INSTALLED_ID },
      sources: [
        { url: SOURCE_A, title: 'EasyList' },
        { url: SOURCE_B, title: 'EasyList' }
      ]
    },
    {
      uuid: 'ios',
      title: 'Brave IOS-Specific Filters',
      default_enabled: true,
      hidden: true,
      list_text_component: { component_id: NOT_INSTALLED_ID },
      sources: [{ url: 'https://example.com/ios.txt', title: 'iOS' }]
    }
  ]
  const catDir = path.join(dir, CATALOG_ID, '1.0.0')
  fs.mkdirSync(catDir, { recursive: true })
  fs.writeFileSync(path.join(catDir, 'list_catalog.json'), JSON.stringify(catalog))

  const listDir = path.join(dir, INSTALLED_ID, ORIG_VERSION)
  fs.mkdirSync(listDir, { recursive: true })
  fs.writeFileSync(path.join(listDir, 'list.txt'), 'original-rules')
  fs.writeFileSync(path.join(listDir, 'manifest.json'), JSON.stringify({ manifest_version: 2, key: ORIG_KEY, version: ORIG_VERSION }))
  return dir
}

const installFetch = (responses: Record<string, string>) => {
  const real = globalThis.fetch
  // @ts-expect-error minimal Response stub
  globalThis.fetch = async (url: string) =>
    String(url) in responses
      ? { status: 200, statusText: 'OK', text: async () => responses[String(url)] }
      : { status: 404, statusText: 'Not Found', text: async () => '' }
  return () => {
    globalThis.fetch = real
  }
}

// SOURCE_A exercises preprocessing; SOURCE_B exercises brave-scriptlet stripping.
const mirrorResponses = (commit: string): Record<string, string> => ({
  [`https://raw.githubusercontent.com/brave/adblock-lists-mirror/${commit}/lists/${md5(SOURCE_A)}.txt`]: 'rule-a\n!#if env_firefox\nff\n!#endif',
  [`https://raw.githubusercontent.com/brave/adblock-lists-mirror/${commit}/lists/${md5(SOURCE_B)}.txt`]: 'rule-b\nfoo##+js(brave-x)'
})

const silence = async (fn: () => unknown | Promise<unknown>) => {
  const lines: string[] = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  const sink = (...a: unknown[]) => void lines.push(a.join(' '))
  console.log = console.warn = console.error = sink as never
  try {
    await fn()
  } finally {
    Object.assign(console, orig)
  }
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
}

const cleanup = (dir: string) => fs.rmSync(dir, { recursive: true, force: true })
const pinnedDir = (dir: string) => path.join(dir, INSTALLED_ID, PINNED_VERSION)

test('pin: writes pinned list.txt + manifest, records commit, skips not-installed', async () => {
  const dir = makeProfile()
  const restore = installFetch(mirrorResponses(COMMIT))
  try {
    const out = await silence(() => cmdPin(dir, COMMIT, false))

    assert.equal(fs.readFileSync(path.join(pinnedDir(dir), 'list.txt'), 'utf8'), EXPECTED_LIST)
    const manifest = JSON.parse(fs.readFileSync(path.join(pinnedDir(dir), 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, PINNED_VERSION)
    assert.equal(manifest.key, ORIG_KEY) // key preserved from the live manifest
    assert.equal(manifest._pinnedCommit, COMMIT) // commit recorded in the manifest

    assert.deepEqual(pinnedComponentIds(dir), [INSTALLED_ID])
    assert.equal(readPinInfo(dir)?.commit, COMMIT)

    assert.match(out, /skip "Brave IOS-Specific Filters"/)
    assert.ok(!fs.existsSync(path.join(dir, NOT_INSTALLED_ID)))
  } finally {
    restore()
    cleanup(dir)
  }
})

test('pin --dry-run: writes nothing', async () => {
  const dir = makeProfile()
  const restore = installFetch(mirrorResponses(COMMIT))
  try {
    await silence(() => cmdPin(dir, COMMIT, true))
    assert.ok(!fs.existsSync(pinnedDir(dir)))
    assert.deepEqual(pinnedComponentIds(dir), [])
  } finally {
    restore()
    cleanup(dir)
  }
})

test('unpin: removes the pin; original stays; not pinned afterwards', async () => {
  const dir = makeProfile()
  const restore = installFetch(mirrorResponses(COMMIT))
  try {
    await silence(() => cmdPin(dir, COMMIT, false))
    await silence(() => cmdUnpin(dir, false))

    assert.ok(!fs.existsSync(pinnedDir(dir)), 'pin removed')
    assert.equal(fs.readFileSync(path.join(dir, INSTALLED_ID, ORIG_VERSION, 'list.txt'), 'utf8'), 'original-rules')
    assert.deepEqual(pinnedComponentIds(dir), [])
    assert.equal(readPinInfo(dir), null)
  } finally {
    restore()
    cleanup(dir)
  }
})

test('unpin: no-ops when not pinned', async () => {
  const dir = makeProfile()
  try {
    const out = await silence(() => cmdUnpin(dir, false))
    assert.match(out, /nothing to unpin/)
  } finally {
    cleanup(dir)
  }
})

test('re-pin to a different commit overwrites the pinned list + commit', async () => {
  const dir = makeProfile()
  const restore = installFetch({ ...mirrorResponses(COMMIT), ...mirrorResponses('beef1234') })
  try {
    await silence(() => cmdPin(dir, COMMIT, false))
    // simulate Brave GC'ing the original (only the pin remains)
    fs.rmSync(path.join(dir, INSTALLED_ID, ORIG_VERSION), { recursive: true, force: true })
    await silence(() => cmdPin(dir, 'beef1234', false))

    assert.equal(readPinInfo(dir)?.commit, 'beef1234')
    // manifest key carried forward from the previous pin (original is gone)
    assert.equal(JSON.parse(fs.readFileSync(path.join(pinnedDir(dir), 'manifest.json'), 'utf8')).key, ORIG_KEY)
  } finally {
    restore()
    cleanup(dir)
  }
})

test('fetchText: throws on non-200', async () => {
  const restore = installFetch({})
  try {
    await assert.rejects(() => fetchText('https://example.com/missing.txt'), /HTTP 404/)
  } finally {
    restore()
  }
})

test('buildListText: helpful error when a source is missing at the commit', async () => {
  const restore = installFetch({})
  try {
    const entry = { uuid: 'x', title: 'T', sources: [{ url: SOURCE_A, title: 'EasyList' }] } as any
    await assert.rejects(() => buildListText(entry, COMMIT), /failed to fetch source.*'lists' branch/s)
  } finally {
    restore()
  }
})

test('pin: invalid --commit is rejected before any fetch', async () => {
  const dir = makeProfile()
  try {
    let threw = false
    const realExit = process.exit
    // @ts-expect-error stub
    process.exit = () => {
      threw = true
      throw new Error('__exit__')
    }
    try {
      await silence(() => cmdPin(dir, 'not-a-hash', false).catch(() => {}))
    } catch {
      /* die throws via stub */
    } finally {
      process.exit = realExit
    }
    assert.ok(threw, 'expected die on invalid commit')
    assert.deepEqual(pinnedComponentIds(dir), [])
  } finally {
    cleanup(dir)
  }
})
