#!/usr/bin/env Rscript

# Build phylogenetic trees using ape's neighbor-joining
# Works with clones of any size (>= 3 sequences)
# Adds sequence counts to tip labels

library(ape)
library(jsonlite)

# Get command line arguments for outs directory
args <- commandArgs(trailingOnly = TRUE)
if (length(args) == 0) {
    outs_dir <- "outs"
} else {
    outs_dir <- args[1]
}

# Directories
build_trees_dir <- file.path(outs_dir, "build-trees-input")
trees_dir <- file.path(outs_dir, "trees")

# Create trees directory if it doesn't exist
dir.create(trees_dir, showWarnings = FALSE, recursive = TRUE)

# Load sequence counts mapping
sequence_counts_path <- file.path(outs_dir, "sequence_counts.json")
sequence_counts <- list()
if (file.exists(sequence_counts_path)) {
    tryCatch({
        # Try jsonlite first
        if (requireNamespace("jsonlite", quietly = TRUE)) {
            sequence_counts <- jsonlite::fromJSON(sequence_counts_path)
        } else {
            # Fallback: read as text and parse manually
            json_text <- readLines(sequence_counts_path, warn = FALSE)
            json_text <- paste(json_text, collapse = "")
            # Simple JSON parsing for our use case (key-value pairs)
            json_text <- gsub('["{}]', '', json_text)
            pairs <- strsplit(json_text, ",")[[1]]
            for (pair in pairs) {
                parts <- strsplit(trimws(pair), ":")[[1]]
                if (length(parts) == 2) {
                    key <- trimws(parts[1])
                    value <- as.numeric(trimws(parts[2]))
                    sequence_counts[[key]] <- value
                }
            }
        }
    }, error = function(e) {
        warning(paste("Could not load sequence counts:", e$message))
        sequence_counts <- list()
    })
}

# Find all FASTA files
fasta_files <- list.files(build_trees_dir, pattern = "\\.fasta$", full.names = TRUE)

if (length(fasta_files) == 0) {
    warning("No FASTA files found for tree building")
    quit(status = 0)
}

tree_count <- 0
skipped_count <- 0

# Build a tree for each clone
for (fasta_file in fasta_files) {
    tryCatch({
        # Get clone ID from filename
        clone_id <- sub("\\.fasta$", "", basename(fasta_file))
        
        # Read sequences using ape's read.dna (simpler and more reliable)
        dna <- read.dna(fasta_file, format = "fasta")
        
        # Check if we have enough sequences (need at least 3)
        n_seqs <- if (is.matrix(dna)) nrow(dna) else 1
        if (n_seqs < 3) {
            skipped_count <- skipped_count + 1
            next
        }
        
        # Get sequence labels (tip labels) - these are the sequence IDs from FASTA headers
        tip_labels <- rownames(dna)
        
        # Clean labels: remove ||| delimiter and any BuildTrees suffixes
        clean_label_base <- function(label) {
            # Remove ||| and everything after it
            label <- sub("\\|\\|\\|.*$", "", label)
            # Remove BuildTrees suffixes like "_1", " 1", etc.
            label <- sub("_\\d+$", "", label)
            label <- sub("\\s+\\d+$", "", label)
            return(trimws(label))
        }
        
        # Add sequence counts to tip labels
        # Match tip labels to sequence IDs in the counts mapping
        new_tip_labels <- character(length(tip_labels))
        for (i in seq_along(tip_labels)) {
            label <- tip_labels[i]
            
            # Skip germline sequences
            if (grepl("GERM", label, ignore.case = TRUE)) {
                new_tip_labels[i] <- label
                next
            }
            
            # Clean the label to match against sequence_counts keys
            base_label <- clean_label_base(label)
            
            # Clean the display label - keep file ID suffix (_1001, _1002, etc.) for traceability
            display_label <- sub("\\|\\|\\|.*$", "", label)
            display_label <- trimws(display_label)
            
            # Try exact match with cleaned label
            count <- NULL
            if (base_label %in% names(sequence_counts)) {
                count <- as.numeric(sequence_counts[[base_label]])
            } else {
                # Try matching with ||| included (in case counts file has it)
                # Look for keys that start with base_label
                for (key in names(sequence_counts)) {
                    key_base <- clean_label_base(key)
                    if (key_base == base_label || base_label == key_base) {
                        count <- as.numeric(sequence_counts[[key]])
                        break
                    }
                }
            }
            
            # Add count to label if found and > 1
            if (!is.null(count) && !is.na(count) && count > 1) {
                new_tip_labels[i] <- paste0(display_label, " (×", count, ")")
            } else {
                new_tip_labels[i] <- display_label
            }
        }
        
        # Update tip labels in the DNA object
        rownames(dna) <- new_tip_labels
        
        # Calculate distance matrix using raw distances (proportion of differences)
        dist_matrix <- dist.dna(dna, model = "raw", as.matrix = TRUE, pairwise.deletion = TRUE)
        
        # Build neighbor-joining tree
        nj_tree <- nj(dist_matrix)
        
        # Update tip labels in the tree object (in case they weren't preserved)
        nj_tree$tip.label <- new_tip_labels
        
        # Save tree in Newick format (unrooted NJ tree)
        tree_file <- file.path(trees_dir, paste0("tree_", clone_id, ".newick"))
        write.tree(nj_tree, file = tree_file)
        
        tree_count <- tree_count + 1
        
    }, error = function(e) {
        warning(paste("Failed to build tree for", basename(fasta_file), ":", e$message))
        skipped_count <- skipped_count + 1
    })
}

# Report results
cat(paste("Successfully built", tree_count, "trees\n"))
if (skipped_count > 0) {
    cat(paste("Skipped", skipped_count, "clones (< 3 sequences or errors)\n"))
}

quit(status = 0)

