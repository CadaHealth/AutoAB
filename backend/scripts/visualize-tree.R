library(ape)

# Get command line arguments for outs directory
args <- commandArgs(trailingOnly = TRUE)
if (length(args) == 0) {
    outs_dir <- "outs"
} else {
    outs_dir <- args[1]
}

# Read newick tree files from trees directory
trees_dir <- file.path(outs_dir, "trees")

# Find all .newick files
newick_files <- list.files(trees_dir, pattern = "\\.newick$", full.names = TRUE)

if (length(newick_files) == 0) {
    warning("No newick tree files found")
    quit(status = 0)
}

# Plot each tree
for (i in seq_along(newick_files)) {
    tryCatch({
        # Read the newick tree
        tree <- read.tree(newick_files[i])
        
        # Get the basename without extension for output
        base_name <- basename(newick_files[i])
        base_name <- sub("\\.newick$", "", base_name)
        
        # Output PNG file
        png_file <- file.path(trees_dir, paste0(base_name, ".png"))
        
        # Root the tree if it's unrooted (root at the first tip for simplicity)
        if (!is.rooted(tree)) {
            # For unrooted trees, we can root at an outgroup (GERM sequence) if available
            germ_tips <- grep("GERM", tree$tip.label, ignore.case = TRUE)
            if (length(germ_tips) > 0) {
                tree <- root(tree, outgroup = tree$tip.label[germ_tips[1]], resolve.root = TRUE)
            } else {
                # Root at first tip if no GERM found
                tree <- root(tree, outgroup = tree$tip.label[1], resolve.root = TRUE)
            }
        }
        
        # Create plot with larger size (optimized for horizontal layout like IgPhyML)
        # Wide format to accommodate tree branching left-to-right
        png(png_file, width = 3200, height = 2400, res = 120)
        
        # Set margins: bottom, left, top (for title), right (large for labels)
        par(mar = c(4, 2, 4, 10))
        
        # Ladderize tree for clearer lineage structure (like IgPhyML)
        tree <- ladderize(tree, right = TRUE)
        
        # Identify germline tip for highlighting
        germ_tips <- grep("GERM", tree$tip.label, ignore.case = TRUE)
        
        # Create color vector for tips (germline in red, others in black)
        tip_colors <- rep("black", length(tree$tip.label))
        if (length(germ_tips) > 0) {
            tip_colors[germ_tips] <- "red"
        }
        
        # Calculate maximum label length for proper x-axis limits
        max_label_length <- max(nchar(tree$tip.label))
        
        # First plot invisibly to get coordinate system
        plot(tree, 
             type = "phylogram",
             direction = "rightwards",
             show.tip.label = FALSE,
             plot = FALSE)
        
        # Get tree depth from last plot
        last_plot <- get("last_plot.phylo", envir = .PlotPhyloEnv)
        tree_depth <- max(last_plot$xx)
        
        # Calculate x limit: tree depth + space for labels
        label_space <- max_label_length * 0.012  # Adjust factor for label spacing
        x_max <- tree_depth + label_space
        
        # Now plot for real with proper limits (IgPhyML style: horizontal, left to right)
        plot(tree, 
             type = "phylogram",        # Phylogram shows branch lengths (like IgPhyML)
             direction = "rightwards",  # Horizontal layout like IgPhyML
             main = paste("Phylogenetic Tree:", base_name),
             cex = 1.3,
             edge.width = 3,
             tip.color = tip_colors,
             label.offset = tree_depth * 0.01,  # Small offset for labels
             show.node.label = FALSE,
             font = 1,
             adj = 0,  # Left-align labels
             x.lim = c(0, x_max),
             use.edge.length = TRUE)
        
        dev.off()
        
    }, error = function(e) {
        warning(paste("Failed to plot tree", i, ":", e$message))
    })
}

cat(paste("Generated", length(newick_files), "tree visualizations\n"))