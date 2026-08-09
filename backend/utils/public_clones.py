"""
Public Clone Analysis Module

Identifies and analyzes public clones (antibody clones shared across multiple patients/samples)
based on CDR3 amino acid sequence similarity and V/J gene usage.
"""

import pandas as pd
import os
import numpy as np
from typing import Dict, List, Tuple, Optional, Any
from collections import defaultdict


def levenshtein_distance(s1: str, s2: str) -> int:
    """
    Calculate Levenshtein (edit) distance between two strings.
    
    Args:
        s1: First string
        s2: Second string
    
    Returns:
        Minimum number of single-character edits needed to transform s1 into s2
    """
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    
    if len(s2) == 0:
        return len(s1)
    
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            # Cost of insertions, deletions, or substitutions
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    
    return previous_row[-1]


def calculate_aa_similarity(seq1: str, seq2: str) -> float:
    """
    Calculate amino acid sequence similarity as percentage identity.
    
    Args:
        seq1: First amino acid sequence
        seq2: Second amino acid sequence
    
    Returns:
        Similarity score between 0.0 and 1.0
    """
    if not seq1 or not seq2:
        return 0.0
    
    # Normalize length difference penalty
    max_len = max(len(seq1), len(seq2))
    min_len = min(len(seq1), len(seq2))
    
    # If length difference is too large (>2 AA), penalize heavily
    if abs(len(seq1) - len(seq2)) > 2:
        length_penalty = abs(len(seq1) - len(seq2)) / max_len
    else:
        length_penalty = 0
    
    # Calculate edit distance
    edit_dist = levenshtein_distance(seq1, seq2)
    
    # Similarity = 1 - (normalized_distance + length_penalty)
    similarity = 1.0 - ((edit_dist / max_len) + length_penalty * 0.5)
    
    return max(0.0, similarity)  # Ensure non-negative


def cluster_similar_cdr3(
    sequences: List[Tuple[str, str, str, str]],  # (cdr3_aa, v_gene, j_gene, seq_id)
    similarity_threshold: float = 0.85,
    max_aa_mismatches: Optional[int] = None,
    same_length_only: bool = False
) -> Dict[str, List[Tuple[str, str, str, str]]]:
    """
    Cluster CDR3 sequences by similarity.
    
    Args:
        sequences: List of (cdr3_aa, v_gene, j_gene, seq_id) tuples
        similarity_threshold: Minimum similarity score (0.0-1.0). Default 0.85 = ~15% difference
        max_aa_mismatches: If set, override similarity_threshold with absolute mismatch count
        same_length_only: If True, only cluster sequences of identical length
    
    Returns:
        Dictionary mapping cluster_id to list of sequences in that cluster
    """
    clusters = {}
    cluster_id = 0
    assigned = set()
    
    for i, (cdr3_1, v_1, j_1, id_1) in enumerate(sequences):
        if id_1 in assigned:
            continue
        
        # Start a new cluster with this sequence
        cluster_key = f"cluster_{cluster_id}"
        clusters[cluster_key] = [(cdr3_1, v_1, j_1, id_1)]
        assigned.add(id_1)
        
        # Find similar sequences
        for j, (cdr3_2, v_2, j_2, id_2) in enumerate(sequences[i+1:], start=i+1):
            if id_2 in assigned:
                continue
            
            # Must use same V and J genes (or very similar alleles)
            v_match = v_1.split('*')[0] == v_2.split('*')[0]
            j_match = j_1.split('*')[0] == j_2.split('*')[0]
            
            if not (v_match and j_match):
                continue
            
            # Check length constraint
            if same_length_only and len(cdr3_1) != len(cdr3_2):
                continue
            
            # Calculate similarity
            if max_aa_mismatches is not None:
                # Use absolute mismatch count
                edit_dist = levenshtein_distance(cdr3_1, cdr3_2)
                if edit_dist <= max_aa_mismatches:
                    clusters[cluster_key].append((cdr3_2, v_2, j_2, id_2))
                    assigned.add(id_2)
            else:
                # Use percentage similarity
                similarity = calculate_aa_similarity(cdr3_1, cdr3_2)
                if similarity >= similarity_threshold:
                    clusters[cluster_key].append((cdr3_2, v_2, j_2, id_2))
                    assigned.add(id_2)
        
        cluster_id += 1
    
    return clusters


def generate_visualization_data(
    public_clones: List[Dict[str, Any]],
    all_patients: List[str]
) -> Dict[str, Any]:
    """
    Generate data structures for various visualizations.
    
    Args:
        public_clones: List of public clone dictionaries
        all_patients: List of all patient/file names
    
    Returns:
        Dictionary with visualization data for heatmap, chord, upset, and network
    """
    viz_data = {
        'heatmap': {'clones': [], 'patients': [], 'matrix': [], 'frequencies': []},
        'chord': {'nodes': [], 'links': []},
        'upset': {'sets': {}, 'intersections': []},
        'network': {'nodes': [], 'edges': []}
    }
    
    if not public_clones:
        return viz_data
    
    # Heatmap data
    viz_data['heatmap']['patients'] = sorted(all_patients)
    for clone in public_clones:
        viz_data['heatmap']['clones'].append(f"{clone['cdr3_aa'][:15]}...")  # Truncate for display
        
        # Create presence/absence and frequency rows
        presence_row = []
        frequency_row = []
        sequences_by_patient = clone.get('sequences_by_patient', {})
        for patient in viz_data['heatmap']['patients']:
            if patient in clone['patients']:
                presence_row.append(1)
                # Count sequences from this patient (use sequences_by_patient, not broken 'patient in s')
                patient_seqs = sequences_by_patient.get(patient, [])
                frequency_row.append(len(patient_seqs))
            else:
                presence_row.append(0)
                frequency_row.append(0)
        
        viz_data['heatmap']['matrix'].append(presence_row)
        viz_data['heatmap']['frequencies'].append(frequency_row)
    
    # Chord diagram data
    viz_data['chord']['nodes'] = sorted(all_patients)
    
    # Calculate pairwise shared clone counts
    patient_pairs = defaultdict(int)
    for clone in public_clones:
        patients_in_clone = clone['patients']
        # For each pair of patients in this clone
        for i, p1 in enumerate(patients_in_clone):
            for p2 in patients_in_clone[i+1:]:
                # Sort to avoid duplicate pairs
                pair_key = tuple(sorted([p1, p2]))
                patient_pairs[pair_key] += 1
    
    # Create links
    for (source, target), count in patient_pairs.items():
        viz_data['chord']['links'].append({
            'source': source,
            'target': target,
            'value': count
        })
    
    # UpSet plot data
    # Set sizes
    for patient in all_patients:
        patient_clones = [c for c in public_clones if patient in c['patients']]
        viz_data['upset']['sets'][patient] = len(patient_clones)
    
    # Intersection sizes
    intersections_count = defaultdict(int)
    for clone in public_clones:
        # Create a frozenset of patients for this clone
        patient_set = frozenset(clone['patients'])
        intersections_count[patient_set] += 1
    
    # Convert to list format
    for patient_set, count in intersections_count.items():
        viz_data['upset']['intersections'].append({
            'sets': sorted(list(patient_set)),
            'size': count
        })
    
    # Sort by size descending
    viz_data['upset']['intersections'].sort(key=lambda x: x['size'], reverse=True)
    
    # Network graph data
    # Add patient nodes
    for patient in all_patients:
        viz_data['network']['nodes'].append({
            'id': f"patient_{patient}",
            'type': 'patient',
            'label': patient
        })
    
    # Add clone nodes and edges
    for idx, clone in enumerate(public_clones[:50]):  # Limit to top 50 for performance
        clone_id = f"clone_{idx}"
        viz_data['network']['nodes'].append({
            'id': clone_id,
            'type': 'clone',
            'label': f"{clone['cdr3_aa'][:10]}..."
        })
        
        # Add edges to patients
        for patient in clone['patients']:
            viz_data['network']['edges'].append({
                'source': clone_id,
                'target': f"patient_{patient}",
                'count': clone['sequence_count']
            })
    
    return viz_data


def analyze_public_clones(
    clone_pass_path: str,
    sequences_data: List[dict],
    mode: str = 'lenient',
    similarity_threshold: float = 0.85,
    max_aa_mismatches: Optional[int] = None,
    top_n: int = 10,
    file_id_mapping: dict = None
) -> Dict[str, Any]:
    """
    Identify public clones (shared across multiple FASTA files/patients).
    
    Args:
        clone_pass_path: Path to clonality TSV file
        sequences_data: List of sequence dictionaries with id and file info
        mode: Clustering mode ('exact', 'lenient', or 'custom')
        similarity_threshold: For custom mode, minimum similarity (0.0-1.0)
        max_aa_mismatches: For custom mode, max allowed mismatches
        top_n: Number of top clones to return
    
    Returns:
        Dictionary with public clones, statistics, and visualization data
    """
    # Set parameters based on mode
    if mode == 'exact':
        similarity_threshold = 1.0
        max_aa_mismatches = 0
        method_desc = "Exact CDR3 AA match (100% identity)"
    elif mode == 'lenient':
        similarity_threshold = 0.85
        max_aa_mismatches = 2
        method_desc = "≤2 AA mismatches or ≥85% similarity (AIRR standard)"
    else:  # custom
        if max_aa_mismatches is not None:
            method_desc = f"≤{max_aa_mismatches} AA mismatches"
        else:
            method_desc = f"≥{int(similarity_threshold*100)}% similarity"
    
    # Load clonality data
    if not os.path.exists(clone_pass_path):
        return {
            'public_clones': [],
            'top_x': [],
            'stats': {
                'total_public_clones': 0,
                'total_sequences_in_public_clones': 0,
                'max_patient_sharing': 0,
                'total_patients': 0,
                'clustering_mode': mode,
                'similarity_threshold': similarity_threshold,
                'top_n_displayed': 0
            },
            'method': method_desc,
            'visualizations': {
                'heatmap': {'clones': [], 'patients': [], 'matrix': [], 'frequencies': []},
                'chord': {'nodes': [], 'links': []},
                'upset': {'sets': {}, 'intersections': []},
                'network': {'nodes': [], 'edges': []}
            }
        }
    
    clone_df = pd.read_table(clone_pass_path)
    
    # Create a mapping: sequence_id -> file
    mapping = file_id_mapping or {}
    seq_to_file = {}
    for seq in sequences_data:
        seq_id = seq['id']
        # Try numeric suffix first
        parts = seq_id.rsplit('_', 1)
        if len(parts) == 2 and parts[1] in mapping:
            seq_to_file[seq_id] = mapping[parts[1]]
        elif '|||' in seq_id:
            # Legacy fallback
            base_id, filename = seq_id.split('|||', 1)
            seq_to_file[seq_id] = filename
        else:
            seq_to_file[seq_id] = seq.get('file', 'unknown.fasta')
    
    # Prepare sequences for clustering: (cdr3_aa, v_gene, j_gene, seq_id)
    sequences_to_cluster = []
    seq_metadata = {}
    
    for _, row in clone_df.iterrows():
        seq_id = str(row['sequence_id'])
        junction_aa = str(row['junction_aa']) if pd.notna(row['junction_aa']) else None
        junction = str(row['junction']) if pd.notna(row['junction']) else None
        v_call = str(row['v_call']) if pd.notna(row['v_call']) else None
        j_call = str(row['j_call']) if pd.notna(row['j_call']) else None
        
        if not junction_aa or not v_call or not j_call:
            continue
        
        v_gene = v_call.split('*')[0] if '*' in v_call else v_call
        j_gene = j_call.split('*')[0] if '*' in j_call else j_call
        
        sequences_to_cluster.append((junction_aa, v_gene, j_gene, seq_id))
        seq_metadata[seq_id] = {
            'cdr3_aa': junction_aa,
            'cdr3_dna': junction,
            'v_gene': v_gene,
            'j_gene': j_gene,
            'v_call': v_call,
            'j_call': j_call,
            'file': seq_to_file.get(seq_id, 'unknown')
        }
    
    # Cluster sequences by CDR3 similarity
    if mode == 'exact':
        # For exact mode, use simple grouping (faster)
        clusters = defaultdict(list)
        for cdr3_aa, v_gene, j_gene, seq_id in sequences_to_cluster:
            cluster_key = f"{cdr3_aa}||{v_gene}||{j_gene}"
            clusters[cluster_key].append((cdr3_aa, v_gene, j_gene, seq_id))
    else:
        # For lenient/custom, use similarity clustering
        clusters = cluster_similar_cdr3(
            sequences_to_cluster,
            similarity_threshold=similarity_threshold,
            max_aa_mismatches=max_aa_mismatches,
            same_length_only=False
        )
    
    # Identify public clones (present in 2+ files)
    public_clones = []
    all_patients = set(seq_to_file.values())
    
    for cluster_id, cluster_seqs in clusters.items():
        files_in_cluster = set()
        seq_ids_in_cluster = []
        
        for cdr3_aa, v_gene, j_gene, seq_id in cluster_seqs:
            files_in_cluster.add(seq_metadata[seq_id]['file'])
            seq_ids_in_cluster.append(seq_id)
        
        num_files = len(files_in_cluster)
        
        if num_files >= 2:  # Public = shared across ≥2 patients
            # Use the first sequence as the representative
            rep_seq = cluster_seqs[0]
            rep_id = rep_seq[3]
            rep_meta = seq_metadata[rep_id]
            
            # Build sequences_by_patient: filename -> [seq_ids] for heatmap frequency counts
            sequences_by_patient: Dict[str, List[str]] = {}
            for cdr3_aa, v_gene, j_gene, seq_id in cluster_seqs:
                f = seq_metadata[seq_id]['file']
                if f not in sequences_by_patient:
                    sequences_by_patient[f] = []
                sequences_by_patient[f].append(seq_id)
            
            # Calculate sequence diversity in cluster
            unique_cdr3s = list(set([s[0] for s in cluster_seqs]))
            avg_similarity = 1.0
            if len(unique_cdr3s) > 1 and mode != 'exact':
                similarities = []
                for i in range(len(unique_cdr3s)):
                    for j in range(i+1, len(unique_cdr3s)):
                        sim = calculate_aa_similarity(unique_cdr3s[i], unique_cdr3s[j])
                        similarities.append(sim)
                avg_similarity = float(np.mean(similarities)) if similarities else 1.0
            
            public_clones.append({
                'id': cluster_id,
                'cdr3_aa': rep_meta['cdr3_aa'],
                'cdr3_dna': rep_meta['cdr3_dna'],
                'v_gene': rep_meta['v_gene'],
                'j_gene': rep_meta['j_gene'],
                'sequence_count': len(cluster_seqs),
                'patient_count': num_files,
                'patients': sorted(list(files_in_cluster)),
                'sequences': seq_ids_in_cluster,
                'sequences_by_patient': sequences_by_patient,
                'unique_cdr3_variants': len(unique_cdr3s),
                'avg_intra_cluster_similarity': round(avg_similarity, 3)
            })
    
    # Sort by patient count (descending), then by sequence count
    public_clones.sort(
        key=lambda x: (x['patient_count'], x['sequence_count']),
        reverse=True
    )
    
    # Get top X
    top_x = public_clones[:top_n] if len(public_clones) >= top_n else public_clones
    
    # Calculate statistics
    total_public_sequences = sum(c['sequence_count'] for c in public_clones)
    max_sharing = max([c['patient_count'] for c in public_clones]) if public_clones else 0
    
    stats = {
        'total_public_clones': len(public_clones),
        'total_sequences_in_public_clones': total_public_sequences,
        'max_patient_sharing': max_sharing,
        'total_patients': len(all_patients),
        'clustering_mode': mode,
        'similarity_threshold': float(similarity_threshold),
        'top_n_displayed': len(top_x)
    }
    
    # Generate visualization data
    visualizations = generate_visualization_data(public_clones, sorted(list(all_patients)))
    
    return {
        'public_clones': public_clones,
        'top_x': top_x,
        'stats': stats,
        'method': method_desc,
        'visualizations': visualizations
    }

