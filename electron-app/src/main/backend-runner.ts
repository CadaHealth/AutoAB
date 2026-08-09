/**
 * Backend Runner
 * 
 * Spawns Python pipeline process and handles NDJSON communication
 */

import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';

interface BackendRunnerOptions {
  backendDir: string;
  binDir: string;
  dataDir: string;
  pythonPath?: string;
}

/** Cached Python user-base bin lookup, keyed by pythonPath. */
const userBinCache = new Map<string, string | null>();

/**
 * Ask Python where the user-installed scripts live (pip --user / pep370).
 * On macOS this is typically ~/Library/Python/<ver>/bin/. Change-O's
 * `MakeDb.py`, `DefineClones.py`, etc. land there.
 *
 * Cached per pythonPath so we don't re-invoke Python on every spawn.
 */
function pythonUserBin(pythonPath: string | undefined): string | null {
  const py = pythonPath || 'python3';
  if (userBinCache.has(py)) return userBinCache.get(py)!;
  try {
    // Ask Python where it puts console scripts rather than assuming 'bin':
    // Windows uses <user-base>\PythonXY\Scripts, POSIX uses <user-base>/bin.
    const probe = 'import sysconfig,os;'
      + "print(sysconfig.get_path('scripts', os.name + '_user') or '');"
      + "print(sysconfig.get_path('scripts') or '')";
    const out = execFileSync(py, ['-c', probe], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    }).trim();

    const result = out.split(/\r?\n/).map(l => l.trim()).find(l => l && fs.existsSync(l)) || null;
    userBinCache.set(py, result);
    return result;
  } catch (_) {
    userBinCache.set(py, null);
    return null;
  }
}

/**
 * Build the PATH for spawned Python processes. The Python subprocess calls
 * out to Change-O's console scripts (MakeDb.py, DefineClones.py, etc.),
 * which on a typical macOS install are at `~/Library/Python/<ver>/bin/`.
 *
 *   1. binDir (igblast, etc., bundled with the app)
 *   2. Python user-installed scripts bin (from `python -m site --user-base`)
 *   3. parent of pythonPath if set (the Python framework's own bin)
 *   4. /opt/homebrew/bin, /usr/local/bin (common Homebrew/conda spots)
 *   5. process.env.PATH (inherited from the user's shell)
 *
 * Optional override: BCR_EXTRA_PATH env var, prepended.
 */
function buildSpawnPath(binDir: string, pythonPath?: string): string {
  const parts: string[] = [binDir];
  if (process.env.BCR_EXTRA_PATH) parts.unshift(process.env.BCR_EXTRA_PATH);

  // Python user-base bin, where pip --user scripts (changeo, presto) live
  const userBin = pythonUserBin(pythonPath);
  if (userBin) parts.push(userBin);

  // Parent of the Python interpreter (where some envs put scripts)
  if (pythonPath) {
    const pyBin = path.dirname(pythonPath);
    if (fs.existsSync(pyBin)) parts.push(pyBin);
  }

  // Common Homebrew / conda locations
  for (const candidate of ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), 'miniconda3/bin'), path.join(os.homedir(), 'anaconda3/bin')]) {
    if (fs.existsSync(candidate)) parts.push(candidate);
  }

  if (process.env.PATH) parts.push(process.env.PATH);
  return parts.join(path.delimiter);
}

/**
 * Environment for a spawned pipeline process, with PATH set safely.
 *
 * Windows environment keys are case-insensitive but a plain object spread
 * preserves the original casing ('Path'), so assigning 'PATH' on top would
 * leave two competing keys and let the OS pick. Strip any case-variant first.
 */
function spawnEnv(binDir: string, pythonPath: string | undefined, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = buildSpawnPath(binDir, pythonPath);
  return env;
}

interface PipelineConfig {
  fasta_dir: string;
  clean_fasta: boolean;
  database_type: 'IMGT' | 'Custom';
  database_v?: string;
  database_d?: string;
  database_j?: string;
  database_c?: string;
  output_dir?: string;
  clone_mode?: 'allele' | 'gene';
  linkage_method?: 'single' | 'average' | 'complete';
  run_covid_matching?: boolean;
  cov_abdab_database_path?: string;
  cohort_type?: string;
  cohort_name?: string;
}

interface RunCallbacks {
  onProgress: (data: { stage: string; percent: number; message: string }) => void;
  onLog: (data: { level: string; message: string }) => void;
  onResult: (data: { artifact: string; path?: string; data?: any }) => void;
  onThresholdRequest: (data: { calculated: number; timepoint_thresholds?: { label: string; calculated: number; plot_base64?: string }[] }) => void;
  onComplete: (data: { success: boolean; error?: string }) => void;
  onError: (error: Error) => void;
}

export class BackendRunner {
  private options: BackendRunnerOptions;
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;

  constructor(options: BackendRunnerOptions) {
    this.options = {
      pythonPath: 'python3',
      ...options
    };
  }

  /**
   * Run the analysis pipeline
   */
  run(config: PipelineConfig, callbacks: RunCallbacks): void {
    // Close stale readline interface from a previous run (process already exited
    // but its exit handler hasn't fired yet, or was replaced before cleanup)
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    const pipelineScript = path.join(this.options.backendDir, 'pipeline_runner.py');
    
    // Prepare environment
    const env = spawnEnv(this.options.binDir, this.options.pythonPath, {
      IGDATA: this.options.dataDir
    });

    // Spawn Python process with detached flag to create a new process group
    // This allows us to kill all child processes (IgBLAST, R scripts, etc.)
    this.process = spawn(this.options.pythonPath!, [pipelineScript], {
      cwd: this.options.backendDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true  // Create new process group
    });

    // Capture reference so the exit handler only cleans up *this* process,
    // not a newer one that may have been spawned in the meantime (multi-cohort).
    const spawnedProcess = this.process;

    // Track whether onComplete was already called via NDJSON 'complete' message,
    // so the exit handler doesn't fire a duplicate (which would close the UI
    // prematurely during multi-cohort runs).
    let completeCalled = false;
    const wrappedCallbacks: RunCallbacks = {
      ...callbacks,
      onComplete: (data: any) => {
        completeCalled = true;
        callbacks.onComplete(data);
      }
    };

    // Unref the process so it doesn't keep the Node process alive
    this.process.unref();

    if (!this.process.stdout || !this.process.stdin) {
      callbacks.onError(new Error('Failed to create process streams'));
      return;
    }

    // Set up line reader for NDJSON output
    this.rl = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    });

    const spawnedRl = this.rl;

    // Handle each line of NDJSON output
    this.rl.on('line', (line: string) => {
      this.handleMessage(line, wrappedCallbacks);
    });

    // Handle stderr for debugging
    this.process.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      console.error('[Backend stderr]:', message);
      // Forward as log message
      callbacks.onLog({ level: 'debug', message: `[stderr] ${message}` });
    });

    // Handle process exit
    this.process.on('exit', (code: number | null, signal: string | null) => {
      console.log(`Backend process exited with code ${code}, signal ${signal}`);

      // Only clean up if this.process still points to the process that exited.
      // During multi-cohort runs a new process may already have been spawned,
      // and we must not kill it.
      if (this.process === spawnedProcess) {
        this.process = null;
      }
      if (this.rl === spawnedRl) {
        spawnedRl.close();
        this.rl = null;
      }

      // Only emit a failure-complete if onComplete wasn't already called via NDJSON.
      // Otherwise the duplicate complete event would reset the UI mid multi-cohort run.
      if (code !== 0 && code !== null && !completeCalled) {
        callbacks.onComplete({
          success: false,
          error: `Process exited with code ${code}`
        });
      }
    });

    // Handle process errors
    this.process.on('error', (error: Error) => {
      console.error('Backend process error:', error);
      callbacks.onError(error);
      if (this.process === spawnedProcess) {
        this.cleanup();
      }
    });

    // Send the configuration to start the pipeline
    const startMessage = JSON.stringify({
      action: 'run',
      config: {
        ...config,
        backend_dir: this.options.backendDir,
        bin_dir: this.options.binDir,
        data_dir: this.options.dataDir
      }
    });

    this.process.stdin.write(startMessage + '\n');
  }

  /**
   * Handle a single NDJSON message from the backend
   */
  private handleMessage(line: string, callbacks: RunCallbacks): void {
    // Skip empty lines
    if (!line || !line.trim()) {
      return;
    }
    
    try {
      const message = JSON.parse(line);
      console.log('[BackendRunner] Parsed message type:', message.type);
      
      switch (message.type) {
        case 'progress':
          callbacks.onProgress({
            stage: message.stage,
            percent: message.percent,
            message: message.message
          });
          break;
          
        case 'log':
          callbacks.onLog({
            level: message.level,
            message: message.message
          });
          break;
          
        case 'result':
          callbacks.onResult({
            artifact: message.artifact,
            path: message.path,
            data: message.data
          });
          break;
          
        case 'threshold_request':
          console.log('[BackendRunner] Received threshold_request message:', message);
          callbacks.onThresholdRequest({
            calculated: message.calculated ?? 0,
            timepoint_thresholds: message.timepoint_thresholds
          });
          break;
          
        case 'complete':
          callbacks.onComplete({
            success: message.success,
            error: message.error
          });
          break;
          
        default:
          console.warn('Unknown message type:', message.type);
      }
    } catch (error) {
      // Not valid JSON, might be raw output
      console.log('[Backend raw]:', line);
    }
  }

  /**
   * Send threshold response to the backend
   */
  sendThresholdResponse(value: number | Record<string, number>): void {
    console.log('[BackendRunner] Sending threshold response:', value);
    if (this.process?.stdin && !this.process.stdin.destroyed) {
      let response: string;
      if (typeof value === 'object' && value !== null) {
        // Multi-timepoint: {thresholds: {T1: 0.12, T2: 0.15, ...}}
        response = JSON.stringify({
          type: 'threshold_response',
          thresholds: value
        });
      } else {
        // Single value (legacy)
        response = JSON.stringify({
          type: 'threshold_response',
          value
        });
      }
      console.log('[BackendRunner] Writing to stdin:', response);
      this.process.stdin.write(response + '\n', (err) => {
        if (err) {
          console.error('[BackendRunner] Error writing to stdin:', err);
        } else {
          console.log('[BackendRunner] Successfully wrote threshold response to stdin');
        }
      });
    } else {
      console.error('[BackendRunner] ERROR: No stdin available or stdin destroyed!');
    }
  }

  /**
   * Load results from disk (restore after app sleep/minimize)
   */
  runLoadResults(outputDir: string, callbacks: RunCallbacks): void {
    this.cleanup(); // Ensure no previous process is running
    const pipelineScript = path.join(this.options.backendDir, 'pipeline_runner.py');
    
    const env = spawnEnv(this.options.binDir, this.options.pythonPath, {
      IGDATA: this.options.dataDir,
      PYTHONUNBUFFERED: '1'  // Ensure Python flushes stdout immediately
    });

    this.process = spawn(this.options.pythonPath!, [pipelineScript], {
      cwd: this.options.backendDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });

    this.process.unref();

    if (!this.process.stdout || !this.process.stdin) {
      callbacks.onError(new Error('Failed to create process streams'));
      return;
    }

    this.rl = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    });

    this.rl.on('line', (line: string) => {
      this.handleMessage(line, callbacks);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      callbacks.onLog({ level: 'debug', message: `[stderr] ${data.toString()}` });
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      console.log(`Load results process exited with code ${code}, signal ${signal}`);
      this.cleanup();
      if (code !== 0 && code !== null) {
        callbacks.onComplete({ success: false, error: `Process exited with code ${code}` });
      }
    });

    this.process.on('error', (error: Error) => {
      callbacks.onError(error);
      this.cleanup();
    });

    const startMessage = JSON.stringify({
      action: 'load_results',
      config: { output_dir: outputDir }
    });
    this.process.stdin.write(startMessage + '\n');
  }

  /**
   * Run public clone analysis
   */
  runPublicCloneAnalysis(
    config: any,
    handlers: { onResult: Function; onComplete: Function; onError: Function }
  ): void {
    const pipelineScript = path.join(this.options.backendDir, 'pipeline_runner.py');
    
    // Prepare environment
    const env = spawnEnv(this.options.binDir, this.options.pythonPath, {
      IGDATA: this.options.dataDir
    });

    // Spawn Python process with detached flag to create a new process group
    // This allows us to kill all child processes (IgBLAST, R scripts, etc.)
    this.process = spawn(this.options.pythonPath!, [pipelineScript], {
      cwd: this.options.backendDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true  // Create new process group
    });

    if (!this.process.stdout || !this.process.stdin) {
      handlers.onError('Failed to create process streams');
      return;
    }

    // Set up line reader for NDJSON output
    this.rl = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    });

    // Handle each line of NDJSON output
    this.rl.on('line', (line: string) => {
      if (!line || !line.trim()) return;
      
      try {
        const message = JSON.parse(line);
        console.log('[PublicClones] Message type:', message.type);
        
        if (message.type === 'result' && message.artifact === 'public_clones') {
          handlers.onResult(message);
        } else if (message.type === 'complete') {
          handlers.onComplete(message);
        } else if (message.type === 'log') {
          console.log(`[PublicClones ${message.level}]:`, message.message);
        } else if (message.type === 'progress') {
          console.log(`[PublicClones Progress]: ${message.percent}% - ${message.message}`);
        }
      } catch (error) {
        console.log('[PublicClones raw]:', line);
      }
    });

    // Handle stderr
    this.process.stderr?.on('data', (data: Buffer) => {
      console.error('[PublicClones stderr]:', data.toString());
    });

    // Handle process exit
    this.process.on('exit', (code: number | null) => {
      console.log(`PublicClones process exited with code ${code}`);
      this.cleanup();
      
      if (code !== 0 && code !== null) {
        handlers.onError(`Process exited with code ${code}`);
      }
    });

    // Handle process errors
    this.process.on('error', (error: Error) => {
      console.error('PublicClones process error:', error);
      handlers.onError(error.message);
      this.cleanup();
    });

    // Send the configuration
    const startMessage = JSON.stringify({
      action: 'public_clones',
      config: {
        output_dir: config.output_dir,
        mode: config.mode || 'lenient',
        similarity_threshold: config.similarity_threshold || 0.85,
        max_mismatches: config.max_mismatches || 2,
        top_n: config.top_n || 10
      }
    });

    console.log('[PublicClones] Sending config:', startMessage);
    this.process.stdin.write(startMessage + '\n');
  }

  /**
   * Run COVID database matching analysis on existing results.
   */
  runCovidMatchingAnalysis(
    config: any,
    handlers: { onResult: Function; onComplete: Function; onError: Function }
  ): void {
    // Kill any previous subprocess before starting a new one. Sequential calls
    // (e.g. disease → control, top_n → public_clones) race against the previous
    // process's exit handler otherwise, which can null out the new process's
    // state and swallow its 'complete' message, the UI then hangs waiting.
    this.cleanup();

    const pipelineScript = path.join(this.options.backendDir, 'pipeline_runner.py');

    const env = spawnEnv(this.options.binDir, this.options.pythonPath, {
      IGDATA: this.options.dataDir
    });

    const child = spawn(this.options.pythonPath!, [pipelineScript], {
      cwd: this.options.backendDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    this.process = child;

    if (!child.stdout || !child.stdin) {
      handlers.onError('Failed to create process streams');
      return;
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });
    this.rl = rl;

    rl.on('line', (line: string) => {
      if (!line || !line.trim()) return;
      try {
        const message = JSON.parse(line);
        console.log('[CovidMatching] Message type:', message.type);
        if (message.type === 'result' && message.artifact === 'covid_matches') {
          handlers.onResult(message);
        } else if (message.type === 'complete') {
          handlers.onComplete(message);
        } else if (message.type === 'log') {
          console.log(`[CovidMatching ${message.level}]:`, message.message);
        } else if (message.type === 'progress') {
          console.log(`[CovidMatching Progress]: ${message.percent}% - ${message.message}`);
        }
      } catch (error) {
        console.log('[CovidMatching raw]:', line);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      console.error('[CovidMatching stderr]:', data.toString());
    });

    child.on('exit', (code: number | null) => {
      console.log(`CovidMatching process exited with code ${code}`);
      // Only null out shared state if we're still the current process; otherwise
      // a stale exit handler would wipe out the newly spawned subprocess.
      if (this.process === child) {
        try { rl.close(); } catch (_) {}
        this.rl = null;
        this.process = null;
      }
      if (code !== 0 && code !== null) {
        handlers.onError(`Process exited with code ${code}`);
      }
    });

    child.on('error', (error: Error) => {
      console.error('CovidMatching process error:', error);
      handlers.onError(error.message);
      if (this.process === child) {
        try { rl.close(); } catch (_) {}
        this.rl = null;
        this.process = null;
      }
    });

    // Forward the full config (mode + specific_clone_ids) so the Python side
    // can distinguish top-N runs from public-clones runs. Earlier versions
    // dropped these fields, silently collapsing every call into a top-N run.
    const pyConfig: Record<string, any> = {
      output_dir: config.output_dir,
      cov_abdab_database_path: config.cov_abdab_database_path,
      top_n_clones: config.top_n_clones || 20
    };
    if (config.mode) pyConfig.mode = config.mode;
    if (config.specific_clone_ids) pyConfig.specific_clone_ids = config.specific_clone_ids;

    const startMessage = JSON.stringify({
      action: 'covid_matching',
      config: pyConfig
    });

    console.log('[CovidMatching] Sending config:', startMessage);
    child.stdin.write(startMessage + '\n');
  }

  /**
   * Cancel the running pipeline
   */
  cancel(): void {
    console.log('[BackendRunner] Cancel requested');
    
    if (this.process) {
      // Send cancel message to backend
      try {
        this.process.stdin?.write(JSON.stringify({ type: 'cancel' }) + '\n');
        console.log('[BackendRunner] Sent cancel message to backend');
      } catch (e) {
        console.warn('[BackendRunner] Failed to send cancel message:', e);
      }
      
      // Kill entire process group immediately
      // Using negative PID kills all processes in the group (Python + all child processes)
      const pid = this.process.pid;
      if (pid) {
        try {
          console.log('[BackendRunner] Killing process group:', pid);
          // Kill the entire process group with SIGKILL (immediate termination)
          process.kill(-pid, 'SIGKILL');
          console.log('[BackendRunner] Process group killed');
        } catch (e: any) {
          console.warn('[BackendRunner] Failed to kill process group, trying individual kill:', e.message);
          // Fallback: kill just the main process
          this.process.kill('SIGKILL');
        }
      }
    }
    
    // Cleanup resources
    this.cleanup();
  }

  /**
   * Clean up resources and kill any running process (e.g. load_results).
   * Prevents stale results from overwriting a newly requested session.
   */
  private cleanup(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.process) {
      const pid = this.process.pid;
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch (_) { /* process may already be dead */ }
      this.process = null;
    }
  }

  /**
   * Check if a process is running
   */
  isRunning(): boolean {
    return this.process !== null;
  }
}

