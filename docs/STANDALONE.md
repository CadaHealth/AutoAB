# Can AutoAB ship as a standalone app?

Short answer: not without real work, and the obstacle is R, not Python. This
records what was actually tested, so the question does not have to be
re-investigated from scratch.

## What the pipeline needs at runtime

| Component | Bundling difficulty |
|---|---|
| IgBLAST binaries | Trivial, already bundled via `extraResources` |
| Reference databases | Trivial, already in the repository |
| Python + changeo/presto/pandas/… | Easy, see below |
| R + alakazam/shazam/ape | Hard, see below |

## Python: solved problem

[python-build-standalone](https://github.com/astral-sh/python-build-standalone)
publishes relocatable CPython builds for macOS on both architectures
(`cpython-3.11.x-aarch64-apple-darwin-install_only.tar.gz` and the `x86_64`
equivalent, current as of release 20260728). Unpack it into the app bundle,
`pip install -r backend/requirements.txt` into it, point `AUTOAB_PYTHON` at it.
Nothing is patched, so no code-signature issues arise. Roughly 250 MB.

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

## The pragmatic answer

`conda env create -f backend/environment.yml` installs Python, R, all R
packages, Change-O, pRESTO and IgBLAST in one command. That is the normal
distribution mechanism for bioinformatics tooling, it is cross-platform, and it
sidesteps every problem above.

Note that this file previously listed `bioconductor-alakazam` and
`bioconductor-shazam`, which do not exist on any channel. The correct package
names are `r-alakazam` and `r-shazam`. The environment could never have been
created as specified; it has been corrected.

## If a true standalone is wanted later

In rough order of effort:

1. Bundle Python only (easy) and keep conda or a single `install.packages()`
   line for R. Removes most of the setup burden for little risk.
2. Add a first-run bootstrap: detect missing dependencies on launch and install
   them, rather than failing with a blank backend.
3. Full bundling: relocate R with a proper, tested script that rewrites install
   names *and* re-signs every binary, then sign and notarise the whole app with
   an Apple Developer ID. Expect days rather than hours, and expect it to break
   again on the next R version.
4. Remove R altogether by porting `calculateDistribution.R`, the tree-building
   scripts and the visualisation to Python. This is the only option that makes
   the app genuinely self-contained, but it changes scientific code and would
   need its results re-validated against the current ones.
