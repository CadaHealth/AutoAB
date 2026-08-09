#!/usr/bin/env bash
#
# AutoAB, fetch the external binaries the pipeline shells out to.
#
# IgBLAST is not vendored in this repository: it is a ~110 MB set of
# platform-specific NCBI executables. This script downloads the pinned release
# and puts igblastn / igblastp / makeblastdb where the pipeline expects them.
#
# Usage:  bash scripts/install.sh
#
set -euo pipefail

IGBLAST_VERSION="1.22.0"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/geneGUI/bin"
DATA_DIR="$REPO_ROOT/geneGUI/data"

case "$(uname -s)" in
  Darwin) ARCHIVE="ncbi-igblast-${IGBLAST_VERSION}-x64-macosx.tar.gz" ;;
  Linux)  ARCHIVE="ncbi-igblast-${IGBLAST_VERSION}-x64-linux.tar.gz" ;;
  *)      echo "Unsupported platform: $(uname -s). Download IgBLAST ${IGBLAST_VERSION} manually into $BIN_DIR." >&2
          exit 1 ;;
esac

URL="https://ftp.ncbi.nih.gov/blast/executables/igblast/release/${IGBLAST_VERSION}/${ARCHIVE}"

echo "==> Target: $BIN_DIR"
mkdir -p "$BIN_DIR"

if [ -x "$BIN_DIR/igblastn" ] && "$BIN_DIR/igblastn" -version >/dev/null 2>&1; then
  echo "==> IgBLAST already present: $("$BIN_DIR/igblastn" -version | head -1)"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  echo "==> Downloading $ARCHIVE"
  curl -fSL --retry 3 "$URL" -o "$TMP/$ARCHIVE"

  echo "==> Extracting"
  tar xzf "$TMP/$ARCHIVE" -C "$TMP"

  SRC="$TMP/ncbi-igblast-${IGBLAST_VERSION}/bin"
  for exe in igblastn igblastp makeblastdb; do
    cp "$SRC/$exe" "$BIN_DIR/$exe"
    chmod +x "$BIN_DIR/$exe"
    echo "    installed $exe"
  done
fi

# IgBLAST resolves its species auxiliary/internal data relative to the binary,
# so geneGUI/bin/internal_data must point at the checked-in reference data.
if [ ! -e "$BIN_DIR/internal_data" ]; then
  ln -s ../data/internal_data "$BIN_DIR/internal_data"
  echo "==> Created symlink geneGUI/bin/internal_data -> ../data/internal_data"
fi

echo
echo "==> Verifying"
"$BIN_DIR/igblastn" -version | head -1
ls "$DATA_DIR/IMGT_Human_Database"/Human_V.fasta >/dev/null && echo "    human germlines OK"
ls "$DATA_DIR/IMGT_Mouse_Database"/Mouse_V.fasta >/dev/null && echo "    mouse germlines OK"
ls "$BIN_DIR/internal_data/human" >/dev/null && echo "    internal_data OK"

echo
echo "Done. Next: pip install -r backend/requirements.txt && (cd electron-app && npm install)"
