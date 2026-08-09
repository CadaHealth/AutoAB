#!/usr/bin/env Rscript

# Build phylogenetic trees using IQ-TREE2 (Maximum Likelihood)
# Falls back to Neighbor-Joining if IQ-TREE2 not available
# Preserves all unique sequences (no aggressive collapsing)
# Adds sequence counts to tip labels
# Uses parallel processing for speed (cross-platform compatible)

library(ape)
library(jsonlite)
library(parallel)  # For parallel processing

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

# Check if IQ-TREE2 is available
iqtree_available <- FALSE
iqtree_cmd <- NULL
for (cmd in c("iqtree2", "iqtree")) {
    check_result <- system(paste("which", cmd), ignore.stdout = TRUE, ignore.stderr = TRUE)
    if (check_result == 0) {
        iqtree_available <- TRUE
        iqtree_cmd <- cmd
        cat(paste("Found IQ-TREE:", cmd, "\n"))
        break
    }
}

if (!iqtree_available) {
    cat("WARNING: IQ-TREE2 not found. Falling back to Neighbor-Joining.\n")
    cat("For better trees, install IQ-TREE2: brew install iqtree\n")
}

# Load sequence counts mapping (now organized by clone)
sequence_counts_path <- file.path(outs_dir, "sequence_counts.json")
sequence_counts_by_clone <- list()
if (file.exists(sequence_counts_path)) {
    tryCatch({
        if (requireNamespace("jsonlite", quietly = TRUE)) {
            sequence_counts_by_clone <- jsonlite::fromJSON(sequence_counts_path)
        }
    }, error = function(e) {
        warning(paste("Could not load sequence counts:", e$message))
    })
}

# Helper function to clean labels
clean_label_base <- function(label) {
    label <- sub("\\|\\|\\|.*$", "", label)
    label <- sub("_\\d+$", "", label)
    label <- sub("\\s+\\d+$", "", label)
    return(trimws(label))
}

# Helper function to add sequence counts to tip labels
# Now matches by SEQUENCE CONTENT, not by ID, because counts are stored by content
add_sequence_counts <- function(dna, tip_labels, clone_id, sequence_counts_by_clone) {
    new_tip_labels <- character(length(tip_labels))
    
    # Get counts for this specific clone (counts are by sequence content, not ID)
    clone_counts <- list()
    if (!is.null(sequence_counts_by_clone) && clone_id %in% names(sequence_counts_by_clone)) {
        clone_counts <- sequence_counts_by_clone[[clone_id]]
    }
    
    for (i in seq_along(tip_labels)) {
        label <- tip_labels[i]
        
        # Skip germline sequences
        if (grepl("GERM", label, ignore.case = TRUE)) {
            new_tip_labels[i] <- label
            next
        }
        
        # Clean the display label - keep file ID suffix (_1001, _1002, etc.) for traceability
        display_label <- sub("\\|\\|\\|.*$", "", label)
        display_label <- trimws(display_label)
        
        # Get the DNA sequence content for this tip
        # Extract sequence as string, normalize (uppercase, remove gaps/N)
        seq_content <- NULL
        tryCatch({
            if (is.matrix(dna)) {
                seq_vector <- dna[i, ]
            } else {
                seq_vector <- dna
            }
            # Convert DNAbin to character, remove gaps and Ns, uppercase
            seq_content <- toupper(gsub("[N-]", "", paste(as.character(seq_vector), collapse = "")))
        }, error = function(e) {
            warning(paste("Could not extract sequence for", label))
        })
        
        # Look up count by sequence content
        count <- NULL
        if (!is.null(seq_content) && seq_content %in% names(clone_counts)) {
            count <- as.numeric(clone_counts[[seq_content]])
        }
        
        # Add count to label if found and > 1
        if (!is.null(count) && !is.na(count) && count > 1) {
            new_tip_labels[i] <- paste0(display_label, " (×", count, ")")
        } else {
            new_tip_labels[i] <- display_label
        }
    }
    return(new_tip_labels)
}

# Find all FASTA files
fasta_files <- list.files(build_trees_dir, pattern = "\\.fasta$", full.names = TRUE)

if (length(fasta_files) == 0) {
    warning("No FASTA files found for tree building")
    quit(status = 0)
}

# Detect CPU cores for parallel processing
# Use all cores except 1 to keep system responsive
detected_cores <- detectCores()
if (is.na(detected_cores) || detected_cores < 1) {
    cat("WARNING: Could not detect CPU cores, defaulting to 4\n")
    num_cores <- 4
} else {
    num_cores <- max(1, detected_cores - 1)
}
cat(paste("Found", length(fasta_files), "clones to process\n"))
cat(paste("Using", num_cores, "CPU cores for parallel tree building\n"))
cat(paste("Estimated time:", round(length(fasta_files) / num_cores * 1.5), "minutes\n"))

# Function to build a single tree (will be parallelized)
build_single_tree <- function(fasta_file) {
    tryCatch({
        # Get clone ID from filename
        clone_id <- sub("\\.fasta$", "", basename(fasta_file))
        
        # Read sequences using ape's read.dna
        dna <- read.dna(fasta_file, format = "fasta")
        
        # Check if we have enough sequences (need at least 3)
        n_seqs <- if (is.matrix(dna)) nrow(dna) else 1
        if (n_seqs < 3) {
            return(list(
                status = "skipped",
                clone_id = clone_id,
                reason = paste("Only", n_seqs, "sequence(s), need at least 3")
            ))
        }
        
        # Get sequence labels
        tip_labels <- rownames(dna)
        
        # Find germline sequence for rooting
        germ_tip <- NULL
        for (i in seq_along(tip_labels)) {
            if (grepl("GERM", tip_labels[i], ignore.case = TRUE)) {
                germ_tip <- tip_labels[i]
                break
            }
        }
        
        tree <- NULL
        method_used <- "NJ"
        
        # Try IQ-TREE2 first (if available)
        if (iqtree_available && n_seqs >= 4) {  # IQ-TREE needs at least 4 sequences
            tryCatch({
                # Create temporary directory for IQ-TREE output
                temp_dir <- file.path(trees_dir, paste0("temp_", clone_id))
                dir.create(temp_dir, showWarnings = FALSE, recursive = TRUE)
                
                temp_fasta <- file.path(temp_dir, paste0(clone_id, ".fasta"))
                temp_tree <- file.path(temp_dir, paste0(clone_id, ".fasta.treefile"))
                
                # Copy FASTA to temp location
                file.copy(fasta_file, temp_fasta, overwrite = TRUE)
                
                # Build tree with IQ-TREE2
                # GTR+G model for DNA evolution with gamma-distributed rates
                # -B 1000: Ultrafast bootstrap (fast, reliable)
                # -redo: Force overwrite
                iqtree_cmd_full <- paste(
                    iqtree_cmd,
                    "-s", temp_fasta,
                    "-m GTR+G",
                    "-B 1000",
                    "-redo",
                    "-quiet",
                    "2>&1"
                )
                
                system(iqtree_cmd_full, ignore.stdout = TRUE, ignore.stderr = TRUE)
                
                # Read the resulting tree
                if (file.exists(temp_tree)) {
                    tree <- read.tree(temp_tree)
                    method_used <- "IQ-TREE2"
                    
                    # Clean up temp files
                    unlink(temp_dir, recursive = TRUE)
                }
            }, error = function(e) {
                warning(paste("IQ-TREE2 failed for", clone_id, "- falling back to NJ"))
                tree <<- NULL
            })
        }
        
        # Fallback to Neighbor-Joining if IQ-TREE failed or not available
        if (is.null(tree)) {
            dist_matrix <- dist.dna(dna, model = "raw", as.matrix = TRUE, pairwise.deletion = TRUE)
            tree <- nj(dist_matrix)
            method_used <- "NJ"
        }
        
        # Root the tree at germline if available
        if (!is.null(germ_tip) && germ_tip %in% tree$tip.label) {
            tree <- root(tree, outgroup = germ_tip, resolve.root = TRUE)
        } else if (!is.rooted(tree)) {
            # Root at midpoint if no germline found
            if (requireNamespace("phytools", quietly = TRUE)) {
                tree <- phytools::midpoint.root(tree)
            } else {
                # Fallback: root at first tip
                tree <- root(tree, outgroup = tree$tip.label[1], resolve.root = TRUE)
            }
        }
        
        # Fix zero-length branches (causes overlapping visualization)
        # Set minimum branch length to 1e-6 (0.000001) for phylotree.js display
        if (!is.null(tree$edge.length)) {
            min_branch_length <- 1e-6
            tree$edge.length[tree$edge.length == 0] <- min_branch_length
            tree$edge.length[tree$edge.length < min_branch_length] <- min_branch_length
        }
        
        # Add sequence counts to tip labels (only for this clone, match by sequence content)
        tree$tip.label <- add_sequence_counts(dna, tree$tip.label, clone_id, sequence_counts_by_clone)
        
        # Save tree in Newick format
        tree_file <- file.path(trees_dir, paste0("tree_", clone_id, ".newick"))
        write.tree(tree, file = tree_file)
        
        # Return success result
        return(list(
            status = "success",
            clone_id = clone_id,
            n_seqs = n_seqs,
            method = method_used
        ))
        
    }, error = function(e) {
        # Return error result
        return(list(
            status = "error",
            clone_id = sub("\\.fasta$", "", basename(fasta_file)),
            message = e$message
        ))
    })
}

# Build trees in parallel
cat("Starting parallel tree building...\n")

if (.Platform$OS.type == "unix") {
    # Mac/Linux: Use mclapply (fork-based, more efficient)
    results <- mclapply(fasta_files, build_single_tree, mc.cores = num_cores)
} else {
    # Windows: Use parLapply (socket-based)
    cl <- makeCluster(num_cores)
    # Export necessary variables and functions to cluster
    clusterExport(cl, c("iqtree_available", "iqtree_cmd", "trees_dir", "sequence_counts_by_clone", "add_sequence_counts", "build_single_tree"))
    # Load required libraries on each worker
    clusterEvalQ(cl, {
        library(ape)
        library(jsonlite)
    })
    
    results <- parLapply(cl, fasta_files, build_single_tree)
    stopCluster(cl)
}

# Count results
tree_count <- sum(sapply(results, function(r) r$status == "success"))
skipped_count <- sum(sapply(results, function(r) r$status == "skipped"))
error_count <- sum(sapply(results, function(r) r$status == "error"))
iqtree_count <- sum(sapply(results, function(r) r$status == "success" && r$method == "IQ-TREE2"))
nj_count <- sum(sapply(results, function(r) r$status == "success" && r$method == "NJ"))

# Report results
cat(paste("\n=== Tree Building Summary ===\n"))
cat(paste("Successfully built", tree_count, "trees\n"))
if (iqtree_count > 0) {
    cat(paste("  IQ-TREE2 (ML):", iqtree_count, "trees\n"))
}
if (nj_count > 0) {
    cat(paste("  Neighbor-Joining:", nj_count, "trees\n"))
}
if (skipped_count > 0) {
    cat(paste("Skipped", skipped_count, "clones (< 3 sequences)\n"))
}
if (error_count > 0) {
    cat(paste("Failed", error_count, "clones (errors during processing)\n"))
    # Print detailed error messages
    cat("\nDetailed errors:\n")
    for (i in seq_along(results)) {
        if (results[[i]]$status == "error") {
            cat(paste("  Clone", results[[i]]$clone_id, ":", results[[i]]$message, "\n"))
        }
    }
}

quit(status = 0)

