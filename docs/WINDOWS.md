# Windows support

**AutoAB does not run on Windows today.** This is not a matter of a missing
build step; several parts of the tool would need changing first. This document
records exactly what, so the decision to invest is an informed one.

A code audit was run against this repository specifically to answer the
question. Findings are grouped by whether they stop the tool outright.

## Hard blockers

| # | Problem | Where | Fix |
|---|---|---|---|
| 1 | No Windows IgBLAST binaries and no way to get them; the installer is bash-only and exits on any non-Darwin/Linux platform | `scripts/install.sh` | NCBI publishes `ncbi-igblast-1.22.0-x64-win64.tar.gz`; add a PowerShell or Node equivalent |
| 2 | IgBLAST/BLAST executables resolved without the `.exe` suffix | `backend/utils/toolpaths.py` handles this now, but it is untested on Windows | Verify `exe()` on a real Windows box |
| 3 | `npm run package:win` aborts: `win.icon` points at `static/icon.ico`, which does not exist (only `icon.icns` is present) | `electron-app/package.json` | Add a real `.ico`, or a ≥256px `.png` for electron-builder to convert |
| 4 | Two competing build configurations. `package.json` has a `build` key, so `electron-builder.yml` is never read, so its NSIS block, file filters and publish settings are dead | `electron-app/package.json`, `electron-app/electron-builder.yml` | Delete one; keep the YAML |
| 5 | `extraResources` copies `geneGUI/bin` verbatim, so cross-building from macOS ships Mach-O binaries inside the Windows installer | `electron-app/package.json` | Make `extraResources` platform-conditional |

Items 1-2 of the original audit (hardcoded macOS Python and R paths) and the
PATH/environment handling have already been fixed in this repository; see
[VALIDATION.md](VALIDATION.md).

## Would silently degrade

| Problem | Where | Effect |
|---|---|---|
| `os.symlink` in tree visualisation | `backend/pipeline_runner.py` | Needs Developer Mode or admin on Windows; otherwise every run produces zero tree images, reported only as a non-fatal warning |
| IQ-TREE detection uses `which` | `backend/scripts/build-trees-iqtree.R` | `which` does not exist in cmd.exe, so every tree silently falls back to neighbour-joining |
| Unquoted IQ-TREE command line | `backend/scripts/build-trees-iqtree.R` | Breaks on output paths containing spaces, which is the norm on Windows |
| Cancel kills the process group with a negative PID | `electron-app/src/main/backend-runner.ts` | Not supported on Windows; IgBLAST and Rscript survive cancellation, keep file handles open, and subsequent cleanup fails with `PermissionError`. Needs `taskkill /T /F` |
| `detached: true` without `windowsHide` | `electron-app/src/main/backend-runner.ts` | Console windows flash on every spawn |
| Output directory under `resources/geneGUI/outs` | `electron-app/src/main/ipc-handlers.ts` | Writable only for per-user installs; breaks under `C:\Program Files`. Should use `app.getPath('userData')` |

## Cosmetic

`titleBarStyle: 'hiddenInset'` is macOS-only and no `titleBarOverlay` is set, so
a Windows window would have no minimise/maximise/close buttons, and the
renderer reserves 80px of padding for macOS traffic lights. Around a dozen
places derive file names with `split('/').pop()`, which shows the whole path
when the separator is `\`.

## Explicitly ruled out

Two things that are commonly assumed to be Windows problems here are not:

- **The `geneGUI/bin/internal_data` symlink.** It is not tracked in git at all; it is created by the installer. IgBLAST resolves `internal_data` from the
  `IGDATA` environment variable (falling back to the working directory), and
  every call site in this repository sets `IGDATA` explicitly. The symlink is
  a convenience, not a requirement.
- **CRLF line endings in the reference data.** Verified against IgBLAST 1.22.0:
  CRLF germline FASTAs, `human_gl.aux` and `internal_data/*.ndm`/`*.pdm` files
  all parse correctly and produce identical output.

## Practical alternative

Running the tool under WSL2 with an X server, or on a Linux VM, avoids all of
the above and only requires the Linux install path, which `scripts/install.sh`
already implements (though it is likewise untested).
