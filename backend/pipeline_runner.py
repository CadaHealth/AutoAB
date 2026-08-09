#!/usr/bin/env python3
"""
Pipeline Runner - NDJSON interface for B-Cell Repertoire Analysis

This module provides a CLI interface that communicates via stdin/stdout using
newline-delimited JSON (NDJSON) for seamless integration with Electron.

Message Types (stdout):
    - progress: {"type": "progress", "stage": "...", "percent": 0-100, "message": "..."}
    - log: {"type": "log", "level": "info|warn|error", "message": "..."}
    - threshold_request: {"type": "threshold_request", "calculated": float}
    - result: {"type": "result", "artifact": "...", "path": "...", "data": {...}}
    - complete: {"type": "complete", "success": bool, "error": "..."}

Input (stdin):
    - config: {"action": "run", "config": {...}}
    - threshold_response: {"type": "threshold_response", "value": float}
    - cancel: {"type": "cancel"}
"""

import sys
import os
import json
import glob
import io
import base64
import traceback
from typing import Optional, Dict, Any, List

# Add backend directory to path
backend_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, backend_dir)

# Import existing utilities
from utils import clean as cl
from utils import blast
from utils import clonality as clone
from utils.clonalityFunctions import make_db, define_clonality, create_germline, findDist
from utils.toolpaths import exe, find_changeo_script, find_igblast_binary, find_rscript

# Try to import DL clustering (optional)
try:
    from utils import dl_clustering
    DL_CLUSTERING_AVAILABLE = True
except ImportError:
    DL_CLUSTERING_AVAILABLE = False
    print("Warning: DL clustering not available")


class NDJSONEmitter:
    """Utility class for emitting NDJSON messages to stdout."""
    
    log_file = None  # Will be set by PipelineRunner
    
    @staticmethod
    def emit(message: Dict[str, Any]):
        """Emit a single NDJSON message."""
        sys.stdout.write(json.dumps(message) + '\n')
        sys.stdout.flush()
        
        # Also write to log file if available
        if NDJSONEmitter.log_file and message.get('type') == 'log':
            try:
                with open(NDJSONEmitter.log_file, 'a') as f:
                    f.write(f"[{message.get('level', 'info').upper()}] {message.get('message', '')}\n")
            except:
                pass  # Don't fail if logging fails
    
    @staticmethod
    def progress(stage: str, percent: int, message: str):
        """Emit a progress update."""
        NDJSONEmitter.emit({
            "type": "progress",
            "stage": stage,
            "percent": percent,
            "message": message
        })
    
    @staticmethod
    def log(level: str, message: str):
        """Emit a log message."""
        NDJSONEmitter.emit({
            "type": "log",
            "level": level,
            "message": message
        })
    
    @staticmethod
    def result(artifact: str, path: Optional[str] = None, data: Optional[Dict] = None):
        """Emit a result artifact."""
        msg = {"type": "result", "artifact": artifact}
        if path:
            msg["path"] = path
        if data:
            msg["data"] = data
        NDJSONEmitter.emit(msg)
    
    @staticmethod
    def threshold_request(calculated: float):
        """Request threshold confirmation from user."""
        msg = {
            "type": "threshold_request",
            "calculated": calculated
        }
        print(f"[DEBUG] Emitting threshold_request: {msg}", file=sys.stderr)
        NDJSONEmitter.emit(msg)
        sys.stdout.flush()  # Ensure it's sent immediately
    
    @staticmethod
    def complete(success: bool, error: Optional[str] = None):
        """Emit completion status."""
        msg = {"type": "complete", "success": success}
        if error:
            msg["error"] = error
        NDJSONEmitter.emit(msg)


class PipelineRunner:
    """Main pipeline runner that orchestrates the analysis."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.emit = NDJSONEmitter
        
        # Extract configuration
        self.fasta_dir = config.get('fasta_dir', '')
        self.clean_fasta = config.get('clean_fasta', False)
        self.database_type = config.get('database_type', 'IMGT')  # IMGT or Custom
        # 'human' | 'mouse' | 'custom'. Only consulted when database_type == 'IMGT'.
        # Defaults to 'human' so the existing Long-COVID workflow is unchanged.
        self.species = (config.get('species') or 'human').lower()
        self.database_v = config.get('database_v', '')
        self.database_d = config.get('database_d', '')
        self.database_j = config.get('database_j', '')
        self.database_c = config.get('database_c', '')  # Optional: for isotype (IgG/IgM/etc.)
        self.output_dir = config.get('output_dir', '')
        self.backend_dir = config.get('backend_dir', backend_dir)
        
        # Clone definition settings
        self.clone_mode = config.get('clone_mode', 'allele')  # 'allele' or 'gene'
        self.linkage_method = config.get('linkage_method', 'average')  # 'single', 'average', or 'complete'
        
        # COVID database matching settings
        self.run_covid_matching = config.get('run_covid_matching', False)
        self.cov_abdab_path = config.get('cov_abdab_database_path', '')
        
        # Set up paths
        self.bin_dir = os.path.join(self.backend_dir, '..', 'geneGUI', 'bin')
        self.data_dir = os.path.join(self.backend_dir, '..', 'geneGUI', 'data')
        
        # Create output directory
        if self.output_dir:
            os.makedirs(self.output_dir, exist_ok=True)
        else:
            self.output_dir = os.path.join(self.backend_dir, '..', 'geneGUI', 'outs')
            os.makedirs(self.output_dir, exist_ok=True)
        
        # Normalize the output directory path to absolute and resolve any ../
        self.output_dir = os.path.abspath(self.output_dir)
        
        # Set up persistent log file
        NDJSONEmitter.log_file = os.path.join(self.output_dir, 'pipeline.log')
        try:
            # Clear old log file
            with open(NDJSONEmitter.log_file, 'w') as f:
                f.write(f"=== Pipeline Started ===\n")
        except:
            NDJSONEmitter.log_file = None
        
        # State
        self.fasta_paths: List[str] = []
        self.combined_fasta: Optional[str] = None
        self.file_id_mapping: Dict[str, str] = {}   # numeric_id -> filename
        self.filename_to_id: Dict[str, str] = {}    # filename -> numeric_id
        self.timepoint_mapping: Dict[str, Dict[str, str]] = {}  # staged_filename -> {timepoint, originalFile}
        self.timepoint_labels: List[str] = []  # ordered list of timepoint labels
        self.tenx_c_gene_map: Dict[str, str] = {}  # contig_id -> c_gene (from 10x annotations)
        self.cancelled = False
    
    def _ensure_file_id_mapping(self):
        """Load file_id_mapping from disk if not already in memory."""
        if not self.file_id_mapping:
            mapping_path = os.path.join(self.output_dir, 'file_id_mapping.json')
            if os.path.exists(mapping_path):
                with open(mapping_path, 'r') as f:
                    self.file_id_mapping = json.load(f)
                self.filename_to_id = {v: k for k, v in self.file_id_mapping.items()}

    def resolve_filename(self, seq_id: str) -> str:
        """Extract the original filename from a sequence ID.
        
        Sequence IDs have a numeric file suffix: e.g. BARCODE-1_contig_2_1001
        The last _XXXX is the file ID that maps back to the original filename.
        """
        self._ensure_file_id_mapping()
        
        # Extract trailing numeric suffix
        parts = seq_id.rsplit('_', 1)
        if len(parts) == 2 and parts[1] in self.file_id_mapping:
            return self.file_id_mapping[parts[1]]
        
        # Legacy fallback: ||| delimiter (for old runs)
        if '|||' in seq_id:
            return seq_id.split('|||')[-1]
        
        return 'unknown.fasta'

    def clean_seq_id(self, seq_id: str) -> str:
        """Remove the file suffix from a sequence ID for display.
        
        e.g. BARCODE-1_contig_2_1001 -> BARCODE-1_contig_2
        """
        self._ensure_file_id_mapping()
        
        parts = seq_id.rsplit('_', 1)
        if len(parts) == 2 and parts[1] in self.file_id_mapping:
            return parts[0]
        
        # Legacy fallback
        if '|||' in seq_id:
            return seq_id.split('|||')[0]
        
        return seq_id

    def check_cancelled(self):
        """Check if cancellation was requested."""
        # Non-blocking check for cancel message on stdin
        # In a real implementation, this would use select() or threading
        return self.cancelled
    
    def load_fasta_files(self) -> bool:
        """Load FASTA files from the specified directory."""
        self.emit.progress("loading", 5, "Loading FASTA files...")
        
        if not os.path.isdir(self.fasta_dir):
            self.emit.log("error", f"FASTA directory does not exist: {self.fasta_dir}")
            return False
        
        # Get all fasta files
        self.fasta_paths = [
            os.path.join(self.fasta_dir, f) 
            for f in os.listdir(self.fasta_dir) 
            if not f.startswith('.') and (f.endswith('.fasta') or f.endswith('.fa'))
        ]
        
        if not self.fasta_paths:
            self.emit.log("error", f"No FASTA files found in: {self.fasta_dir}")
            return False
        
        self.emit.log("info", f"Found {len(self.fasta_paths)} FASTA file(s)")
        self.emit.result("fasta_count", data={"count": len(self.fasta_paths), "files": [os.path.basename(f) for f in self.fasta_paths]})
        
        return True
    
    def clean_fasta_files(self) -> bool:
        """Clean FASTA files if requested."""
        if not self.clean_fasta:
            return True
        
        self.emit.progress("cleaning", 10, "Cleaning FASTA files...")
        
        clean_fasta_dir = os.path.join(self.output_dir, 'clean_fasta')
        os.makedirs(clean_fasta_dir, exist_ok=True)
        
        cleaned_paths = []
        for i, fasta_path in enumerate(self.fasta_paths):
            filename = os.path.basename(fasta_path)
            dot_idx = filename.find('.')
            if dot_idx == -1:
                clean_name = filename + '_clean'
            else:
                clean_name = filename[:dot_idx] + '_clean' + filename[dot_idx:]
            
            clean_path = os.path.join(clean_fasta_dir, clean_name)
            
            # Check if clean file already exists and is valid
            if os.path.exists(clean_path) and os.path.getsize(clean_path) > 0:
                self.emit.log("info", f"Using existing cleaned file: {clean_name}")
            else:
                try:
                    cl.clean_imgt(fasta_path, clean_path)
                    self.emit.log("info", f"Cleaned: {filename}")
                except Exception as e:
                    self.emit.log("warn", f"Failed to clean {filename}: {str(e)}")
                    continue
            
            cleaned_paths.append(clean_path)
            
            # Update progress
            progress = 10 + int((i + 1) / len(self.fasta_paths) * 5)
            self.emit.progress("cleaning", progress, f"Cleaned {i + 1}/{len(self.fasta_paths)} files")
        
        self.fasta_paths = cleaned_paths
        return len(self.fasta_paths) > 0

    def preprocess_10x_contigs(self) -> bool:
        """Filter 10x contigs using paired annotation CSVs.

        For each FASTA that has a matching *_filtered_annotations.csv in the
        same directory, keep only the top-UMI contig per chain per cell and
        store the 10x c_gene for later use as the isotype source.
        """
        import pandas as pd
        from Bio import SeqIO

        # Build a map from FASTA basename -> annotation CSV path using the
        # timepoint_mapping (populated by load_timepoint_mapping or from disk).
        tp_map = self.timepoint_mapping
        if not tp_map:
            tp_path = os.path.join(self.fasta_dir, 'timepoint_mapping.json')
            if os.path.exists(tp_path):
                with open(tp_path) as f:
                    tp_map = json.load(f)

        fasta_to_ann: Dict[str, str] = {}
        for staged_name, info in tp_map.items():
            ann_file = info.get('annotationFile')
            if ann_file:
                fasta_to_ann[staged_name] = os.path.join(self.fasta_dir, ann_file)

        if not fasta_to_ann:
            self.emit.log("info", "No 10x annotation files detected, skipping contig preprocessing")
            return True

        self.emit.progress("preprocessing", 12, "Preprocessing 10x contigs...")

        clean_dir = os.path.join(self.output_dir, 'clean_10x')
        os.makedirs(clean_dir, exist_ok=True)

        new_fasta_paths: List[str] = []
        total_input = 0
        total_kept = 0

        for fasta_path in self.fasta_paths:
            basename = os.path.basename(fasta_path)
            ann_path = fasta_to_ann.get(basename)

            if not ann_path or not os.path.exists(ann_path):
                new_fasta_paths.append(fasta_path)
                continue

            ann_df = pd.read_csv(ann_path)
            file_input = len(ann_df)
            total_input += file_input

            # Apply 10x quality filters
            keep = (
                (ann_df['is_cell'].astype(str).str.upper() == 'TRUE') &
                (ann_df['high_confidence'].astype(str).str.upper() == 'TRUE') &
                (ann_df['productive'].astype(str).str.upper() == 'TRUE')
            )
            ann_df = ann_df[keep].copy()

            # Per barcode + chain: keep the contig with the highest UMI count
            ann_df['umis'] = pd.to_numeric(ann_df['umis'], errors='coerce').fillna(0).astype(int)
            ann_df = ann_df.sort_values('umis', ascending=False)
            ann_df = ann_df.drop_duplicates(subset=['barcode', 'chain'], keep='first')

            selected_ids = set(ann_df['contig_id'].values)

            # Store 10x c_gene for every selected contig
            for _, row in ann_df.iterrows():
                cg = str(row.get('c_gene', '')).strip()
                if cg and cg.lower() != 'none' and cg.lower() != 'nan':
                    self.tenx_c_gene_map[row['contig_id']] = cg

            # Write filtered FASTA
            clean_path = os.path.join(clean_dir, basename)
            kept = 0
            with open(clean_path, 'w') as out_f:
                for record in SeqIO.parse(fasta_path, 'fasta'):
                    if record.id in selected_ids:
                        SeqIO.write(record, out_f, 'fasta')
                        kept += 1

            total_kept += kept
            n_cells = ann_df['barcode'].nunique()
            n_igh = len(ann_df[ann_df['chain'] == 'IGH'])
            n_light = len(ann_df[ann_df['chain'].isin(['IGK', 'IGL'])])

            sample_label = basename.replace('_filtered.fasta', '').lstrip('T0123456789_')
            self.emit.log("info",
                f"  {sample_label}: {file_input} contigs -> {n_cells} cells "
                f"({n_igh} IGH, {n_light} IGK/IGL), {kept} seqs written")

            new_fasta_paths.append(clean_path)

        self.fasta_paths = new_fasta_paths

        self.emit.log("info",
            f"10x preprocessing complete: {total_kept} contigs kept, "
            f"{len(self.tenx_c_gene_map)} c_gene annotations stored")

        # Persist c_gene map for downstream steps
        if self.tenx_c_gene_map:
            map_path = os.path.join(self.output_dir, 'tenx_c_gene_map.json')
            with open(map_path, 'w') as f:
                json.dump(self.tenx_c_gene_map, f)

        return True

    def setup_databases(self) -> bool:
        """
        Set up V/D/J/C database paths.

        IMGT mode resolves the species-appropriate reference directory:
          - human → geneGUI/data/IMGT_Human_Database/Human_*.fasta
          - mouse → geneGUI/data/IMGT_Mouse_Database/Mouse_*.fasta

        Custom mode uses the explicit V/D/J paths from the config.

        Mouse references aren't shipped with the repo (different size + license
        considerations). If they're missing the user is pointed at
        backend/scripts/download_mouse_imgt.sh which fetches them from IMGT.
        """
        self.emit.progress("setup", 15, "Setting up databases...")

        if self.database_type == 'IMGT':
            # Map species → reference folder + filename stem
            species_config = {
                'human': ('IMGT_Human_Database', 'Human'),
                'mouse': ('IMGT_Mouse_Database', 'Mouse'),
            }
            if self.species not in species_config:
                self.emit.log("error",
                    f"Unsupported species '{self.species}' for IMGT mode. "
                    f"Use 'human' or 'mouse', or switch database_type to 'Custom'.")
                return False

            folder, stem = species_config[self.species]
            imgt_dir = os.path.join(self.data_dir, folder)
            self.database_v = os.path.join(imgt_dir, f'{stem}_V.fasta')
            self.database_d = os.path.join(imgt_dir, f'{stem}_D.fasta')
            self.database_j = os.path.join(imgt_dir, f'{stem}_J.fasta')

            # C gene for isotype
            if not self.database_c:
                candidates = [
                    os.path.join(imgt_dir, f'{stem}_C.fasta'),
                ]
                if self.species == 'human':
                    # Legacy fallback path (Immcantation default install location)
                    candidates.append(
                        os.path.expanduser('~/share/germlines/imgt/human/constant/imgt_human_IGHC.fasta')
                    )
                # User override via env var (any species)
                env_override = os.environ.get('BCR_IGHC_DB_PATH')
                if env_override:
                    candidates.insert(0, env_override)
                for p in candidates:
                    if p and os.path.exists(p):
                        self.database_c = p
                        break
                else:
                    self.database_c = ''
            if self.database_c:
                self.emit.log("info", f"Using C gene database for isotype: {self.database_c}")
            self.emit.log("info", f"Species: {self.species}, reference folder: {folder}")

        # Verify V/D/J databases exist
        for db_name, db_path in [('V', self.database_v), ('D', self.database_d), ('J', self.database_j)]:
            if not os.path.exists(db_path):
                self.emit.log("error", f"Database {db_name} not found: {db_path}")
                if self.species == 'mouse':
                    self.emit.log("error",
                        "Mouse IMGT references are not shipped with the repo. "
                        "Run `backend/scripts/download_mouse_imgt.sh` to fetch them, "
                        "or switch to 'Custom' database mode and point at your own files.")
                return False
        
        # Clean database files
        clean_db_dir = os.path.join(self.output_dir, 'clean_db_files')
        os.makedirs(clean_db_dir, exist_ok=True)
        
        # Remove old clean db files
        for f in glob.glob(os.path.join(clean_db_dir, "*")):
            try:
                os.remove(f)
            except:
                pass
        
        # Clean V database
        vname = os.path.basename(self.database_v)
        self.database_v_clean = os.path.join(clean_db_dir, vname.replace('.fasta', '_clean.fasta'))
        cl.clean_imgt(self.database_v, self.database_v_clean)
        
        # Clean D database
        dname = os.path.basename(self.database_d)
        self.database_d_clean = os.path.join(clean_db_dir, dname.replace('.fasta', '_clean.fasta'))
        cl.clean_imgt(self.database_d, self.database_d_clean)
        
        # Clean J database
        jname = os.path.basename(self.database_j)
        self.database_j_clean = os.path.join(clean_db_dir, jname.replace('.fasta', '_clean.fasta'))
        cl.clean_imgt(self.database_j, self.database_j_clean)
        
        # Clean C database (optional, for isotype annotation)
        if self.database_c and os.path.exists(self.database_c):
            try:
                cname = os.path.basename(self.database_c)
                raw_clean = os.path.join(clean_db_dir, cname.replace('.fasta', '_clean_raw.fasta'))
                self.database_c_clean = os.path.join(clean_db_dir, cname.replace('.fasta', '_clean.fasta'))
                cl.clean_imgt(self.database_c, raw_clean)
                
                # Deduplicate: IMGT C gene files have multiple entries per allele
                # (membrane vs secreted isoforms).  makeblastdb -parse_seqids
                # fails on duplicate sequence IDs, so keep only the first entry
                # per allele name.
                from Bio import SeqIO
                seen_ids = set()
                kept = 0
                skipped = 0
                with open(self.database_c_clean, 'w') as out_f:
                    for record in SeqIO.parse(raw_clean, 'fasta'):
                        if record.id not in seen_ids:
                            seen_ids.add(record.id)
                            SeqIO.write(record, out_f, 'fasta')
                            kept += 1
                        else:
                            skipped += 1
                self.emit.log("info", f"C gene database: kept {kept} unique alleles, removed {skipped} duplicate entries")
                
                # Remove temp file
                try:
                    os.remove(raw_clean)
                except:
                    pass
            except Exception as e:
                self.emit.log("warn", f"C gene cleaning failed, isotype will be unavailable: {e}")
                self.database_c_clean = None
        else:
            self.database_c_clean = None
        
        self.emit.log("info", "Database files cleaned and ready")
        return True
    
    def combine_fasta_files(self) -> bool:
        """Combine all FASTA files into one, adding a unique numeric suffix per file."""
        self.emit.progress("combining", 18, "Combining FASTA files...")
        
        self.combined_fasta = os.path.join(self.output_dir, 'combined.fasta')
        
        # Assign a unique numeric ID to each input file (starting at 1001 to avoid
        # collisions with contig numbers like _1, _2, _3 that already exist in headers).
        self.file_id_mapping = {}   # numeric_id (str) -> filename
        self.filename_to_id = {}    # filename -> numeric_id (str)
        
        with open(self.combined_fasta, 'w') as outfile:
            for idx, fasta_path in enumerate(self.fasta_paths):
                file_id = str(1001 + idx)
                base = os.path.basename(fasta_path)
                self.file_id_mapping[file_id] = base
                self.filename_to_id[base] = file_id
                
                with open(fasta_path, 'r') as infile:
                    for line in infile:
                        if line.startswith('>'):
                            # Append _XXXX numeric suffix (same approach as reference pipeline)
                            outfile.write(line.rstrip() + '_' + file_id + '\n')
                        else:
                            outfile.write(line)
        
        # Persist the mapping so downstream steps can resolve file IDs back to filenames
        mapping_path = os.path.join(self.output_dir, 'file_id_mapping.json')
        with open(mapping_path, 'w') as f:
            json.dump(self.file_id_mapping, f, indent=2)
        
        self.emit.log("info", f"Combined {len(self.fasta_paths)} files into {self.combined_fasta}")
        self.emit.log("info", f"File ID mapping: {self.file_id_mapping}")
        return True
    
    def load_timepoint_mapping(self) -> bool:
        """Load timepoint_mapping.json if present in the output or staging directory."""
        tp_path = os.path.join(self.output_dir, 'timepoint_mapping.json')
        if not os.path.exists(tp_path):
            # Try staging dir (fasta_dir)
            tp_path = os.path.join(self.fasta_dir, 'timepoint_mapping.json')
        
        if os.path.exists(tp_path):
            with open(tp_path, 'r') as f:
                self.timepoint_mapping = json.load(f)
            # Build ordered list of unique timepoint labels (preserving insertion order)
            seen = set()
            self.timepoint_labels = []
            for entry in self.timepoint_mapping.values():
                tp = entry['timepoint']
                if tp not in seen:
                    seen.add(tp)
                    self.timepoint_labels.append(tp)
            self.emit.log("info", f"Loaded timepoint mapping: {len(self.timepoint_mapping)} files across {len(self.timepoint_labels)} timepoints: {self.timepoint_labels}")
            return True
        else:
            self.emit.log("info", "No timepoint_mapping.json found, running single-cohort mode")
            return False
    
    def split_db_pass_by_timepoint(self) -> Dict[str, str]:
        """Split the global db-pass TSV by timepoint.
        
        Returns dict of tp_label -> path to per-timepoint db-pass TSV.
        """
        import pandas as pd
        
        self._ensure_file_id_mapping()
        
        db_pass_path = os.path.join(self.output_dir, "ig_out_data_db-pass.tsv")
        if not os.path.exists(db_pass_path):
            self.emit.log("error", "db-pass.tsv not found for splitting")
            return {}
        
        df = pd.read_table(db_pass_path)

        # Filter for heavy chain (IGH) only, light chains (IGK/IGL) don't have
        # meaningful clonal definitions or isotype switching
        if 'locus' in df.columns:
            total_before = len(df)
            df = df[df['locus'] == 'IGH'].copy()
            self.emit.log("info", f"Filtered for IGH locus: {total_before} -> {len(df)} sequences (dropped {total_before - len(df)} light chain)")

        self.emit.log("info", f"Splitting {len(df)} sequences from db-pass.tsv by timepoint")
        
        # Build numeric_id -> timepoint mapping.
        # file_id_mapping holds the basenames the pipeline actually combined, which
        # carry a '_clean' suffix when clean_fasta is on, while timepoint_mapping is
        # keyed by the original staged names. Match on a normalised form so the
        # cleaned run still resolves.
        def _tp_key(name: str) -> str:
            stem, ext = os.path.splitext(name)
            if stem.endswith('_clean'):
                stem = stem[:-len('_clean')]
            return stem + ext

        normalised_tp = {_tp_key(k): v for k, v in self.timepoint_mapping.items()}

        id_to_tp = {}
        for num_id, filename in self.file_id_mapping.items():
            entry = self.timepoint_mapping.get(filename) or normalised_tp.get(_tp_key(filename))
            if entry:
                id_to_tp[num_id] = entry['timepoint']
            else:
                self.emit.log("warn", f"File {filename} (id={num_id}) not found in timepoint mapping")
        
        # Assign timepoint to each row based on sequence_id suffix
        def get_timepoint(seq_id):
            parts = str(seq_id).rsplit('_', 1)
            if len(parts) == 2 and parts[1] in id_to_tp:
                return id_to_tp[parts[1]]
            return None
        
        df['_timepoint'] = df['sequence_id'].apply(get_timepoint)
        
        per_tp_dir = os.path.join(self.output_dir, 'per_timepoint')
        os.makedirs(per_tp_dir, exist_ok=True)
        
        tp_paths = {}
        for tp_label in self.timepoint_labels:
            tp_dir = os.path.join(per_tp_dir, tp_label)
            os.makedirs(tp_dir, exist_ok=True)
            
            tp_df = df[df['_timepoint'] == tp_label].drop(columns=['_timepoint'])
            tp_path = os.path.join(tp_dir, 'db-pass.tsv')
            tp_df.to_csv(tp_path, sep='\t', index=False)
            tp_paths[tp_label] = tp_path
            self.emit.log("info", f"  {tp_label}: {len(tp_df)} sequences -> {tp_path}")
        
        # Log any unmapped sequences
        unmapped = df[df['_timepoint'].isna()]
        if len(unmapped) > 0:
            self.emit.log("warn", f"  {len(unmapped)} sequences could not be mapped to a timepoint")
        
        return tp_paths
    
    def build_blast_databases(self) -> bool:
        """Build BLAST databases from cleaned database files."""
        self.emit.progress("blast_db", 20, "Building BLAST databases...")
        
        makeblastdb_path = find_igblast_binary(self.bin_dir, 'makeblastdb')
        db_files_dir = os.path.join(self.data_dir, 'Database-Files')
        os.makedirs(db_files_dir, exist_ok=True)
        
        import subprocess
        
        for db_type, clean_path in [('V', self.database_v_clean), ('D', self.database_d_clean), ('J', self.database_j_clean)]:
            db_name = os.path.basename(clean_path)
            db_out = os.path.join(db_files_dir, db_name)
            
            # List form, no shell: any of these paths may contain spaces.
            result = subprocess.run(
                [makeblastdb_path, '-parse_seqids', '-dbtype', 'nucl', '-in', clean_path, '-out', db_out],
                capture_output=True, text=True
            ).returncode

            if result != 0:
                self.emit.log("warn", f"makeblastdb for {db_type} returned non-zero exit code")
            
            # Store the database path for later use
            setattr(self, f'igblast_db_{db_type.lower()}', db_out)
        
        # Build C gene BLAST database if available
        if getattr(self, 'database_c_clean', None) and os.path.exists(self.database_c_clean):
            cname = os.path.basename(self.database_c_clean)
            db_out = os.path.join(db_files_dir, cname)
            result = subprocess.run(
                [makeblastdb_path, '-parse_seqids', '-dbtype', 'nucl', '-in', self.database_c_clean, '-out', db_out],
                capture_output=True, text=True
            ).returncode
            if result != 0:
                self.emit.log("warn", "makeblastdb for C returned non-zero exit code")
            else:
                self.igblast_db_c = db_out
                self.emit.log("info", "C gene BLAST database built for isotype annotation")
        
        self.emit.log("info", "BLAST databases built successfully")
        return True
    
    def run_igblast(self) -> bool:
        """Run IgBLAST analysis."""
        self.emit.progress("igblast", 25, "Running IgBLAST analysis...")
        
        try:
            db_c = getattr(self, 'igblast_db_c', None)
            version = self._get_igblast_version()
            if version and version < (1, 18, 0):
                db_c = None
            df, raw_output = blast.blast_get_top_hits_v(
                input_fp=self.combined_fasta,
                db_V_fp=self.igblast_db_v,
                db_D_fp=self.igblast_db_d,
                db_J_fp=self.igblast_db_j,
                organism=self.species,
                bin_dir=self.bin_dir,
                data_dir=self.data_dir,
                output_dir=self.output_dir,
                db_C_fp=db_c
            )
            
            # Save results
            outdata_path = os.path.join(self.output_dir, 'outdata.csv')
            df.to_csv(outdata_path)
            
            self.emit.log("info", f"IgBLAST analysis complete, found {len(df)} hits")
            self.emit.result("igblast_output", path=outdata_path)
            
            self.blast_df = df
            return True
            
        except Exception as e:
            self.emit.log("error", f"IgBLAST failed: {str(e)}")
            return False
    
    def calculate_thresholds(self) -> Optional[Dict[str, float]]:
        """Calculate distance thresholds - per timepoint if mapping available, else single global.
        
        Returns dict of tp_label -> threshold, or {'_global': threshold} for single-cohort mode.
        """
        self.emit.progress("threshold", 35, "Calculating distance threshold...")
        
        try:
            # Run MakeDb first (global)
            fmt7_path = os.path.join(self.output_dir, "ig_out_data.fmt7")
            db_pass_path = os.path.join(self.output_dir, "ig_out_data_db-pass.tsv")
            
            import utils.clonalityFunctions as clonalityFunctions
            original_outs_dir = clonalityFunctions.outs_dir
            clonalityFunctions.outs_dir = self.output_dir
            
            try:
                make_db(fmt7_path, self.database_j, self.database_v, self.database_d, self.combined_fasta)
            finally:
                clonalityFunctions.outs_dir = original_outs_dir

            # Filter db-pass for heavy chain (IGH) only, clone definition and threshold
            # calculation should only consider heavy chains
            import pandas as pd
            db_df = pd.read_table(db_pass_path)
            if 'locus' in db_df.columns:
                total_before = len(db_df)
                db_df = db_df[db_df['locus'] == 'IGH']
                db_df.to_csv(db_pass_path, sep='\t', index=False)
                self.emit.log("info", f"Filtered db-pass for IGH locus: {total_before} -> {len(db_df)} sequences (dropped {total_before - len(db_df)} light chain)")

            script_path = os.path.join(self.backend_dir, 'scripts', 'calculateDistribution.R')
            
            # Per-timepoint mode
            if self.timepoint_labels:
                self.emit.log("info", f"Calculating thresholds per timepoint: {self.timepoint_labels}")
                tp_paths = self.split_db_pass_by_timepoint()
                
                timepoint_thresholds = []
                for tp_label in self.timepoint_labels:
                    tp_db_path = tp_paths.get(tp_label)
                    if not tp_db_path or not os.path.exists(tp_db_path):
                        self.emit.log("warn", f"No db-pass for timepoint {tp_label}, using default 0.1")
                        timepoint_thresholds.append({"label": tp_label, "calculated": 0.1})
                        continue

                    tp_dir = os.path.dirname(tp_db_path)
                    plot_path = os.path.join(tp_dir, 'distributionPlot.png')

                    self.emit.progress("threshold", 35, f"Calculating threshold for {tp_label}...")
                    calculated_dist = findDist(tp_db_path, pathToScript=script_path, pathToPlot=plot_path)
                    self.emit.log("info", f"  {tp_label}: calculated threshold = {calculated_dist}")
                    tp_entry = {"label": tp_label, "calculated": calculated_dist}
                    # Embed the distribution plot as base64 if it was generated
                    if os.path.exists(plot_path):
                        try:
                            with open(plot_path, 'rb') as f:
                                tp_entry["plot_base64"] = base64.b64encode(f.read()).decode('ascii')
                        except Exception as e:
                            self.emit.log("warn", f"Could not read distribution plot for {tp_label}: {e}")
                    timepoint_thresholds.append(tp_entry)

                # Emit batched threshold request
                NDJSONEmitter.emit({
                    "type": "threshold_request",
                    "timepoint_thresholds": timepoint_thresholds
                })
            else:
                # Single-cohort mode (backward compat)
                plot_path = os.path.join(self.output_dir, 'distributionPlot.png')
                calculated_dist = findDist(db_pass_path, pathToScript=script_path, pathToPlot=plot_path)
                self.emit.log("info", f"Calculated distance threshold: {calculated_dist}")

                # Embed the distribution plot as base64 if it was generated
                plot_b64 = None
                if os.path.exists(plot_path):
                    try:
                        with open(plot_path, 'rb') as f:
                            plot_b64 = base64.b64encode(f.read()).decode('ascii')
                    except Exception as e:
                        self.emit.log("warn", f"Could not read distribution plot: {e}")

                NDJSONEmitter.emit({
                    "type": "threshold_request",
                    "calculated": calculated_dist,
                    "timepoint_thresholds": [{"label": "_global", "calculated": calculated_dist, **({"plot_base64": plot_b64} if plot_b64 else {})}]
                })
            
            self.emit.log("info", "Waiting for threshold response from user...")
            sys.stdout.flush()
            
            # Wait for response from stdin
            try:
                response_line = sys.stdin.readline()
                self.emit.log("debug", f"Received line from stdin: {response_line[:100] if response_line else 'None'}")
            except Exception as e:
                self.emit.log("error", f"Error reading from stdin: {str(e)}")
                response_line = None
            
            if response_line:
                try:
                    response = json.loads(response_line.strip())
                    self.emit.log("info", f"Parsed threshold response: {response}")
                    if response.get('type') == 'threshold_response':
                        # New format: {thresholds: {T1: 0.12, T2: 0.15, ...}}
                        if 'thresholds' in response:
                            thresholds = {k: float(v) for k, v in response['thresholds'].items()}
                            self.emit.log("info", f"Using per-timepoint thresholds: {thresholds}")
                            return thresholds
                        # Legacy format: {value: 0.12}
                        elif 'value' in response:
                            val = float(response['value'])
                            self.emit.log("info", f"Using single threshold value: {val}")
                            return {'_global': val}
                    elif response.get('type') == 'cancel':
                        self.cancelled = True
                        self.emit.log("info", "User cancelled threshold confirmation")
                        return None
                except json.JSONDecodeError as e:
                    self.emit.log("warn", f"Failed to parse threshold response JSON: {response_line[:100]}, error: {str(e)}")
            
            # Fallback: use calculated values
            if self.timepoint_labels:
                fallback = {}
                for item in timepoint_thresholds:
                    fallback[item['label']] = item['calculated']
                self.emit.log("info", f"No valid response, using calculated thresholds: {fallback}")
                return fallback
            else:
                self.emit.log("info", f"No valid response, using calculated threshold: {calculated_dist}")
                return {'_global': calculated_dist}
            
        except Exception as e:
            self.emit.log("error", f"Threshold calculation failed: {str(e)}")
            if self.timepoint_labels:
                return {tp: 0.1 for tp in self.timepoint_labels}
            return {'_global': 0.1}
    
    def _restore_d_gene_fields(self, db_pass_path: str, clone_pass_path: str):
        """Restore D-gene alignment fields that DefineClones.py strips.
        
        DefineClones zeroes out d_sequence_start/end, d_germline_start/end, and
        np2_length for sequences with D gene calls. These fields are needed by
        CreateGermlines to properly reconstruct heavy chain germlines.
        """
        import pandas as pd
        if not os.path.exists(db_pass_path) or not os.path.exists(clone_pass_path):
            return
        
        db_df = pd.read_table(db_pass_path)
        cp_df = pd.read_table(clone_pass_path)
        
        d_fields = ['d_sequence_start', 'd_sequence_end', 'd_germline_start',
                     'd_germline_end', 'np2_length']
        
        available = [f for f in d_fields if f in db_df.columns and f in cp_df.columns]
        if not available:
            return
        
        db_lookup = db_df.set_index('sequence_id')[available]
        restored = 0
        for col in available:
            mask = cp_df[col].isna()
            if mask.any():
                cp_df.loc[mask, col] = cp_df.loc[mask, 'sequence_id'].map(db_lookup[col])
                restored += mask.sum()
        
        if restored > 0:
            cp_df.to_csv(clone_pass_path, sep='\t', index=False)
            self.emit.log("info", f"  Restored {restored} D-gene field values in clone-pass")

    def _rescue_dropped_sequences(self, clone_pass_path: str, germ_pass_path: str, label: str):
        """Add sequences dropped by CreateGermlines back into germ-pass.
        
        CreateGermlines fails on most heavy chains due to D-gene germline
        reconstruction issues. For these sequences, the MakeDb-generated
        germline_alignment (already in clone-pass) is valid and identical
        to what CreateGermlines would produce, so we use it directly.
        """
        import pandas as pd
        if not os.path.exists(clone_pass_path):
            return
        
        cp_df = pd.read_table(clone_pass_path)
        
        if os.path.exists(germ_pass_path):
            gp_df = pd.read_table(germ_pass_path)
        else:
            gp_df = pd.DataFrame(columns=cp_df.columns)
        
        gp_ids = set(gp_df['sequence_id']) if 'sequence_id' in gp_df.columns else set()
        dropped = cp_df[~cp_df['sequence_id'].isin(gp_ids)].copy()
        
        if len(dropped) == 0:
            return
        
        # Only rescue sequences that have both germline_alignment and sequence_alignment
        # with matching lengths (these are the ones MakeDb processed correctly)
        if 'germline_alignment' not in dropped.columns or 'sequence_alignment' not in dropped.columns:
            return
        
        valid_mask = (
            dropped['germline_alignment'].notna() &
            dropped['sequence_alignment'].notna() &
            (dropped['germline_alignment'].str.len() == dropped['sequence_alignment'].str.len())
        )
        rescuable = dropped[valid_mask].copy()
        
        if len(rescuable) == 0:
            return
        
        # Add the columns CreateGermlines would produce
        rescuable['germline_alignment_d_mask'] = rescuable['germline_alignment']
        if 'v_call' in rescuable.columns:
            rescuable['germline_v_call'] = rescuable['v_call']
        if 'd_call' in rescuable.columns:
            rescuable['germline_d_call'] = rescuable['d_call']
        if 'j_call' in rescuable.columns:
            rescuable['germline_j_call'] = rescuable['j_call']
        
        # Ensure column alignment with germ-pass
        for col in gp_df.columns:
            if col not in rescuable.columns:
                rescuable[col] = pd.NA
        
        combined = pd.concat([gp_df, rescuable[gp_df.columns]], ignore_index=True)
        combined.to_csv(germ_pass_path, sep='\t', index=False)
        
        self.emit.log("info", f"  {label}: rescued {len(rescuable)} sequences dropped by CreateGermlines "
                       f"(total germ-pass: {len(gp_df)} -> {len(combined)})")

    def run_clonality_analysis(self, thresholds: Dict[str, float]) -> bool:
        """Run clonality analysis - per timepoint if mapping available, else single global.
        
        Args:
            thresholds: dict of tp_label -> threshold value (or {'_global': value} for single cohort)
        """
        self.emit.progress("clonality", 50, "Running clonality analysis...")
        
        try:
            import pandas as pd
            import utils.clonalityFunctions as clonalityFunctions
            original_outs_dir = clonalityFunctions.outs_dir
            
            # Single-cohort mode (backward compat)
            if '_global' in thresholds or not self.timepoint_labels:
                threshold = thresholds.get('_global', list(thresholds.values())[0])
                clonalityFunctions.outs_dir = self.output_dir
                try:
                    db_pass_path = os.path.join(self.output_dir, "ig_out_data_db-pass.tsv")
                    clone_pass_path = os.path.join(self.output_dir, "ig_out_data_db-pass_clone-pass.tsv")

                    self.emit.log("info", f"Clone definition (single cohort): mode={self.clone_mode}, linkage={self.linkage_method}, threshold={threshold}")
                    define_clonality(db_pass_path, str(threshold), mode=self.clone_mode, link=self.linkage_method)
                    self._restore_d_gene_fields(db_pass_path, clone_pass_path)
                    create_germline(clone_pass_path, self.database_v, self.database_d, self.database_j)
                    
                    germ_pass_path = os.path.join(self.output_dir, "ig_out_data_db-pass_clone-pass_germ-pass.tsv")
                    self._rescue_dropped_sequences(clone_pass_path, germ_pass_path, "global")
                    self.emit.log("info", "Clonality analysis complete (single cohort)")
                finally:
                    clonalityFunctions.outs_dir = original_outs_dir
                
                germ_pass_path = os.path.join(self.output_dir, "ig_out_data_db-pass_clone-pass_germ-pass.tsv")
                self.emit.result("clonality_output", path=germ_pass_path)
                return True
            
            # Per-timepoint mode
            self.emit.log("info", f"Running per-timepoint clonality for {len(self.timepoint_labels)} timepoints")
            per_tp_dir = os.path.join(self.output_dir, 'per_timepoint')
            
            all_germ_dfs = []
            all_clone_dfs = []
            clone_id_offset = 0
            
            for tp_idx, tp_label in enumerate(self.timepoint_labels):
                tp_dir = os.path.join(per_tp_dir, tp_label)
                threshold = thresholds.get(tp_label, 0.1)
                
                db_pass_path = os.path.join(tp_dir, 'db-pass.tsv')
                if not os.path.exists(db_pass_path):
                    self.emit.log("warn", f"No db-pass.tsv for timepoint {tp_label}, skipping")
                    continue
                
                self.emit.progress("clonality", 50 + int(tp_idx / len(self.timepoint_labels) * 15),
                                   f"Defining clones for {tp_label}...")
                self.emit.log("info", f"  {tp_label}: threshold={threshold}, mode={self.clone_mode}, linkage={self.linkage_method}")
                
                # Point clonalityFunctions to the per-timepoint dir
                clonalityFunctions.outs_dir = tp_dir
                try:
                    define_clonality(db_pass_path, str(threshold), mode=self.clone_mode, link=self.linkage_method)
                    
                    clone_pass_path = os.path.join(tp_dir, 'db-pass_clone-pass.tsv')
                    if not os.path.exists(clone_pass_path):
                        self.emit.log("warn", f"  {tp_label}: clone-pass.tsv not created, skipping germline")
                        continue
                    
                    # DefineClones strips D-gene alignment fields (d_sequence_start/end,
                    # d_germline_start/end, np2_length). Restore them from db-pass so
                    # CreateGermlines can reconstruct heavy chain germlines properly.
                    self._restore_d_gene_fields(db_pass_path, clone_pass_path)
                    
                    create_germline(clone_pass_path, self.database_v, self.database_d, self.database_j)
                    
                    # Rescue heavy chains dropped by CreateGermlines: their MakeDb
                    # germline_alignment is already valid, so we can add them back.
                    germ_pass_path = os.path.join(tp_dir, 'db-pass_clone-pass_germ-pass.tsv')
                    self._rescue_dropped_sequences(clone_pass_path, germ_pass_path, tp_label)
                    
                    # Read clone-pass (ALL sequences with clone_id) and remap IDs
                    tp_clone_df = pd.read_table(clone_pass_path)
                    tp_offset = clone_id_offset
                    
                    if 'clone_id' in tp_clone_df.columns:
                        valid_ids = tp_clone_df['clone_id'].dropna()
                        if len(valid_ids) > 0:
                            max_id = int(valid_ids.max())
                            tp_clone_df['clone_id'] = tp_clone_df['clone_id'].apply(
                                lambda x: int(x) + tp_offset if pd.notna(x) else x
                            )
                            clone_id_offset += max_id + 1
                    
                    tp_clone_df['timepoint'] = tp_label
                    tp_clone_df.to_csv(clone_pass_path, sep='\t', index=False)
                    all_clone_dfs.append(tp_clone_df)
                    
                    # Read germ-pass (now includes rescued sequences)
                    germ_count = 0
                    if os.path.exists(germ_pass_path):
                        tp_germ_df = pd.read_table(germ_pass_path)
                        if 'clone_id' in tp_germ_df.columns:
                            tp_germ_df['clone_id'] = tp_germ_df['clone_id'].apply(
                                lambda x: int(x) + tp_offset if pd.notna(x) else x
                            )
                        tp_germ_df['timepoint'] = tp_label
                        tp_germ_df.to_csv(germ_pass_path, sep='\t', index=False)
                        all_germ_dfs.append(tp_germ_df)
                        germ_count = len(tp_germ_df)
                    else:
                        self.emit.log("warn", f"  {tp_label}: germ-pass.tsv not created")
                    
                    self.emit.log("info", f"  {tp_label}: {len(tp_clone_df)} clone-pass, "
                                  f"{germ_count} germ-pass sequences")
                    
                finally:
                    clonalityFunctions.outs_dir = original_outs_dir
            
            if not all_clone_dfs:
                self.emit.log("error", "No timepoints produced clonality results")
                return False
            
            # Merge all per-timepoint clone-pass TSVs
            merged_clone_df = pd.concat(all_clone_dfs, ignore_index=True)
            merged_clone_path = os.path.join(self.output_dir, "ig_out_data_db-pass_clone-pass.tsv")
            merged_clone_df.to_csv(merged_clone_path, sep='\t', index=False)
            self.emit.log("info", f"Merged clone-pass: {len(merged_clone_df)} total sequences")
            
            # Merge all per-timepoint germ-pass TSVs
            if all_germ_dfs:
                merged_df = pd.concat(all_germ_dfs, ignore_index=True)
            else:
                merged_df = pd.DataFrame()
            merged_path = os.path.join(self.output_dir, "ig_out_data_db-pass_clone-pass_germ-pass.tsv")
            merged_df.to_csv(merged_path, sep='\t', index=False)
            
            self.emit.log("info", f"Merged germ-pass: {len(merged_df)} total sequences from {len(all_germ_dfs)} timepoints")
            self.emit.log("info", f"Clone ID offset after merge: {clone_id_offset} (globally unique)")
            self.emit.result("clonality_output", path=merged_path)
            
            return True
            
        except Exception as e:
            self.emit.log("error", f"Clonality analysis failed: {str(e)}")
            traceback.print_exc()
            return False
    
    def build_cross_timepoint_lineages(self) -> bool:
        """Match clones across timepoints by V-gene + J-gene + CDR3 AA similarity.
        
        Assigns a lineage_id to each sequence. Clones from different timepoints that share
        the same V-gene family, J-gene, and CDR3 AA sequence (>=85% similarity) get the same
        lineage_id, enabling cross-timepoint tracking.
        """
        if not self.timepoint_labels or len(self.timepoint_labels) < 2:
            self.emit.log("info", "Skipping cross-timepoint lineage mapping (< 2 timepoints)")
            return True
        
        self.emit.progress("lineage", 67, "Building cross-timepoint lineage map...")
        
        try:
            import pandas as pd
            
            merged_path = os.path.join(self.output_dir, "ig_out_data_db-pass_clone-pass_germ-pass.tsv")
            if not os.path.exists(merged_path):
                self.emit.log("warn", "Merged germ-pass not found, skipping lineage mapping")
                return True
            
            df = pd.read_table(merged_path)
            
            if 'timepoint' not in df.columns or 'clone_id' not in df.columns:
                self.emit.log("warn", "Missing timepoint/clone_id columns, skipping lineage mapping")
                return True
            
            # Build representative clone profiles: one entry per (timepoint, clone_id)
            # with the consensus V-gene family, J-gene, and CDR3 AA
            clone_profiles = []
            for (tp, cid), group in df.groupby(['timepoint', 'clone_id']):
                if pd.isna(cid):
                    continue
                
                v_call = group['v_call'].dropna().mode()
                j_call = group['j_call'].dropna().mode()
                junction_aa = group['junction_aa'].dropna().mode()
                
                v_fam = str(v_call.iloc[0]).split('*')[0] if len(v_call) > 0 else ''
                j_gene = str(j_call.iloc[0]).split('*')[0] if len(j_call) > 0 else ''
                cdr3_aa = str(junction_aa.iloc[0]) if len(junction_aa) > 0 else ''
                
                if v_fam and j_gene and cdr3_aa and cdr3_aa != 'nan':
                    clone_profiles.append({
                        'timepoint': tp,
                        'clone_id': int(cid),
                        'v_family': v_fam,
                        'j_gene': j_gene,
                        'cdr3_aa': cdr3_aa,
                        'size': len(group)
                    })
            
            self.emit.log("info", f"Built {len(clone_profiles)} clone profiles for lineage matching")
            
            # Match clones across timepoints using V+J+CDR3 AA hamming distance
            # Consistent with DefineClones which uses normalized hamming distance
            def cdr3_similarity(s1, s2):
                if not s1 or not s2:
                    return 0.0
                # Require same length for hamming distance (different CDR3 lengths
                # are very unlikely to be from the same rearrangement)
                if len(s1) != len(s2):
                    return 0.0
                if len(s1) == 0:
                    return 1.0
                mismatches = sum(1 for a, b in zip(s1, s2) if a != b)
                return 1.0 - (mismatches / len(s1))
            
            # Union-Find for grouping matched clones
            parent = {}
            def find(x):
                while parent.get(x, x) != x:
                    parent[x] = parent.get(parent[x], parent[x])
                    x = parent[x]
                return x
            def union(a, b):
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[ra] = rb
            
            # Compare clones across different timepoints
            for i in range(len(clone_profiles)):
                for j in range(i + 1, len(clone_profiles)):
                    pi, pj = clone_profiles[i], clone_profiles[j]
                    if pi['timepoint'] == pj['timepoint']:
                        continue  # Only match across timepoints
                    if pi['v_family'] != pj['v_family']:
                        continue
                    if pi['j_gene'] != pj['j_gene']:
                        continue
                    sim = cdr3_similarity(pi['cdr3_aa'], pj['cdr3_aa'])
                    if sim >= 0.85:
                        union(pi['clone_id'], pj['clone_id'])
            
            # Assign lineage IDs
            lineage_map = {}  # clone_id -> lineage_id
            lineage_counter = 1
            root_to_lineage = {}
            
            for profile in clone_profiles:
                root = find(profile['clone_id'])
                if root not in root_to_lineage:
                    root_to_lineage[root] = lineage_counter
                    lineage_counter += 1
                lineage_map[profile['clone_id']] = root_to_lineage[root]
            
            # Count cross-timepoint lineages (lineages spanning >1 timepoint)
            lineage_to_tps = {}
            for profile in clone_profiles:
                lid = lineage_map.get(profile['clone_id'])
                if lid is not None:
                    if lid not in lineage_to_tps:
                        lineage_to_tps[lid] = set()
                    lineage_to_tps[lid].add(profile['timepoint'])
            
            cross_tp_lineages = {lid: tps for lid, tps in lineage_to_tps.items() if len(tps) > 1}
            self.emit.log("info", f"Found {len(cross_tp_lineages)} cross-timepoint lineages (out of {lineage_counter - 1} total)")
            
            # Add lineage_id column to merged germ-pass
            df['lineage_id'] = df['clone_id'].apply(lambda x: lineage_map.get(int(x)) if pd.notna(x) else None)
            df.to_csv(merged_path, sep='\t', index=False)
            
            # Save lineage mapping
            lineage_info = {
                'lineage_map': {str(k): v for k, v in lineage_map.items()},
                'cross_timepoint_lineages': {str(lid): list(tps) for lid, tps in cross_tp_lineages.items()},
                'total_lineages': lineage_counter - 1,
                'cross_timepoint_count': len(cross_tp_lineages)
            }
            lineage_path = os.path.join(self.output_dir, 'cross_timepoint_lineages.json')
            with open(lineage_path, 'w') as f:
                json.dump(lineage_info, f, indent=2)
            
            self.emit.log("info", "Cross-timepoint lineage mapping complete")
            return True
            
        except Exception as e:
            self.emit.log("warn", f"Cross-timepoint lineage mapping failed (non-fatal): {str(e)}")
            traceback.print_exc()
            return True  # Non-fatal
    
    def _get_igblast_version(self) -> Optional[tuple]:
        """Return (major, minor, patch) version tuple of the installed igblastn, or None."""
        import subprocess
        igblastn_path = find_igblast_binary(self.bin_dir, 'igblastn')
        if not os.path.exists(igblastn_path):
            return None
        try:
            result = subprocess.run([igblastn_path, '-version'],
                                    capture_output=True, text=True, timeout=10)
            import re
            m = re.search(r'igblastn:\s*(\d+)\.(\d+)\.(\d+)', result.stdout)
            if m:
                return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except Exception:
            pass
        return None

    def _assign_c_genes_igblast_native(self, igblast_db_c: str) -> Optional[dict]:
        """Use igblastn with -c_region_db and AIRR output to assign C genes (IgBLAST >= 1.18).

        This is the standard method: IgBLAST identifies V/D/J boundaries first,
        then searches the 3' post-J region specifically for constant genes.
        Returns c_call_map or None on failure.
        """
        import subprocess
        import pandas as pd

        igblastn_path = find_igblast_binary(self.bin_dir, 'igblastn')
        # Auxiliary data is species-specific
        aux_filename = 'mouse_gl.aux' if self.species == 'mouse' else 'human_gl.aux'
        aux_data_path = os.path.join(self.data_dir, 'optional_data', aux_filename)
        airr_out = os.path.join(self.output_dir, 'c_gene_airr.tsv')

        env = os.environ.copy()
        env['IGDATA'] = self.data_dir

        cmd = [
            igblastn_path,
            '-germline_db_V', self.igblast_db_v,
            '-germline_db_D', self.igblast_db_d,
            '-germline_db_J', self.igblast_db_j,
            '-organism', self.species,
            '-c_region_db', igblast_db_c,
            '-query', self.combined_fasta,
            '-auxiliary_data', aux_data_path,
            '-outfmt', '19',
            '-num_threads', '4',
            '-out', airr_out
        ]

        self.emit.log("info", "Running igblastn with -c_region_db (AIRR format) for C gene assignment...")
        try:
            result = subprocess.run(cmd, capture_output=True, text=True,
                                    timeout=600, cwd=os.path.dirname(self.bin_dir), env=env)
        except subprocess.TimeoutExpired:
            self.emit.log("warn", "igblastn AIRR run timed out")
            return None

        if result.returncode != 0:
            self.emit.log("warn", f"igblastn AIRR failed (rc={result.returncode}): {result.stderr[:300]}")
            return None

        if not os.path.exists(airr_out) or os.path.getsize(airr_out) == 0:
            self.emit.log("warn", "igblastn AIRR produced no output")
            return None

        try:
            airr_df = pd.read_csv(airr_out, sep='\t')
        except Exception as e:
            self.emit.log("warn", f"Failed to parse AIRR output: {e}")
            return None

        if 'c_call' not in airr_df.columns:
            self.emit.log("warn", "AIRR output missing c_call column")
            return None

        seq_id_col = 'sequence_id' if 'sequence_id' in airr_df.columns else airr_df.columns[0]

        c_call_map = {}
        for _, row in airr_df.iterrows():
            seq_id = str(row[seq_id_col])
            c_call = row.get('c_call')
            if pd.notna(c_call) and str(c_call).strip():
                c_call_map[seq_id] = str(c_call).strip()

        return c_call_map

    def _assign_c_genes_blastn_fallback(self, igblast_db_c: str) -> Optional[dict]:
        """Fallback: standalone blastn search of full sequences against C gene DB.

        Used when IgBLAST < 1.18 (no -c_region_db support).
        Standard thresholds: top hit, >= 80% identity, >= 50 nt alignment, evalue 1e-5.
        Less accurate than native IgBLAST because V/D/J regions create noise.
        """
        import subprocess
        import pandas as pd

        blastn_path = find_igblast_binary(self.bin_dir, 'blastn')
        if not os.path.exists(blastn_path):
            blastn_path = 'blastn'

        blast_out = os.path.join(self.output_dir, 'c_gene_blast.tsv')
        cmd = [
            blastn_path,
            '-query', self.combined_fasta,
            '-db', igblast_db_c,
            '-outfmt', '6 qseqid sseqid pident length',
            '-max_target_seqs', '1',
            '-max_hsps', '1',
            '-evalue', '1e-5',
            '-num_threads', '4',
            '-out', blast_out
        ]

        self.emit.log("info", f"Running blastn fallback for C gene assignment (upgrade IgBLAST to >= 1.18 for better results)...")

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            self.emit.log("warn", "blastn for C gene timed out")
            return None

        if result.returncode != 0:
            self.emit.log("warn", f"blastn for C gene failed (rc={result.returncode}): {result.stderr[:300]}")
            return None

        c_call_map = {}
        if os.path.exists(blast_out) and os.path.getsize(blast_out) > 0:
            blast_df = pd.read_csv(blast_out, sep='\t', header=None,
                                   names=['qseqid', 'sseqid', 'pident', 'length'])
            good_hits = blast_df[(blast_df['pident'] >= 80.0) & (blast_df['length'] >= 50)]
            for _, row in good_hits.iterrows():
                seq_id = str(row['qseqid'])
                if seq_id not in c_call_map:
                    c_call_map[seq_id] = str(row['sseqid'])

            self.emit.log("info",
                f"C gene assignment (blastn fallback): {len(c_call_map)}/{len(blast_df['qseqid'].unique())} "
                f"sequences passed filters (>= 80% identity, >= 50 nt)")
        else:
            self.emit.log("warn", "blastn produced no output for C gene assignment")
            return None

        return c_call_map

    def _build_tenx_c_call_map(self) -> Optional[Dict[str, str]]:
        """Build a sequence_id -> c_gene map from 10x annotations.

        The 10x c_gene map keys are original contig IDs (before the file-ID
        suffix was appended by combine_fasta_files).  Pipeline sequence IDs
        have the form ``<contig_id>_<file_id>``; we strip the known file-ID
        suffix to recover the original contig ID for lookup.
        """
        if not self.tenx_c_gene_map:
            map_path = os.path.join(self.output_dir, 'tenx_c_gene_map.json')
            if os.path.exists(map_path):
                with open(map_path) as f:
                    self.tenx_c_gene_map = json.load(f)
            if not self.tenx_c_gene_map:
                return None

        self._ensure_file_id_mapping()
        known_suffixes = set(self.file_id_mapping.keys())

        import pandas as pd
        c_call_map: Dict[str, str] = {}

        db_pass = os.path.join(self.output_dir, 'ig_out_data_db-pass.tsv')
        if os.path.exists(db_pass):
            df = pd.read_table(db_pass, usecols=['sequence_id'])
            for seq_id in df['sequence_id']:
                parts = str(seq_id).rsplit('_', 1)
                if len(parts) == 2 and parts[1] in known_suffixes:
                    contig_id = parts[0]
                else:
                    contig_id = str(seq_id)
                c_gene = self.tenx_c_gene_map.get(contig_id)
                if c_gene:
                    c_call_map[str(seq_id)] = c_gene

        return c_call_map if c_call_map else None

    def assign_c_genes(self) -> bool:
        """Assign C gene (isotype) to each sequence.

        When 10x annotation data is available (from preprocess_10x_contigs),
        the 10x c_gene is used directly, no BLAST needed.

        Otherwise, preferred method (IgBLAST >= 1.18): uses igblastn with
        -c_region_db and AIRR format output. Fallback: standalone blastn.
        """
        self.emit.progress("c_gene", 55, "Assigning isotype (C gene)...")

        try:
            import pandas as pd

            # Prefer 10x ground-truth c_gene when available
            c_call_map = self._build_tenx_c_call_map()
            if c_call_map:
                self.emit.log("info",
                    f"Using 10x c_gene annotations for {len(self.tenx_c_gene_map)} contigs "
                    f"({len(c_call_map)} sequence IDs mapped)")
            else:
                igblast_db_c = getattr(self, 'igblast_db_c', None)
                if not igblast_db_c:
                    self.emit.log("info", "No C gene database available, skipping isotype assignment")
                    return True

                if not any(os.path.exists(igblast_db_c + ext) for ext in ['.ndb', '.nin', '.nsq']):
                    self.emit.log("warn", "C gene BLAST database index files not found, skipping isotype assignment")
                    return True

                version = self._get_igblast_version()

                if version and version >= (1, 18, 0):
                    self.emit.log("info", f"IgBLAST {'.'.join(map(str, version))} supports -c_region_db, using native C gene assignment")
                    c_call_map = self._assign_c_genes_igblast_native(igblast_db_c)
                else:
                    ver_str = '.'.join(map(str, version)) if version else 'unknown'
                    self.emit.log("warn",
                        f"IgBLAST version {ver_str} < 1.18, using blastn fallback for C gene assignment. "
                        f"Upgrade IgBLAST to >= 1.18 (latest: 1.22.0) for significantly better isotype coverage.")

                if c_call_map is None:
                    c_call_map = self._assign_c_genes_blastn_fallback(igblast_db_c)

            if not c_call_map:
                self.emit.log("warn", "No sequences met C gene assignment thresholds")
                return True
            
            # Summarize isotype distribution
            from collections import Counter
            isotype_counts = Counter()
            for c_gene in c_call_map.values():
                # Extract gene family (e.g. IGHM*01 -> IGHM)
                gene_family = c_gene.split('*')[0] if '*' in c_gene else c_gene
                isotype_counts[gene_family] += 1
            self.emit.log("info", f"Isotype distribution: {dict(isotype_counts)}")
            
            # Update germ-pass TSV with c_call column
            germ_pass_path = os.path.join(self.output_dir, "ig_out_data_db-pass_clone-pass_germ-pass.tsv")
            if os.path.exists(germ_pass_path):
                df = pd.read_table(germ_pass_path)
                df['c_call'] = df['sequence_id'].map(c_call_map).fillna('')
                df.to_csv(germ_pass_path, sep='\t', index=False)
                assigned = (df['c_call'] != '').sum()
                self.emit.log("info", f"Updated {germ_pass_path}: {assigned}/{len(df)} sequences have c_call")
            
            # Also update db-pass, clone-pass, and per-timepoint clone-pass TSVs
            tsv_paths = [
                os.path.join(self.output_dir, 'ig_out_data_db-pass.tsv'),
                os.path.join(self.output_dir, 'ig_out_data_db-pass_clone-pass.tsv'),
            ]
            per_tp_dir = os.path.join(self.output_dir, 'per_timepoint')
            if os.path.isdir(per_tp_dir):
                for tp in os.listdir(per_tp_dir):
                    tp_cp = os.path.join(per_tp_dir, tp, 'db-pass_clone-pass.tsv')
                    if os.path.exists(tp_cp):
                        tsv_paths.append(tp_cp)

            for tsv_path in tsv_paths:
                if os.path.exists(tsv_path):
                    try:
                        df = pd.read_table(tsv_path)
                        df['c_call'] = df['sequence_id'].map(c_call_map).fillna('')
                        df.to_csv(tsv_path, sep='\t', index=False)
                    except Exception as e:
                        self.emit.log("warn", f"Could not update {tsv_path}: {e}")
            
            return True
            
        except Exception as e:
            self.emit.log("warn", f"C gene assignment failed (non-fatal): {str(e)}")
            return True  # Non-fatal
    
    def _build_trees_for_cohort(self, germ_pass_path: str, work_dir: str, trees_out_dir: str, label: str) -> List[int]:
        """Build trees for a single cohort (timepoint or global).
        
        Args:
            germ_pass_path: Path to the germ-pass TSV for this cohort
            work_dir: Directory for intermediate files (build-trees-input, etc.)
            trees_out_dir: Directory to write newick/png files
            label: Label for logging (e.g. 'T1' or 'global')
        
        Returns: List of clone IDs that were built
        """
        import pandas as pd
        import subprocess
        from Bio import SeqIO
        
        os.makedirs(trees_out_dir, exist_ok=True)
        
        if not os.path.exists(germ_pass_path):
            self.emit.log("warn", f"[{label}] Germline pass file not found, skipping")
            return []
        
        clonedf = pd.read_table(germ_pass_path)
        clonedf['clone_freq'] = clonedf.groupby('clone_id')['sequence_id'].transform('count')
        clonedf.sort_values('clone_freq', inplace=True, ascending=False)
        
        clone_sizes = clonedf.groupby('clone_id').size().sort_values(ascending=False)
        valid_clones = clone_sizes[clone_sizes >= 3]
        top_clones = valid_clones.head(20).index.tolist()
        
        if not top_clones:
            self.emit.log("info", f"[{label}] No clones with >= 3 sequences, skipping trees")
            return []
        
        # BuildTrees.py aborts the entire batch if any clone has inconsistent
        # germlines (different germline_alignment_d_mask within a clone). Filter
        # these out, then backfill from the next-largest clones to stay at 20.
        if 'germline_alignment_d_mask' in clonedf.columns:
            consistent_clones = []
            skipped = 0
            for cid in top_clones:
                n_unique = clonedf.loc[clonedf['clone_id'] == cid, 'germline_alignment_d_mask'].nunique()
                if n_unique <= 1:
                    consistent_clones.append(cid)
                else:
                    skipped += 1
                    self.emit.log("info", f"[{label}] Skipping clone {cid}: {n_unique} distinct germlines within clone")
            
            if skipped > 0:
                # Backfill from next-largest valid clones
                remaining = valid_clones.drop(top_clones, errors='ignore')
                for cid in remaining.index:
                    if len(consistent_clones) >= 20:
                        break
                    n_unique = clonedf.loc[clonedf['clone_id'] == cid, 'germline_alignment_d_mask'].nunique()
                    if n_unique <= 1:
                        consistent_clones.append(cid)
                
                self.emit.log("info", f"[{label}] {skipped} clones had inconsistent germlines, "
                              f"building trees for {len(consistent_clones)} clones")
                top_clones = consistent_clones
        
        if not top_clones:
            self.emit.log("info", f"[{label}] No clones with consistent germlines, skipping trees")
            return []
        
        self.emit.log("info", f"[{label}] Building trees for {len(top_clones)} clones")
        
        tempdf = clonedf[clonedf['clone_id'].isin(top_clones)].copy()
        if 'clone_freq' in tempdf.columns:
            tempdf = tempdf.drop(columns=['clone_freq'])
        
        input_tsv = os.path.join(work_dir, 'build-trees-input.tsv')
        tempdf.to_csv(input_tsv, sep="\t", index=False)
        
        # Build sequence count mapping
        sequence_counts_by_clone = {}
        combined_fasta = os.path.join(self.output_dir, 'combined.fasta')
        
        if os.path.exists(combined_fasta):
            seq_content_map = {}
            for record in SeqIO.parse(combined_fasta, "fasta"):
                seq_content = str(record.seq).upper().replace('-', '').replace('N', '')
                seq_content_map[str(record.id)] = seq_content
            
            for clone_id in top_clones:
                clone_seqs = clonedf[clonedf['clone_id'] == clone_id]
                content_counts = {}
                for _, row in clone_seqs.iterrows():
                    seq_id = str(row['sequence_id'])
                    if seq_id in seq_content_map:
                        seq_content = seq_content_map[seq_id]
                        content_counts[seq_content] = content_counts.get(seq_content, 0) + 1
                sequence_counts_by_clone[str(clone_id)] = content_counts
        
        counts_path = os.path.join(work_dir, 'sequence_counts.json')
        with open(counts_path, 'w') as f:
            json.dump(sequence_counts_by_clone, f)
        
        # Run BuildTrees.py
        build_trees_dir = os.path.join(work_dir, 'build-trees-input')
        if os.path.exists(build_trees_dir):
            import shutil
            shutil.rmtree(build_trees_dir)
        
        original_cwd = os.getcwd()
        try:
            os.chdir(work_dir)
            build_trees_result = subprocess.run(
                [find_changeo_script('BuildTrees'), '-d', 'build-trees-input.tsv', '--clean', 'all', '--collapse'],
                capture_output=True, text=True, timeout=600
            )
            if build_trees_result.returncode != 0:
                self.emit.log("warn", f"[{label}] BuildTrees.py failed: {build_trees_result.stderr[:300]}")
        finally:
            os.chdir(original_cwd)
        
        # Run R tree building script
        build_trees_r = os.path.join(backend_dir, 'scripts', 'build-trees-iqtree.R')
        r_env = os.environ.copy()
        r_cmd = find_rscript()

        result = subprocess.run(
            [r_cmd, build_trees_r, work_dir],
            capture_output=True, text=True, timeout=3600, env=r_env
        )
        
        if result.returncode != 0:
            self.emit.log("warn", f"[{label}] R tree building failed: {result.stderr[:300]}")
            return []
        
        # Move newick files from work_dir/trees/ to trees_out_dir
        work_trees = os.path.join(work_dir, 'trees')
        if os.path.isdir(work_trees):
            for f in os.listdir(work_trees):
                if f.endswith('.newick'):
                    src = os.path.join(work_trees, f)
                    dst = os.path.join(trees_out_dir, f)
                    import shutil
                    shutil.move(src, dst)
        
        tree_files = glob.glob(os.path.join(trees_out_dir, '*.newick'))
        self.emit.log("info", f"[{label}] Built {len(tree_files)} trees")
        return top_clones
    
    def build_trees(self) -> bool:
        """Build phylogenetic trees - per timepoint if mapping available, else global."""
        self.emit.log("info", "=" * 60)
        self.emit.log("info", "STARTING TREE BUILDING STEP")
        self.emit.log("info", "=" * 60)
        self.emit.progress("trees", 70, "Building phylogenetic trees...")
        
        try:
            import pandas as pd
            
            # Clean old tree directory completely
            trees_dir = os.path.join(self.output_dir, 'trees')
            if os.path.exists(trees_dir):
                import shutil
                shutil.rmtree(trees_dir)
            os.makedirs(trees_dir, exist_ok=True)
            
            if self.timepoint_labels:
                # Per-timepoint tree building
                total_trees = 0
                for tp_idx, tp_label in enumerate(self.timepoint_labels):
                    self.emit.progress("trees", 70 + int(tp_idx / len(self.timepoint_labels) * 10),
                                       f"Building trees for {tp_label}...")
                    
                    tp_dir = os.path.join(self.output_dir, 'per_timepoint', tp_label)
                    germ_path = os.path.join(tp_dir, 'db-pass_clone-pass_germ-pass.tsv')
                    tp_trees_dir = os.path.join(trees_dir, tp_label)
                    
                    clones = self._build_trees_for_cohort(germ_path, tp_dir, tp_trees_dir, tp_label)
                    total_trees += len(glob.glob(os.path.join(tp_trees_dir, '*.newick')))
                
                self.emit.log("info", f"Per-timepoint tree building complete: {total_trees} total trees across {len(self.timepoint_labels)} timepoints")
            else:
                # Single cohort mode
                germ_pass_path = os.path.join(self.output_dir, "ig_out_data_db-pass_clone-pass_germ-pass.tsv")
                self._build_trees_for_cohort(germ_pass_path, self.output_dir, trees_dir, 'global')
            
            return True
            
        except Exception as e:
            self.emit.log("warn", f"Tree building failed (non-fatal): {str(e)}")
            traceback.print_exc()
            self.emit.result("tree_images", data={"images": [], "tree_metadata": []})
            return True
    
    def visualize_trees(self) -> bool:
        """Generate tree visualizations - handles both per-timepoint and flat tree dirs."""
        self.emit.log("info", "=" * 60)
        self.emit.log("info", "STARTING TREE VISUALIZATION STEP")
        self.emit.log("info", "=" * 60)
        self.emit.progress("visualize", 85, "Generating tree visualizations...")
        
        try:
            import subprocess
            import pandas as pd
            
            trees_dir = os.path.join(self.output_dir, 'trees')
            visualize_script = os.path.join(backend_dir, 'scripts', 'visualize-tree.R')
            
            r_env = os.environ.copy()
            r_cmd = find_rscript()

            # Load clone sizes from merged germ-pass
            clone_sizes = {}
            clone_pass_path = os.path.join(self.output_dir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv')
            if os.path.exists(clone_pass_path):
                clone_df = pd.read_table(clone_pass_path)
                for cid in clone_df['clone_id'].unique():
                    if pd.notna(cid):
                        clone_sizes[int(cid)] = len(clone_df[clone_df['clone_id'] == cid])
            
            # Detect per-timepoint subdirectories
            tp_subdirs = []
            if os.path.isdir(trees_dir):
                for entry in sorted(os.listdir(trees_dir)):
                    subdir = os.path.join(trees_dir, entry)
                    if os.path.isdir(subdir) and glob.glob(os.path.join(subdir, '*.newick')):
                        tp_subdirs.append((entry, subdir))
            
            all_tree_data = []
            all_tree_images = []
            
            def process_tree_dir(tree_dir, timepoint_label=None):
                """Run visualization and collect tree metadata for one directory."""
                newick_files = glob.glob(os.path.join(tree_dir, '*.newick'))
                if not newick_files:
                    return
                
                # The visualize-tree.R script expects an outs_dir with trees/ subdir
                # We need to point it at the parent of the tree dir
                # OR create a symlink. Simpler: run it per directory.
                # The R script looks for trees/*.newick in the passed dir.
                # For per-timepoint: parent_of_tree_dir = per_timepoint/T1, trees_dir = trees/T1
                # We need a temp structure where <dir>/trees/*.newick exists.
                # Easiest: create a temp wrapper dir with symlink.
                
                # Actually, the R script just does: newick_files <- list.files(trees_dir, ...)
                # Let's just call it directly with the tree_dir path.
                # But the R script expects: args[1] = outs_dir, then looks in outs_dir/trees/
                # Let me check...
                
                # The script does: outs_dir <- args[1]; trees_dir <- file.path(outs_dir, "trees")
                # So we need to set up a temp dir where temp_dir/trees/ -> our tree_dir
                import tempfile
                tmp_wrapper = tempfile.mkdtemp()
                tmp_trees = os.path.join(tmp_wrapper, 'trees')
                os.symlink(os.path.abspath(tree_dir), tmp_trees)
                
                try:
                    result = subprocess.run(
                        [r_cmd, visualize_script, tmp_wrapper],
                        capture_output=True, text=True, timeout=300, env=r_env
                    )
                    if result.returncode != 0:
                        self.emit.log("warn", f"Visualization failed for {timepoint_label or 'global'}: {result.stderr[:300]}")
                finally:
                    # Clean up symlink and temp dir
                    try:
                        os.unlink(tmp_trees)
                        os.rmdir(tmp_wrapper)
                    except:
                        pass
                
                # Collect results
                for png_path in sorted(glob.glob(os.path.join(tree_dir, '*.png'))):
                    basename = os.path.basename(png_path)
                    newick_name = basename.replace('.png', '')
                    if not os.path.exists(os.path.join(tree_dir, newick_name + '.newick')):
                        continue
                    
                    abs_path = os.path.abspath(png_path)
                    match_str = basename.replace('tree_', '').replace('.png', '')
                    try:
                        clone_id = int(match_str)
                        clone_size = clone_sizes.get(clone_id, 0)
                    except ValueError:
                        clone_id = None
                        clone_size = 0
                    
                    entry = {
                        'path': abs_path,
                        'clone_id': clone_id,
                        'clone_size': clone_size
                    }
                    if timepoint_label:
                        entry['timepoint'] = timepoint_label
                    
                    all_tree_data.append(entry)
                    all_tree_images.append(abs_path)
            
            if tp_subdirs:
                for tp_label, subdir in tp_subdirs:
                    self.emit.progress("visualize", 85, f"Visualizing trees for {tp_label}...")
                    process_tree_dir(subdir, tp_label)
            elif glob.glob(os.path.join(trees_dir, '*.newick')):
                process_tree_dir(trees_dir)
            
            # Sort by clone size (largest first), keeping timepoint grouping
            all_tree_data.sort(key=lambda x: (x.get('timepoint', ''), -x.get('clone_size', 0)))
            all_tree_images = [d['path'] for d in all_tree_data]
            
            self.emit.log("info", f"Tree visualization complete: {len(all_tree_data)} trees total")
            
            self.emit.result("tree_images", data={
                "images": all_tree_images,
                "tree_metadata": all_tree_data
            })
            
            return True
            
        except Exception as e:
            self.emit.log("warn", f"Tree visualization failed (non-fatal): {str(e)}")
            traceback.print_exc()
            self.emit.result("tree_images", data={"images": [], "tree_metadata": []})
            return True
    
    def load_results(self) -> bool:
        """Load and emit final results."""
        self.emit.progress("results", 95, "Loading results...")
        
        try:
            import pandas as pd
            from Bio import SeqIO
            
            # Load sequence names from combined.fasta (original input sequences)
            # This matches the original GUI behavior which uses sortNames()
            sequence_names = []
            if os.path.exists(self.combined_fasta):
                for record in SeqIO.parse(self.combined_fasta, "fasta"):
                    sequence_names.append(record.id)
            
            # Load IgBLAST results
            outdata_path = os.path.join(self.output_dir, 'outdata.csv')
            if os.path.exists(outdata_path):
                blast_df = pd.read_csv(outdata_path)
                
                # Convert to records for JSON - only for sequences in combined.fasta
                sequences = []
                for query_id in sequence_names:
                    if pd.isna(query_id):
                        continue
                    
                    # IgBLAST may prefix reversed sequences with "reversed|"
                    # Try multiple matching strategies to find the sequence data
                    seq_data = blast_df[blast_df['query id'] == query_id]
                    
                    # If not found, try with "reversed|" prefix
                    if seq_data.empty:
                        seq_data = blast_df[blast_df['query id'] == f"reversed|{query_id}"]
                    
                    # If still not found, try matching without the reversed prefix
                    # (in case query_id accidentally has the prefix)
                    if seq_data.empty and query_id.startswith('reversed|'):
                        clean_id = query_id.replace('reversed|', '', 1)
                        seq_data = blast_df[blast_df['query id'] == clean_id]
                    
                    # Skip if no blast data for this sequence
                    if seq_data.empty:
                        continue
                    
                    seq_record = {
                        'id': str(query_id),
                        'name': str(query_id),
                        'v_gene': None,
                        'd_gene': None,
                        'j_gene': None,
                        'v_locus': None,
                        'd_locus': None,
                        'j_locus': None,
                        'cdr3_dna': None,
                        'cdr3_peptide': None,
                        'somatic_mutations': None,
                        'isotype': None,
                        'c_call': None
                    }
                    
                    # Extract V gene info
                    v_data = seq_data[seq_data['chain type'] == 'V']
                    if not v_data.empty:
                        row = v_data.iloc[0]
                        seq_record['v_gene'] = str(row['subject id']) if pd.notna(row['subject id']) else None
                        if seq_record['v_gene']:
                            g = seq_record['v_gene']
                            if '*' in g:
                                idx = g.index('*')
                                if len(g) > 4:
                                    seq_record['v_locus'] = g[3] + g[2] + g[4:idx]
                            if 'L' in g:
                                seq_record['isotype'] = 'Lambda'
                            elif 'K' in g:
                                seq_record['isotype'] = 'Kappa'
                            else:
                                seq_record['isotype'] = 'Heavy'
                    
                    # Extract D gene info
                    d_data = seq_data[seq_data['chain type'] == 'D']
                    if not d_data.empty:
                        row = d_data.iloc[0]
                        seq_record['d_gene'] = str(row['subject id']) if pd.notna(row['subject id']) else None
                        if seq_record['d_gene'] and '*' in seq_record['d_gene']:
                            g = seq_record['d_gene']
                            idx = g.index('*')
                            if len(g) > 4:
                                seq_record['d_locus'] = g[3] + g[2] + g[4:idx]
                    
                    # Extract J gene info
                    j_data = seq_data[seq_data['chain type'] == 'J']
                    if not j_data.empty:
                        row = j_data.iloc[0]
                        seq_record['j_gene'] = str(row['subject id']) if pd.notna(row['subject id']) else None
                        if seq_record['j_gene'] and '*' in seq_record['j_gene']:
                            g = seq_record['j_gene']
                            idx = g.index('*')
                            if len(g) > 4:
                                seq_record['j_locus'] = g[3] + g[2] + g[4:idx]
                    
                    # somatic_mutations will be computed from sequence_alignment vs
                    # germline_alignment in the clonality data below (real SHM count)

                    sequences.append(seq_record)
            
            # Load clonality data and CDR3 from the clonality TSV file
            # This is the authoritative source for CDR3 data (junction and junction_aa columns)
            clone_pass_path = os.path.join(self.output_dir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv')
            clone_data = {}
            if os.path.exists(clone_pass_path):
                clone_df = pd.read_table(clone_pass_path)
                
                # Import translation function for AA sequences
                try:
                    from utils.covid_db_matcher import translate_dna_to_aa
                except ImportError:
                    translate_dna_to_aa = None
                    self.emit.log("warn", "COVID matcher module not available, AA sequences will not be added")
                
                for _, row in clone_df.iterrows():
                    seq_id = str(row['sequence_id'])
                    clone_id = row['clone_id'] if pd.notna(row['clone_id']) else None
                    
                    # Extract CDR3 data from junction columns
                    junction = str(row['junction']) if pd.notna(row['junction']) else None
                    junction_aa = str(row['junction_aa']) if pd.notna(row['junction_aa']) else None
                    
                    # Extract full DNA sequence
                    dna_seq = str(row['sequence']) if pd.notna(row['sequence']) else None
                    
                    # Extract and translate V-J region to AA
                    aa_seq = None
                    if dna_seq and translate_dna_to_aa:
                        try:
                            v_start = int(row['v_sequence_start']) - 1 if pd.notna(row['v_sequence_start']) else 0
                            j_end = int(row['j_sequence_end']) if pd.notna(row['j_sequence_end']) else len(dna_seq)
                            vj_region = dna_seq[v_start:j_end]
                            aa_seq = translate_dna_to_aa(vj_region)
                        except Exception as e:
                            self.emit.log("debug", f"Failed to translate sequence {seq_id}: {str(e)}")
                    
                    c_call = None
                    if 'c_call' in clone_df.columns and pd.notna(row.get('c_call')):
                        val = str(row['c_call']).strip()
                        if val:  # Skip empty strings
                            c_call = val
                    lineage_id = None
                    if 'lineage_id' in clone_df.columns and pd.notna(row.get('lineage_id')):
                        lineage_id = int(row['lineage_id'])

                    # Compute real SHM: count mismatches between sequence_alignment and germline_alignment
                    shm_count = None
                    seq_align = str(row.get('sequence_alignment', '')) if pd.notna(row.get('sequence_alignment')) else ''
                    germ_align = str(row.get('germline_alignment', '')) if pd.notna(row.get('germline_alignment')) else ''
                    if seq_align and germ_align and len(seq_align) == len(germ_align):
                        mismatches = 0
                        for si, gi in zip(seq_align, germ_align):
                            if si not in ('.', 'N') and gi not in ('.', 'N') and si != gi:
                                mismatches += 1
                        shm_count = mismatches

                    clone_data[seq_id] = {
                        'clone_id': int(clone_id) if clone_id is not None else None,
                        'clone_count': len(clone_df[clone_df['clone_id'] == clone_id]) if clone_id is not None else 0,
                        'productive': True,
                        'cdr3_dna': junction,
                        'cdr3_peptide': junction_aa,
                        'dna_sequence': dna_seq,
                        'aa_sequence': aa_seq,
                        'c_call': c_call,
                        'somatic_mutations': shm_count,
                        'lineage_id': lineage_id
                    }
            
            # Supplement clone_id + c_call from merged clone-pass (heavy chains dropped by CreateGermlines)
            merged_cp_path = os.path.join(self.output_dir, 'ig_out_data_db-pass_clone-pass.tsv')
            if os.path.exists(merged_cp_path):
                cp_df = pd.read_table(merged_cp_path)
                clone_counts_cp = {}
                if 'clone_id' in cp_df.columns:
                    for cid in cp_df['clone_id'].dropna().unique():
                        clone_counts_cp[int(cid)] = int((cp_df['clone_id'] == cid).sum())
                for _, row in cp_df.iterrows():
                    seq_id = str(row['sequence_id'])
                    c_call_val = str(row['c_call']).strip() if 'c_call' in cp_df.columns and pd.notna(row.get('c_call')) and str(row['c_call']).strip() else None
                    cp_clone_id = int(row['clone_id']) if pd.notna(row.get('clone_id')) else None
                    if seq_id in clone_data:
                        if not clone_data[seq_id].get('c_call') and c_call_val:
                            clone_data[seq_id]['c_call'] = c_call_val
                        if clone_data[seq_id].get('clone_id') is None and cp_clone_id is not None:
                            clone_data[seq_id]['clone_id'] = cp_clone_id
                            clone_data[seq_id]['clone_count'] = clone_counts_cp.get(cp_clone_id, 0)
                    elif c_call_val or cp_clone_id is not None:
                        junction = str(row['junction']) if pd.notna(row.get('junction')) else None
                        junction_aa = str(row['junction_aa']) if pd.notna(row.get('junction_aa')) else None
                        clone_data[seq_id] = {
                            'clone_id': cp_clone_id,
                            'clone_count': clone_counts_cp.get(cp_clone_id, 0) if cp_clone_id else 0,
                            'productive': True,
                            'cdr3_dna': junction,
                            'cdr3_peptide': junction_aa,
                            'c_call': c_call_val,
                        }

            # Load non-productive sequences from fail file (if --failed flag was used)
            clone_fail_path = os.path.join(self.output_dir, 'ig_out_data_db-fail.tsv')
            if os.path.exists(clone_fail_path):
                self.emit.log("info", f"Loading non-productive sequences from fail file")
                fail_df = pd.read_table(clone_fail_path)
                for _, row in fail_df.iterrows():
                    seq_id = str(row['sequence_id'])
                    
                    # Extract CDR3 data from junction columns (if available)
                    junction = str(row['junction']) if pd.notna(row['junction']) else None
                    junction_aa = str(row['junction_aa']) if pd.notna(row['junction_aa']) else None
                    
                    clone_data[seq_id] = {
                        'clone_id': None,  # Non-productive sequences don't get clone IDs
                        'clone_count': 0,
                        'productive': False,  # Non-productive sequences in fail file
                        'cdr3_dna': junction,
                        'cdr3_peptide': junction_aa
                    }
                self.emit.log("info", f"Added {len(fail_df)} non-productive sequences")
            
            # Merge clone data (including CDR3 from clonality file) into sequences
            for seq in sequences:
                if seq['id'] in clone_data:
                    # Update with clonality data
                    seq.update(clone_data[seq['id']])
                    # If somatic_mutations wasn't set from blast CSV, set to None
                    if seq['somatic_mutations'] is None and seq['cdr3_dna']:
                        # Could calculate from junction_length if needed
                        pass
            
            # Group sequences by file using the numeric suffix -> filename mapping
            file_groups = {}
            for seq in sequences:
                filename = self.resolve_filename(seq['id'])
                if filename not in file_groups:
                    file_groups[filename] = []
                file_groups[filename].append(seq)
            
            # Emit results (include file_id_mapping for ID→filename lookup in UI)
            self.emit.result("sequences", data={
                "sequences": sequences,
                "file_groups": file_groups,
                "total_count": len(sequences),
                "output_dir": self.output_dir,
                "file_id_mapping": self.file_id_mapping,
                "fasta_dir": self.fasta_dir
            })
            
            return True
            
        except Exception as e:
            self.emit.log("error", f"Failed to load results: {str(e)}")
            traceback.print_exc()
            return False
    
    def run_dl_clustering(self) -> bool:
        """Run deep learning-based clustering on CDR3 sequences."""
        if not DL_CLUSTERING_AVAILABLE:
            self.emit.log("info", "Deep learning clustering not available, skipping")
            return False
        
        self.emit.progress("dl_clustering", 98, "Running deep learning clustering...")
        
        try:
            import pandas as pd
            from Bio import SeqIO
            
            # Use HuggingFace pre-trained DNABERT-2 model
            # The local finetuned model is incomplete (only .part file)
            model_name = "zhihan1996/DNABERT-2-117M"
            
            self.emit.log("info", f"Using DNABERT-2 model: {model_name}")
            self.emit.log("info", "Note: First run will download the model (~500MB)")
            
            # Get sequences from combined.fasta
            if not os.path.exists(self.combined_fasta):
                self.emit.log("warn", "Combined FASTA not found, skipping DL clustering")
                return False
            
            # Read sequence IDs and CDR3 sequences from clonality output
            clone_pass_path = os.path.join(self.output_dir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv')
            if not os.path.exists(clone_pass_path):
                self.emit.log("warn", "Clonality output not found, skipping DL clustering")
                return False
            
            # Load clonality data
            clonality_df = pd.read_table(clone_pass_path)
            
            # Extract sequences with CDR3 data
            sequences_with_ids = []
            for _, row in clonality_df.iterrows():
                if pd.notna(row.get('junction')) and row.get('junction'):
                    seq_id = str(row['sequence_id'])
                    cdr3_seq = str(row['junction'])
                    sequences_with_ids.append((seq_id, cdr3_seq))
            
            if not sequences_with_ids:
                self.emit.log("warn", "No CDR3 sequences found for DL clustering")
                return False
            
            self.emit.log("info", f"Running DL clustering on {len(sequences_with_ids)} sequences...")
            
            # Run DL clustering
            cluster_mapping = dl_clustering.run_dl_clustering(
                sequences_with_ids,
                model_dir=model_name,  # HuggingFace model name
                threshold=0.00015,  # Default threshold from demo
                distance_type='cosine'
            )
            
            if not cluster_mapping:
                self.emit.log("warn", "DL clustering returned no results")
                return False
            
            # Get clone counts
            clone_counts = dl_clustering.get_clone_counts(cluster_mapping)
            
            # Create DL clustering results (same format as traditional results, but with DL clone IDs)
            dl_sequences = []
            for seq_id, dl_clone_id in cluster_mapping.items():
                # Find the original sequence data
                original_seq = None
                for record in SeqIO.parse(self.combined_fasta, "fasta"):
                    if record.id == seq_id:
                        original_seq = record
                        break
                
                if not original_seq:
                    continue
                
                # Get data from clonality file
                seq_clonality_data = clonality_df[clonality_df['sequence_id'] == seq_id]
                
                seq_record = {
                    'id': seq_id,
                    'name': seq_id,
                    'v_gene': None, 'd_gene': None, 'j_gene': None,
                    'v_locus': None, 'd_locus': None, 'j_locus': None,
                    'cdr3_dna': None, 'cdr3_peptide': None, 'somatic_mutations': None,
                    'isotype': None, 'c_call': None,
                    'clone_id': dl_clone_id,
                    'clone_count': clone_counts.get(seq_id, 0),
                    'productive': True
                }
                
                # Copy CDR3 and other data from clonality output
                if not seq_clonality_data.empty:
                    row = seq_clonality_data.iloc[0]
                    seq_record['cdr3_dna'] = str(row['junction']) if pd.notna(row['junction']) else None
                    seq_record['cdr3_peptide'] = str(row['junction_aa']) if pd.notna(row['junction_aa']) else None
                    seq_record['v_gene'] = str(row['v_call']) if pd.notna(row.get('v_call')) else None
                    seq_record['d_gene'] = str(row['d_call']) if pd.notna(row.get('d_call')) else None
                    seq_record['j_gene'] = str(row['j_call']) if pd.notna(row.get('j_call')) else None
                    if 'c_call' in clonality_df.columns and pd.notna(row.get('c_call')):
                        val = str(row['c_call']).strip()
                        if val:
                            seq_record['c_call'] = val
                
                dl_sequences.append(seq_record)
            
            # Group DL sequences by file using the numeric suffix -> filename mapping
            file_groups = {}
            for seq in dl_sequences:
                filename = self.resolve_filename(seq['id'])
                if filename not in file_groups:
                    file_groups[filename] = []
                file_groups[filename].append(seq)
            
            # Emit DL clustering results
            self.emit.result("dl_sequences", data={
                "sequences": dl_sequences,
                "file_groups": file_groups,
                "total_count": len(dl_sequences)
            })
            
            self.emit.log("info", f"DL clustering complete: {len(dl_sequences)} sequences, {len(file_groups)} file groups")
            return True
            
        except Exception as e:
            self.emit.log("warn", f"DL clustering failed: {str(e)}")
            self.emit.log("debug", traceback.format_exc())
            return False
    
    def run(self) -> bool:
        """Execute the full analysis pipeline."""
        try:
            self.emit.log("info", "🚀 PIPELINE STARTING - Check logs for tree building messages")
            
            # Step 1: Load FASTA files
            if not self.load_fasta_files():
                self.emit.complete(False, "Failed to load FASTA files")
                return False
            
            if self.check_cancelled():
                self.emit.complete(False, "Cancelled by user")
                return False
            
            # Step 2: Clean FASTA files if requested
            if not self.clean_fasta_files():
                self.emit.complete(False, "Failed to clean FASTA files")
                return False
            
            # Step 2b: Preprocess 10x contigs (filter by annotations if available)
            if not self.preprocess_10x_contigs():
                self.emit.complete(False, "Failed to preprocess 10x contigs")
                return False
            
            # Step 3: Setup databases
            if not self.setup_databases():
                self.emit.complete(False, "Failed to setup databases")
                return False
            
            # Step 4: Combine FASTA files
            if not self.combine_fasta_files():
                self.emit.complete(False, "Failed to combine FASTA files")
                return False
            
            # Step 5: Build BLAST databases
            if not self.build_blast_databases():
                self.emit.complete(False, "Failed to build BLAST databases")
                return False
            
            if self.check_cancelled():
                self.emit.complete(False, "Cancelled by user")
                return False
            
            # Step 6: Run IgBLAST
            if not self.run_igblast():
                self.emit.complete(False, "IgBLAST analysis failed")
                return False
            
            # Step 6b: Load timepoint mapping (determines per-tp vs single-cohort mode)
            self.load_timepoint_mapping()
            
            # Step 7: Calculate thresholds (per timepoint or single global)
            thresholds = self.calculate_thresholds()
            if thresholds is None or self.check_cancelled():
                self.emit.complete(False, "Cancelled by user")
                return False
            
            # Step 8: Run clonality analysis (per timepoint or single global)
            if not self.run_clonality_analysis(thresholds):
                self.emit.complete(False, "Clonality analysis failed")
                return False
            
            if self.check_cancelled():
                self.emit.complete(False, "Cancelled by user")
                return False
            
            # Step 8b: Assign C genes (isotype) via igblastn -c_region_db (>= 1.18) or blastn fallback
            self.assign_c_genes()
            
            # Step 8c: Build cross-timepoint lineage map
            self.build_cross_timepoint_lineages()
            
            # Step 9: Build trees (per timepoint or single global)
            self.emit.log("info", "About to call build_trees()...")
            if not self.build_trees():
                self.emit.log("warn", "build_trees() returned False - continuing anyway")
            
            # Step 10: Visualize trees
            self.emit.log("info", "About to call visualize_trees()...")
            if not self.visualize_trees():
                self.emit.log("warn", "visualize_trees() returned False - continuing anyway")
            
            # Step 11: Load and emit results
            if not self.load_results():
                self.emit.complete(False, "Failed to load results")
                return False
            
            # Step 12: Run COVID database matching (if enabled)
            if self.run_covid_matching and self.cov_abdab_path:
                self.emit.log("info", "COVID database matching is enabled, starting analysis...")
                try:
                    from utils.covid_db_matcher import analyze_covid_matches
                    
                    clone_pass_path = os.path.join(self.output_dir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv')
                    
                    if os.path.exists(clone_pass_path) and os.path.exists(self.cov_abdab_path):
                        self.emit.progress("covid_matching", 85, "Matching clones against COVID database...")
                        
                        results = analyze_covid_matches(
                            clone_pass_path=clone_pass_path,
                            cov_abdab_path=self.cov_abdab_path,
                            top_n_clones=20,
                            file_id_mapping=self.file_id_mapping
                        )
                        
                        self.emit.result('covid_matches', data=results)
                        # Persist to disk so session restore can reload it
                        try:
                            covid_json_path = os.path.join(self.output_dir, 'covid_matches.json')
                            with open(covid_json_path, 'w') as f:
                                json.dump(results, f)
                            self.emit.log("info", f"COVID matches saved to {covid_json_path}")
                        except Exception as save_err:
                            self.emit.log("warn", f"Could not save covid_matches.json: {save_err}")
                        self.emit.log("info", f"COVID matching complete: {results['stats']['clones_with_high_matches']} clones with high matches")
                    else:
                        self.emit.log("warn", f"COVID matching enabled but files not found: clone_pass={os.path.exists(clone_pass_path)}, cov_abdab={os.path.exists(self.cov_abdab_path)}")
                except Exception as e:
                    self.emit.log("error", f"COVID matching failed: {str(e)}")
                    # Don't fail the entire pipeline if COVID matching fails
            
            # Step 13: Run deep learning clustering (DISABLED - uncomment to enable)
            # self.run_dl_clustering()
            
            self.emit.progress("complete", 100, "Analysis complete!")
            self.emit.complete(True)
            return True
            
        except Exception as e:
            self.emit.log("error", f"Pipeline failed: {str(e)}")
            traceback.print_exc()
            self.emit.complete(False, str(e))
            return False


def run_load_results(config: Dict[str, Any], emit) -> bool:
    """
    Load and emit results from a previous run (restore after app sleep/minimize).
    
    Args:
        config: Must contain output_dir
        emit: NDJSONEmitter for output
    
    Returns:
        True if successful, False otherwise
    """
    try:
        output_dir = config.get('output_dir')
        if not output_dir or not os.path.isdir(output_dir):
            emit.log("error", f"Invalid or missing output_dir: {output_dir}")
            emit.complete(False, "Invalid output directory")
            return False
        
        # Create minimal runner with output_dir and combined_fasta path
        runner = PipelineRunner({'output_dir': output_dir, 'fasta_dir': ''})
        runner.combined_fasta = os.path.join(output_dir, 'combined.fasta')
        
        if not runner.load_results():
            return False
        
        # Also emit existing tree images (they're on disk from the previous run)
        trees_dir = os.path.join(output_dir, 'trees')
        if os.path.isdir(trees_dir):
            all_tree_images = glob.glob(os.path.join(trees_dir, '*.png'))
            all_tree_newicks = {os.path.basename(f).replace('.newick', '') for f in glob.glob(os.path.join(trees_dir, '*.newick'))}
            tree_images = [img for img in all_tree_images
                          if os.path.basename(img).replace('.png', '') in all_tree_newicks]
            if tree_images:
                import pandas as pd
                clone_sizes = {}
                clone_pass_path = os.path.join(output_dir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv')
                if os.path.exists(clone_pass_path):
                    clone_df = pd.read_table(clone_pass_path)
                    for cid in clone_df['clone_id'].unique():
                        if pd.notna(cid):
                            clone_sizes[int(cid)] = len(clone_df[clone_df['clone_id'] == cid])
                def get_clone_size(tree_path):
                    basename = os.path.basename(tree_path)
                    match = basename.replace('tree_', '').replace('.png', '')
                    try:
                        return clone_sizes.get(int(match), 0)
                    except ValueError:
                        return 0
                tree_images.sort(key=get_clone_size, reverse=True)
                tree_data = []
                for tree_path in tree_images:
                    abs_path = os.path.abspath(tree_path)
                    basename = os.path.basename(abs_path)
                    match = basename.replace('tree_', '').replace('.png', '')
                    try:
                        clone_id = int(match)
                        tree_data.append({'path': abs_path, 'clone_id': clone_id, 'clone_size': clone_sizes.get(clone_id, 0)})
                    except ValueError:
                        tree_data.append({'path': abs_path, 'clone_id': None, 'clone_size': 0})
                emit.result("tree_images", data={"images": tree_images, "tree_metadata": tree_data})
            else:
                emit.result("tree_images", data={"images": [], "tree_metadata": []})
        else:
            emit.result("tree_images", data={"images": [], "tree_metadata": []})
        
        emit.complete(True)
        return True
    except Exception as e:
        emit.log("error", f"Failed to load results: {str(e)}")
        emit.complete(False, str(e))
        return False


def run_public_clone_analysis(config: Dict[str, Any], emit) -> bool:
    """
    Run public clone analysis on existing results.
    
    Args:
        config: Configuration dictionary with analysis parameters
        emit: NDJSONEmitter for output
    
    Returns:
        True if successful, False otherwise
    """
    try:
        from utils.public_clones import analyze_public_clones
        from Bio import SeqIO
        
        output_dir = config.get('output_dir')
        mode = config.get('mode', 'lenient')
        similarity_threshold = config.get('similarity_threshold', 0.85)
        max_mismatches = config.get('max_mismatches', 2)
        top_n = config.get('top_n', 10)
        
        emit.log("info", f"Starting public clone analysis in {mode} mode")
        emit.progress("public_clones", 10, "Loading clonality data...")
        
        # Paths to existing data
        clone_pass_path = os.path.join(output_dir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv')
        combined_fasta = os.path.join(output_dir, 'combined.fasta')
        
        # Check if required files exist
        if not os.path.exists(clone_pass_path):
            emit.log("error", f"Clonality file not found: {clone_pass_path}")
            emit.complete(False, "Required clonality data not found. Please run main analysis first.")
            return False
        
        if not os.path.exists(combined_fasta):
            emit.log("error", f"Combined FASTA file not found: {combined_fasta}")
            emit.complete(False, "Required FASTA file not found. Please run main analysis first.")
            return False
        
        emit.progress("public_clones", 30, "Loading sequence metadata...")
        
        # Load sequence metadata (for file grouping)
        sequences_data = []
        for record in SeqIO.parse(combined_fasta, "fasta"):
            sequences_data.append({
                'id': record.id,
                'file': None  # Will be extracted from ID
            })
        
        emit.progress("public_clones", 50, "Analyzing public clones...")
        emit.log("info", f"Analyzing {len(sequences_data)} sequences with top_n={top_n}")
        
        # Load file ID mapping if available
        mapping_path = os.path.join(output_dir, 'file_id_mapping.json')
        file_id_mapping = {}
        if os.path.exists(mapping_path):
            with open(mapping_path, 'r') as f:
                file_id_mapping = json.load(f)
        
        # Run analysis
        results = analyze_public_clones(
            clone_pass_path,
            sequences_data,
            mode=mode,
            similarity_threshold=similarity_threshold,
            max_aa_mismatches=max_mismatches,
            top_n=top_n,
            file_id_mapping=file_id_mapping
        )
        
        emit.progress("public_clones", 90, "Generating visualization data...")
        
        # Emit results
        emit.result('public_clones', data=results)
        
        stats = results.get('stats', {})
        emit.log("info", f"Found {stats.get('total_public_clones', 0)} public clones across {stats.get('total_patients', 0)} patients")
        
        emit.progress("public_clones", 100, "Public clone analysis complete!")
        emit.complete(True)
        return True
        
    except Exception as e:
        emit.log("error", f"Public clone analysis failed: {str(e)}")
        emit.log("debug", traceback.format_exc())
        emit.complete(False, str(e))
        return False


def run_covid_matching_analysis(config: dict, emit) -> bool:
    """
    Run COVID-19 antibody database matching analysis on existing clonality results.

    This is a separate analysis that can be run after the main pipeline.
    By default matches the top 20 largest clones. When config["mode"] == "public_clones",
    matches against the caller-provided list of clone IDs instead
    (typically the union of public clones discovered across timepoints).

    Args:
        config: Configuration dictionary with:
            - output_dir: Directory containing clonality results
            - cov_abdab_database_path: Path to CoV-AbDab CSV file
            - top_n_clones: Number of top clones to analyze (default 20)
            - mode: "top_n" (default) or "public_clones"
            - specific_clone_ids: list of int clone IDs (used when mode=public_clones)
        emit: NDJSONEmitter for output

    Returns:
        True if successful, False otherwise
    """
    try:
        from utils.covid_db_matcher import analyze_covid_matches

        emit.log("info", "=" * 60)
        emit.log("info", "COVID-19 ANTIBODY DATABASE MATCHING")
        emit.log("info", "=" * 60)

        output_dir = config.get('output_dir')
        cov_abdab_path = config.get('cov_abdab_database_path')
        top_n = config.get('top_n_clones', 20)
        mode = config.get('mode', 'top_n')
        specific_clone_ids = config.get('specific_clone_ids') if mode == 'public_clones' else None
        
        if not output_dir:
            emit.log("error", "No output directory specified")
            emit.complete(False, "Output directory required")
            return False
        
        if not cov_abdab_path:
            emit.log("error", "No CoV-AbDab database path specified")
            emit.complete(False, "CoV-AbDab database path required")
            return False
        
        if not os.path.exists(cov_abdab_path):
            emit.log("error", f"CoV-AbDab database not found: {cov_abdab_path}")
            emit.complete(False, "CoV-AbDab database file not found")
            return False
        
        emit.progress("covid_matching", 10, "Loading clonality data...")
        
        # Path to clonality data
        clone_pass_path = os.path.join(output_dir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv')
        
        # Check if required file exists
        if not os.path.exists(clone_pass_path):
            emit.log("error", f"Clonality file not found: {clone_pass_path}")
            emit.complete(False, "Required clonality data not found. Please run main analysis first.")
            return False
        
        emit.progress("covid_matching", 30, "Loading CoV-AbDab database...")
        emit.log("info", f"CoV-AbDab database: {cov_abdab_path}")
        if mode == 'public_clones' and specific_clone_ids:
            emit.log("info", f"Mode: public_clones, analyzing {len(specific_clone_ids)} discovered public clones")
        else:
            emit.log("info", f"Mode: top_n, analyzing top {top_n} clones")

        # Load file ID mapping if available
        mapping_path = os.path.join(output_dir, 'file_id_mapping.json')
        file_id_mapping = {}
        if os.path.exists(mapping_path):
            with open(mapping_path, 'r') as f:
                file_id_mapping = json.load(f)

        # Run analysis
        emit.progress("covid_matching", 50, "Matching sequences against COVID database...")
        results = analyze_covid_matches(
            clone_pass_path=clone_pass_path,
            cov_abdab_path=cov_abdab_path,
            top_n_clones=top_n,
            file_id_mapping=file_id_mapping,
            specific_clone_ids=specific_clone_ids
        )
        # Tag the result so the frontend knows which mode this came from
        results['mode'] = mode

        emit.progress("covid_matching", 90, "Finalizing results...")

        # Emit results
        emit.result('covid_matches', data=results)

        # Persist to disk so session restore can reload it
        # Public-clones results go to a separate filename so they don't overwrite top_n
        try:
            covid_json_name = 'covid_matches_public.json' if mode == 'public_clones' else 'covid_matches.json'
            covid_json_path = os.path.join(output_dir, covid_json_name)
            with open(covid_json_path, 'w') as f:
                json.dump(results, f)
            emit.log("info", f"COVID matches saved to {covid_json_path}")
        except Exception as save_err:
            emit.log("warn", f"Could not save covid matches JSON: {save_err}")

        stats = results.get('stats', {})
        emit.log("info", f"Analyzed {stats.get('total_clones_analyzed', 0)} clones")
        emit.log("info", f"Clones with high matches (≥90%): {stats.get('clones_with_high_matches', 0)}")
        emit.log("info", f"Database size: {stats.get('database_size', 0)} antibodies")
        
        emit.progress("covid_matching", 100, "COVID database matching complete!")
        emit.complete(True)
        return True
        
    except Exception as e:
        emit.log("error", f"COVID matching analysis failed: {str(e)}")
        emit.log("debug", traceback.format_exc())
        emit.complete(False, str(e))
        return False


def main():
    """Main entry point."""
    emit = NDJSONEmitter
    
    emit.log("info", "Pipeline runner started")
    
    try:
        # Read configuration from stdin
        config_line = sys.stdin.readline()
        if not config_line:
            emit.complete(False, "No configuration received")
            return 1
        
        config = json.loads(config_line)
        
        action = config.get('action')
        
        if action == 'run':
            runner = PipelineRunner(config.get('config', {}))
            success = runner.run()
            return 0 if success else 1
        elif action == 'public_clones':
            # Run public clone analysis on existing results
            success = run_public_clone_analysis(config.get('config', {}), emit)
            return 0 if success else 1
        elif action == 'covid_matching':
            # Run COVID database matching on existing results
            success = run_covid_matching_analysis(config.get('config', {}), emit)
            return 0 if success else 1
        elif action == 'load_results':
            # Restore results from disk (e.g. after app wake from sleep)
            success = run_load_results(config.get('config', {}), emit)
            return 0 if success else 1
        else:
            emit.complete(False, f"Unknown action: {action}")
            return 1
            
    except json.JSONDecodeError as e:
        emit.complete(False, f"Invalid JSON configuration: {str(e)}")
        return 1
    except Exception as e:
        emit.log("error", f"Fatal error: {str(e)}")
        traceback.print_exc()
        emit.complete(False, str(e))
        return 1


if __name__ == '__main__':
    sys.exit(main())

