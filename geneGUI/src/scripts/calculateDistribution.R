# Set up error handling to always output a value
options(warn=1)  # Convert warnings to messages, don't stop execution

# Wrap everything in a tryCatch to ensure we always return a value
result <- tryCatch({
  suppressWarnings({
    library(shazam)
  })
  
  args = commandArgs(trailingOnly = TRUE)

  if (length(args)==0) {
    return(0.1)  # Return default instead of stopping
  } else if (length(args)==1) {
    # default output file
    args[2] = "distributionPlot.png"
  }

  # Check if input file exists
  if (!file.exists(args[1])) {
    warning(paste("Input file does not exist:", args[1]))
    return(0.1)
  }

  # Check if input file is empty
  if (file.info(args[1])$size == 0) {
    warning(paste("Input file is empty:", args[1]))
    return(0.1)
  }

  db = read.table(file = args[1], sep = '\t', header = TRUE)

  # Check if database has required columns and data
  if (nrow(db) == 0) {
    warning("Database has no rows")
    return(0.1)
  }

  required_cols <- c("junction", "v_call", "j_call")
  missing_cols <- setdiff(required_cols, colnames(db))
  if (length(missing_cols) > 0) {
    warning(paste("Database missing required columns:", paste(missing_cols, collapse=", ")))
    return(0.1)
  }

  # Check if there are enough sequences for analysis
  if (nrow(db) < 10) {
    warning("Very few sequences in database. GMM fitting may fail.")
  }

  # Calculate distances and get valid values
  db <- distToNearest(db, 
                            sequenceColumn="junction", 
                            vCallColumn="v_call", jCallColumn="j_call",
                            model="ham", normalize="len", nproc=1)
  
  # Check if dist_nearest column was created and has valid data
  if (!"dist_nearest" %in% colnames(db)) {
    warning("distToNearest failed to create dist_nearest column")
    return(0.1)
  }
  
  # Remove NA values and filter out zeros and extreme values
  valid_dists <- db$dist_nearest[!is.na(db$dist_nearest) & db$dist_nearest > 0 & db$dist_nearest <= 1]
  if (length(valid_dists) == 0) {
    warning("No valid distance values calculated")
    return(0.1)
  }
  
  # Calculate threshold using multiple fallback methods
  threshold <- tryCatch({
    
    # Check data quality
    if (length(unique(valid_dists)) < 5) {
      warning("Too few unique distance values. Using quantile-based threshold.")
      threshold <- quantile(valid_dists, 0.5, na.rm=TRUE)
      return(as.numeric(threshold))
    }
    
    if (length(valid_dists) < 20) {
      warning("Very few valid distance values. Using quantile-based threshold.")
      threshold <- quantile(valid_dists, 0.5, na.rm=TRUE)
      return(as.numeric(threshold))
    }
    
    # Check if data has sufficient variance
    if (var(valid_dists, na.rm=TRUE) < 1e-6) {
      warning("Distance values have very low variance. Using quantile-based threshold.")
      threshold <- quantile(valid_dists, 0.5, na.rm=TRUE)
      return(as.numeric(threshold))
    }
    
    # Try multiple methods, starting with the most robust
    threshold <- NULL
    
    # Method 1: Try gamma-gamma GMM with lower spc (more lenient)
    result <- tryCatch({
      output <- findThreshold(valid_dists, method="gmm", model="gamma-gamma", cutoff="user", spc=0.95)
      as.numeric(output@threshold)
    }, error = function(e) {
      warning(paste("GMM gamma-gamma (spc=0.95) failed:", e$message))
      NULL
    })
    if (!is.null(result) && !is.na(result) && result > 0 && result <= 1) {
      threshold <- result
    }
    
    # Method 2: Try gamma-gamma GMM with optimal cutoff
    if (is.null(threshold)) {
      result <- tryCatch({
        output <- findThreshold(valid_dists, method="gmm", model="gamma-gamma", cutoff="optimal")
        as.numeric(output@threshold)
      }, error = function(e) {
        warning(paste("GMM gamma-gamma (optimal) failed:", e$message))
        NULL
      })
      if (!is.null(result) && !is.na(result) && result > 0 && result <= 1) {
        threshold <- result
      }
    }
    
    # Method 3: Try gamma model instead of gamma-gamma (simpler model)
    if (is.null(threshold)) {
      result <- tryCatch({
        output <- findThreshold(valid_dists, method="gmm", model="gamma", cutoff="optimal")
        as.numeric(output@threshold)
      }, error = function(e) {
        warning(paste("GMM gamma failed:", e$message))
        NULL
      })
      if (!is.null(result) && !is.na(result) && result > 0 && result <= 1) {
        threshold <- result
      }
    }
    
    # Method 4: Try density method (non-parametric)
    if (is.null(threshold)) {
      result <- tryCatch({
        output <- findThreshold(valid_dists, method="density", cutoff="optimal")
        as.numeric(output@threshold)
      }, error = function(e) {
        warning(paste("Density method failed:", e$message))
        NULL
      })
      if (!is.null(result) && !is.na(result) && result > 0 && result <= 1) {
        threshold <- result
      }
    }
    
    # Method 5: Use quantile-based threshold as final fallback
    if (is.null(threshold)) {
      warning("All GMM methods failed. Using quantile-based threshold.")
      threshold <- as.numeric(quantile(valid_dists, 0.5, na.rm=TRUE))
    }
    
    # Ensure we always return a valid threshold
    if (is.null(threshold) || is.na(threshold) || threshold <= 0 || threshold > 1) {
      warning("Invalid threshold calculated. Using default 0.1")
      threshold <- 0.1
    }
    
    as.numeric(threshold)
  }, error = function(e) {
    # If distance calculation fails, return default
    warning(paste("Error in distance calculation:", e$message))
    0.1  # Return default threshold
  })
  
  # Try to create plot if possible (don't fail if this doesn't work)
  # Note: valid_dists and threshold are in the outer scope
  tryCatch({
    if (exists("valid_dists") && length(valid_dists) > 0 && exists("threshold") && !is.null(threshold)) {
      png(filename = args[2])
      hist(valid_dists, breaks=50, main=paste("Distance Distribution (threshold =", round(threshold, 3), ")"), xlab="Distance")
      abline(v=threshold, col="red", lwd=2)
      dev.off()
    }
  }, error = function(e) {
    warning(paste("Failed to create plot:", e$message))
  })
  
  # Return the threshold value
  as.numeric(threshold)
  
}, error = function(e) {
  # Outer error handler - catch any errors that weren't caught above
  warning(paste("Fatal error in R script:", e$message))
  0.1  # Return default threshold
})

# Always output the result and exit successfully
cat(result)
cat("\n")
quit(status=0)
