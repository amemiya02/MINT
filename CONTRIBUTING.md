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
    tabs/                Tab store of one window; show a document with useTabStore().openDocument(path)
    commands.ts          Command registry (menus and shortcuts derive from it)
    settings/            Settings schema, store synced with settings.json, settings window
  src-tauri/             Rust backend (kept thin, see ADR-0005)
  e2e/                   Playwright tests
packages/editor/         Editor core: CodeMirror 6, no framework or platform imports
packages/markdown/       Dialect definition and export pipeline
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
`writeFile(page, path, text)`,
and read files back with `readFile(page, path)` (see `e2e/memory-platform.ts`).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) and reference
the ticket, e.g. `feat(editor): span reveal for inline marks (#3)`.
