#!/usr/bin/env bash
#
# AutoAB, build the self-contained Python runtime that ships inside the app.
#
# The pipeline shells out to Change-O and pRESTO console scripts and imports
# biopython/pandas/numpy/scipy. Requiring users to provide a Python with all of
# that installed is the single biggest setup hurdle, so the packaged app carries
# its own interpreter instead.
#
# The interpreter comes from python-build-standalone, which publishes CPython
# builds that run from any directory. Ordinary CPython bakes its install prefix
# into the binary and cannot simply be copied into an .app bundle.
#
# Usage:
#   bash scripts/bundle-python.sh              # host architecture
#   bash scripts/bundle-python.sh --arch x64   # cross-build for Intel
#   bash scripts/bundle-python.sh --all        # both macOS architectures
#
set -euo pipefail

# Pinned so a build is reproducible. Bump both together; the asset name
# embeds the release date.
PBS_RELEASE="20260807"
PY_VERSION="3.11.15"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="$REPO_ROOT/electron-app/runtime"
REQUIREMENTS="$REPO_ROOT/backend/requirements.txt"

host_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64)        echo "x64" ;;
    *) echo "Unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

# electron-builder's arch names -> python-build-standalone target triples.
triple_for() {
  local arch="$1"
  case "$(uname -s):$arch" in
    Darwin:arm64) echo "aarch64-apple-darwin" ;;
    Darwin:x64)   echo "x86_64-apple-darwin" ;;
    Linux:x64)    echo "x86_64-unknown-linux-gnu" ;;
    Linux:arm64)  echo "aarch64-unknown-linux-gnu" ;;
    *) echo "No python-build-standalone target for $(uname -s)/$arch" >&2; exit 1 ;;
  esac
}

# pip writes the interpreter's absolute path into every console script it
# installs. That path stops existing the moment the runtime is copied into
# AutoAB.app, so rewrite the shebangs to resolve through PATH instead. The
# Electron main process puts this bin directory ahead of the system one when it
# spawns the pipeline, so `python3` resolves back to the bundled interpreter.
relocate_shebangs() {
  local bin_dir="$1"
  local rewritten=0
  local script
  for script in "$bin_dir"/*; do
    [ -f "$script" ] || continue
    # Only touch text files that start with a shebang pointing at our own
    # interpreter; leave the real binaries (python3.11, pip's own ELF/Mach-O)
    # untouched.
    head -c 2 "$script" 2>/dev/null | grep -q '^#!' || continue
    grep -qE '^#!.*(python|pypy)' "$script" 2>/dev/null || continue

    # Preserve the executable bit; sed -i on macOS needs the empty suffix.
    sed -i '' '1s|^#!.*$|#!/usr/bin/env python3|' "$script"
    rewritten=$((rewritten + 1))
  done
  echo "    rewrote $rewritten shebangs to /usr/bin/env python3"
}

build_one() {
  local arch="$1"
  local triple
  triple="$(triple_for "$arch")"
  local dest="$RUNTIME_ROOT/$arch"
  local archive="cpython-${PY_VERSION}+${PBS_RELEASE}-${triple}-install_only.tar.gz"
  local url="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${archive}"

  echo "==> $arch ($triple)"

  if [ -x "$dest/python/bin/python3" ] \
     && "$dest/python/bin/python3" -c 'import changeo, presto' >/dev/null 2>&1; then
    echo "    already built, skipping (delete $dest to force a rebuild)"
    return 0
  fi

  rm -rf "$dest"
  mkdir -p "$dest"

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" RETURN

  echo "    downloading $archive"
  curl -fSL --retry 3 "$url" -o "$tmp/$archive"

  echo "    extracting"
  tar xzf "$tmp/$archive" -C "$dest"   # unpacks to $dest/python

  local py="$dest/python/bin/python3"
  [ -x "$py" ] || { echo "    expected interpreter missing at $py" >&2; exit 1; }

  # A cross-architecture build runs the foreign interpreter to resolve its own
  # wheels, which on Apple Silicon means Rosetta 2 has to be present.
  if [ "$arch" != "$(host_arch)" ] && ! "$py" -c 'pass' >/dev/null 2>&1; then
    echo "    cannot execute the $arch interpreter on this host." >&2
    echo "    Install Rosetta 2:  softwareupdate --install-rosetta --agree-to-license" >&2
    exit 1
  fi

  echo "    installing $(basename "$REQUIREMENTS")"
  "$py" -m pip install --quiet --upgrade pip
  "$py" -m pip install --quiet --no-cache-dir --no-warn-script-location -r "$REQUIREMENTS"

  relocate_shebangs "$dest/python/bin"

  # Ship no bytecode caches; they are regenerated on first use and are a
  # meaningful slice of the bundle size.
  find "$dest/python" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

  echo "    verifying"
  "$py" -c 'import Bio, pandas, numpy, matplotlib, scipy, airr, changeo, presto; print("       imports OK")'
  PATH="$dest/python/bin:$PATH" MakeDb.py --version 2>&1 | head -1 | sed 's/^/       /'
  echo "    size: $(du -sh "$dest" | cut -f1)"
}

ARCHES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCHES+=("$2"); shift 2 ;;
    --all)  ARCHES=(arm64 x64); shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[ ${#ARCHES[@]} -gt 0 ] || ARCHES=("$(host_arch)")

[ -f "$REQUIREMENTS" ] || { echo "Missing $REQUIREMENTS" >&2; exit 1; }

for arch in "${ARCHES[@]}"; do
  build_one "$arch"
done

echo
echo "Done. Runtime(s) under $RUNTIME_ROOT/"
echo "The packaged app picks these up automatically; see electron-builder.yml."
