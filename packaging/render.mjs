// Renders the Homebrew cask and winget manifests for one MINT release from the
// templates next to this file, and knows which release assets the
// distribution channels download. Used by .github/workflows/distribute.yml and
// by the maintainer for the first manual submissions (CONTRIBUTING.md).
//
//   node packaging/render.mjs assets <version>
//       Print the expected asset names (one per line).
//   node packaging/render.mjs check-assets <version> < names.txt
//       Fail unless every expected asset is among the names read from stdin.
//   node packaging/render.mjs manifests <version> <assets-dir> <out-dir>
//       Hash the downloaded installers in <assets-dir> and write
//       <out-dir>/homebrew/Casks/mint.rb and
//       <out-dir>/winget/manifests/a/amemiya02/MINT/<version>/*.yaml.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const WINGET_ID = "amemiya02.MINT";
const WINGET_FILES = [
  `${WINGET_ID}.yaml`,
  `${WINGET_ID}.installer.yaml`,
  `${WINGET_ID}.locale.en-US.yaml`,
];

function checkVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected a version X.Y.Z, got "${version}"`);
  }
}

function checkSha256(value, what) {
  if (!/^[0-9a-fA-F]{64}$/.test(value ?? "")) {
    throw new Error(`Expected a sha256 hex digest for ${what}, got "${value}"`);
  }
}

function fill(template, values) {
  const text = template.replace(/@([A-Z0-9_]+)@/g, (match, key) => {
    if (!(key in values)) throw new Error(`No value for placeholder ${match}`);
    return values[key];
  });
  return text;
}

function template(...path) {
  return readFileSync(join(here, ...path), "utf8");
}

/** Release asset names (as produced by tauri-action) that the channels download. */
export function releaseAssets(version) {
  checkVersion(version);
  return {
    macArm: `MINT_${version}_aarch64.dmg`,
    macIntel: `MINT_${version}_x64.dmg`,
    windowsSetup: `MINT_${version}_x64-setup.exe`,
    appImage: `MINT_${version}_amd64.AppImage`,
    deb: `MINT_${version}_amd64.deb`,
  };
}

/** The Homebrew cask `Casks/mint.rb` for a release. */
export function renderCask({ version, sha256 }) {
  checkVersion(version);
  checkSha256(sha256?.arm, "the Apple silicon dmg");
  checkSha256(sha256?.intel, "the Intel dmg");
  return fill(template("homebrew", "mint.rb.template"), {
    VERSION: version,
    SHA256_ARM: sha256.arm.toLowerCase(),
    SHA256_INTEL: sha256.intel.toLowerCase(),
  });
}

/** The three winget manifest files for a release, keyed by file name. */
export function renderWinget({ version, sha256, releaseDate = new Date() }) {
  checkVersion(version);
  checkSha256(sha256, "the Windows setup");
  const values = {
    VERSION: version,
    SHA256: sha256.toUpperCase(),
    RELEASE_DATE: releaseDate.toISOString().slice(0, 10),
  };
  return Object.fromEntries(
    WINGET_FILES.map((name) => [name, fill(template("winget", `${name}.template`), values)]),
  );
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main([command, version, ...rest]) {
  const assets = releaseAssets(version);
  switch (command) {
    case "assets":
      console.log(Object.values(assets).join("\n"));
      return;
    case "check-assets": {
      const present = new Set(readFileSync(0, "utf8").split(/\s+/).filter(Boolean));
      const missing = Object.values(assets).filter((name) => !present.has(name));
      if (missing.length > 0) {
        throw new Error(`Release v${version} is missing: ${missing.join(", ")}`);
      }
      return;
    }
    case "manifests": {
      const [assetsDir, outDir] = rest;
      if (!assetsDir || !outDir)
        throw new Error("Usage: manifests <version> <assets-dir> <out-dir>");
      const casksDir = join(outDir, "homebrew", "Casks");
      mkdirSync(casksDir, { recursive: true });
      writeFileSync(
        join(casksDir, "mint.rb"),
        renderCask({
          version,
          sha256: {
            arm: sha256Of(join(assetsDir, assets.macArm)),
            intel: sha256Of(join(assetsDir, assets.macIntel)),
          },
        }),
      );
      const wingetDir = join(outDir, "winget", "manifests", "a", "amemiya02", "MINT", version);
      mkdirSync(wingetDir, { recursive: true });
      const manifests = renderWinget({
        version,
        sha256: sha256Of(join(assetsDir, assets.windowsSetup)),
      });
      for (const [name, text] of Object.entries(manifests)) {
        writeFileSync(join(wingetDir, name), text);
      }
      return;
    }
    default:
      throw new Error(`Unknown command "${command}" (assets, check-assets, manifests)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
