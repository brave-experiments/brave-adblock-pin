/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// Saved-default-profile config + resolveProfileArg precedence. Config is pinned
// to a temp $XDG_CONFIG_HOME so tests never touch the real one. The interactive
// picker/prompt is not exercised (manual); we cover the non-interactive paths.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readConfig, writeConfig, configPath, resolveProfileArg } from '../src/pin-adblock.ts'

// Run fn with config isolated under a fresh temp XDG_CONFIG_HOME.
const withTempConfig = async (fn: () => unknown | Promise<unknown>) => {
  const prev = process.env.XDG_CONFIG_HOME
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abp-cfg-'))
  process.env.XDG_CONFIG_HOME = tmp
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// A throwaway user-data dir (has a "Local State").
const makeUserDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abp-ud-'))
  fs.writeFileSync(path.join(dir, 'Local State'), '{}')
  return dir
}

const silence = async (fn: () => unknown | Promise<unknown>) => {
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = (() => {}) as never
  try {
    return await fn()
  } finally {
    Object.assign(console, orig)
  }
}

const expectExit = async (fn: () => Promise<unknown>) => {
  const real = process.exit
  let exited = false
  // @ts-expect-error test stub
  process.exit = () => {
    exited = true
    throw new Error('__exit__')
  }
  try {
    await fn()
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e
  } finally {
    process.exit = real
  }
  return exited
}

test('readConfig: {} for missing or corrupt file; round-trips through writeConfig', async () => {
  await withTempConfig(() => {
    assert.deepEqual(readConfig(), {})
    writeConfig({ defaultProfile: '/x/Brave-Browser' })
    assert.deepEqual(readConfig(), { defaultProfile: '/x/Brave-Browser' })
    fs.writeFileSync(configPath(), 'not json {')
    assert.deepEqual(readConfig(), {})
  })
})

test('configPath: honors $XDG_CONFIG_HOME', async () => {
  await withTempConfig(() => {
    assert.equal(configPath(), path.join(process.env.XDG_CONFIG_HOME!, 'brave-adblock-pin', 'config.json'))
  })
})

test('resolveProfileArg: explicit --profile wins and never touches the saved default', async () => {
  await withTempConfig(async () => {
    const ud = makeUserDataDir()
    try {
      writeConfig({ defaultProfile: '/nonexistent/Brave-Browser' })
      const got = await silence(() => resolveProfileArg({ profile: ud }))
      assert.equal(got, path.resolve(ud))
      // saved default untouched
      assert.equal(readConfig().defaultProfile, '/nonexistent/Brave-Browser')
    } finally {
      fs.rmSync(ud, { recursive: true, force: true })
    }
  })
})

test('resolveProfileArg: uses a valid saved default (works non-interactively)', async () => {
  await withTempConfig(async () => {
    const ud = makeUserDataDir()
    try {
      writeConfig({ defaultProfile: ud })
      const got = await silence(() => resolveProfileArg({}))
      assert.equal(got, ud)
    } finally {
      fs.rmSync(ud, { recursive: true, force: true })
    }
  })
})

test('resolveProfileArg: a saved default whose dir is gone is skipped (then errors non-TTY)', async () => {
  await withTempConfig(async () => {
    writeConfig({ defaultProfile: '/definitely/not/here/Brave-Browser' })
    const exited = await silence(() => expectExit(() => resolveProfileArg({})))
    assert.ok(exited, 'expected die when no usable profile and no TTY')
  })
})
