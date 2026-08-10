"""
COVID-19 Antibody Database Matching Module

Matches B-cell receptor sequences against the CoV-AbDab COVID-19 antibody database.
Performs both full VH (Variable Heavy chain) sequence matching and CDR3 region matching.
"""

import pandas as pd
import os
from typing import Dict, List, Tuple, Optional, Any
from collections import defaultdict


# Standard Genetic Code (NCBI Translation Table 1)
CODON_TABLE = {
    # Phenylalanine
    'TTT': 'F', 'TTC': 'F',
    # Leucine
    'TTA': 'L', 'TTG': 'L', 'CTT': 'L', 'CTC': 'L', 'CTA': 'L', 'CTG': 'L',
    # Isoleucine
    'ATT': 'I', 'ATC': 'I', 'ATA': 'I',
    # Methionine (Start)
    'ATG': 'M',
    # Valine
    'GTT': 'V', 'GTC': 'V', 'GTA': 'V', 'GTG': 'V',
    # Serine
    'TCT': 'S', 'TCC': 'S', 'TCA': 'S', 'TCG': 'S', 'AGT': 'S', 'AGC': 'S',
    # Proline
    'CCT': 'P', 'CCC': 'P', 'CCA': 'P', 'CCG': 'P',
    # Threonine
    'ACT': 'T', 'ACC': 'T', 'ACA': 'T', 'ACG': 'T',
    # Alanine
    'GCT': 'A', 'GCC': 'A', 'GCA': 'A', 'GCG': 'A',
    # Tyrosine
    'TAT': 'Y', 'TAC': 'Y',
    # Stop codons
    'TAA': '*', 'TAG': '*', 'TGA': '*',
    # Histidine
    'CAT': 'H', 'CAC': 'H',
    # Glutamine
    'CAA': 'Q', 'CAG': 'Q',
    # Asparagine
    'AAT': 'N', 'AAC': 'N',
    # Lysine
    'AAA': 'K', 'AAG': 'K',
    # Aspartic acid
    'GAT': 'D', 'GAC': 'D',
    # Glutamic acid
    'GAA': 'E', 'GAG': 'E',
    # Cysteine
    'TGT': 'C', 'TGC': 'C',
    # Tryptophan
    'TGG': 'W',
    # Arginine
    'CGT': 'R', 'CGC': 'R', 'CGA': 'R', 'CGG': 'R', 'AGA': 'R', 'AGG': 'R',
    # Glycine
    'GGT': 'G', 'GGC': 'G', 'GGA': 'G', 'GGG': 'G',
}


def convert_airr_junction_to_imgt_cdr3(junction_aa: str) -> str:
    """
    Convert AIRR Junction format to IMGT CDR3 format.
    
    CoV-AbDab requires IMGT CDR3 format:
    - Remove conserved C (Cysteine 104) at start if present
    - Remove conserved W/F (Trp/Phe 118) at end if present
    
    Examples:
        AIRR:  CARRGDGLYYTGMDVW  → IMGT CDR3: ARRGDGLYYTGMDV
        AIRR:  CARRVTMTEGVYFDYW  → IMGT CDR3: ARRVTMTEGVYFDY
        AIRR:  CQLYNTNSWTF       → IMGT CDR3: QLYNTNSWT
    
    Args:
        junction_aa: AIRR Junction amino acid sequence
    
    Returns:
        IMGT CDR3 sequence (trimmed)
    """
    if not junction_aa or junction_aa == 'None' or junction_aa == '':
        return ""
    
    cdr3 = str(junction_aa).strip()
    
    # Remove leading C (Cysteine 104 in IMGT numbering)
    if cdr3.startswith('C'):
        cdr3 = cdr3[1:]
    
    # Remove trailing W (Trp 118) or F (Phe, sometimes at end instead of W)
    if cdr3.endswith('W') or cdr3.endswith('F'):
        cdr3 = cdr3[:-1]
    
    return cdr3


def translate_dna_to_aa(dna_seq: str, remove_gaps: bool = True) -> str:
    """
    Translate DNA sequence to amino acids using standard genetic code.
    
    IgBLAST provides sequences in correct reading frame, so translation
    is reliable and deterministic.
    
    Args:
        dna_seq: DNA nucleotide sequence
        remove_gaps: If True, remove gap characters (-) before translation
    
    Returns:
        Amino acid sequence
    """
    if not dna_seq or dna_seq == 'None':
        return ""
    
    dna_seq = str(dna_seq).strip()
    
    # Remove gaps if present (from aligned sequences)
    if remove_gaps:
        dna_seq = dna_seq.replace('-', '').replace('.', '').replace(' ', '')
    
    # Convert to uppercase
    dna_seq = dna_seq.upper()
    
    # Ensure sequence length is multiple of 3
    # IgBLAST sequences should already be in frame, but trim excess if needed
    trim_length = len(dna_seq) % 3
    if trim_length > 0:
        dna_seq = dna_seq[:-trim_length]
    
    # Translate codon by codon
    aa_sequence = ''
    for i in range(0, len(dna_seq), 3):
        codon = dna_seq[i:i+3]
        
        # Skip incomplete codons (shouldn't happen after trimming)
        if len(codon) < 3:
            break
        
        # Translate codon
        if codon in CODON_TABLE:
            amino_acid = CODON_TABLE[codon]
            
            # Stop at stop codon
            if amino_acid == '*':
                break
            
            aa_sequence += amino_acid
        else:
            # Unknown/ambiguous codon → use 'X'
            aa_sequence += 'X'
    
    return aa_sequence


def calculate_sequence_identity(seq1: str, seq2: str) -> float:
    """
    Calculate simple identity percentage between two sequences.
    
    Both sequences must be the same length (CoV-AbDab requirement).
    Performs character-by-character comparison.
    
    Args:
        seq1: First amino acid sequence
        seq2: Second amino acid sequence
    
    Returns:
        Identity percentage (0.0 - 100.0)
    """
    if not seq1 or not seq2:
        return 0.0
    
    if len(seq1) != len(seq2):
        return 0.0  # CoV-AbDab only matches same-length sequences
    
    matches = sum(1 for a, b in zip(seq1, seq2) if a == b)
    identity = (matches / len(seq1)) * 100.0
    
    return identity


def align_sequences(query: str, reference: str) -> dict:
    """
    Create alignment visualization strings for display.
    
    Returns alignment in format matching CoV-AbDab web interface:
    - Query sequence
    - Match string: '|' for match, ' ' for mismatch
    - Reference sequence
    
    Args:
        query: Query amino acid sequence
        reference: Reference amino acid sequence from database
    
    Returns:
        Dictionary with alignment strings and statistics
    """
    if not query or not reference:
        return {
            'query_aligned': query or '',
            'reference_aligned': reference or '',
            'match_string': '',
            'identity': 0.0,
            'matches': 0,
            'length': 0
        }
    
    # Ensure same length (pad if necessary, though CoV-AbDab requires exact match)
    max_len = max(len(query), len(reference))
    query_padded = query.ljust(max_len, '-')
    reference_padded = reference.ljust(max_len, '-')
    
    # Build match string
    match_string = ''
    matches = 0
    for q, r in zip(query_padded, reference_padded):
        if q == r and q != '-':
            match_string += '|'
            matches += 1
        else:
            match_string += ' '
    
    identity = (matches / max_len) * 100.0 if max_len > 0 else 0.0
    
    return {
        'query_aligned': query_padded,
        'reference_aligned': reference_padded,
        'match_string': match_string,
        'identity': identity,
        'matches': matches,
        'length': max_len
    }


def load_cov_abdab_database(csv_path: str) -> dict:
    """
    Load and index CoV-AbDab COVID antibody database.
    
    CoV-AbDab CSV columns (relevant):
    - Column 1 (index 0): Name (antibody identifier)
    - Column 2 (index 1): Ab or Nb (Antibody or Nanobody)
    - Column 3 (index 2): Binds to (virus strains)
    - Column 5 (index 4): Neutralising Vs (neutralization data)
    - Column 8 (index 7): Origin (source)
    - Column 9 (index 8): VHorVHH (full VH amino acid sequence)
    - Column 15 (index 14): CDRH3 (CDR3 amino acid sequence, IMGT format)
    - Column 11 (index 10): Heavy V Gene
    - Column 12 (index 11): Heavy J Gene
    
    Args:
        csv_path: Path to CoV-AbDab CSV file
    
    Returns:
        Dictionary with antibodies and length-indexed lookups
    """
    print(f"Loading CoV-AbDab database from: {csv_path}")
    
    # Load CSV
    df = pd.read_csv(csv_path, encoding='utf-8', encoding_errors='ignore')
    
    antibodies = []
    vh_by_length = defaultdict(list)
    cdr3_by_length = defaultdict(list)
    
    for idx, row in df.iterrows():
        # Extract data (using iloc for position-based access)
        name = str(row.iloc[0]) if pd.notna(row.iloc[0]) else f'Unknown_{idx}'
        ab_or_nb = str(row.iloc[1]) if pd.notna(row.iloc[1]) else ''
        binds_to = str(row.iloc[2]) if pd.notna(row.iloc[2]) else ''
        neutralizes = str(row.iloc[4]) if pd.notna(row.iloc[4]) else ''
        origin = str(row.iloc[7]) if pd.notna(row.iloc[7]) else ''
        
        # VH sequence (column 9, index 8)
        vh_seq = ''
        if pd.notna(row.iloc[8]) and str(row.iloc[8]) != 'ND':
            vh_seq = str(row.iloc[8]).strip()
        
        # CDR3 sequence (column 15, index 14)
        cdr3_seq = ''
        if pd.notna(row.iloc[14]) and str(row.iloc[14]) != 'ND':
            cdr3_seq = str(row.iloc[14]).strip()
        
        v_gene = str(row.iloc[10]) if pd.notna(row.iloc[10]) else ''
        j_gene = str(row.iloc[11]) if pd.notna(row.iloc[11]) else ''
        
        antibody = {
            'name': name,
            'ab_or_nb': ab_or_nb,
            'vh_sequence': vh_seq,
            'cdr3_sequence': cdr3_seq,
            'v_gene': v_gene,
            'j_gene': j_gene,
            'binds_to': binds_to,
            'neutralizes': neutralizes,
            'origin': origin
        }
        
        antibodies.append(antibody)
        
        # Index by length for fast lookup (CoV-AbDab requirement)
        if vh_seq and len(vh_seq) > 10:  # Valid VH sequence
            vh_by_length[len(vh_seq)].append(antibody)
        
        if cdr3_seq and len(cdr3_seq) > 3:  # Valid CDR3 sequence
            cdr3_by_length[len(cdr3_seq)].append(antibody)
    
    print(f"Loaded {len(antibodies)} antibodies from CoV-AbDab")
    print(f"VH sequences available: {sum(len(v) for v in vh_by_length.values())}")
    print(f"CDR3 sequences available: {sum(len(v) for v in cdr3_by_length.values())}")
    
    return {
        'antibodies': antibodies,
        'vh_by_length': dict(vh_by_length),
        'cdr3_by_length': dict(cdr3_by_length),
        'total_count': len(antibodies)
    }


def find_vh_matches(query_vh: str, database: dict, min_identity: float = 0.0) -> List[dict]:
    """
    Find VH sequence matches in database.
    
    IMPORTANT: CoV-AbDab only matches sequences of the same length!
    
    Args:
        query_vh: Query VH amino acid sequence
        database: Loaded database dict (from load_cov_abdab_database)
        min_identity: Minimum identity % to include (default 0.0 = all matches)
    
    Returns:
        List of match dicts sorted by identity (descending)
    """
    if not query_vh:
        return []
    
    query_length = len(query_vh)
    
    # Only check antibodies with same length
    candidates = database['vh_by_length'].get(query_length, [])
    
    if not candidates:
        print(f"No VH sequences of length {query_length} in database")
        return []
    
    matches = []
    for antibody in candidates:
        ref_seq = antibody['vh_sequence']
        
        # Calculate identity
        identity = calculate_sequence_identity(query_vh, ref_seq)
        
        if identity >= min_identity:
            # Create alignment visualization
            alignment = align_sequences(query_vh, ref_seq)
            
            matches.append({
                'antibody_name': antibody['name'],
                'identity': identity,
                'alignment': alignment,
                'db_info': {
                    'binds_to': antibody['binds_to'],
                    'neutralizes': antibody['neutralizes'],
                    'v_gene': antibody['v_gene'],
                    'j_gene': antibody['j_gene'],
                    'origin': antibody['origin'],
                    'ab_or_nb': antibody['ab_or_nb']
                }
            })
    
    # Sort by identity descending
    matches.sort(key=lambda x: x['identity'], reverse=True)
    
    return matches


def find_cdr3_matches(query_cdr3: str, database: dict, min_identity: float = 0.0) -> List[dict]:
    """
    Find CDR3 sequence matches in database.
    
    IMPORTANT: 
    - Input should be IMGT CDR3 format (without C and W/F)
    - CoV-AbDab only matches sequences of the same length!
    
    Args:
        query_cdr3: Query CDR3 amino acid sequence (IMGT format, trimmed)
        database: Loaded database dict
        min_identity: Minimum identity % to include
    
    Returns:
        List of match dicts sorted by identity (descending)
    """
    if not query_cdr3:
        return []
    
    query_length = len(query_cdr3)
    
    # Only check antibodies with same CDR3 length
    candidates = database['cdr3_by_length'].get(query_length, [])
    
    if not candidates:
        print(f"No CDR3 sequences of length {query_length} in database")
        return []
    
    matches = []
    for antibody in candidates:
        ref_seq = antibody['cdr3_sequence']
        
        # Calculate identity
        identity = calculate_sequence_identity(query_cdr3, ref_seq)
        
        if identity >= min_identity:
            # Create alignment visualization
            alignment = align_sequences(query_cdr3, ref_seq)
            
            matches.append({
                'antibody_name': antibody['name'],
                'identity': identity,
                'alignment': alignment,
                'db_info': {
                    'binds_to': antibody['binds_to'],
                    'neutralizes': antibody['neutralizes'],
                    'v_gene': antibody['v_gene'],
                    'j_gene': antibody['j_gene'],
                    'origin': antibody['origin'],
                    'ab_or_nb': antibody['ab_or_nb']
                }
            })
    
    # Sort by identity descending
    matches.sort(key=lambda x: x['identity'], reverse=True)
    
    return matches


def _resolve_filename(seq_id: str, file_id_mapping: dict) -> str:
    """Resolve a sequence ID to its original filename using the numeric suffix mapping."""
    parts = str(seq_id).rsplit('_', 1)
    if len(parts) == 2 and parts[1] in file_id_mapping:
        return file_id_mapping[parts[1]]
    # Legacy fallback
    if '|||' in str(seq_id):
        return str(seq_id).split('|||')[1]
    return ''


def analyze_covid_matches(
    clone_pass_path: str,
    cov_abdab_path: str,
    top_n_clones: int = 20,
    file_id_mapping: dict = None,
    specific_clone_ids: list = None
) -> dict:
    """
    Main function to analyze clones against CoV-AbDab database.

    Steps:
    1. Load CoV-AbDab database
    2. Identify which clones to analyze (either top N by size OR a caller-provided list)
    3. For each clone:
       a. Extract representative sequence (first sequence in clone)
       b. Translate DNA → AA for VH matching
       c. Convert junction_aa (AIRR) → IMGT CDR3
       d. Find VH matches (length-specific)
       e. Find CDR3 matches (length-specific)
    4. Return results with match statistics

    Args:
        clone_pass_path: Path to ig_out_data_db-pass_clone-pass_germ-pass.tsv
        cov_abdab_path: Path to CoV-AbDab CSV
        top_n_clones: Number of largest clones to analyze (default 20).
            Ignored when specific_clone_ids is provided.
        file_id_mapping: Maps numeric sequence-id suffixes to original filenames.
        specific_clone_ids: Optional explicit list of clone IDs to analyze
            (e.g. IDs of discovered public clones). When provided, overrides top_n.

    Returns:
        Results dict with top_clones and stats
    """
    print(f"Starting COVID database matching analysis...")
    print(f"Clone data: {clone_pass_path}")
    print(f"CoV-AbDab database: {cov_abdab_path}")

    # Load CoV-AbDab database
    database = load_cov_abdab_database(cov_abdab_path)

    # Load clone data
    clone_df = pd.read_csv(clone_pass_path, sep='\t')

    # Decide which clones to analyze: caller-provided list wins, else top N by size
    clone_sizes = clone_df.groupby('clone_id').size().sort_values(ascending=False)
    if specific_clone_ids:
        # Keep only IDs that actually exist in the clone table, preserve size order
        id_set = set(int(c) for c in specific_clone_ids)
        top_clone_ids = [int(cid) for cid in clone_sizes.index.tolist() if int(cid) in id_set]
        print(f"Analyzing {len(top_clone_ids)} caller-specified clones "
              f"(of {len(specific_clone_ids)} requested, matched in clone table)")
    else:
        top_clone_ids = clone_sizes.head(top_n_clones).index.tolist()
        print(f"Analyzing top {len(top_clone_ids)} clones (sizes: {clone_sizes.head(top_n_clones).tolist()})")
    
    top_clones = []
    clones_with_vh_matches = 0
    clones_with_cdr3_matches = 0
    clones_with_high_matches = 0
    
    for clone_id in top_clone_ids:
        # Get all sequences in this clone
        clone_seqs = clone_df[clone_df['clone_id'] == clone_id]
        clone_size = len(clone_seqs)
        
        # Get representative sequence (first one)
        rep_seq = clone_seqs.iloc[0]
        
        # Extract data
        sequence_id = str(rep_seq['sequence_id'])
        dna_seq = str(rep_seq['sequence']) if pd.notna(rep_seq['sequence']) else ''
        junction_aa_raw = str(rep_seq['junction_aa']) if pd.notna(rep_seq['junction_aa']) else ''
        v_call = str(rep_seq['v_call']) if pd.notna(rep_seq['v_call']) else ''
        j_call = str(rep_seq['j_call']) if pd.notna(rep_seq['j_call']) else ''
        
        # Extract V/J gene (without allele)
        v_gene = v_call.split('*')[0] if '*' in v_call else v_call
        j_gene = j_call.split('*')[0] if '*' in j_call else j_call
        
        # Get file names for this clone
        files = []
        mapping = file_id_mapping or {}
        for seq_id in clone_seqs['sequence_id']:
            filename = _resolve_filename(seq_id, mapping)
            if filename and filename not in files:
                files.append(filename)
        
        # Extract V-J region from the full sequence for proper VH translation
        # The full sequence includes UTRs and primers - we need only the V-J region
        v_start = int(rep_seq['v_sequence_start']) - 1 if pd.notna(rep_seq['v_sequence_start']) else 0
        j_end = int(rep_seq['j_sequence_end']) if pd.notna(rep_seq['j_sequence_end']) else len(dna_seq)
        
        # Extract V-J region
        vj_region = dna_seq[v_start:j_end]

        # Translate in the germline's reading frame rather than from offset 0.
        #
        # v_sequence_start says where the V region begins in the read;
        # v_germline_start says which germline V position that is. A contig
        # starting inside FR1, routine for 10x, has v_germline_start > 1, so
        # translating from offset 0 is frame-shifted: translate_dna_to_aa stops
        # at the first spurious stop codon and returns a short nonsense peptide.
        # find_vh_matches buckets purely by length, so that peptide is then
        # compared against the wrong part of the database and real matches are
        # missed without any sign that something went wrong.
        frame_offset = 0
        v_germ_start = rep_seq.get('v_germline_start')
        if pd.notna(v_germ_start):
            try:
                frame_offset = (int(v_germ_start) - 1) % 3
            except (TypeError, ValueError):
                frame_offset = 0

        # Translate V-J region to AA for VH matching
        vh_aa = translate_dna_to_aa(vj_region[frame_offset:])
        
        # Convert AIRR Junction to IMGT CDR3
        cdr3_aa = convert_airr_junction_to_imgt_cdr3(junction_aa_raw)
        
        print(f"Clone {clone_id}: size={clone_size}, VH_len={len(vh_aa)}, CDR3_len={len(cdr3_aa)}")
        
        # Find matches
        vh_matches = find_vh_matches(vh_aa, database, min_identity=0.0) if vh_aa else []
        cdr3_matches = find_cdr3_matches(cdr3_aa, database, min_identity=0.0) if cdr3_aa else []
        
        # Check for high matches (>= 90%)
        has_high_vh_match = any(m['identity'] >= 90.0 for m in vh_matches)
        has_high_cdr3_match = any(m['identity'] >= 90.0 for m in cdr3_matches)
        
        if vh_matches:
            clones_with_vh_matches += 1
        if cdr3_matches:
            clones_with_cdr3_matches += 1
        if has_high_vh_match or has_high_cdr3_match:
            clones_with_high_matches += 1
        
        print(f"  Found {len(vh_matches)} VH matches, {len(cdr3_matches)} CDR3 matches")
        if vh_matches:
            print(f"  Best VH match: {vh_matches[0]['antibody_name']} ({vh_matches[0]['identity']:.1f}%)")
        if cdr3_matches:
            print(f"  Best CDR3 match: {cdr3_matches[0]['antibody_name']} ({cdr3_matches[0]['identity']:.1f}%)")
        
        top_clones.append({
            'clone_id': int(clone_id),
            'size': int(clone_size),
            'cdr3_aa': cdr3_aa,
            'cdr3_aa_raw': junction_aa_raw,
            'vh_aa': vh_aa,
            'v_gene': v_gene,
            'j_gene': j_gene,
            'files': files,
            'vh_matches': vh_matches[:20],  # Limit to top 20 matches
            'cdr3_matches': cdr3_matches[:20],  # Limit to top 20 matches
            'has_high_vh_match': has_high_vh_match,
            'has_high_cdr3_match': has_high_cdr3_match
        })
    
    results = {
        'top_clones': top_clones,
        'stats': {
            'total_clones_analyzed': len(top_clones),
            'clones_with_vh_matches': clones_with_vh_matches,
            'clones_with_cdr3_matches': clones_with_cdr3_matches,
            'clones_with_high_matches': clones_with_high_matches,
            'database_size': database['total_count']
        }
    }
    
    print(f"COVID matching complete: {clones_with_high_matches}/{len(top_clones)} clones with high matches")
    
    return results
