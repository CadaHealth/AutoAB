# AutoAB

A desktop application for B-cell receptor (BCR) repertoire analysis. It takes
raw antibody sequences, runs them through germline assignment, clonal
clustering, somatic hypermutation and lineage reconstruction, and presents the
result as an interactive dashboard.

The pipeline is Python and R (IgBLAST, Change-O, presto, Alakazam, Shazam); the
interface is an Electron + Svelte app that drives it and renders the output.

## Origin and citation

AutoAB was built as the research instrument for a master's thesis on B-cell
receptor repertoires in Long COVID, and the analysis reported there was run
with it. The design goal follows from that: an analysis that previously took a
dozen command-line invocations with hand-managed intermediate files should be
reproducible by an immunologist rather than only by a bioinformatician, without
giving up the established methods underneath.

The analytical core is the Immcantation stack. What AutoAB adds around it is
study design, per-timepoint threshold review, cohort comparison, lineage
reconstruction and the visual analysis, as one tool with a single input step —
and a distribution that installs without a toolchain.

> Teichmann, J. (2026). *AutoAB: an integrated desktop pipeline for B-cell
> receptor repertoire analysis.* Master's thesis.

Please cite the underlying tools as well; they are listed in
[ATTRIBUTION.md](ATTRIBUTION.md).

## Download

Signed and notarised builds for macOS 11 and later are on the
[releases page](https://github.com/CadaHealth/AutoAB/releases/latest):
`Clono-1.0.0-arm64.dmg` for Apple Silicon, `Clono-1.0.0.dmg` for Intel.

Open the disk image, drag the app to Applications, launch it. **R is the only
thing you install yourself.** Everything else — the Python interpreter,
IgBLAST, IQ-TREE, Change-O, pRESTO, the IMGT references — is inside the app,
and the Setup screen installs the R packages and Rosetta 2 for you. The build
instructions further down are for developing it, not for using it.

## What it does

Given one or more cohorts of sequences, AutoAB will:

- assign V/D/J germline genes with IgBLAST against IMGT references (**human or
  mouse**)
- call isotypes from the constant region
- cluster sequences into clones at an automatically estimated distance
  threshold, which you can review and override per timepoint
- reconstruct germlines and build lineage trees
- compute repertoire metrics: diversity, V-gene usage, isotype distribution,
  SHM accumulation, clonal dynamics across timepoints
- find clones shared between cohorts ("public clones")
- optionally match clones against the CoV-AbDab database of known SARS-CoV-2
  antibodies

## Input formats

| Input | Use case |
|---|---|
| Per-sample FASTA directories | 10x Genomics contigs, or any pre-filtered sequence set |
| BD Rhapsody AIRR TSV + `Sample_Tag_Calls.csv` | Multiplexed single-cell runs; the app demultiplexes sample tags into cohorts for you |

Study designs are free-form: any number of cohorts, any number of samples per
cohort, one or more timepoints.

## Requirements

To **use a packaged build**, only R ≥ 4.3 from [CRAN](https://cran.r-project.org/).
Everything else is inside the app, and its Setup screen installs the R packages
and Rosetta 2 for you.

To **build or develop** it:

- macOS or Linux. On Apple Silicon the app itself is native; IgBLAST needs Rosetta 2
- Python ≥ 3.11
- R ≥ 4.3 with `alakazam`, `shazam`, `ggplot2`, `dplyr`, `tidyr`, `ape`
- Node.js ≥ 20

## Install

If you are picking this up to try it out rather than to develop it, follow
[docs/TESTING.md](docs/TESTING.md) instead. It covers the same steps with
more hand-holding.

### Recommended: one conda environment

This installs the entire toolchain (Python, R, every R package, Change-O,
pRESTO and IgBLAST) in a single command. Nothing else has to be set up by
hand.

```sh
git clone <this-repo> autoab
cd autoab

conda env create -f backend/environment.yml     # Apple Silicon: prefix with CONDA_SUBDIR=osx-64
conda activate autoab

cd electron-app && npm install && cd ..
```

On Apple Silicon use `CONDA_SUBDIR=osx-64 conda env create -f backend/environment.yml`,
because `r-alakazam` is only published for x86-64; Rosetta 2 runs it.

Start the app from the activated environment and it will find that Python
automatically.

### Alternative: system Python + R

If you would rather not use conda:

```sh
bash scripts/install.sh                                    # fetches IgBLAST 1.22.0
python3 -m pip install --user -r backend/requirements.txt
cd electron-app && npm install && cd ..
```

plus R ≥ 4.3 with:

```r
install.packages(c("ggplot2", "dplyr", "tidyr", "ape", "alakazam", "shazam"))
```

## Run

```sh
cd electron-app
npm run dev                # development, with live reload
npm run package:mac        # distributable bundle, both Mac architectures
npm run package:mac:arm64  # Apple Silicon only, quicker
```

The `package:*` scripts fetch IgBLAST and build the bundled Python runtime
first, so a packaged app is self-contained apart from R. Building the Intel
runtime on an Apple Silicon Mac needs Rosetta 2; use the `:arm64` script to
skip that.

The wizard walks you through picking an input format, naming cohorts, choosing
the species and reference database, and starting the run. Reference BLAST
indexes are built on first use and cached under `geneGUI/data/Database-Files/`.

## Reference data

Human and mouse IMGT germlines ship with the repository and work out of the
box. `backend/scripts/download_mouse_imgt.sh` re-fetches the mouse set from
IMGT if you need to refresh it.

## Layout

```
backend/            Python pipeline, pipeline_runner.py is the NDJSON entry point
  utils/            IgBLAST wrappers, clonality, isotype, CoV-AbDab matching
  scripts/          R scripts for trees, SHM distributions; reference downloads
electron-app/       Electron main process + Svelte renderer
  src/main/         Process orchestration, AIRR staging, IPC
  src/renderer/     Wizard, results dashboard, visualisations
geneGUI/data/       IMGT references, IgBLAST internal data, CoV-AbDab
scripts/install.sh  Fetches IgBLAST
```

The Electron main process talks to `backend/pipeline_runner.py` over
newline-delimited JSON on stdin/stdout, progress, logs, threshold prompts and
result artifacts all flow through that one channel.

## Reproducibility

The clonal distance threshold is estimated per run from shazam's gamma-gamma
mixture fit, which draws its starting points from a source outside R's seeded
RNG. Repeat runs on identical input therefore produce slightly different
thresholds, and occasionally the fit fails to converge and the cascade falls
back to another estimator. **What matters is how far that carries into the
results, and for clone assignment the answer is: barely.**

Measured on one timepoint, holding the data fixed and varying only the
threshold across its full observed range:

| Threshold | Clones | Largest clone | Singletons |
|---|---|---|---|
| 0.1167 | 607 | 10 | 584 |
| 0.2085 | 606 | 10 | 583 |
| 0.2889 | 599 | 10 | 570 |

A factor of 2.5 in the threshold moves the clone count by 1.3% and leaves the
largest clone untouched. Sequence counts, germline assignment and isotype calls
are unaffected entirely: two runs of the same cohort on different CPU
architectures returned the same 31,372 IgBLAST hits.

**Counts of clones shared between donors are the exception** and are much more
threshold-sensitive, because a looser threshold merges sequences from different
donors into one clone. In one cohort the shared-clone count at a single
timepoint ranged from 79 to 205 across thresholds from 0.306 to 0.4. Any
analysis that leans on public clones should report the threshold and the method
that produced it; the app logs both.

This is the standard Immcantation method and is kept as the default. The
threshold and its estimator are shown for confirmation before clones are
assigned, so a study can be pinned by entering a fixed value. For a fully
deterministic estimate instead, set `AUTOAB_THRESHOLD_METHOD=density`.
Measurements in [docs/VALIDATION.md](docs/VALIDATION.md).

## Platform support

| Platform | State |
|---|---|
| macOS (Apple Silicon) | Verified end to end, including the GUI. The app is native arm64; only IgBLAST runs under Rosetta 2 |
| macOS (Intel) | Verified end to end, including the GUI |
| Linux x86-64 | Install path implemented; not tested |
| Windows | **Not supported.** See [docs/WINDOWS.md](docs/WINDOWS.md) |

## What a packaged build does and does not include

A packaged `.dmg` carries its own Python, so **R is the only thing a user has
to install.** The app checks for it on launch and offers to install what it can
by itself.

| | Bundled | Must already be on the machine |
|---|---|---|
| Analysis code (`backend/`) | ✅ | |
| IgBLAST, makeblastdb | ✅ | |
| IQ-TREE 2.4.0 | ✅ native arm64 and x86-64 | |
| IMGT references, CoV-AbDab | ✅ | |
| Python interpreter | ✅ CPython 3.11, relocatable | |
| changeo, presto, biopython, pandas | ✅ preinstalled into it | |
| Rosetta 2 (Apple Silicon only) | | the app installs it for you |
| R | | ✅ R ≥ 4.3, from [CRAN](https://cran.r-project.org/) |
| alakazam, shazam, ape, jsonlite | | the app installs them for you |

Rosetta 2 appears on the list because NCBI publishes IgBLAST for macOS as an
Intel binary only; there is no Apple Silicon build to bundle.

The bundled interpreter is built by `scripts/bundle-python.sh` and lands at
`Resources/python` inside the app. It is preferred over anything on the
machine, so a user's own Python cannot interfere; `AUTOAB_PYTHON` still
overrides it. A source checkout without that runtime falls back to the
system Python exactly as before, so the conda path above keeps working for
development.

The **Setup** screen (top right of the window, and shown automatically at
launch when something is missing) reports what is present, explains what is
not, and runs the two installs it can perform: Rosetta 2 via the standard macOS
authentication prompt, and the R packages into the user library, no
administrator rights needed.

R itself stays a manual install. It bakes its own path into its binaries and
package tree, and a relocation attempt is written up with measurements in
[docs/STANDALONE.md](docs/STANDALONE.md).

## Code signing

Builds are **not signed or notarised**, there is no signing identity,
`hardenedRuntime` or notarisation step in the electron-builder configuration.

Consequently macOS Gatekeeper will refuse the first launch with *"Clono cannot
be opened because the developer cannot be verified"*. The user has to
right-click the app and choose **Open**, then confirm, or run
`xattr -dr com.apple.quarantine /Applications/Clono.app`. Windows would show a
SmartScreen warning for the same reason.

Fixing this properly requires an Apple Developer ID certificate (99 EUR/year)
plus notarisation, and an authenticode certificate on the Windows side. For
handing the tool to a supervisor or a lab, documenting the right-click-Open
step is usually enough.

## Status

Both species paths were run end to end on real data before this repository was
published; see [docs/VALIDATION.md](docs/VALIDATION.md) for what was tested,
the numbers each run produced, and what was *not* covered.

## Licence

AutoAB is dual-licensed.

**AGPL-3.0** for everyone, see [LICENSE](LICENSE). You may use, modify and
redistribute it freely, including for research and teaching. If you distribute a
modified version, or run one as a network service, you must publish its complete
source code under the same licence.

**A commercial licence** is available for anyone who wants to embed AutoAB in a
proprietary product, or offer it as a hosted service, without those disclosure
obligations. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

Copyright 2026 Jo Teichmann.

The external tools the pipeline invokes and the reference databases
redistributed here carry their own terms. Read
[ATTRIBUTION.md](ATTRIBUTION.md) before redistributing.
