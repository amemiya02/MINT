# MINT

MINT (MINT Is Not Typora) is an open-source, cross-platform desktop Markdown
editor. It edits the `.md` files on your disk in place with live preview, and
every part of a file you did not edit is saved back byte-for-byte unchanged.

## Install

Every version is published on the
[Releases page](https://github.com/amemiya02/MINT/releases/latest). MINT checks
for new versions at startup and from **Check for Updates…**, and updates
itself (except the Linux `.deb`, which is updated by reinstalling it).

### macOS

With [Homebrew](https://brew.sh):

```sh
brew install --cask amemiya02/mint/mint
```

Or download `MINT_<version>_aarch64.dmg` (Apple silicon) or
`MINT_<version>_x64.dmg` (Intel) and drag MINT to Applications.

MINT is not notarized by Apple yet. If macOS says the app cannot be opened or
is damaged, right-click MINT in Applications and choose **Open**, or run:

```sh
xattr -dr com.apple.quarantine /Applications/MINT.app
```

### Windows

With [winget](https://learn.microsoft.com/windows/package-manager/winget/):

```powershell
winget install amemiya02.MINT
```

Or download and run `MINT_<version>_x64-setup.exe` (installs for the current
user, no administrator rights needed). The `.msi` on the release page is for
administrators who deploy machine-wide.

The installer is not code-signed yet, so SmartScreen may show "Windows
protected your PC": choose **More info › Run anyway**.

### Linux (x64)

**AppImage** (any distribution with glibc 2.35 or newer, e.g. Ubuntu 22.04+,
Debian 12+, Fedora 36+):

```sh
chmod +x MINT_<version>_amd64.AppImage
./MINT_<version>_amd64.AppImage
```

On Ubuntu 24.04 and newer, AppImages need FUSE 2 first:
`sudo apt install libfuse2t64`.

**Debian / Ubuntu** (`.deb`):

```sh
sudo apt install ./MINT_<version>_amd64.deb
```

An `.rpm` for Fedora and openSUSE is also attached to each release.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
