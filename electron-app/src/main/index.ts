/**
 * Electron Main Process
 * 
 * Handles window management, app lifecycle, and IPC communication
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { setupIpcHandlers } from './ipc-handlers';
import { BackendRunner } from './backend-runner';

// Keep a global reference of the window object to prevent garbage collection
let mainWindow: BrowserWindow | null = null;
let backendRunner: BackendRunner | null = null;

/**
 * Unpackaged: resources sit in the repo tree rather than under
 * process.resourcesPath. True for `npm run dev` and `npm run preview` alike.
 */
const isDev = !app.isPackaged;

/**
 * Load the renderer from the Vite dev server instead of the built files.
 *
 * Kept separate from isDev: both are unpackaged, but `npm run preview` builds
 * the renderer and expects to load it from disk. Conflating the two made
 * preview always point at a dev server that isn't running.
 */
const useDevServer = process.env.NODE_ENV !== 'production'
  && (process.env.NODE_ENV === 'development' || !app.isPackaged);

function getResourcesPath(): string {
  if (isDev) {
    return path.join(__dirname, '..', '..');
  }
  return process.resourcesPath;
}

function getBackendPath(): string {
  const resourcesPath = getResourcesPath();
  if (isDev) {
    return path.join(resourcesPath, '..', 'backend');
  }
  return path.join(resourcesPath, 'backend');
}

function getBinPath(): string {
  const resourcesPath = getResourcesPath();
  if (isDev) {
    return path.join(resourcesPath, '..', 'geneGUI', 'bin');
  }
  return path.join(resourcesPath, 'bin');
}

function getDataPath(): string {
  const resourcesPath = getResourcesPath();
  if (isDev) {
    return path.join(resourcesPath, '..', 'geneGUI', 'data');
  }
  return path.join(resourcesPath, 'data');
}

/**
 * BLAST+ cannot cope with whitespace in any path it is given.
 *
 * It re-parses its own arguments and splits on spaces, so quoting and argv
 * separation do not help: `-in` reports "File /Users/x/Library/Application does
 * not exist" and `-out` reports "Please provide a database name using -out".
 * That rules out ~/Library/Application Support, which is where Electron's
 * userData lives, for anything the aligner touches.
 */
function hasWhitespace(p: string): boolean {
  return /\s/.test(p);
}

/**
 * Generated BLAST indexes.
 *
 * In a checkout these have always lived beside the reference FASTAs, and
 * .gitignore already covers them there. Once packaged that location is inside
 * the read-only bundle, where makeblastdb failed for every database.
 */
function getCachePath(): string {
  // ~/Library/Caches has no space in it, unlike userData's parent.
  // Electron has no 'cache' path name, so build it from home.
  let dir = isDev
    ? getDataPath()
    : process.platform === 'darwin'
      ? path.join(app.getPath('home'), 'Library', 'Caches', 'com.bcr-analysis.app')
      : path.join(app.getPath('userData'), 'cache');

  if (hasWhitespace(dir)) dir = path.join(os.tmpdir(), 'autoab-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where analysis runs are written.
 *
 * Unlike the resource directories this one is written to, so once packaged it
 * must live outside the .app: an application installed in /Applications is not
 * writable by the user running it. Deriving it from the backend directory put
 * results inside Contents/Resources, which only worked because the app was
 * still sitting in its build folder.
 *
 * ~/Documents/AutoAB rather than userData: it has no space in it, and results
 * are something the user should be able to find.
 */
function getOutsPath(): string {
  let dir = isDev
    ? path.join(getResourcesPath(), '..', 'geneGUI', 'outs')
    : path.join(app.getPath('home'), 'Documents', 'AutoAB');

  if (hasWhitespace(dir)) dir = path.join(os.tmpdir(), 'autoab-runs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow(): void {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: (() => {
        const preloadPath = path.resolve(__dirname, '..', 'preload', 'index.js');
        if (!fs.existsSync(preloadPath)) {
          // Fallback for dev mode
          const fallback = path.join(process.cwd(), 'dist', 'preload', 'index.js');
          if (fs.existsSync(fallback)) {
            console.log('[Main] Using fallback preload path:', fallback);
            return fallback;
          }
        }
        return preloadPath;
      })(),
      sandbox: false
    },
    show: false // Don't show until ready
  });

  // Log preload path for debugging
  const preloadPath = path.resolve(__dirname, '..', 'preload', 'index.js');
  console.log('[Main] Preload path:', preloadPath);
  console.log('[Main] Preload exists:', fs.existsSync(preloadPath));
  console.log('[Main] __dirname:', __dirname);
  console.log('[Main] isDev:', isDev);
  
  if (!fs.existsSync(preloadPath)) {
    console.error('[Main] ERROR: Preload script not found at:', preloadPath);
    // Try alternative paths
    const altPath1 = path.join(process.cwd(), 'dist', 'preload', 'index.js');
    const altPath2 = path.join(__dirname, 'preload', 'index.js');
    console.log('[Main] Trying alternative path 1:', altPath1, 'exists:', fs.existsSync(altPath1));
    console.log('[Main] Trying alternative path 2:', altPath2, 'exists:', fs.existsSync(altPath2));
  }
  
  // Load the app
  if (useDevServer) {
    mainWindow.loadURL('http://localhost:5173');
    if (!process.env.AUTOAB_NO_DEVTOOLS) mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  
  // Debug: Check if preload script loaded
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Window finished loading');
    // Wait a moment for preload to finish
    setTimeout(() => {
      mainWindow?.webContents.executeJavaScript(`
        console.log('[Renderer] window.electronAPI:', window.electronAPI);
        console.log('[Renderer] typeof window.electronAPI:', typeof window.electronAPI);
        console.log('[Renderer] window keys:', Object.keys(window));
        if (window.electronAPI) {
          console.log('[Renderer] electronAPI methods:', Object.keys(window.electronAPI));
        } else {
          console.error('[Renderer] ERROR: electronAPI is not available!');
        }
      `).catch(err => console.error('[Main] Error executing debug script:', err));
    }, 500);
  });
  
  // Check for preload script errors - this is the key event!
  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error('[Main] ===== PRELOAD SCRIPT ERROR =====');
    console.error('[Main] Preload path:', preloadPath);
    console.error('[Main] Error:', error);
    console.error('[Main] =================================');
  });
  
  // Listen for all console messages
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const source = sourceId ? String(sourceId) : 'unknown';
    if (source.includes('preload') || message.includes('[Preload]')) {
      console.log(`[Preload ${level}]:`, message);
    }
  });
  
  // Also log when the preload script starts
  mainWindow.webContents.on('did-attach-webview', () => {
    console.log('[Main] Webview attached');
  });

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Kill any running backend process
    if (backendRunner) {
      backendRunner.cancel();
      backendRunner = null;
    }
  });

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Put the usual command-line locations back on PATH.
 *
 * An app launched from Finder inherits launchd's PATH, which is
 * /usr/bin:/bin:/usr/sbin:/sbin and nothing else. It never sees the user's
 * shell profile. R installs to /usr/local/bin, so without this the app reports
 * "R is not installed" to everyone who has a perfectly good CRAN install, and
 * offers to download it again. Launching from a terminal hides the problem
 * entirely, which is why it survived testing.
 */
function augmentProcessPath(): void {
  if (process.platform === 'win32') return;

  const extras = [
    '/usr/local/bin',                                  // CRAN R, and most installers
    '/opt/homebrew/bin',                               // Homebrew on Apple Silicon
    '/opt/local/bin',                                  // MacPorts
    '/Library/Frameworks/R.framework/Resources/bin',   // R.framework directly
    path.join(os.homedir(), '.local', 'bin'),
  ];

  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const missing = extras.filter(p => !current.includes(p) && fs.existsSync(p));
  if (missing.length) {
    process.env.PATH = [...current, ...missing].join(path.delimiter);
    console.log('[Main] Added to PATH:', missing.join(', '));
  }
}

/**
 * The interpreter that ships inside the app, built by scripts/bundle-python.sh.
 *
 * Packaged, it lands at Resources/python. Unpackaged it sits per-architecture
 * under electron-app/runtime/, because a cross-built Intel runtime has to be
 * able to coexist with the native one.
 *
 * Returns null when no runtime was bundled, which is the normal state of a
 * fresh checkout: the script has to be run once before packaging.
 */
function getBundledPythonPath(): string | null {
  const exe = process.platform === 'win32' ? 'python.exe' : 'python3';
  const candidate = isDev
    ? path.join(getResourcesPath(), 'runtime', process.arch, 'python', 'bin', exe)
    : path.join(process.resourcesPath, 'python', 'bin', exe);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Locate a Python interpreter that has the pipeline's dependencies installed.
 *
 * The bundled runtime wins whenever it is present, so a packaged app never
 * depends on what the user happens to have installed. Failing that, the
 * pipeline needs the interpreter that owns changeo/presto, which is not
 * necessarily the first `python3` on PATH, a machine can easily have several.
 * Candidates are probed in order and the first one that can import changeo
 * wins. AUTOAB_PYTHON overrides the search entirely.
 */
function resolvePythonPath(): string {
  const override = process.env.AUTOAB_PYTHON;
  if (override) return override;

  const candidates: string[] = [];

  const bundled = getBundledPythonPath();
  if (bundled) candidates.push(bundled);

  // An activated conda environment is the documented install path, so it wins.
  if (process.env.CONDA_PREFIX) {
    candidates.push(path.join(process.env.CONDA_PREFIX, 'bin', process.platform === 'win32' ? 'python.exe' : 'python'));
  }
  for (const envName of ['autoab', 'bcr-analysis']) {
    for (const base of [path.join(os.homedir(), 'miniforge3'), path.join(os.homedir(), 'miniconda3'), path.join(os.homedir(), 'anaconda3')]) {
      candidates.push(path.join(base, 'envs', envName, 'bin', 'python'));
    }
  }

  candidates.push(...(process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python3.13', 'python3.12', 'python3.11', '/usr/local/bin/python3', '/opt/homebrew/bin/python3']));

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-c', 'import changeo, presto'], { stdio: 'ignore' });
      if (probe.status === 0) {
        console.log('[Main] Using Python interpreter:', candidate);
        return candidate;
      }
    } catch {
      // candidate not executable, try the next one
    }
  }

  console.warn(
    bundled
      ? `[Main] Bundled runtime at ${bundled} cannot import changeo/presto and no system Python could either.`
      : '[Main] No bundled runtime (run scripts/bundle-python.sh) and no system Python with changeo/presto.'
  );
  return process.platform === 'win32' ? 'python' : 'python3';
}

// Initialize the backend runner
function initBackendRunner(): void {
  const backendPath = getBackendPath();
  const binPath = getBinPath();
  const dataPath = getDataPath();

  backendRunner = new BackendRunner({
    backendDir: backendPath,
    binDir: binPath,
    dataDir: dataPath,
    outsDir: getOutsPath(),
    cacheDir: getCachePath(),
    pythonPath: resolvePythonPath()
  });
}

// App lifecycle
app.whenReady().then(() => {
  // Before anything looks for R or Python: a Finder launch starts with
  // launchd's bare PATH.
  augmentProcessPath();

  initBackendRunner();
  
  // Create window first
  createWindow();
  
  // Setup IPC handlers with the created window
  setupIpcHandlers(mainWindow, backendRunner!, {
    backendDir: getBackendPath(),
    binDir: getBinPath(),
    dataDir: getDataPath(),
    outsDir: getOutsPath(),
    pythonPath: resolvePythonPath(),
    pythonIsBundled: getBundledPythonPath() !== null
  });

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up before quitting
app.on('before-quit', () => {
  if (backendRunner) {
    backendRunner.cancel();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

export { mainWindow, backendRunner };

