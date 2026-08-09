# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `igblastn: command not found` | `scripts/install.sh` not run | `bash scripts/install.sh` |
| `igblastn: Bad CPU type in executable` | x86-64 binary on Apple Silicon without Rosetta | `softwareupdate --install-rosetta`, or build IgBLAST for arm64 (bioconda ships an `osx-arm64` package) |
| `Germline annotation database ... could not be found in [internal_data]` | `IGDATA` not set. IgBLAST resolves `internal_data` from it, falling back to the working directory | Every call site sets `IGDATA` automatically; if running IgBLAST by hand, set `IGDATA=geneGUI/data` |
| `DefineClones.py: command not found` | changeo/presto console scripts not on `PATH` | Confirm `python3 -m pip install --user -r backend/requirements.txt` succeeded. The app asks Python where its scripts live; override a single tool with e.g. `AUTOAB_DEFINECLONES`, or prepend a directory with `BCR_EXTRA_PATH`. |
| Backend never starts, no output | No Python on the machine has changeo/presto | The app probes candidates and needs one that can `import changeo, presto`. Set `AUTOAB_PYTHON=/path/to/python3`. |
| R step fails with "there is no package called 'alakazam'" | R dependencies missing | `install.packages(c("alakazam","shazam","ape"))` |
| `Rscript` not found | R not on `PATH` | Set `AUTOAB_RSCRIPT=/path/to/Rscript` |
| Clone counts differ between runs on the same data | Expected. The default GMM threshold estimate is not deterministic | Pin the threshold by typing the same value when prompted, or set `AUTOAB_THRESHOLD_METHOD=density`. See [VALIDATION.md](VALIDATION.md). |
| Pipeline reports success but per-timepoint results are empty | Timepoint mapping mismatch | Fixed; see [VALIDATION.md](VALIDATION.md). If it reappears, check that `timepoint_mapping.json` keys match the FASTA basenames. |
| No CoV-AbDab matches | Database CSV missing | Confirm `geneGUI/data/internal_data/CoV-AbDab_080224.csv` exists |
| First analysis is very slow | BLAST indexes being built from the reference FASTAs | One-off; cached under `geneGUI/data/Database-Files/` afterwards |

## Environment variables

| Variable | Effect |
|---|---|
| `AUTOAB_PYTHON` | Python interpreter to run the pipeline with, skipping auto-detection |
| `AUTOAB_RSCRIPT` | Path to `Rscript` |
| `AUTOAB_MAKEDB`, `AUTOAB_DEFINECLONES`, `AUTOAB_CREATEGERMLINES`, `AUTOAB_BUILDTREES` | Explicit paths to individual Change-O console scripts |
| `AUTOAB_IGBLASTN`, `AUTOAB_MAKEBLASTDB`, `AUTOAB_BLASTN` | Explicit paths to individual BLAST binaries |
| `AUTOAB_THRESHOLD_METHOD` | `density` selects the deterministic kernel-density threshold instead of the default gamma-gamma GMM |
| `BCR_EXTRA_PATH` | Prepended to `PATH` when the app spawns Python |
| `BCR_IGHC_DB_PATH` | Path to a custom IGHC FASTA for the isotype step, instead of the bundled one |

## Platform notes

The IgBLAST binaries fetched by `scripts/install.sh` are **x86-64** on both
macOS and Linux; NCBI does not publish an arm64 macOS build for 1.22.0. On
Apple Silicon they run under Rosetta 2, which is what the validation runs used.
For a native arm64 build, install IgBLAST from bioconda (`osx-arm64` is
available) and copy `igblastn`, `igblastp` and `makeblastdb` into
`geneGUI/bin/`.

## Running the pipeline without the GUI

`backend/pipeline_runner.py` speaks newline-delimited JSON on stdin/stdout, so
it can be driven directly. Send one config line:

```json
{"action":"run","config":{"fasta_dir":"...","species":"mouse","database_type":"IMGT",
 "output_dir":"...","backend_dir":"...","clone_mode":"gene","linkage_method":"average"}}
```

then read messages of type `progress`, `log`, `result` and `complete`. When a
`threshold_request` arrives, reply with
`{"type":"threshold_response","thresholds":{"<label>":<value>}}` (or
`{"type":"threshold_response","value":<float>}` in single-cohort mode).
