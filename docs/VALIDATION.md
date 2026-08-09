# Validation runs

Record of the end-to-end runs used to confirm this release works before it was
published. Both species paths and both input formats were exercised on real
data, on macOS (Apple Silicon, Rosetta 2 for the x86-64 IgBLAST binaries).

Environment: Python 3.13.7, changeo 1.3.4, presto 0.7.6, biopython 1.86,
R 4.x with alakazam 1.4.2 / shazam 1.3.1 / ape 5.8.1, IgBLAST 1.22.0,
Node.js 24.11.1.

## 1. Application build

`npm run build` (main + preload + renderer) completes; 891 modules transformed.
Only non-blocking warnings remain: Svelte a11y hints on SVG click handlers and
a Rollup chunk-size notice.

## 2. BD Rhapsody AIRR staging, mouse

Input: a combined AIRR TSV (169 MB gzipped) plus `Sample_Tag_Calls.csv` from a
12-mouse checkpoint-blockade experiment, demultiplexed into the study's four
treatment groups (3 mice each).

| Metric | Value |
|---|---|
| AIRR rows scanned | 643,299 |
| Productive B-cell contigs kept (IGH/IGK/IGL) | 77,859 |
| Cells assigned to a cohort | 20,124 |
| Cells dropped (Multiplet / Undetermined) | 8,311 |
| Cells dropped (tag not assigned by user) | 0 |
| Runtime | 2.3 s |

Per-cohort cell counts: A-IgG 6,768 · B-CTLA-4 4,225 · C-CTLA4+LTBR 4,172 ·
D-CTLA4+LTBR+PD1 4,959. Twelve per-mouse FASTAs plus `timepoint_mapping.json`
were written, one staging directory per cohort.

## 3. Pipeline, mouse (`species: mouse`)

Run on a 1,500-sequence subset of cohort A-IgG (500 per mouse) to keep the
verification quick; the full cohort exercises the identical code path.

- Mouse IMGT BLAST databases built: 858 V, 64 D, 25 J, 108 C alleles
- IgBLAST with `-organism mouse` and `mouse_gl.aux`
- 461 sequences after the IGH locus filter
- Distance threshold estimated at 0.1, accepted
- **361 clones** from 461 records, 0 failures
- Germline reconstruction, isotype assignment, lineage trees and tree images
  all produced
- Result: **success, 54.2 s**

## 4. Pipeline, human (`species: human`)

Run on 800 sequences across two samples, single-cohort mode (no timepoint
mapping), to confirm the original path still works.

- Result: **success, 36.5 s**, same five result artifacts

## 5. Reproducibility, known limitation

**Repeat runs on identical input do not produce identical clone counts.** Three
runs of the mouse subset gave 361, 363 and 365 clones.

The cause is `findThreshold(method="gmm")` in shazam, which supplies the clonal
distance threshold. Measured over eight calls on the same distance vector:

| | Value |
|---|---|
| min | 0.0876 |
| max | 0.1041 |
| sd | 0.0058 |
| spread | 17.4% of the mean |

Its mixture fit draws random starting points from a source outside R's seeded
RNG, `set.seed()` immediately before each call does not constrain it.
`distToNearest` was confirmed deterministic (`identical()` → TRUE), which
isolates the mixture fit as the source.

This is accepted behaviour: gamma-gamma GMM is the standard Immcantation
approach, and the threshold is shown to the user for confirmation before clones
are assigned, so a run can be pinned by entering a fixed value.

If exact reproducibility matters more than method convention, set
`AUTOAB_THRESHOLD_METHOD=density` to use the kernel-density estimate instead.
That path was verified deterministic, three calls returned 0.1176089 exactly,
and two full pipeline runs then agreed exactly at 358 clones. It yields a
different (typically higher) threshold than GMM, so the two are not
interchangeable within one study.

## 6. Application, end to end through the GUI

`npm run test:e2e -- <fasta-dir> [species]` drives the real application window
with Playwright, start to finish. The wizard picks files through native OS
dialogs, which cannot be automated, so the two dialog IPC handlers are replaced
in the main process with ones returning a fixed directory. Everything after
that, store updates, staging, pipeline spawn, threshold round-trip, result
rendering, runs for real.

The recorded run, on the 1,500-sequence mouse subset:

```
✓ wizard step 1 rendered
✓ study name entered
✓ FASTA directory selected via stubbed dialog
✓ advanced to step 2
✓ species set to Mouse
✓ advanced to step 3
✓ analysis started
  IgBLAST analysis complete, found 13668 hits
✓ threshold dialog confirmed
  Per-timepoint tree building complete: 8 total trees across 1 timepoints
  Tree visualization complete: 8 trees total
  complete: success=true
=== RESULT: PASS, results rendered ===
```

The results screen rendered "1500 sequences analyzed" with per-sample clone
tables for all three mice, plus the Sequence Browser, Dashboard, Phylogenetic
Trees and COVID-DB Matching tabs.

Note the stubbing caveat: the native file-picker dialogs themselves are the one
part of the flow this does not exercise.

Two fixes came out of building this test. The dialog handlers had to be
replaced *after* `setupIpcHandlers` runs, otherwise the app's own registration
overwrites them, worth knowing for anyone extending the test. And `isDev`
conflated "unpackaged" with "load from the Vite dev server", so
`npm run preview` always tried to reach a dev server that wasn't running; the
two are now separate flags.

## 7. The tester install path, verified from scratch

The conda instructions were executed rather than assumed. Miniforge was
installed into an empty directory, the environment was built from
`backend/environment.yml` with `CONDA_SUBDIR=osx-64`, and the repository cloned
fresh from GitHub, a clone that contains no IgBLAST binaries, so everything had
to come from the environment.

The environment resolved and installed cleanly (2.1 GB) and provided:

| | Version |
|---|---|
| changeo / presto / biopython | 1.3.4 / 0.7.9 / 1.87 |
| shazam / alakazam / ape | 1.0.2 / 1.0.2 / 5.8.1 |
| IgBLAST | 1.22.0 |
| MakeDb.py, DefineClones.py, CreateGermlines.py, BuildTrees.py | present |
| iqtree | present |

Note that bioconda's shazam and alakazam (1.0.2) lag the current CRAN releases
(1.3.1 / 1.4.2) used elsewhere in this document.

The pipeline was then run with **only** that environment on `PATH`, no system
Python, R or IgBLAST, against the mouse subset: **success in 60.4 s, no
warnings, 9 lineage trees with their PNGs**.

The first attempt exposed a gap: `environment.yml` was missing `r-jsonlite`,
which the tree-building script loads. Tree construction failed with
`there is no package called 'jsonlite'`. Because that failure is logged as a
warning, the run still reported success while producing no per-timepoint
trees. Added to the environment, after which the run above is clean.

## 8. Full-scale run, all four treatment groups

Everything above ran on a 1,500-sequence subset. This section is the full
dataset, through the conda environment, from the fresh clone.

| Cohort | Contigs in | IGH after filtering | Clones | Trees | Runtime | Result |
|---|---|---|---|---|---|---|
| A-IgG | 26,208 | 8,002 | 4,351 | 20 | 1018.6 s | success |
| B-CTLA-4 | 16,986 | 4,904 | 2,721 | 20 | 1608.5 s | success |
| C-CTLA4+LTBR | 15,664 | 4,502 | 2,689 | 20 | 424.9 s | success |
| D-CTLA4+LTBR+PD1 | 19,001 | 5,458 | 3,145 | 20 | 526.4 s | success |

77,859 contigs in, 22,866 heavy chains analysed, 12,906 clones, **zero warnings
or errors across all four runs**. IgBLAST accounts for most of the wall clock
(158 s for cohort A); the light chains (IGK/IGL) are correctly dropped by the
IGH filter.

### Are the results biologically sensible?

Checked on cohort A-IgG (8,002 sequences), because a pipeline that merely exits
zero proves very little.

- **V genes**: 181 distinct mouse IGHV genes, correct nomenclature, led by
  IGHV11-2, IGHV8-8, IGHV3-6, IGHV7-3
- **Locus**: IGH only, as intended
- **Clone size distribution**: largest clone 344 sequences and 87% singletons,
  the long-tailed shape a repertoire should have
- **Replicate consistency**: the three mice give 3,120 / 1,922 / 2,960
  sequences and 1,766 / 1,288 / 1,777 clones
- **Isotypes**: IGHM 4,570 · IGHA 1,206 · IGHG2B 114 · IGHG3 109 · IGHD 64 ·
  IGHG2A 63 · IGHG1 24 · IGHG2C 8. This is the mouse isotype set, no IGHG4,
  which mice do not have, and IGHG2C does appear, which is the C57BL/6 allele
  that replaces IGHG2A in that background.

The strongest check is the relationship between class switching and mutation.
Somatic hypermutation and class switching both happen in the germinal centre,
so switched isotypes must be more mutated than IgM:

| Isotype | Median SHM | Mean SHM | n |
|---|---|---|---|
| IGHM | 0.00% | 0.26% | 3,442 |
| IGHA | 0.27% | 0.67% | 901 |
| IGHG2A | 0.27% | 0.44% | 51 |
| IGHG2B | 0.26% | 0.55% | 83 |
| IGHG3 | 0.27% | 0.49% | 79 |
| IGHG1 | 0.52% | 0.99% | 17 |

The ordering holds. Absolute mutation is low throughout, consistent with an
IgM-dominated, largely naive repertoire.

## 9. Cross-cohort public clones

Shared-clone detection across cohorts runs in the renderer
(`electron-app/src/renderer/lib/utils/cross-cohort-clones.ts`), not in Python:
clones are bucketed by (V family, J family, CDR3 length), then union-find
clustered within each bucket by CDR3 Hamming distance ≤ 10%. It was bundled and
run against the four full-scale cohort outputs.

| | Count |
|---|---|
| Clusters found | 1,002 |
| shared across 2 cohorts | 624 |
| shared across 3 cohorts | 186 |
| shared across all 4 cohorts | 192 |

Runtime 0.1 s. Consistency check: no cluster mixes CDR3 lengths (0 violations),
as the bucketing requires.

The largest clusters have CDR3s such as `ARSGDYDVMDY` (IGHV1/IGHJ4, 143 clones)
and `ARSGDYGAFDY` (IGHV1/IGHJ2, 106 clones), present in all four groups. The
motifs end in MDY / FDV / WFAY and only IGHJ1-IGHJ4 appear, which is exactly the
mouse J repertoire. That these convergent sequences are shared across every
treatment arm and sit in the unmutated fraction is what one would expect of
public, naive-repertoire clones rather than antigen-driven expansions.

## 10. CoV-AbDab matching

Run against the human subset results (the database is a human SARS-CoV-2
antibody set, so mouse input would be meaningless):

- 20 top clones analysed against 12,918 database antibodies
- 19 with VH matches, 20 with CDR3 matches, 4 with high-confidence
  matches (≥ 90%)
- Runtime 2.8 s

## Bugs found and fixed during validation

**Timepoint assignment was silently lost whenever FASTA cleaning was enabled.**

`file_id_mapping.json` records the basenames the pipeline actually combined,
which carry a `_clean` suffix once the cleaning step has run
(`endpoint_Mouse1_filtered_clean.fasta`). `timepoint_mapping.json`, written by
the staging step, is keyed by the original names
(`endpoint_Mouse1_filtered.fasta`). The lookup in `split_by_timepoint` compared
the two with an exact string match, so every file failed to resolve:

```
File endpoint_Mouse2_filtered_clean.fasta (id=1001) not found in timepoint mapping
  8007 sequences could not be mapped to a timepoint
```

The run still reported success; the per-timepoint outputs were simply empty.
The wizard defaults `cleanFasta` to `false`, which is why this had not surfaced
in normal use.

Fixed in `backend/pipeline_runner.py` by normalising the `_clean` suffix on
both sides before matching, keeping the exact match as the first attempt. After
the fix the same run produces a fully populated `per_timepoint/endpoint/`
directory and emits no mapping warnings.

**Hardcoded absolute interpreter paths.**

`electron-app/src/main/index.ts` pinned
`/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13`, and the R
invocations in `backend/utils/clonalityFunctions.py` and
`backend/pipeline_runner.py` (two sites) pinned a specific R framework build
plus forced `R_HOME`/`R_SHARE_DIR`/`R_INCLUDE_DIR`/`R_DOC_DIR`. These existed
only on the original development machine, so a fresh clone would have failed on
any other computer, including another Mac.

Replaced with discovery: the app probes candidate interpreters and picks the
first that can `import changeo, presto` (`AUTOAB_PYTHON` overrides), and
`backend/utils/toolpaths.py` resolves Rscript, the Change-O console scripts and
the IgBLAST binaries via `shutil.which` with per-tool environment overrides.
The forced `R_*` variables were removed, Rscript locates its own `R_HOME`.

**Unquoted shell command for makeblastdb.**

`backend/pipeline_runner.py` built two `makeblastdb` invocations as f-strings
passed to `os.system`, which breaks on any install path containing a space and
was only logged as a warning, leaving the pipeline to fail later with a
confusing error. Both now use `subprocess.run` with an argument list.

## Not covered

- **Windows**, not supported; see [WINDOWS.md](WINDOWS.md) for the specific
  blockers
- Linux: the install path is implemented but was not tested
- The native file-picker dialogs, which the GUI test stubs out
- Signed or notarised builds. See the code-signing section of the README
- Packaged application bundles (`npm run package:mac`)
- Multi-timepoint studies, all test data has a single "endpoint" timepoint
- The AIRR input path *through the GUI* (staging was driven headless; the GUI
  test used pre-staged FASTAs), and the multi-cohort wizard flow
- Correctness against a reference. The checks in sections 8 and 9 establish
  internal biological consistency, not agreement with a ground truth or with an
  independent tool.
- The deep-clustering module is not part of this repository (see
  [ATTRIBUTION.md](../ATTRIBUTION.md))
