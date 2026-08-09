/**
 * Refuse to package an architecture whose Python runtime has not been built.
 *
 * electron-builder treats a missing `extraResources.from` directory as nothing
 * to copy rather than as an error, so without this guard a build for an
 * architecture you forgot to prepare produces a perfectly ordinary-looking
 * .dmg with no interpreter inside. That failure only shows up on the user's
 * machine, as an app whose backend never starts.
 */

const fs = require('fs');
const path = require('path');

// electron-builder's Arch enum, which arrives as a number.
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

exports.default = async function beforePack(context) {
  const arch = ARCH_NAMES[context.arch] ?? String(context.arch);

  // Only macOS and Linux ship the bundled runtime today; Windows is not
  // supported (see docs/WINDOWS.md) and has no runtime to check for.
  if (context.electronPlatformName === 'win32') return;

  const runtime = path.join(__dirname, '..', 'runtime', arch, 'python', 'bin', 'python3');

  if (!fs.existsSync(runtime)) {
    throw new Error(
      `No bundled Python runtime for ${arch}.\n`
      + `  Expected: ${runtime}\n`
      + `  Build it first:  bash scripts/bundle-python.sh --arch ${arch}\n`
      + `  (building the x64 runtime on Apple Silicon needs Rosetta 2)`
    );
  }
};
