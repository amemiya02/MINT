# Contributing to MINT

Read `GLOSSARY.md` first and use its terms in code, UI copy and commit messages.
Architectural decisions live in `docs/adr/`.

## Prerequisites

- Node.js 24 or newer, pnpm 10 or newer
- Rust stable (with `rustfmt` and `clippy`)
- The [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS

## Commands

| What | Command |
| --- | --- |
| Install | `pnpm install` |
| Run the desktop app | `pnpm dev` |
| Run the shell in a browser (in-memory platform, no Rust) | `pnpm dev:web` |
| Unit tests (editor core, Markdown package, shell checks such as the theme variable list) | `pnpm test` |
| E2E tests (Playwright) | `pnpm test:e2e` (first time: `pnpm --filter @mint/desktop exec playwright install chromium`) |
| Rust tests | `pnpm test:rust` |
| Homebrew cask and winget manifest templates | `pnpm test:packaging` |
| Type check | `pnpm typecheck` |
| Lint and format check (Biome, rustfmt, clippy) | `pnpm lint` |
| Auto-format | `pnpm format` |
| Build installers | `pnpm build` |

## Layout

```
apps/desktop/            Tauri app
  src/                   React shell
    platform/            Platform interface + Tauri and in-memory implementations
    i18n/                UI strings (en is the reference, zh-CN must match it)
    folder/              Folder sidebar: file tree, recent list; opens documents via the tab store
    paths.ts             Every path helper of the shell (separators, names, resolving and relative paths)
    quick-open/          Quick open (⌘P): fuzzy file-name search over the folder's documents
    search/              Global search (⌘⇧F): text search over the folder's documents, streamed from the Rust backend
    tabs/                Tab store of one window; show a document with useTabStore().openDocument(path[, range]).
                         It also watches each open document and reloads it or reports conflicts
    commands.ts          Command registry (menus and shortcuts derive from it)
    App.tsx              One window: wires the tab store, commands, sidebar and overlays together
    window/              Parts of a window: tab panel, status bar, welcome screen, overlay state, dialogs it asks
    settings/            Settings schema, store synced with settings.json, settings window
    updates/             Update checks and the update notice (Platform.checkForUpdate)
    print/               The print window PDF export opens (see the exception below)
  src-tauri/             Rust backend (kept thin, see ADR-0005)
  e2e/                   Playwright tests
packages/editor/         Editor core: CodeMirror 6, no framework or platform imports
packages/markdown/       Dialect definition and export pipeline
packaging/               Homebrew cask and winget manifest templates (see Distribution channels)
```

## Rules of the road

- The editor core (`packages/editor`) must not import React, Tauri or anything
  from `apps/`. Whatever it needs from its host goes through `HostAdapter`.
- The shell reaches files, dialogs, windows and menus only through the
  `Platform` interface (`apps/desktop/src/platform/platform.ts`). Add new
  capabilities there and implement them in both `tauri.ts` and `memory.ts`.
  One exception: `src/print/main.ts` is the entry point of the print window,
  a separate page that only exists in the desktop app (`Platform.printDocument`
  opens it). It talks to Tauri directly to receive its document, print and
  close; it never runs with the in-memory platform, so a seam would only add
  indirection.
- Every user-visible string goes through `t()` from `src/i18n`. Add the key to
  `en.ts`; the type checker then requires the `zh-CN.ts` translation.
- New user actions are added to the command registry (`commands.ts`), not wired
  directly to keys or menu items.
- New settings are one entry in `src/settings/schema.ts` (key, kind, default,
  label) plus its strings in `src/i18n`. Validation of settings.json and the
  control in the settings window are derived from that entry; read the value
  with `useSettings().settings.<key>`. The Rust side only reads, writes and
  watches the file and never needs to change.

## Security and privacy

- **Granted roots.** The Rust file commands only touch paths inside a root the
  user granted: the folder of a document picked in an open or save dialog
  (the dialogs run in Rust, `show_*_dialog`), a folder the user opened, a path
  handed over by the file manager or the command line, settings.json and the
  theme folder. Paths are compared after resolving symbolic links and `..`.
  Grants are remembered in `access/granted-roots.json` in the app data
  directory (outside every root), so the recent list and the recovery area
  keep working after a restart. See `src-tauri/src/grants.rs`. The asset
  protocol's scope starts empty and grows with the same roots. Consequence: an
  image or asset folder outside the opened documents' folders does not load.
- **HTML from documents.** Whatever goes into the app's DOM from a document
  is sanitized (`renderHtml` in `packages/markdown`: GitHub's schema plus
  MINT's own elements; ids get a `user-content-` prefix). An exported HTML file
  keeps the HTML written in the document, minus `<script>`, `on…` handlers and
  `javascript:` URLs (`renderExportHtml`).
- **Remote images (privacy).** Documents may show images from `http(s)` URLs,
  as ticket #5 requires, so opening a document can make requests to the servers
  those images live on (revealing your IP address and when you read it). The
  CSP keeps `img-src https: http:` for this; nothing else is loaded remotely.

## Tests

Tests only go through three seams, and assert behaviour visible at that seam,
never internals (CodeMirror state fields, decorations, React structure).

| Seam | Where | Exemplar |
| --- | --- | --- |
| Editor core public API (Vitest + jsdom, fast-check for properties) | `packages/editor/test/` | `editor.test.ts`, `source-fidelity.test.ts` |
| Markdown export API (Vitest) | `packages/markdown/test/` | `export.test.ts` |
| Platform interface: shell E2E in a browser with the in-memory platform (Playwright) | `apps/desktop/e2e/` | `open-edit-save.spec.ts` |
| Platform interface: Rust backend commands (`cargo test`) | `#[cfg(test)]` modules in `apps/desktop/src-tauri/src/` | `fs.rs` |

E2E tests seed the in-memory platform with `launch(page, { files, openDialogResults, locale })`
and settings.json via `files: { [settingsPath]: "…" }`, change files from outside with
`writeFile(page, path, text)` (settings.json) or `externalWrite` / `externalRemove` /
`externalRename` (documents; see `external-changes.spec.ts`), and read files back with `readFile(page, path)` (see `e2e/memory-platform.ts`).

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request (and on pushes to `main`
and `feat/**`): Biome, type check, rustfmt and the packaging templates once on Linux, then unit tests,
Playwright E2E tests, clippy and `cargo test` on Linux, macOS and Windows.
A smoke job builds the real app on Linux and drives it over WebDriver with
`tauri-driver` (`apps/desktop/smoke/`): open a document from the command line,
edit, save, check the file. It cannot run on macOS (tauri-driver has no macOS
support); on Linux run `tauri-driver &` then
`MINT_APP=src-tauri/target/debug/mint node --test smoke/*.smoke.ts` in
`apps/desktop` under X. There are no performance gates.

## Releases and automatic updates

`.github/workflows/release.yml` runs when a tag `vX.Y.Z` is pushed. It builds
the installers with `tauri-action` (macOS Apple silicon and Intel: `.dmg` +
`.app.tar.gz`; Windows: NSIS `-setup.exe` + `.msi`; Linux: `.AppImage`, `.deb`,
`.rpm`), uploads them with signatures and the updater manifest `latest.json` to
a draft GitHub Release, and publishes the release once all four builds have
succeeded.

Installed copies of MINT check
`https://github.com/amemiya02/MINT/releases/latest/download/latest.json` at
startup (setting `checkForUpdates`, on by default) and from **MINT › Check for
Updates…**, then download, verify and install the new version and restart.
Updates are only offered by release builds that were given the updater public
key, and not to Linux `.deb`/`.rpm` installs (their package manager updates
them). `pnpm dev`, debug builds and local `pnpm build` need no keys: the
committed `tauri.conf.json` has an empty `plugins.updater.pubkey` and does not
create updater artifacts; the release workflow fills both in.

### One-time setup for the maintainer

1. Generate the updater key pair (this signs updates; it is not OS code signing):

   ```sh
   pnpm --filter @mint/desktop tauri signer generate -w ~/.tauri/mint-updater.key
   ```

   Choose a password when asked. This writes the private key to
   `~/.tauri/mint-updater.key` and the public key to `~/.tauri/mint-updater.key.pub`.
   **Back up the private key and password offline.** If either is lost, installed
   copies can never auto-update again; users would have to reinstall by hand.
2. In the GitHub repository, **Settings › Secrets and variables › Actions**:

   | Kind | Name | Value |
   | --- | --- | --- |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/mint-updater.key` |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 1 |
   | Variable | `TAURI_UPDATER_PUBKEY` | contents of `~/.tauri/mint-updater.key.pub` |

   The release workflow stops before building if the private key or the public
   key is missing, and fails to sign if the password is wrong.
3. **Settings › Actions › General › Workflow permissions**: allow read and write
   (the workflow also declares `contents: write`).

Optional, not wired yet: Apple Developer ID signing and notarization
(`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, passed to `tauri-action` as env)
and Windows code signing. Without them macOS users must right-click › Open the
first time (or run `xattr -dr com.apple.quarantine /Applications/MINT.app`) and
Windows SmartScreen warns about an unrecognised app. Updates work either way.

### Cutting a release

1. Set the same version in `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/src-tauri/Cargo.toml` and `apps/desktop/package.json`
   (MSI needs a plain `X.Y.Z` or a numeric pre-release).
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
   The workflow refuses a tag that does not match `tauri.conf.json`.
3. When the workflow finishes, the release is public and installed copies see
   the update on their next check. Its last job generates Homebrew and winget
   manifests (next section).

## Distribution channels

`release.yml` publishes installers to GitHub Releases. The AppImage and
`.deb` come from the Linux build on Ubuntu 22.04 and run on glibc 2.35+.
Before publishing, the workflow checks that the installers required by the
README and package manifests are attached. Their names are defined in
`packaging/render.mjs` (`releaseAssets`).

`packaging/` holds the Homebrew cask template and the winget manifest
templates. `.github/workflows/distribute.yml` downloads the released `.dmg`s and
`-setup.exe`, fills in the version and SHA-256 with `packaging/render.mjs`, and
uploads the result as the `package-manifests` artifact. It runs after
`release.yml`, when a release is published by hand, and from **Actions ›
Distribute › Run workflow** with a tag. Update the templates to change future
manifests. `pnpm test:packaging` checks them.

To render the manifests locally for a published release:

```sh
mkdir -p /tmp/mint-assets
gh release download v0.2.0 --dir /tmp/mint-assets --pattern '*.dmg' --pattern '*_x64-setup.exe'
node packaging/render.mjs manifests 0.2.0 /tmp/mint-assets /tmp/mint-manifests
```

To publish the packages manually, copy `homebrew/Casks/mint.rb` from the
artifact into the tap's `Casks/` directory. For winget, validate
`winget/manifests/a/amemiya02/MINT/<version>` with `winget validate --manifest`
and submit that version directory to `microsoft/winget-pkgs`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) and reference
the ticket, e.g. `feat(editor): span reveal for inline marks (#3)`.
