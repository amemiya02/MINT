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
| Unit tests (editor core, Markdown package) | `pnpm test` |
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
    workspace/           Folder sidebar: file tree, recent list; opens documents via the tab store
    quick-open/          Quick open (⌘P): fuzzy file-name search over the folder's documents
    tabs/                Tab store of one window; show a document with useTabStore().openDocument(path).
                         It also watches each open document and reloads it or reports conflicts
    commands.ts          Command registry (menus and shortcuts derive from it)
    settings/            Settings schema, store synced with settings.json, settings window
    updates/             Update checks and the update notice (Platform.checkForUpdate)
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
- Every user-visible string goes through `t()` from `src/i18n`. Add the key to
  `en.ts`; the type checker then requires the `zh-CN.ts` translation.
- New user actions are added to the command registry (`commands.ts`), not wired
  directly to keys or menu items.
- New settings are one entry in `src/settings/schema.ts` (key, kind, default,
  label) plus its strings in `src/i18n`. Validation of settings.json and the
  control in the settings window are derived from that entry; read the value
  with `useSettings().settings.<key>`. The Rust side only reads, writes and
  watches the file and never needs to change.

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
There are no performance gates.

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
   the update on their next check. Its last job then updates the package
   managers (next section).

## Distribution channels

| Channel | Users install with | Updated on release by |
| --- | --- | --- |
| GitHub Release (`.dmg`, `-setup.exe`, `.msi`, `.AppImage`, `.deb`, `.rpm`) | download (README, "Install") | `release.yml` |
| Homebrew tap `amemiya02/homebrew-mint` | `brew install --cask amemiya02/mint/mint` | `distribute.yml`, job "Update the Homebrew tap" |
| winget `amemiya02.MINT` | `winget install amemiya02.MINT` | `distribute.yml`, job "Submit to winget" |

The AppImage and `.deb` come from the Linux build in `release.yml` (Ubuntu
22.04, so they run on glibc 2.35+). Before publishing, the release workflow
checks that every installer the channels and the README link to is attached;
the names are defined once in `packaging/render.mjs` (`releaseAssets`).

`packaging/` holds the templates: `homebrew/mint.rb.template` (the cask) and
`winget/*.yaml.template` (version, installer and default-locale manifests).
`.github/workflows/distribute.yml` downloads the released `.dmg`s and
`-setup.exe`, fills in version and SHA-256 with `packaging/render.mjs`, and
uploads the result as the `package-manifests` artifact. It then commits
`Casks/mint.rb` to the tap and opens a pull request on `microsoft/winget-pkgs`,
each only if its token is set; otherwise the job is skipped with a notice and
the workflow still succeeds. It runs after `release.yml`, when a release is
published by hand, and from **Actions › Distribute › Run workflow** with a tag
(use that to retry or to update a channel after setting it up). Change the
templates, not the generated files; `pnpm test:packaging` checks them.

To render the manifests locally for a published release:

```sh
mkdir -p /tmp/mint-assets
gh release download v0.2.0 --dir /tmp/mint-assets --pattern '*.dmg' --pattern '*_x64-setup.exe'
node packaging/render.mjs manifests 0.2.0 /tmp/mint-assets /tmp/mint-manifests
```

### One-time setup for the package managers

Do these once, after the first release has been published (steps 2 and 3 need
its installers). Until then the distribution jobs are no-ops.

1. **Create the Homebrew tap.** Create the public repository
   `amemiya02/homebrew-mint` (the `homebrew-` prefix is required; `brew` turns
   `amemiya02/mint` into it). Give it a README and a `Casks/` directory; the
   workflow writes `Casks/mint.rb`. To use another repository, set the Actions
   variable `HOMEBREW_TAP_REPO` (e.g. `someone/homebrew-mint`) and change the
   tap name in the README.
2. **Allow the workflow to push to the tap.** Create a fine-grained personal
   access token with access to only the tap repository and permission
   **Contents: Read and write**, and save it in this repository as the Actions
   secret `HOMEBREW_TAP_TOKEN`. Then run **Actions › Distribute › Run workflow**
   with the current tag and check that `brew install --cask amemiya02/mint/mint`
   works.
3. **Submit the first winget version by hand** (winget only automates updates
   of packages it already has):
   1. Run **Distribute** for the current tag (or render locally, above) and
      download the `package-manifests` artifact.
   2. Validate on Windows: `winget validate --manifest <dir>` and
      `winget install --manifest <dir>`, where `<dir>` is
      `winget/manifests/a/amemiya02/MINT/<version>`.
   3. Fork `microsoft/winget-pkgs` under the account that will own the
      token, copy the directory to the same path in the fork, and open a pull
      request (or use `wingetcreate submit <dir>` / `komac submit`). Sign the
      Microsoft CLA when the bot asks. Validation runs in a VM; merging usually
      takes a few days.
4. **Allow the workflow to update winget.** Under the account that owns the
   `winget-pkgs` fork, create a **classic** personal access token with the
   `public_repo` scope (fine-grained tokens are not supported by
   `winget-releaser`) and save it as the Actions secret `WINGET_TOKEN`. Every
   later release then opens the winget pull request automatically; keep the
   fork in place.

| Kind | Name | Needed for |
| --- | --- | --- |
| Secret | `HOMEBREW_TAP_TOKEN` | pushing `Casks/mint.rb` to the tap |
| Variable | `HOMEBREW_TAP_REPO` | optional, tap repository other than `amemiya02/homebrew-mint` |
| Secret | `WINGET_TOKEN` | opening `winget-pkgs` pull requests from the fork |

The official `homebrew/cask` repository only accepts signed and notarized apps
(and has popularity requirements), so MINT ships through its own tap until
Apple Developer ID signing is set up. After that, submit the cask from
`packaging/homebrew/` to `Homebrew/homebrew-cask`
(`brew audit --new --cask mint`); Homebrew's autobump then follows releases
through the cask's `livecheck`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) and reference
the ticket, e.g. `feat(editor): span reveal for inline marks (#3)`.
