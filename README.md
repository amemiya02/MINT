# MINT

**MINT Is Not Typora.** An open-source, cross-platform Markdown editor with live preview.

[简体中文](README.zh-CN.md)

## Features

- **Live preview:** Markdown renders as you type, and the syntax under the cursor is revealed for editing. A source mode is one shortcut away.
- **Your files, untouched:** MINT edits plain `.md` files in place, and every part you didn't change is saved back byte-for-byte.
- **Rich content:** GFM tables and task lists, math (KaTeX), Mermaid diagrams, front matter, footnotes and inline HTML.
- **Folders and tabs:** a file tree, quick open, search across a folder, tabs and multiple windows.
- **Writing tools:** outline, focus mode, typewriter mode, a command palette, and Typora-style shortcuts you can change.
- **Safe by default:** autosave and crash recovery, image pasting into an assets folder, and export to HTML and PDF.
- Light and dark modes, [custom CSS themes](docs/themes.md), and an interface in English and 简体中文.

## Install

Download the installer for your system from [Releases](https://github.com/amemiya02/MINT/releases/latest):

| System | File |
|---|---|
| macOS (Apple silicon / Intel) | `MINT_<version>_aarch64.dmg` / `MINT_<version>_x64.dmg` |
| Windows | `MINT_<version>_x64-setup.exe` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

The installers are not code-signed yet:

- **macOS:** if MINT "cannot be opened" or is "damaged", run `xattr -dr com.apple.quarantine /Applications/MINT.app`.
- **Windows:** if SmartScreen blocks it, choose **More info › Run anyway**.

MINT updates itself when a new version is out (except `.deb` and `.rpm` installs).

## Build from source

Requires Node 24+, pnpm 10+, Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and tests.

## License

[MIT](LICENSE)
