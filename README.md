# AutoAB

A desktop application for B-cell receptor (BCR) repertoire analysis. It takes
raw antibody sequences, runs them through germline assignment, clonal
clustering, somatic hypermutation and lineage reconstruction, and presents the
result as an interactive dashboard.

The pipeline is Python and R (IgBLAST, Change-O, presto, Alakazam, Shazam); the
interface is an Electron + Svelte app that drives it and renders the output.

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

- macOS or Linux (x86-64 binaries; on Apple Silicon they run under Rosetta 2)
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
npm run dev          # development, with live reload
npm run package:mac  # or build a distributable app bundle
```

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

Repeat runs on identical input do **not** give identical clone counts. The
clonal distance threshold comes from shazam's gamma-gamma mixture fit, which
draws random starting points from a source outside R's seeded RNG; across eight
calls on the same data it spanned 17.4% of its mean, and the clone count moves
with it (361 / 363 / 365 in three runs of the same subset).

This is the standard Immcantation method and is kept as the default. The
threshold is shown for confirmation before clones are assigned, so a study can
be pinned by entering a fixed value. For a deterministic estimate instead, set
`AUTOAB_THRESHOLD_METHOD=density`. Measurements in
[docs/VALIDATION.md](docs/VALIDATION.md).

## Platform support

| Platform | State |
|---|---|
| macOS (Apple Silicon, Rosetta 2 for IgBLAST) | Verified end to end, including the GUI |
| macOS (Intel) | Expected to work; not tested |
| Linux x86-64 | Install path implemented; not tested |
| Windows | **Not supported.** See [docs/WINDOWS.md](docs/WINDOWS.md) |

## What a packaged build does and does not include

AutoAB is not a self-contained application, and a packaged `.dmg` will not run
on a machine that has nothing else installed. The bundle ships the analysis
code, the IgBLAST binaries and the reference databases, but the pipeline is
Python and R, and neither runtime is bundled.

| | Bundled | Must already be on the machine |
|---|---|---|
| Analysis code (`backend/`) | ✅ | |
| IgBLAST, makeblastdb | ✅ | |
| IMGT references, CoV-AbDab | ✅ | |
| Python interpreter | | ✅ Python ≥ 3.11 |
| changeo, presto, biopython, pandas | | ✅ `pip install -r backend/requirements.txt` |
| R | | ✅ R ≥ 4.3 |
| alakazam, shazam, ape | | ✅ `install.packages(...)` |

The app locates whichever Python has changeo/presto installed at startup; if it
finds none, the backend never starts. Set `AUTOAB_PYTHON` to point it at the
right interpreter.

The conda environment above collapses all of that into one command, which is
the practical answer. Making the app genuinely double-click-installable is a
larger job, a relocation attempt for R was carried out and is written up, with
measurements, in [docs/STANDALONE.md](docs/STANDALONE.md).

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
