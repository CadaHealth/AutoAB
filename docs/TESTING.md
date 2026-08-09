# Getting AutoAB running as a tester

Aimed at someone who has been handed this repository and wants to run an
analysis, not at someone developing it. macOS; Linux should work but has not
been tested. Windows does not; see [WINDOWS.md](WINDOWS.md).

Budget about 30 minutes, most of it waiting for downloads.

## 0. What you need first

- **conda**. [Miniforge](https://github.com/conda-forge/miniforge) is the
  lightest option. Download the installer for your Mac and run it.
- **Node.js ≥ 20**, from [nodejs.org](https://nodejs.org/) or `brew install node`.
- **Rosetta 2**, on Apple Silicon: `softwareupdate --install-rosetta`

Nothing else. You do not need to install Python, R, IgBLAST or any R package by
hand. The environment below brings all of it.

## 1. Get the code

```sh
git clone https://github.com/CadaHealth/AutoAB.git
cd AutoAB
git checkout clean
```

## 2. Build the analysis environment

On **Apple Silicon** (M1/M2/M3/M4):

```sh
CONDA_SUBDIR=osx-64 conda env create -f backend/environment.yml
conda activate autoab
conda config --env --set subdir osx-64
```

On **Intel Macs** and Linux, drop the `CONDA_SUBDIR` prefix:

```sh
conda env create -f backend/environment.yml
conda activate autoab
```

The `osx-64` part is not a mistake: `r-alakazam` is only published for x86-64,
so the whole environment is built for that architecture and Rosetta runs it.

This step downloads a few hundred megabytes and takes several minutes.

Check it worked:

```sh
python -c "import changeo, presto; print('python ok')"
Rscript -e 'library(shazam); library(alakazam); cat("R ok\n")'
igblastn -version
```

## 3. Install the app's own dependencies

```sh
cd electron-app
npm install
```

## 4. Start it

From the **same terminal**, with `autoab` still activated. That is how the app
finds the right Python:

```sh
npm run dev
```

The window opens on step 1 of the wizard.

## 5. Run an analysis

You need BCR sequences. Either:

- **Per-sample FASTA files**: one FASTA per sample in a single folder, or
- **BD Rhapsody output**: a combined AIRR TSV plus its `Sample_Tag_Calls.csv`

Then, in the wizard:

1. **Define Study**: name the study, pick the input format, add a timepoint,
   click *Select Folder* and choose your FASTA directory. For multiple
   treatment groups, tick *Multi-cohort study* first.
2. **Choose Database**: leave IMGT selected and pick **Human** or **Mouse**.
3. **Review & Start**: check the summary, click *Start Analysis*.

Partway through, the app shows the estimated clonal distance threshold and asks
you to confirm it. Accepting the suggested value is fine for a first run.

A few hundred sequences take about a minute; tens of thousands take
considerably longer, most of it in IgBLAST.

When it finishes you get the results view: a dashboard with diversity, V-gene
usage, isotype distribution and SHM, a sequence browser, phylogenetic trees,
and, for multi-cohort studies, shared "public" clones.

## If something goes wrong

| Symptom | Cause |
|---|---|
| Nothing happens after *Start Analysis* | The app could not find a Python with changeo/presto. Make sure you launched `npm run dev` from the activated `autoab` environment, or set `AUTOAB_PYTHON` to that environment's `bin/python`. |
| `Rscript: command not found` in the log | Same cause: the environment is not active. |
| "cannot be opened because the developer cannot be verified" | Only applies to a packaged `.app` build; it is unsigned. Right-click it and choose **Open**. |
| Analysis finishes but there are no trees | Non-fatal; check the log for the tree-building step. |

More in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## One thing to know about the numbers

Running the same data twice will not give exactly the same clone count. The
clonal threshold comes from a mixture fit that is not deterministic; the spread
is around 17% of the threshold value. If you need two runs to match exactly,
type the same threshold in by hand when the app asks, or set
`AUTOAB_THRESHOLD_METHOD=density` before starting. Details and measurements in
[VALIDATION.md](VALIDATION.md).
