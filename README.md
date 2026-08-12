# AutoAB

Desktop pipeline for B-cell receptor repertoire analysis: germline assignment,
clonal clustering, somatic hypermutation and lineage reconstruction, for human
and mouse.

Built as the research instrument for a master's thesis (Teichmann, 2026).

## Install

Download from the [releases page](https://github.com/CadaHealth/AutoAB/releases/latest):

| Mac | File |
|---|---|
| Apple Silicon | `Clono-1.0.0-arm64.dmg` |
| Intel | `Clono-1.0.0.dmg` |

Open the disk image, drag the app to Applications, launch it. The builds are
signed and notarised, so macOS opens them without a warning. Requires macOS 11
or later.

**Install [R ≥ 4.3](https://cran.r-project.org/) as well.** It is the one thing
not inside the app. Everything else — Python, IgBLAST, IQ-TREE, Change-O,
pRESTO, the IMGT references — ships in the bundle, and the Setup screen on first
launch installs the R packages and Rosetta 2 for you.

Windows is not supported; see [docs/WINDOWS.md](docs/WINDOWS.md).

## Build from source

Needs Python ≥ 3.11, R ≥ 4.3, Node.js ≥ 20.

```sh
git clone https://github.com/CadaHealth/AutoAB.git autoab
cd autoab

conda env create -f backend/environment.yml   # Apple Silicon: prefix CONDA_SUBDIR=osx-64
conda activate autoab
cd electron-app && npm install
```

Without conda: `bash scripts/install.sh`, then
`pip install -r backend/requirements.txt`, then in R
`install.packages(c("ggplot2", "dplyr", "tidyr", "ape", "alakazam", "shazam"))`.

```sh
cd electron-app
npm run dev                # development
npm run package:mac        # both Mac architectures
npm run package:mac:arm64  # Apple Silicon only, quicker
```

The `package:*` scripts fetch IgBLAST and IQ-TREE and build the bundled Python
runtime first. Signing and notarisation: [docs/SIGNING.md](docs/SIGNING.md).

## Notes

The clonal distance threshold is re-estimated on every run and varies slightly,
because shazam's mixture fit is randomly initialised. Across its full observed
range a factor of 2.5 moves the clone count by 1.3% and leaves the largest clone
unchanged; counts of clones shared between donors are more sensitive and should
be reported together with the threshold. Set `AUTOAB_THRESHOLD_METHOD=density`
for a deterministic estimate. Measurements: [docs/VALIDATION.md](docs/VALIDATION.md).

If something goes wrong: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Licence

AGPL-3.0, or a commercial licence — see [LICENSE](LICENSE) and
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md). Third-party tools bundled in the
release carry their own terms, listed in [ATTRIBUTION.md](ATTRIBUTION.md).
