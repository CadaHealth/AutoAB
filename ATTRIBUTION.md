# Attribution and licensing

AutoAB itself is copyright Jo Teichmann and licensed under AGPL-3.0, with a
commercial licence available separately. See [LICENSE](LICENSE) and
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

This file records the third-party components AutoAB depends on, which carry
their own terms.

## Tools invoked by the pipeline

AutoAB runs these as external processes and does not link against them.

**In this source repository** they are not vendored: the conda environment or
`scripts/install.sh` fetches them at build time.

**In a packaged release they are redistributed.** The `.dmg` on the releases
page carries IgBLAST, makeblastdb, IQ-TREE, Change-O, pRESTO, Biopython and a
CPython interpreter inside the application bundle, so that R is the only thing
a user installs. Each is the upstream release, unmodified, and its licence
travels with it. IQ-TREE is GPL-2 and Change-O, pRESTO, Alakazam and Shazam are
AGPL-3.0; corresponding sources are available from the project pages linked
below.

| Tool | Licence | Role |
|---|---|---|
| [IgBLAST](https://ncbi.github.io/igblast/) 1.22.0 (NCBI) | Public domain (US Government work) | V/D/J germline assignment |
| [Change-O](https://changeo.readthedocs.io/) | AGPL-3.0 | Clone assignment, germline reconstruction |
| [pRESTO](https://presto.readthedocs.io/) | AGPL-3.0 | Sequence preprocessing |
| [Alakazam](https://alakazam.readthedocs.io/) | AGPL-3.0 | Diversity, lineage, repertoire metrics |
| [Shazam](https://shazam.readthedocs.io/) | AGPL-3.0 | SHM analysis, distance-to-nearest thresholds |
| [ape](https://cran.r-project.org/package=ape) | GPL-2/3 | Phylogenetic tree construction |
| [IQ-TREE](http://www.iqtree.org/) | GPL-2 | Optional maximum-likelihood trees |
| Biopython | Biopython licence (BSD-like) | Sequence I/O |

The Immcantation components (Change-O, pRESTO, Alakazam, Shazam) are AGPL-3.0,
which is one reason AutoAB is released under the same licence: the combination
raises no compatibility question.

## Reference data shipped in this repository

| Data | Source | Terms |
|---|---|---|
| `geneGUI/data/IMGT_Human_Database/`, `IMGT_Mouse_Database/` | [IMGT/GENE-DB](https://www.imgt.org/genedb/) | IMGT requires citation and restricts redistribution. See their [terms of use](https://www.imgt.org/about/termsofuse.php) |
| `geneGUI/data/internal_data/`, `optional_data/` | Ships with NCBI IgBLAST | Public domain |
| `geneGUI/data/internal_data/CoV-AbDab_080224.csv` | [CoV-AbDab](https://opig.stats.ox.ac.uk/webapps/covabdab/), OPIG Oxford | Free for academic use. Cite Raybould et al. |

IMGT germline sets are redistributed here for reproducibility. Now that the
repository is public, confirm this remains compatible with IMGT's terms. The
alternative is to fetch them at install time, as
`backend/scripts/download_mouse_imgt.sh` already does for mouse.

## Removed from earlier versions of this project

- `BCR_Deep_Clustering-main/`, a third-party DNABERT-based clustering module
  (MIT, copyright 2024 Kerwin) that was vendored but never wired into the
  running tool, along with roughly 50 MB of model weights. Dropped.
- Vendored IgBLAST binaries (about 110 MB), now installed by conda or fetched
  by `scripts/install.sh`.
- Study data, collaborator result files, and journal PDFs, which never belong
  in a source repository.

## Citing

If you use AutoAB in published work, please cite the underlying tools as well:
IgBLAST, Change-O/pRESTO, Alakazam/Shazam, IMGT, and CoV-AbDab where
applicable.
