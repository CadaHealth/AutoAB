#!/usr/bin/env bash
# Download mouse IMGT germline references into geneGUI/data/IMGT_Mouse_Database/.
#
# Change-O's MakeDb.py requires IMGT-numbered ("gapped") FASTAs, the references
# must contain `.` characters at the IMGT-conserved framework positions so the
# tool can validate alignments. NCBI's IgBLAST distribution ships *ungapped*
# references, which IgBLAST uses fine but which MakeDb rejects, producing only
# ig_out_data_db-fail.tsv and no db-pass.tsv (downstream clonality silently
# fails on "No db-pass.tsv for timepoint X").
#
# This script downloads the all-species gapped bundle from IMGT GENE-DB,
# filters mouse-only entries, and splits them into Mouse_V/D/J.fasta.
#
# Run: bash backend/scripts/download_mouse_imgt.sh

set -eo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TARGET="$REPO_ROOT/geneGUI/data/IMGT_Mouse_Database"
WORK=$(mktemp -d)

GAPPED_URL="https://www.imgt.org/download/GENE-DB/IMGTGENEDB-ReferenceSequences.fasta-nt-WithGaps-F+ORF+inframeP"

echo "Fetching IMGT all-species gapped reference bundle…"
echo "  target: $TARGET"
mkdir -p "$TARGET"

curl -fsSL "$GAPPED_URL" -o "$WORK/imgt_all_gapped.fasta"
echo "  downloaded $(wc -c < "$WORK/imgt_all_gapped.fasta") bytes"

python3 - <<PYEOF
"""Extract mouse-only IMGT-gapped germlines and split into Mouse_V/D/J.fasta."""
import os, re

src = "$WORK/imgt_all_gapped.fasta"
out_dir = "$TARGET"

entries = []
with open(src) as f:
    header = None
    seq_parts = []
    for line in f:
        line = line.rstrip()
        if line.startswith('>'):
            if header is not None:
                entries.append((header, ''.join(seq_parts)))
            header = line
            seq_parts = []
        else:
            seq_parts.append(line)
    if header is not None:
        entries.append((header, ''.join(seq_parts)))

# Dedupe by gene-allele name: makeblastdb -parse_seqids rejects duplicate
# sequence IDs, and IMGT ships multiple records per allele (different
# mouse strains: C57BL/6, BALB/cJ, NOD, …). Keep the first occurrence.
v_seen, d_seen, j_seen = set(), set(), set()
v_entries, d_entries, j_entries = [], [], []
for h, s in entries:
    fields = h[1:].split('|')
    if len(fields) < 4: continue
    gene_full = fields[1]
    species_field = fields[2]
    if not species_field.startswith('Mus musculus'):
        continue
    m = re.match(r'^(IG[HKL])([VDJ])', gene_full)
    if not m: continue
    segment = m.group(2)
    record = f'>{gene_full}\n{s}\n'
    if segment == 'V' and gene_full not in v_seen:
        v_seen.add(gene_full); v_entries.append(record)
    elif segment == 'D' and gene_full not in d_seen:
        d_seen.add(gene_full); d_entries.append(record)
    elif segment == 'J' and gene_full not in j_seen:
        j_seen.add(gene_full); j_entries.append(record)

os.makedirs(out_dir, exist_ok=True)
for stem, records in [('Mouse_V', v_entries), ('Mouse_D', d_entries), ('Mouse_J', j_entries)]:
    out = os.path.join(out_dir, f'{stem}.fasta')
    with open(out, 'w') as f:
        for r in records: f.write(r)
    print(f'  {stem}.fasta: {len(records)} entries')
PYEOF

# C-region: pull from the un-gapped IMGT bundle (constant region is not gapped
# in IMGT's scheme, they don't have the V-conserved positions).
C_OUT="$TARGET/Mouse_C.fasta"
UNGAPPED_URL="https://www.imgt.org/download/GENE-DB/IMGTGENEDB-ReferenceSequences.fasta-nt-WithoutGaps-F+ORF+inframeP"
echo ""
echo "Fetching mouse C-region germlines (ungapped)…"
if curl -fsSL "$UNGAPPED_URL" -o "$WORK/imgt_all_ungapped.fasta" 2>/dev/null; then
  python3 - <<PYEOF
import os, re
src = "$WORK/imgt_all_ungapped.fasta"
out = "$C_OUT"
records = []
seen_ids = set()

def maybe_append(header, seq_parts):
    if header is None: return
    fields = header[1:].split('|')
    if len(fields) < 4 or not fields[2].startswith('Mus musculus'):
        return
    gene_full = fields[1]
    # C-region genes: IGHM, IGHD, IGHG*, IGHA, IGHE for heavy; IGKC, IGLC for light
    if not (re.match(r'^IG[HKL][MDGAE]', gene_full) or re.match(r'^IG[KL]C', gene_full)):
        return
    # Dedupe (multiple strain variants per allele)
    if gene_full in seen_ids: return
    seen_ids.add(gene_full)
    records.append(f'>{gene_full}\n{"".join(seq_parts)}\n')

with open(src) as f:
    header = None
    seq_parts = []
    for line in f:
        line = line.rstrip()
        if line.startswith('>'):
            maybe_append(header, seq_parts)
            header = line
            seq_parts = []
        else:
            seq_parts.append(line)
    maybe_append(header, seq_parts)

if records:
    with open(out, 'w') as f:
        for r in records: f.write(r)
    print(f'  Mouse_C.fasta: {len(records)} entries')
else:
    print('  WARN: no mouse C-region entries found; isotype calls will be empty')
PYEOF
else
  echo "    WARN: could not fetch C-region bundle. Isotypes will be unavailable."
fi

echo ""
echo "Done. Mouse IMGT references staged in:"
echo "  $TARGET"
ls -la "$TARGET"
rm -rf "$WORK"
