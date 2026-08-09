# Can AutoAB ship as a standalone app?

Everything except R now ships inside the app. R remains a manual install, and
this file records why, so the question does not have to be re-investigated from
scratch.

## What the pipeline needs at runtime

| Component | State |
|---|---|
| IgBLAST binaries | Bundled via `extraResources` |
| Reference databases | Bundled, in the repository |
| Python + changeo/presto/pandas/… | **Bundled**, see below |
| R + alakazam/shazam/ape | Not bundled, see below |

## Python: done

[python-build-standalone](https://github.com/astral-sh/python-build-standalone)
publishes relocatable CPython builds for macOS on both architectures. Unpack one
into the app bundle, `pip install -r backend/requirements.txt` into it, and
point the app at it. Nothing is patched, so no code-signature issues arise.

This is implemented in [`scripts/bundle-python.sh`](../scripts/bundle-python.sh),
which the `package:mac` npm scripts run before electron-builder. It pins
CPython 3.11.15 from release 20260807, installs the requirements, and lands the
result in `electron-app/runtime/<arch>/python`, which `extraResources` copies to
`Resources/python`. Measured size: **299 MB** per architecture.

Two things were not obvious and are worth keeping in mind when bumping versions:

- **pip writes absolute shebangs.** The console scripts (`MakeDb.py`,
  `DefineClones.py`, …) get `#!` lines pointing at the interpreter's build-time
  path, which stops existing once the runtime is copied into the `.app`. The
  script rewrites them to `#!/usr/bin/env python3`, and `buildSpawnPath()` in
  `backend-runner.ts` puts the bundled `bin` directory ahead of the system one
  so they resolve back to the bundled interpreter.
- **A clean runtime has no `setuptools`.** `airr` still imports `pkg_resources`,
  which setuptools removed in version 81. System Pythons usually carry an older
  setuptools, so this never surfaced before; `backend/requirements.txt` now pins
  `setuptools<81` explicitly.

## R: tested, and it is the sticking point

R installs to a fixed location and bakes that path into its own files. A
relocation attempt was carried out and got most of the way:

1. **`bin/R` is a shell script** with `R_HOME_DIR=/Library/Frameworks/...`
   hardcoded. Patchable with `sed`. ✅
2. **`bin/Rscript` is a Mach-O binary** containing the absolute path as a
   string. Not patchable in place, but avoidable by invoking `bin/R -f script.R`
   instead. ✅
3. **The shared libraries carry absolute install names.** Rewriting them to
   `@loader_path` with `install_name_tool` works. Afterwards `otool -L` showed
   zero absolute references, and base R ran correctly from an arbitrary
   directory, reporting the relocated `R_HOME` and computing normally. ✅
4. **Apple Silicon kills modified binaries.** `install_name_tool` invalidates
   the code signature, and the process is then terminated with SIGKILL
   (observed: exit 137, no output at all). Every touched Mach-O must be
   re-signed ad hoc with `codesign --force --sign -`. ⚠️
5. **Doing this across the package tree is where it broke.** The 109 required
   packages contain 107 `.so` files. After rewriting their references and
   re-signing, R segfaulted (`invalid permissions`). The naive
   `@rpath` + `add_rpath` approach is not sufficient; getting this right needs
   a more careful, tested bundling script. ❌

Size, measured: base R is ~48 MB, the 109 required packages are ~459 MB
(alakazam pulls in a substantial Bioconductor subtree: Biostrings,
GenomicRanges, SummarizedExperiment and friends). So an R bundle is roughly
500 MB, and a fully standalone app would land near 1 GB.

## What ships instead

Python is bundled and R is not, which leaves R as the single manual step. Two
things close the remaining gap:

- **The Setup screen** (`electron-app/src/renderer/lib/components/DependencyGate.svelte`,
  backed by `src/main/dependency-check.ts`) inspects Python, IgBLAST, Rosetta 2,
  R and the R packages at launch. It installs Rosetta 2 through the standard
  macOS authentication prompt and the R packages into the user library, and
  links to CRAN for R itself.
- **No silent defaults.** `findDist()` used to return a hardcoded 0.1 on every
  failure path, so a missing R produced a complete run whose clone assignments
  rested on a number unrelated to the data. It now raises `ThresholdUnavailable`
  and the pipeline stops with an explanation.

For development, `conda env create -f backend/environment.yml` still installs
Python, R, all R packages, Change-O, pRESTO and IgBLAST in one command.

Note that this file previously listed `bioconductor-alakazam` and
`bioconductor-shazam`, which do not exist on any channel. The correct package
names are `r-alakazam` and `r-shazam`. The environment could never have been
created as specified; it has been corrected.

## If R should be bundled too, later

In rough order of effort:

1. Relocate R with a proper, tested script that rewrites install names *and*
   re-signs every binary, then sign and notarise the whole app with an Apple
   Developer ID. Expect days rather than hours, and expect it to break again on
   the next R version. This adds roughly 500 MB.
2. Remove R altogether by porting `calculateDistribution.R`, the tree-building
   scripts and the visualisation to Python. This is the only option that makes
   the app genuinely self-contained, but it changes scientific code and would
   need its results re-validated against the current ones.
