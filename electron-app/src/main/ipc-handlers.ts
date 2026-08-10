/**
 * IPC Handlers
 * 
 * Handles inter-process communication between main and renderer processes
 */

import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { BackendRunner } from './backend-runner';
import { loadResultsFromDisk } from './results-loader';
import { stageFromAirr, type AirrSampleTagAssignment } from './airr-staging';
import { checkDependencies, runFix, type FixAction } from './dependency-check';

interface AppPaths {
  backendDir: string;
  binDir: string;
  dataDir: string;
  /** Writable location for analysis runs; outside the .app once packaged. */
  outsDir: string;
  pythonPath: string;
  pythonIsBundled: boolean;
}

/** Where users get IQ-TREE 2, which AutoAB cannot install for them. */
const IQTREE_DOWNLOAD_URL = 'https://iqtree.github.io/#download';

/** Where users get R when AutoAB cannot install it for them. */
const R_DOWNLOAD_URL = process.platform === 'darwin'
  ? 'https://cran.r-project.org/bin/macosx/'
  : process.platform === 'win32'
    ? 'https://cran.r-project.org/bin/windows/base/'
    : 'https://cran.r-project.org/bin/linux/';


/**
 * The window to talk to right now, rather than the one that existed at startup.
 *
 * setupIpcHandlers runs once and captured `mainWindow` in a closure. On macOS
 * the red button destroys the window while the app stays in the dock, and
 * clicking the dock icon builds a new one; every send() then targeted a
 * destroyed object. The pipeline ran to completion and the renderer heard
 * nothing: no progress, no threshold request, no results, and the run
 * deadlocked with the overlay at 0%. Dialogs kept working because they resolve
 * the window from the event sender, which made the app look alive.
 */
function liveWindow(fallback: BrowserWindow | null): BrowserWindow | null {
  if (fallback && !fallback.isDestroyed()) return fallback;
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) || null;
}

export function setupIpcHandlers(
  mainWindow: BrowserWindow | null,
  backendRunner: BackendRunner,
  paths: AppPaths
): void {

  // Remove existing handlers to avoid duplicates
  ipcMain.removeHandler('dialog:selectDirectory');
  ipcMain.removeHandler('dialog:selectFile');
  ipcMain.removeHandler('dialog:saveFile');
  ipcMain.removeHandler('pipeline:stageFiles');
  ipcMain.removeHandler('pipeline:loadResults');
  ipcMain.removeHandler('pipeline:runPublicCloneAnalysis');
  ipcMain.removeHandler('pipeline:runCovidMatchingAnalysis');
  ipcMain.removeHandler('deps:check');
  ipcMain.removeHandler('deps:runFix');
  ipcMain.removeHandler('deps:openDownloadPage');

  // Dependencies: report what is installed and what is missing.
  ipcMain.handle('deps:check', async () => {
    return checkDependencies({
      pythonPath: paths.pythonPath,
      binDir: paths.binDir,
      dataDir: paths.dataDir,
      pythonIsBundled: paths.pythonIsBundled,
    });
  });

  // Dependencies: perform a repair, streaming installer output to the renderer.
  ipcMain.handle('deps:runFix', async (event, fix: FixAction) => {
    const sender = event.sender;
    const result = await runFix(fix, (line) => {
      if (!sender.isDestroyed()) sender.send('deps:fixLog', line);
    });
    return result;
  });

  // Dependencies: open CRAN in the user's browser.
  ipcMain.handle('deps:openDownloadPage', async (_event, which?: string) => {
    const url = which === 'download-iqtree' ? IQTREE_DOWNLOAD_URL : R_DOWNLOAD_URL;
    await shell.openExternal(url);
    return { success: true, url };
  });

  // Dialog: Select directory
  // Detects folder structure:
  //   Flat:    selected_dir/*.fasta  → files returned directly
  //   2-level: selected_dir/subdir/*.fasta → each subdir is a timepoint
  // No staging occurs here – staging happens at pipeline start.
  ipcMain.handle('dialog:selectDirectory', async (event) => {
    try {
      console.log('[IPC] dialog:selectDirectory called');
      const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
      
      if (!window) {
        console.error('[IPC] No window available for dialog');
        return null;
      }
      
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory'],
        title: 'Select FASTA Files Directory'
      });
      
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      
      const dirPath = result.filePaths[0];
      const isFasta = (f: string) => !f.startsWith('.') && (f.endsWith('.fasta') || f.endsWith('.fa'));
      const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

      // Helper: detect 10x filtered file pairs in a directory.
      // Returns matched pairs of *_filtered.fasta + *_filtered_annotations.csv.
      function detect10xPairs(dir: string): { fasta: string; annotations: string; prefix: string }[] {
        const entries = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
        const pairs: { fasta: string; annotations: string; prefix: string }[] = [];
        for (const f of entries) {
          if (!f.endsWith('_filtered.fasta')) continue;
          const prefix = f.replace(/_filtered\.fasta$/, '');
          const csvName = `${prefix}_filtered_annotations.csv`;
          if (entries.includes(csvName)) {
            pairs.push({ fasta: f, annotations: csvName, prefix });
          }
        }
        return pairs;
      }

      // 1. Check for 10x filtered file pairs in selected directory
      const tenxPairs = detect10xPairs(dirPath);
      if (tenxPairs.length > 0) {
        console.log(`[IPC] Detected ${tenxPairs.length} 10x filtered sample pairs in ${dirPath}`);
        return {
          path: dirPath,
          mode: '10x',
          fileCount: tenxPairs.length,
          files: tenxPairs.map(p => p.fasta),
          annotationFiles: tenxPairs.map(p => p.annotations),
          filePairs: tenxPairs.map(p => ({
            fasta: path.join(dirPath, p.fasta),
            annotations: path.join(dirPath, p.annotations)
          }))
        };
      }

      // 2. Check for plain FASTA files directly in the selected directory
      const topFiles = fs.readdirSync(dirPath).filter(isFasta);
      
      if (topFiles.length > 0) {
        return {
          path: dirPath,
          fileCount: topFiles.length,
          files: topFiles
        };
      }
      
      // 3. No files at top level, scan subdirectories as timepoints
      const topEntries = fs.readdirSync(dirPath)
        .filter(e => !e.startsWith('.') && isDir(path.join(dirPath, e)))
        .sort();
      
      if (topEntries.length === 0) {
        return { path: dirPath, fileCount: 0, files: [] };
      }
      
      interface DetectedTP { label: string; dir: string; files: string[]; }
      const detectedTimepoints: DetectedTP[] = [];
      let totalFiles = 0;
      
      for (const entry of topEntries) {
        const subPath = path.join(dirPath, entry);
        const subFasta = fs.readdirSync(subPath).filter(isFasta);
        if (subFasta.length > 0) {
          detectedTimepoints.push({
            label: entry,
            dir: subPath,
            files: subFasta
          });
          totalFiles += subFasta.length;
        }
      }
      
      if (detectedTimepoints.length === 0) {
        return { path: dirPath, fileCount: 0, files: [] };
      }
      
      console.log(`[IPC] Detected ${detectedTimepoints.length} timepoint subfolders with ${totalFiles} total FASTA files`);
      
      return {
        path: dirPath,
        fileCount: totalFiles,
        files: [],
        detectedTimepoints
      };
    } catch (error) {
      console.error('[IPC] Error in dialog:selectDirectory:', error);
      return null;
    }
  });

  // Dialog: Select file
  ipcMain.handle('dialog:selectFile', async (event, options?: { filters?: { name: string, extensions: string[] }[] }) => {
    const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!window) {
      console.error('[IPC] No window available for file dialog');
      return null;
    }
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: options?.filters || [
        { name: 'FASTA Files', extensions: ['fasta', 'fa'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    
    return result.filePaths[0];
  });

  // Dialog: Save file
  ipcMain.handle('dialog:saveFile', async (event, options?: { defaultPath?: string, filters?: { name: string, extensions: string[] }[] }) => {
    const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!window) {
      console.error('[IPC] No window available for save dialog');
      return null;
    }
    const result = await dialog.showSaveDialog(window, {
      defaultPath: options?.defaultPath,
      filters: options?.filters || [
        { name: 'TSV Files', extensions: ['tsv'] },
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (result.canceled || !result.filePath) {
      return null;
    }
    
    return result.filePath;
  });

  // Get app paths
  ipcMain.handle('app:getPaths', async () => {
    return {
      backend: paths.backendDir,
      bin: paths.binDir,
      data: paths.dataDir,
      userData: app.getPath('userData'),
      temp: app.getPath('temp')
    };
  });

  // Get default database paths
  ipcMain.handle('app:getDefaultDatabases', async () => {
    const imgtDir = path.join(paths.dataDir, 'IMGT_Human_Database');
    
    return {
      type: 'IMGT',
      v: path.join(imgtDir, 'Human_V.fasta'),
      d: path.join(imgtDir, 'Human_D.fasta'),
      j: path.join(imgtDir, 'Human_J.fasta')
    };
  });

  // Get bundled CoV-AbDab database path
  ipcMain.handle('app:getCovidDatabase', async () => {
    const covidDbPath = path.join(paths.dataDir, 'internal_data', 'CoV-AbDab_080224.csv');
    if (fs.existsSync(covidDbPath)) {
      return covidDbPath;
    }
    return null;
  });

  // Stage timepoint files into a flat directory for the pipeline.
  // Called right before pipeline:start. Returns the staging dir path.
  ipcMain.handle('pipeline:stageFiles', async (_event, timepoints: { label: string; files: string[]; annotationFiles?: string[] }[], studyName: string) => {
    try {
      const baseOuts = paths.outsDir;
      if (!fs.existsSync(baseOuts)) fs.mkdirSync(baseOuts, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const uniqueId = Math.random().toString(36).slice(2, 6);
      const stagingDir = path.join(baseOuts, `staging_${timestamp}_${uniqueId}`);
      fs.mkdirSync(stagingDir, { recursive: true });

      const timepointMapping: Record<string, { timepoint: string; originalFile: string; annotationFile?: string }> = {};
      const usedNames = new Set<string>();

      for (const tp of timepoints) {
        for (let fi = 0; fi < tp.files.length; fi++) {
          const filePath = tp.files[fi];
          const originalName = path.basename(filePath);
          
          let destName = `${tp.label}_${originalName}`;
          
          let counter = 2;
          while (usedNames.has(destName)) {
            destName = `${tp.label}_${counter}_${originalName}`;
            counter++;
          }
          usedNames.add(destName);

          const destFile = path.join(stagingDir, destName);
          if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, destFile);
            const mappingEntry: { timepoint: string; originalFile: string; annotationFile?: string } = {
              timepoint: tp.label,
              originalFile: originalName
            };

            // Copy paired annotation CSV if present
            const annPath = tp.annotationFiles?.[fi];
            if (annPath && fs.existsSync(annPath)) {
              const annOrigName = path.basename(annPath);
              const annDestName = `${tp.label}_${annOrigName}`;
              fs.copyFileSync(annPath, path.join(stagingDir, annDestName));
              mappingEntry.annotationFile = annDestName;
            }

            timepointMapping[destName] = mappingEntry;
          }
        }
      }

      // Save timepoint_mapping.json in staging dir (will be moved to output dir later)
      const mappingPath = path.join(stagingDir, 'timepoint_mapping.json');
      fs.writeFileSync(mappingPath, JSON.stringify(timepointMapping, null, 2), 'utf-8');

      // Save study_name.txt for reference
      fs.writeFileSync(path.join(stagingDir, 'study_name.txt'), studyName, 'utf-8');

      console.log(`[IPC] Staged ${Object.keys(timepointMapping).length} files from ${timepoints.length} timepoints into ${stagingDir}`);

      return { success: true, stagingDir, timepointMapping };
    } catch (error: any) {
      console.error('[IPC] Failed to stage files:', error);
      return { success: false, error: error.message };
    }
  });

  // Stage a BD Rhapsody AIRR TSV + SampleTag CSV into one staging dir per cohort.
  // Returns the list of per-cohort staging dirs so the orchestrator in
  // ReviewStart can run one pipeline per cohort, just like the FASTA flow.
  ipcMain.handle('pipeline:stageFromAirr', async (_event, input: {
    airrTsvPath: string;
    sampleTagCsvPath: string;
    tagAssignments: AirrSampleTagAssignment[];
    studyName: string;
  }) => {
    try {
      const outsDir = paths.outsDir;
      const result = await stageFromAirr({ ...input, outsDir });
      console.log('[IPC] stageFromAirr result:', {
        success: result.success,
        cohorts: result.cohorts?.map(c => ({ name: c.name, dir: c.stagingDir })),
        summary: result.summary
      });
      return result;
    } catch (error: any) {
      console.error('[IPC] stageFromAirr failed:', error);
      return { success: false, error: error.message };
    }
  });

  // Start analysis pipeline
  ipcMain.handle('pipeline:start', async (event, config: any) => {
    return new Promise((resolve, reject) => {
      // Create a unique output directory per run so sessions don't overwrite each other
      const baseOuts = paths.outsDir;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const uniqueId = Math.random().toString(36).slice(2, 6);
      const outputDir = path.join(baseOuts, `run_${timestamp}_${uniqueId}`);
      const configWithOutput = { ...config, output_dir: outputDir };
      console.log('[IPC] Pipeline output_dir:', outputDir);

      // Copy timepoint_mapping.json and study_name.txt from staging dir to output dir if present
      const fastaDir = config.fasta_dir;
      if (fastaDir) {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const srcMapping = path.join(fastaDir, 'timepoint_mapping.json');
        if (fs.existsSync(srcMapping)) {
          fs.copyFileSync(srcMapping, path.join(outputDir, 'timepoint_mapping.json'));
          console.log('[IPC] Copied timepoint_mapping.json to output dir');
        }
        const srcStudy = path.join(fastaDir, 'study_name.txt');
        if (fs.existsSync(srcStudy)) {
          fs.copyFileSync(srcStudy, path.join(outputDir, 'study_name.txt'));
        }
      }

      // Set up event forwarding to renderer
      const onProgress = (data: any) => {
        const tagged = config.cohort_type ? { ...data, cohort_type: config.cohort_type, cohort_name: config.cohort_name } : data;
        liveWindow(mainWindow)?.webContents.send('pipeline:progress', tagged);
      };
      
      const onLog = (data: any) => {
        liveWindow(mainWindow)?.webContents.send('pipeline:log', data);
      };
      
      const onResult = (data: any) => {
        const tagged = config.cohort_type ? { ...data, cohort_type: config.cohort_type, cohort_name: config.cohort_name } : data;
        liveWindow(mainWindow)?.webContents.send('pipeline:result', tagged);
      };
      
      const onThresholdRequest = (data: any) => {
        console.log('[IPC] onThresholdRequest callback called with:', data);
        const tagged = config.cohort_type ? { ...data, cohort_type: config.cohort_type, cohort_name: config.cohort_name } : data;
        liveWindow(mainWindow)?.webContents.send('pipeline:threshold-request', tagged);
        console.log('[IPC] Sent pipeline:threshold-request to renderer');
      };
      
      const onComplete = (data: any) => {
        // After pipeline completes, emit timepoint_mapping if it exists
        const tpMappingPath = path.join(outputDir, 'timepoint_mapping.json');
        if (fs.existsSync(tpMappingPath)) {
          try {
            const tpContent = fs.readFileSync(tpMappingPath, 'utf-8');
            const tpMapping = JSON.parse(tpContent);
            console.log('[IPC] Emitting timepoint_mapping artifact with', Object.keys(tpMapping).length, 'entries');
            liveWindow(mainWindow)?.webContents.send('pipeline:result', {
              artifact: 'timepoint_mapping',
              data: tpMapping
            });
          } catch (e) {
            console.warn('[IPC] Failed to emit timepoint_mapping:', e);
          }
        }
        
        const completeData = {
          ...data,
          cohort_type: config.cohort_type,
          cohort_name: config.cohort_name,
          output_dir: outputDir
        };
        liveWindow(mainWindow)?.webContents.send('pipeline:complete', completeData);
        resolve(completeData);
      };
      
      const onError = (error: Error) => {
        liveWindow(mainWindow)?.webContents.send('pipeline:error', { message: error.message });
        reject(error);
      };

      // Start the backend runner
      backendRunner.run(configWithOutput, {
        onProgress,
        onLog,
        onResult,
        onThresholdRequest,
        onComplete,
        onError
      });
    });
  });

  // Send threshold response to pipeline
  ipcMain.handle('pipeline:thresholdResponse', async (_, value: number | Record<string, number>) => {
    console.log('[IPC] Received threshold response:', value);
    backendRunner.sendThresholdResponse(value);
  });

  // Cancel pipeline
  ipcMain.handle('pipeline:cancel', async () => {
    backendRunner.cancel();
  });

  // Load results from disk (restore after sleep/minimize)
  // Uses pure Node/TS loader - no Python subprocess, guarantees correct directory
  // Optional: save previous session's study design before loading (outputDir + design)
  ipcMain.handle('pipeline:loadResults', async (event, outputDir: string, savePrevious?: { outputDir: string; design: any }, cohorts?: { cohortType: string; cohortName: string; outputDir: string }[]) => {
    const webContents = event.sender;
    const resolvedDir = path.resolve(outputDir);

    // Save previous session's study design in main process (guarantees correct path)
    if (savePrevious?.outputDir && savePrevious?.design) {
      try {
        const prevDir = path.resolve(savePrevious.outputDir);
        const designPath = path.join(prevDir, 'study_design.json');
        fs.writeFileSync(designPath, JSON.stringify(savePrevious.design, null, 2), 'utf-8');
        console.log('[IPC] Saved study design to', designPath);
      } catch (e) {
        console.warn('[IPC] Failed to save previous study design:', e);
      }
    }

    console.log('[IPC] Load results for:', resolvedDir, 'cohorts:', cohorts?.length ?? 0);

    return new Promise((resolve, reject) => {
      const send = (channel: string, data: any) => {
        try { webContents.send(channel, data); } catch (e) { console.warn('[IPC] Failed to send', channel, e); }
      };

      if (cohorts && cohorts.length > 0) {
        // Multi-cohort load: load each cohort's output dir separately, tagging results
        let completedCount = 0;
        const totalCohorts = cohorts.length;

        for (const cohort of cohorts) {
          const cohortDir = path.resolve(cohort.outputDir);
          console.log('[IPC] Loading cohort:', cohort.cohortType, cohort.cohortName, cohortDir);

          const tag = (data: any) => ({ ...data, cohort_type: cohort.cohortType, cohort_name: cohort.cohortName });

          loadResultsFromDisk(cohortDir, {
            onProgress: (data) => send('pipeline:progress', tag(data)),
            onLog: (data) => send('pipeline:log', data),
            onResult: (data) => send('pipeline:result', tag(data)),
            onComplete: (data) => {
              send('pipeline:complete', { ...tag(data), output_dir: cohortDir });
              completedCount++;
              if (completedCount >= totalCohorts) {
                resolve(data);
              }
            }
          });
        }
      } else {
        // Single-cohort / legacy load
        const onProgress = (data: any) => send('pipeline:progress', data);
        const onLog = (data: any) => send('pipeline:log', data);
        const onResult = (data: any) => send('pipeline:result', data);
        const onComplete = (data: any) => {
          send('pipeline:complete', data);
          resolve(data);
        };

        try {
          loadResultsFromDisk(resolvedDir, {
            onProgress,
            onLog,
            onResult,
            onComplete
          });
        } catch (err: any) {
          console.error('[IPC] Load results error:', err);
          send('pipeline:error', { message: err?.message ?? String(err) });
          send('pipeline:complete', { success: false, error: err?.message ?? String(err) });
          resolve({ success: false, error: err?.message ?? String(err) });
        }
      }
    });
  });

  // Run public clone analysis
  ipcMain.handle('pipeline:runPublicCloneAnalysis', async (event, config: any) => {
    console.log('[IPC] Running public clone analysis with config:', config);
    
    return new Promise((resolve, reject) => {
      // Set up event forwarding
      const onResult = (data: any) => {
        console.log('[IPC] Public clone result:', data);
        liveWindow(mainWindow)?.webContents.send('pipeline:publicCloneResult', data);
      };
      
      const onComplete = (data: any) => {
        console.log('[IPC] Public clone analysis complete');
        liveWindow(mainWindow)?.webContents.send('pipeline:publicCloneComplete', data);
        resolve(data);
      };
      
      const onError = (error: string) => {
        console.error('[IPC] Public clone analysis error:', error);
        liveWindow(mainWindow)?.webContents.send('pipeline:publicCloneError', error);
        reject(new Error(error));
      };
      
      // Run with action: public_clones
      backendRunner.runPublicCloneAnalysis(config, { onResult, onComplete, onError });
    });
  });

  ipcMain.handle('pipeline:runCovidMatchingAnalysis', async (event, config: any) => {
    console.log('[IPC] Running COVID matching analysis with config:', config);

    return new Promise((resolve, reject) => {
      const onResult = (data: any) => {
        console.log('[IPC] COVID matching result:', data);
        liveWindow(mainWindow)?.webContents.send('pipeline:covidMatchResult', data);
      };

      const onComplete = (data: any) => {
        console.log('[IPC] COVID matching analysis complete');
        liveWindow(mainWindow)?.webContents.send('pipeline:covidMatchComplete', data);
        resolve(data);
      };

      const onError = (error: string) => {
        console.error('[IPC] COVID matching analysis error:', error);
        liveWindow(mainWindow)?.webContents.send('pipeline:covidMatchError', error);
        reject(new Error(error));
      };

      backendRunner.runCovidMatchingAnalysis(config, { onResult, onComplete, onError });
    });
  });

  // Read file contents
  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    try {
      console.log('[IPC] Reading file:', filePath);
      const data = fs.readFileSync(filePath, 'utf-8');
      console.log('[IPC] Successfully read file, length:', data.length);
      return { success: true, data };
    } catch (error: any) {
      console.error('[IPC] Failed to read file:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Write file contents
  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Write binary file contents (for zip export etc.)
  ipcMain.handle('fs:writeBinaryFile', async (_, filePath: string, base64Data: string) => {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(filePath, buffer);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Copy file
  ipcMain.handle('fs:copyFile', async (_, sourcePath: string, destPath: string) => {
    try {
      fs.copyFileSync(sourcePath, destPath);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Check if file exists
  ipcMain.handle('fs:exists', async (_, filePath: string) => {
    return fs.existsSync(filePath);
  });

  // Read directory
  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
    try {
      const files = fs.readdirSync(dirPath);
      return { success: true, files };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Get image as base64
  ipcMain.handle('fs:readImageBase64', async (_, imagePath: string) => {
    try {
      const buffer = fs.readFileSync(imagePath);
      const base64 = buffer.toString('base64');
      const ext = path.extname(imagePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 
                       ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 
                       'image/png';
      return { success: true, data: `data:${mimeType};base64,${base64}` };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}

