# brave-adblock-pin

[![CI](https://github.com/brave-experiments/brave-adblock-pin/actions/workflows/ci.yml/badge.svg)](https://github.com/brave-experiments/brave-adblock-pin/actions/workflows/ci.yml)

Point a local Brave install at an **older version of the adblock filter lists**,
identified by a commit hash from
[`brave/adblock-lists-mirror`](https://github.com/brave/adblock-lists-mirror/commits/lists/),
for local testing of adblock incidents.

```
status  →  pin --commit <hash>  →  (quit + relaunch Brave)  →  test  →  unpin
```

## Install

I've only tested this on MacOS, though other OSes shouldn't be hard to add support for.

```bash
cd brave-adblock-pin
npm link          # puts `brave-adblock-pin` on your PATH (symlinked to this repo)
brave-adblock-pin --help
```

`npm link` symlinks the repo, so edits take effect immediately. Use
`npm install -g .` for a fixed copy instead, or skip install entirely and run
`node src/pin-adblock.ts <command>`. To remove: `npm rm -g brave-adblock-pin`.

## Quickstart

```bash
# 1. See what's installed / pinned
brave-adblock-pin status

# 2. Pin the default lists to a specific mirror commit
brave-adblock-pin pin --commit d2d0243c32146ca27b95807d4a36d44664e9b714

# 3. Fully quit Brave (Cmd-Q), then relaunch it normally and test.

# 4. Revert when done (relaunch Brave afterward to re-download current lists)
brave-adblock-pin unpin
```

After step 2, confirm at `brave://components` that the "Brave Ad Block Updater"
entries show the pin version `99.0.0`.

### Verifying a pin

- `brave://components` shows the "Brave Ad Block Updater" entries at
  `99.0.0`, and the on-disk `<component_id>/99.0.0/list.txt` is the pinned commit's
  content. 
- if you want to *see* a rule take effect, note that Brave only does
  first-party cosmetic filtering in **Aggressive** shields mode; generic cosmetic
  rules (e.g. `##.TextAd`) will not hide first-party page elements under the default
  Standard mode. Set Shields to Aggressive for the test site, or check a
  network-blocked request instead (blocking works in any mode).

Worked example (what we used): pin to `d2d0243c`; its EasyList still had
`##.TextAd`, a generic rule the current list dropped. On `example.com` with
Shields set to **Aggressive**, inject a matching element and it gets hidden;
on the current lists (or in Standard mode) it stays visible:

```js
// paste in the DevTools console on https://example.com
const d = document.createElement('div');
d.className = 'TextAd'; d.textContent = 'ad';
document.body.prepend(d);
setTimeout(() => console.log('TextAd display:', getComputedStyle(d).display), 3000);
// pinned to d2d0243c + Aggressive -> "none" (blocked);  otherwise -> "block"
```

## Commands & flags

| Command | Description |
|---------|-------------|
| `status` | Show each default component's installed versions and which one Brave will load. |
| `pin`    | Rebuild the default lists from a mirror commit and write them as a high version. |
| `unpin`  | Remove the pin and restore the original lists. |
| `list`   | List detected Brave profiles (user-data dirs) and their pin status. |
| `forget` | Clear the saved default profile. |

| Flag | Applies to | Description |
|------|-----------|-------------|
| `--profile <dir>` | `pin`, `unpin`, `status` | Brave user-data dir (the one with `Local State`) **or** a profile dir like `.../Default`. If omitted: a saved default is used if set; otherwise on a terminal you're prompted to pick one (and can save it); with no TTY and no saved default, it errors. |
| `--commit <hash>` | `pin` | Commit on the `lists` branch of `adblock-lists-mirror`. Validated as a 7-40 char hex SHA. |
| `--dry-run` | `pin`, `unpin` | Print what would happen without writing anything. |

Pinned lists are written at a fixed sentinel version, `99.0.0` (higher than any
real component version, so the update server never overrides them).

### Saving a default profile

The first time you run a command without `--profile` on a terminal, you pick a
profile and are offered to remember it. The choice is stored in
`$XDG_CONFIG_HOME/brave-adblock-pin/config.json` (default `~/.config/brave-adblock-pin/`) and
reused on later runs (including non-interactive ones, e.g. CI). `--profile`
always overrides for that run without changing the saved default, and
`brave-adblock-pin forget` clears it.

Both `--key value` and `--key=value` forms are accepted.

### Finding your Brave user-data dir

| Channel | Path (macOS) |
|---------|--------------|
| Release | `~/Library/Application Support/BraveSoftware/Brave-Browser` |
| Beta    | `~/Library/Application Support/BraveSoftware/Brave-Browser-Beta` |
| Nightly | `~/Library/Application Support/BraveSoftware/Brave-Browser-Nightly` |

You can also pass a specific profile dir (e.g. `.../Brave-Browser/Default`); the
tool walks up to the user-data dir automatically.

### Finding a commit hash

Browse [the `lists` branch history](https://github.com/brave/adblock-lists-mirror/commits/lists/),
or fetch the latest programmatically:

```bash
# latest commit on the lists branch
curl -s "https://api.github.com/repos/brave/adblock-lists-mirror/commits/lists" | jq -r .sha

# a commit from on/before a given date
curl -s "https://api.github.com/repos/brave/adblock-lists-mirror/commits?sha=lists&until=2026-04-30T00:00:00Z&per_page=1" | jq -r '.[0].sha'
```

The mirror updates roughly twice an hour.

## How it works

Brave ships filter lists as component-updater components, installed directly
under the user-data dir as `<user-data>/<component_id>/<version>/`:

- `gkboaolpopklhgplhaaiboijnklogmbc/<v>/list_catalog.json`: the list catalog
- `mfddibmblmbccpadfndgakiopmmhebop/<v>/resources.json`: scriptlet resources
- per-list components, e.g. `iodkpdagapdfkphljnddpjlldadblomo/<v>/list.txt`: the
  actual filter rules (`iodkp…` is the Brave default / EasyList list)

brave-core loads the **highest-versioned** directory of each component. 

`pin`:

1. Reads `list_catalog.json` from the installed catalog component to find the
   **default** lists (`default_enabled && hidden`) and their source URLs.
2. For each source, fetches the pinned text from
   `raw.githubusercontent.com/brave/adblock-lists-mirror/<commit>/lists/<md5(sourceUrl)>.txt`
   (the same URL scheme crx-packager uses), then applies the same `!#if`
   preprocessing and Brave-directive stripping, and concatenates the sources.
3. Writes the rebuilt `list.txt` into a new `99.0.0` dir, with a `manifest.json`
   copied from the live version (preserving the component key, bumping `version`,
   and recording the pinned commit in a `_pinnedCommit` field).

The **filesystem is the only state**: a profile is "pinned" iff its components
have a `99.0.0/list.txt`, and the pinned commit is read back from the manifest.
There's no separate state file. `unpin` deletes the `99.0.0` dirs; on next
launch Brave's component updater re-downloads the current lists (the standard
recovery path), so a brief restart is all that's needed to revert.

## Tests

```bash
npm test                                   # runs test/*.test.ts
node --test --experimental-test-coverage test/*.test.ts   # with coverage
```

## Scope / limitations

- Pins the **default lists only** (Brave Default Adblock / Privacy / First-Party).
  Regional and additional opt-in lists are not touched. Lists not installed on
  this platform (e.g. the iOS-specific list on desktop) are skipped automatically.
- Skips crx-packager's `removeIncompatibleRules` (an adblock-rust 0.8.6 WASM
  compatibility filter) and its network/iOS sanity checks. Those protect *older*
  clients from certain scriptlet syntax; the current desktop engine parses those
  rules fine, so the rebuilt `list.txt` is a faithful superset for modern Brave.
- The `resources.json` (scriptlets) and the catalog itself are not pinned, only
  the filter rule text. 
- Quit Brave between runs. 

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `could not find a Brave "Local State" …` | You passed a path that isn't a Brave user-data or profile dir. Use one of the paths above. |
| `filter list catalog component … not found` | Brave hasn't installed the adblock components yet. Launch Brave once (with network) and retry. |
| `failed to fetch source … at commit` | The commit isn't on the `lists` branch, or it predates a source being added. Double-check the hash against the [lists history](https://github.com/brave/adblock-lists-mirror/commits/lists/). |
| `brave://components` still shows `1.0.x` after pin | Brave wasn't fully quit before relaunch. Quit Brave completely (Cmd-Q) and reopen. |

## Files this tool writes (under the user-data dir)

The only thing written is, per pinned component:

- `<component_id>/99.0.0/{list.txt, manifest.json[, manifest.fingerprint]}`

