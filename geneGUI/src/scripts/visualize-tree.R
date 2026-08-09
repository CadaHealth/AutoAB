library(alakazam)
library(ape)

# Get command line arguments for outs directory
args <- commandArgs(trailingOnly = TRUE)
if (length(args) == 0) {
    outs_dir <- "outs"
} else {
    outs_dir <- args[1]
}

tab_file <- file.path(outs_dir, "build-trees-input_igphyml-pass.tab")
db = readIgphyml(tab_file, format="phylo")

#plot largest lineage tree
trees_dir <- file.path(outs_dir, "trees")
for(x in 1:length(db$trees[])){

    y = file.path(trees_dir, paste("tree", x, ".png", sep = ""))
    png(y)
    plot(db$trees[[x]])

}
#plot(db$trees[[1]])
#plot(db$trees[[2]])

dev.off()