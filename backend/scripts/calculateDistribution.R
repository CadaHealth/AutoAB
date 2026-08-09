# Estimate the clonal distance threshold from nearest-neighbour distances.
#
# Prints one of:
#   <number>                                  the threshold, in (0, 1)
#   AUTOAB_THRESHOLD_UNAVAILABLE<TAB><reason> nothing usable could be computed
#
# It never prints a made-up number. An earlier version returned 0.1 from every
# failure path, which the pipeline could not tell apart from a real result, so a
# broken input produced a complete analysis resting on an arbitrary threshold.
#
# Note also that `return()` was previously called at the top level of a
# tryCatch() expression, which is not valid R ("no function to return from").
# Every data-quality guard therefore raised an error instead of taking its
# intended quantile-based path, and collapsed to that same 0.1. The guards live
# inside functions now, so they do what they say.

options(warn = 1)  # surface warnings as they happen, do not stop execution
set.seed(42)

UNAVAILABLE_MARKER <- "AUTOAB_THRESHOLD_UNAVAILABLE"

unavailable <- function(reason) {
  structure(list(reason = reason), class = "autoab_unavailable")
}

is_unavailable <- function(x) inherits(x, "autoab_unavailable")

# Threshold from the distance vector. Returns a number, or an unavailable()
# marker when the data cannot support an estimate.
compute_threshold <- function(valid_dists) {
  # Data-quality guards. Each falls back to the median distance, which is a
  # weak but honest estimate, rather than to a constant.
  if (length(unique(valid_dists)) < 5) {
    warning("Too few unique distance values. Using quantile-based threshold.")
    return(as.numeric(quantile(valid_dists, 0.5, na.rm = TRUE)))
  }

  if (length(valid_dists) < 20) {
    warning("Very few valid distance values. Using quantile-based threshold.")
    return(as.numeric(quantile(valid_dists, 0.5, na.rm = TRUE)))
  }

  if (var(valid_dists, na.rm = TRUE) < 1e-6) {
    warning("Distance values have very low variance. Using quantile-based threshold.")
    return(as.numeric(quantile(valid_dists, 0.5, na.rm = TRUE)))
  }

  threshold <- NULL

  # Threshold method. The default is shazam's gamma-gamma GMM, which is the
  # standard Immcantation approach.
  #
  # Be aware that it is not deterministic: its mixture fit draws random
  # starting points from a source outside R's RNG, so repeated calls on
  # identical input return thresholds spanning ~17% of their mean, and the
  # clone count moves with them. set.seed() does not constrain it. If you need
  # runs to reproduce exactly, set AUTOAB_THRESHOLD_METHOD=density to use the
  # kernel-density estimate instead, which is deterministic but yields a
  # different (typically higher) threshold. See docs/VALIDATION.md.
  method_pref <- Sys.getenv("AUTOAB_THRESHOLD_METHOD", "gmm")

  accept <- function(x) !is.null(x) && !is.na(x) && x > 0 && x <= 1

  if (method_pref == "density") {
    result <- tryCatch({
      output <- findThreshold(valid_dists, method = "density")
      as.numeric(output@threshold)
    }, error = function(e) {
      warning(paste("Density threshold failed:", e$message))
      NULL
    })
    if (accept(result)) {
      threshold <- result
      message("Threshold method: density (deterministic)")
    }
  }

  set.seed(42)

  # Method 1: gamma-gamma GMM with lower spc (more lenient)
  if (is.null(threshold)) {
    result <- tryCatch({
      output <- findThreshold(valid_dists, method = "gmm", model = "gamma-gamma", cutoff = "user", spc = 0.95)
      as.numeric(output@threshold)
    }, error = function(e) {
      warning(paste("GMM gamma-gamma (spc=0.95) failed:", e$message))
      NULL
    })
    if (accept(result)) {
      threshold <- result
      message("Threshold method: gmm gamma-gamma (spc=0.95)")
    }
  }

  # Method 2: gamma-gamma GMM with optimal cutoff
  if (is.null(threshold)) {
    result <- tryCatch({
      output <- findThreshold(valid_dists, method = "gmm", model = "gamma-gamma", cutoff = "optimal")
      as.numeric(output@threshold)
    }, error = function(e) {
      warning(paste("GMM gamma-gamma (optimal) failed:", e$message))
      NULL
    })
    if (accept(result)) threshold <- result
  }

  # Method 3: gamma model instead of gamma-gamma (simpler model)
  if (is.null(threshold)) {
    result <- tryCatch({
      output <- findThreshold(valid_dists, method = "gmm", model = "gamma", cutoff = "optimal")
      as.numeric(output@threshold)
    }, error = function(e) {
      warning(paste("GMM gamma failed:", e$message))
      NULL
    })
    if (accept(result)) threshold <- result
  }

  # Method 4: density method (non-parametric)
  if (is.null(threshold)) {
    result <- tryCatch({
      output <- findThreshold(valid_dists, method = "density", cutoff = "optimal")
      as.numeric(output@threshold)
    }, error = function(e) {
      warning(paste("Density method failed:", e$message))
      NULL
    })
    if (accept(result)) threshold <- result
  }

  # Method 5: quantile-based threshold as final fallback
  if (is.null(threshold)) {
    warning("All GMM methods failed. Using quantile-based threshold.")
    threshold <- as.numeric(quantile(valid_dists, 0.5, na.rm = TRUE))
  }

  if (!accept(threshold)) {
    return(unavailable(paste0(
      "every estimation method failed and the fallback produced an out-of-range value (",
      format(threshold), ")"
    )))
  }

  as.numeric(threshold)
}

draw_plot <- function(path, valid_dists, threshold) {
  tryCatch({
    png(filename = path, width = 600, height = 480, res = 100)
    h <- hist(valid_dists, breaks = 50, freq = FALSE, col = "grey70", border = "grey40",
              main = paste("Distance Distribution - Threshold =", round(threshold, 3)),
              xlab = "Distance", ylab = "Density", xlim = c(0, 1))
    dens <- density(valid_dists, from = 0, to = 1, n = 512)
    lines(dens, col = "navy", lwd = 2)
    abline(v = threshold, col = "darkred", lty = 2, lwd = 2)
    dev.off()
  }, error = function(e) {
    warning(paste("Failed to create plot:", e$message))
  })
}

main <- function() {
  suppressWarnings({
    library(shazam)
  })

  args <- commandArgs(trailingOnly = TRUE)

  if (length(args) == 0) {
    return(unavailable("no input file was given to the threshold script"))
  }
  if (length(args) == 1) {
    args[2] <- "distributionPlot.png"
  }

  if (!file.exists(args[1])) {
    return(unavailable(paste("the aligned sequence table is missing:", args[1])))
  }
  if (file.info(args[1])$size == 0) {
    return(unavailable("the alignment produced no sequences"))
  }

  db <- read.table(file = args[1], sep = "\t", header = TRUE)

  if (nrow(db) == 0) {
    return(unavailable("the alignment produced no sequences"))
  }

  required_cols <- c("junction", "v_call", "j_call")
  missing_cols <- setdiff(required_cols, colnames(db))
  if (length(missing_cols) > 0) {
    return(unavailable(paste(
      "the alignment is missing columns needed for clonal distances:",
      paste(missing_cols, collapse = ", ")
    )))
  }

  if (nrow(db) < 10) {
    warning("Very few sequences in database. GMM fitting may fail.")
  }

  db <- distToNearest(db,
                      sequenceColumn = "junction",
                      vCallColumn = "v_call", jCallColumn = "j_call",
                      model = "ham", normalize = "len", nproc = 1)

  if (!"dist_nearest" %in% colnames(db)) {
    return(unavailable("nearest-neighbour distances could not be calculated"))
  }

  # Write disttonearest.tsv next to the input for downstream inspection.
  dist_output_path <- file.path(dirname(args[1]), "disttonearest.tsv")
  tryCatch({
    write.table(db, file = dist_output_path, sep = "\t", row.names = FALSE, quote = FALSE)
  }, error = function(e) {
    warning(paste("Failed to write disttonearest.tsv:", e$message))
  })

  valid_dists <- db$dist_nearest[!is.na(db$dist_nearest) & db$dist_nearest > 0 & db$dist_nearest <= 1]
  if (length(valid_dists) == 0) {
    return(unavailable(paste0(
      "no sequence had a comparable neighbour, so no distance distribution exists ",
      "(", nrow(db), " sequences, all without a nearest neighbour in the same V/J group)"
    )))
  }

  threshold <- compute_threshold(valid_dists)
  if (is_unavailable(threshold)) return(threshold)

  draw_plot(args[2], valid_dists, threshold)

  as.numeric(threshold)
}

res <- tryCatch(main(), error = function(e) {
  unavailable(paste("R failed while estimating the threshold:", conditionMessage(e)))
})

if (is_unavailable(res)) {
  cat(paste0(UNAVAILABLE_MARKER, "\t", res$reason, "\n"))
} else {
  cat(format(as.numeric(res), digits = 10), "\n")
}
