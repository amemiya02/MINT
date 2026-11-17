// Behaviour of the package-manager manifests MINT publishes for each release.
// Run with `pnpm test:packaging` (node:test, no dependencies).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { releaseAssets, renderCask, renderWinget } from "./render.mjs";

const SHA_ARM = "a".repeat(64);
const SHA_INTEL = "b".repeat(64);
const SHA_WIN = "c".repeat(64);

describe("release assets", () => {
  it("names the installers each distribution channel downloads", () => {
    assert.deepEqual(releaseAssets("1.2.3"), {
      macArm: "MINT_1.2.3_aarch64.dmg",
      macIntel: "MINT_1.2.3_x64.dmg",
      windowsSetup: "MINT_1.2.3_x64-setup.exe",
      appImage: "MINT_1.2.3_amd64.AppImage",
      deb: "MINT_1.2.3_amd64.deb",
    });
  });

  it("rejects a version that is not X.Y.Z", () => {
    assert.throws(() => releaseAssets("v1.2.3"), /version/);
    assert.throws(() => releaseAssets("1.2"), /version/);
  });
});

describe("Homebrew cask", () => {
  const cask = renderCask({ version: "1.2.3", sha256: { arm: SHA_ARM, intel: SHA_INTEL } });

  it("pins the version and both macOS checksums", () => {
    assert.match(cask, /^ {2}version "1\.2\.3"$/m);
    assert.match(cask, new RegExp(`sha256 arm:\\s+"${SHA_ARM}",\\s+intel: "${SHA_INTEL}"`));
  });

  it("downloads the per-architecture dmg from the GitHub release", () => {
    assert.match(
      cask,
      /url "https:\/\/github\.com\/amemiya02\/MINT\/releases\/download\/v#\{version\}\/MINT_#\{version\}_#\{arch\}\.dmg"/,
    );
    assert.match(cask, /arch arm: "aarch64", intel: "x64"/);
  });

  it("leaves no placeholder behind", () => {
    assert.doesNotMatch(cask, /@[A-Z_]+@/);
  });

  it("rejects a checksum that is not SHA-256 hex", () => {
    assert.throws(
      () => renderCask({ version: "1.2.3", sha256: { arm: "nope", intel: SHA_INTEL } }),
      /sha256/i,
    );
  });
});

describe("winget manifests", () => {
  const manifests = renderWinget({ version: "1.2.3", sha256: SHA_WIN });

  it("produces the version, installer and default-locale files", () => {
    assert.deepEqual(Object.keys(manifests).sort(), [
      "amemiya02.MINT.installer.yaml",
      "amemiya02.MINT.locale.en-US.yaml",
      "amemiya02.MINT.yaml",
    ]);
  });

  it("points the installer at the NSIS setup with its checksum", () => {
    const installer = manifests["amemiya02.MINT.installer.yaml"];
    assert.match(
      installer,
      /InstallerUrl: https:\/\/github\.com\/amemiya02\/MINT\/releases\/download\/v1\.2\.3\/MINT_1\.2\.3_x64-setup\.exe/,
    );
    assert.match(installer, new RegExp(`InstallerSha256: ${SHA_WIN.toUpperCase()}`));
    assert.match(installer, /InstallerType: nullsoft/);
  });

  it("carries the same identifier and version in every file", () => {
    for (const text of Object.values(manifests)) {
      assert.match(text, /^PackageIdentifier: amemiya02\.MINT$/m);
      assert.match(text, /^PackageVersion: 1\.2\.3$/m);
      assert.doesNotMatch(text, /@[A-Z_]+@/);
    }
  });
});
