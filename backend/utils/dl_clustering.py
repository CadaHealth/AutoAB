"""
Deep Learning-based BCR Clustering using DNABERT

Integrates the BCR Deep Clustering model for clonal assignment.
"""

import os
import sys

# Add BCR Deep Clustering to path FIRST before any other imports
BCR_CLUSTERING_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'BCR_Deep_Clustering-main', 'Code'
)
if os.path.exists(BCR_CLUSTERING_DIR):
    sys.path.insert(0, BCR_CLUSTERING_DIR)

import numpy as np
import pandas as pd
import torch
from typing import List, Dict, Tuple

# Now try to import BCR Deep Clustering modules
DataProcessor = None
EmbeddingProcessor = None
Cluster = None

try:
    from DataProcessor import DataProcessor
    from Cluster import EmbeddingProcessor, Cluster
except ImportError as e:
    print(f"Warning: Could not import BCR Deep Clustering modules: {e}")
except Exception as e:
    print(f"Warning: Error loading BCR Deep Clustering: {e}")


class SequenceEncoder:
    """Wrapper for DNABERT model to encode sequences."""
    
    def __init__(self, model_directory: str):
        """
        Initialize the SequenceEncoder with a DNABERT model.
        
        Args:
            model_directory: Path to the DNABERT model directory
        """
        self.model_directory = model_directory
        self.model = None
        self.tokenizer = None
        self._load_model()
    
    def _load_model(self):
        """Load the DNABERT model and tokenizer."""
        try:
            from transformers import AutoModel, AutoTokenizer
            
            self.tokenizer = AutoTokenizer.from_pretrained(
                self.model_directory,
                trust_remote_code=True
            )
            self.model = AutoModel.from_pretrained(
                self.model_directory,
                trust_remote_code=True
            )
            
            # Set model to eval mode
            self.model.eval()
            
            # Move to GPU if available
            if torch.cuda.is_available():
                self.model = self.model.cuda()
                
        except Exception as e:
            print(f"Error loading DNABERT model: {e}")
            raise
    
    def encode_sequences(self, sequences: List[str], batch_size: int = 32) -> torch.Tensor:
        """
        Encode sequences into embeddings using DNABERT.
        
        Args:
            sequences: List of DNA sequences to encode
            batch_size: Batch size for encoding
            
        Returns:
            torch.Tensor: Embeddings matrix (n_sequences x embedding_dim)
        """
        all_embeddings = []
        
        with torch.no_grad():
            for i in range(0, len(sequences), batch_size):
                batch = sequences[i:i + batch_size]
                
                # Tokenize
                inputs = self.tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    max_length=512,
                    return_tensors='pt'
                )
                
                # Move to GPU if available
                if torch.cuda.is_available():
                    inputs = {k: v.cuda() for k, v in inputs.items()}
                
                # Get embeddings
                outputs = self.model(**inputs)
                
                # Use CLS token embedding or mean pooling
                # CLS token is the first token
                embeddings = outputs.last_hidden_state[:, 0, :]
                
                all_embeddings.append(embeddings.cpu())
        
        return torch.cat(all_embeddings, dim=0)


def run_dl_clustering(
    sequences_with_ids: List[Tuple[str, str]],
    model_dir: str,
    threshold: float = 0.00015,
    distance_type: str = 'cosine'
) -> Dict[str, int]:
    """
    Run deep learning-based clustering on BCR sequences.
    
    Args:
        sequences_with_ids: List of (sequence_id, cdr3_sequence) tuples
        model_dir: Path to the DNABERT model directory
        threshold: Clustering threshold (default from demo: 0.00015)
        distance_type: Distance metric ('cosine', 'euclidean', or 'manhattan')
        
    Returns:
        Dictionary mapping sequence_id to DL cluster_id
    """
    if not sequences_with_ids:
        return {}
    
    # Check if modules are available
    if DataProcessor is None or EmbeddingProcessor is None or Cluster is None:
        print("Error: BCR Deep Clustering modules not available")
        return {}
    
    try:
        # Extract sequences
        sequence_ids = [sid for sid, _ in sequences_with_ids]
        sequences = [seq.upper() for _, seq in sequences_with_ids]  # Ensure uppercase
        
        # Truncate to shortest sequence length (as per DataProcessor)
        min_length = min(len(seq) for seq in sequences)
        sequences = [seq[:min_length] for seq in sequences]
        
        print(f"Encoding {len(sequences)} sequences with DNABERT...")
        
        # Encode sequences using DNABERT
        encoder = SequenceEncoder(model_dir)
        embeddings = encoder.encode_sequences(sequences)
        
        print(f"Generated embeddings shape: {embeddings.shape}")
        
        # Process embeddings
        embedding_processor = EmbeddingProcessor(embeddings)
        norm_embeddings = embedding_processor.normalize_embeddings()
        
        # Calculate distances
        distance_matrix = embedding_processor.calculate_distance(
            norm_embeddings,
            distance_type=distance_type
        )
        
        print(f"Calculated {distance_type} distance matrix shape: {distance_matrix.shape}")
        
        # Perform clustering
        cluster = Cluster(distance_matrix)
        cluster_labels = cluster.hierarchical_cluster(threshold)
        
        print(f"Clustering complete. Found {len(np.unique(cluster_labels))} clusters")
        
        # Map sequence IDs to cluster IDs
        cluster_mapping = {
            seq_id: int(cluster_id)
            for seq_id, cluster_id in zip(sequence_ids, cluster_labels)
        }
        
        return cluster_mapping
        
    except Exception as e:
        print(f"Error during DL clustering: {e}")
        import traceback
        traceback.print_exc()
        return {}


def get_clone_counts(cluster_mapping: Dict[str, int]) -> Dict[str, int]:
    """
    Calculate the number of sequences in each clone.
    
    Args:
        cluster_mapping: Dictionary mapping sequence_id to cluster_id
        
    Returns:
        Dictionary mapping sequence_id to clone_count
    """
    # Count sequences per clone
    clone_sizes = {}
    for seq_id, clone_id in cluster_mapping.items():
        clone_sizes[clone_id] = clone_sizes.get(clone_id, 0) + 1
    
    # Map each sequence to its clone size
    clone_counts = {
        seq_id: clone_sizes[clone_id]
        for seq_id, clone_id in cluster_mapping.items()
    }
    
    return clone_counts

