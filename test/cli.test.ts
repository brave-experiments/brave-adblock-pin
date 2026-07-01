/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// Drives the real CLI entrypoint as a subprocess (`node src/pin-adblock.ts ...`)
// to cover argument dispatch, help, error exit codes, and the no-network
// commands (status / unpin) end to end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRIPT = fileURLToPath(new URL('../src/pin-adblock.ts', import.meta.url))

const run = (args: string[]) => {
  // Point config at an empty dir so a real saved default can't affect these tests.
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(os.tmpdir(), 'abp-cli-noconfig') }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env })
  return { code: r.status, out: r.stdout ?? '', errOut: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') }
}

// A minimal valid user-data dir with a catalog and one installed default list.
const makeProfile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abp-cli-'))
  fs.writeFileSync(path.join(dir, 'Local State'), '{}')
  const catDir = path.join(dir, 'gkboaolpopklhgplhaaiboijnklogmbc', '1.0.0')
  fs.mkdirSync(catDir, { recursive: true })
  fs.writeFileSync(
    path.join(catDir, 'list_catalog.json'),
    JSON.stringify([
      {
        uuid: 'default',
        title: 'Brave Default Adblock Filters',
        default_enabled: true,
        hidden: true,
        list_text_component: { component_id: 'iodkpdagapdfkphljnddpjlldadblomo' },
        sources: [{ url: 'https://example.com/a.txt', title: 'EasyList', format: 'Standard' }]
      }
    ])
  )
  const listDir = path.join(dir, 'iodkpdagapdfkphljnddpjlldadblomo', '1.0.100')
  fs.mkdirSync(listDir, { recursive: true })
  fs.writeFileSync(path.join(listDir, 'list.txt'), 'original-rules')
  fs.writeFileSync(path.join(listDir, 'manifest.json'), JSON.stringify({ version: '1.0.100', key: 'K' }))
  return dir
}
const cleanup = (dir: string) => fs.rmSync(dir, { recursive: true, force: true })

test('cli: --help exits 0 and prints usage', () => {
  const r = run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /Usage:/)
})

test('cli: no args exits 1 and prints usage', () => {
  const r = run([])
  assert.equal(r.code, 1)
  assert.match(r.all, /Usage:/)
})

test('cli: unknown command exits 1', () => {
  const r = run(['frobnicate', '--profile', '/tmp'])
  assert.equal(r.code, 1)
  assert.match(r.all, /unknown command/)
})

test('cli: missing --profile exits 1', () => {
  const r = run(['status'])
  assert.equal(r.code, 1)
  assert.match(r.all, /missing required --profile/)
})

test('cli: missing --commit on pin exits 1', () => {
  const dir = makeProfile()
  try {
    const r = run(['pin', '--profile', dir])
    assert.equal(r.code, 1)
    assert.match(r.all, /missing required --commit/)
  } finally {
    cleanup(dir)
  }
})

test('cli: invalid --commit is rejected before any network access', () => {
  const dir = makeProfile()
  try {
    const r = run(['pin', '--profile', dir, '--commit', 'not a hash!'])
    assert.equal(r.code, 1)
    assert.match(r.all, /invalid --commit/)
  } finally {
    cleanup(dir)
  }
})

test('cli: status on a path with no Local State exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abp-cli-bad-'))
  try {
    const r = run(['status', '--profile', dir])
    assert.equal(r.code, 1)
    assert.match(r.all, /could not find a Brave "Local State"/)
  } finally {
    cleanup(dir)
  }
})

test('cli: status on a user-data dir without the catalog component exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abp-cli-nocat-'))
  fs.writeFileSync(path.join(dir, 'Local State'), '{}')
  try {
    const r = run(['status', '--profile', dir])
    assert.equal(r.code, 1)
    assert.match(r.all, /catalog component .* not found/)
  } finally {
    cleanup(dir)
  }
})

test('cli: status on a valid profile exits 0 and lists the default component', () => {
  const dir = makeProfile()
  try {
    const r = run(['status', '--profile', dir])
    assert.equal(r.code, 0)
    assert.match(r.out, /Not pinned\./)
    assert.match(r.out, /Brave Default Adblock Filters/)
    assert.match(r.out, /loads 1\.0\.100/)
  } finally {
    cleanup(dir)
  }
})

test('cli: forget with no saved default is a no-op', () => {
  const r = run(['forget'])
  assert.equal(r.code, 0)
  assert.match(r.all, /no saved default profile/)
})

test('cli: unpin with nothing pinned exits 0 with a notice', () => {
  const dir = makeProfile()
  try {
    const r = run(['unpin', '--profile', dir])
    assert.equal(r.code, 0)
    assert.match(r.all, /nothing to unpin/)
  } finally {
    cleanup(dir)
  }
})
