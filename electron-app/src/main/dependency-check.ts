/**
 * Runtime dependency inspection, and the repairs the app can perform itself.
 *
 * AutoAB ships its own Python, IgBLAST and reference data, so the only thing a
 * user has to supply is R. This module works out what is actually present and,
 * where possible, offers to fix it without sending the user to a terminal.
 */

import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** R packages the pipeline's scripts load. Keep in sync with backend/scripts/*.R. */
export const REQUIRED_R_PACKAGES = ['alakazam', 'shazam', 'ape', 'jsonlite'];

export type CheckStatus = 'ok' | 'missing' | 'error';

/** A repair the app can carry out on the user's behalf. */
export type FixAction = 'install-rosetta' | 'install-r-packages' | 'download-r';

export interface DependencyItem {
  id: string;
  label: string;
  status: CheckStatus;
  /** Whether analysis is impossible without it. */
  required: boolean;
  /** Version or path, shown when things are fine. */
  detail?: string;
  /** What is wrong, in the user's terms. */
  problem?: string;
  fix?: FixAction;
}

export interface DependencyReport {
  ok: boolean;
  items: DependencyItem[];
  platform: string;
  arch: string;
}

export interface DependencyCheckInput {
  pythonPath: string;
  binDir: string;
  /** True when the interpreter came from the app bundle rather than the system. */
  pythonIsBundled: boolean;
}

const RUN_TIMEOUT_MS = 20000;

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Exit status, or a libuv error string such as 'ENOENT' when it never ran. */
  code: number | string | null;
}

/**
 * Run a probe without blocking the main process.
 *
 * These checks spawn Python, IgBLAST and R, and R alone takes about a second to
 * start, twice. Done synchronously that freezes Electron long enough for macOS
 * to show the spinning beachball, which reads as a hung application.
 */
async function tryRun(command: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: RUN_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '', code: 0 };
  } catch (e: any) {
    return {
      ok: false,
      stdout: e?.stdout || '',
      stderr: e?.stderr || '',
      code: e?.code ?? null,
    };
  }
}

function firstLine(s: string | null | undefined): string {
  return (s || '').split(/\r?\n/).find(l => l.trim())?.trim() || '';
}

/**
 * The Python that runs the pipeline, plus every module it imports.
 *
 * Checking imports rather than just the binary matters: a half-built bundled
 * runtime, or a system Python that lost changeo to an OS upgrade, both present
 * as a perfectly good interpreter.
 */
async function checkPython(input: DependencyCheckInput): Promise<DependencyItem> {
  // find_spec rather than __import__: importing scipy, pandas and matplotlib
  // for real costs several seconds, and this only needs to know whether they
  // are installed. A present-but-broken module still surfaces when the
  // pipeline runs, with a better error than this screen could give.
  const probe = [
    'import sys, json, importlib.util',
    'mods = ["Bio","pandas","numpy","matplotlib","scipy","airr","changeo","presto"]',
    'missing = []',
    'for m in mods:',
    '    try:',
    '        if importlib.util.find_spec(m) is None: missing.append(m)',
    '    except Exception: missing.append(m)',
    'print(json.dumps({"version": sys.version.split()[0], "missing": missing}))',
  ].join('\n');

  const res = await tryRun(input.pythonPath, ['-c', probe]);
  const label = input.pythonIsBundled ? 'Python (built in)' : 'Python';

  if (!res.ok) {
    return {
      id: 'python',
      label,
      status: 'error',
      required: true,
      problem: input.pythonIsBundled
        ? 'The built-in Python runtime could not be started. The app may be damaged; reinstalling it should fix this.'
        : 'No Python with the analysis packages could be found.',
      detail: firstLine(res.stderr) || `exit ${res.code}`,
    };
  }

  try {
    const parsed = JSON.parse(firstLine(res.stdout));
    if (parsed.missing?.length) {
      return {
        id: 'python',
        label,
        status: 'error',
        required: true,
        problem: `Python is present but these packages are missing: ${parsed.missing.join(', ')}.`,
        detail: `${input.pythonPath} (Python ${parsed.version})`,
      };
    }
    return {
      id: 'python',
      label,
      status: 'ok',
      required: true,
      detail: input.pythonIsBundled
        ? `Python ${parsed.version}, bundled with AutoAB`
        : `Python ${parsed.version} at ${input.pythonPath}`,
    };
  } catch {
    return {
      id: 'python',
      label,
      status: 'error',
      required: true,
      problem: 'Python responded in a way AutoAB did not understand.',
      detail: firstLine(res.stdout),
    };
  }
}

/**
 * IgBLAST, and the Rosetta question it drags along.
 *
 * NCBI publishes IgBLAST for macOS as x86_64 only, so on Apple Silicon the
 * bundled binary runs through Rosetta 2. A missing Rosetta shows up as
 * "Bad CPU type in executable", which is worth translating.
 */
/**
 * Rosetta 2, listed in its own right on Apple Silicon.
 *
 * It is a real requirement there, not an implementation detail: NCBI publishes
 * IgBLAST for macOS as x86_64 only, and Apple Silicon Macs do not ship with
 * Rosetta. Showing it only when broken meant the screen never admitted the
 * dependency existed, and a user could not confirm it was satisfied.
 *
 * `igblastWorks` is the authoritative signal, since running the Intel binary is
 * exactly what Rosetta is needed for. The oahd check is the fallback for when
 * IgBLAST could not be consulted at all.
 */
function rosettaItem(igblastWorks: boolean | null): DependencyItem | null {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null;

  const installed = igblastWorks !== null
    ? igblastWorks
    : fs.existsSync('/usr/libexec/rosetta/oahd');

  if (installed) {
    return {
      id: 'rosetta',
      label: 'Rosetta 2',
      status: 'ok',
      required: true,
      detail: 'Installed. Needed because IgBLAST is published for Intel only.',
    };
  }

  return {
    id: 'rosetta',
    label: 'Rosetta 2',
    status: 'missing',
    required: true,
    problem:
      'IgBLAST is only published as an Intel program, so Apple Silicon Macs need Rosetta 2 to run it. '
      + 'AutoAB can install it for you; macOS will ask for your password.',
    fix: 'install-rosetta',
  };
}

async function checkIgblast(input: DependencyCheckInput): Promise<DependencyItem[]> {
  const exe = process.platform === 'win32' ? 'igblastn.exe' : 'igblastn';
  const bin = path.join(input.binDir, exe);
  const items: DependencyItem[] = [];
  const withRosetta = (igblastWorks: boolean | null) => {
    const r = rosettaItem(igblastWorks);
    if (r) items.push(r);
    return items;
  };

  if (!fs.existsSync(bin)) {
    items.push({
      id: 'igblast',
      label: 'IgBLAST',
      status: 'missing',
      required: true,
      problem: 'The IgBLAST aligner is missing from the application bundle. Reinstalling AutoAB should restore it.',
      detail: `Expected at ${bin}`,
    });
    return withRosetta(null);
  }

  const res = await tryRun(bin, ['-version']);
  const combined = `${res.stdout}${res.stderr}`;
  const badCpu = /bad cpu type|Exec format error/i.test(combined) || res.code === 'ENOEXEC';

  if (badCpu) {
    items.push({
      id: 'igblast',
      label: 'IgBLAST',
      status: 'error',
      required: true,
      problem: 'IgBLAST could not run on this Mac.',
      detail: firstLine(combined),
    });
    return withRosetta(false);
  }

  if (!res.ok && !firstLine(combined)) {
    items.push({
      id: 'igblast',
      label: 'IgBLAST',
      status: 'error',
      required: true,
      problem: 'IgBLAST is present but did not respond.',
      detail: `exit ${res.code}`,
    });
    return withRosetta(null);
  }

  items.push({
    id: 'igblast',
    label: 'IgBLAST',
    status: 'ok',
    required: true,
    detail: firstLine(combined),
  });
  return withRosetta(true);
}

/** Locate Rscript the same way the Python backend does, so both agree. */
export function resolveRscript(): string {
  const override = process.env.AUTOAB_RSCRIPT;
  if (override) return override;
  return process.platform === 'win32' ? 'Rscript.exe' : 'Rscript';
}

async function checkR(): Promise<DependencyItem[]> {
  const rscript = resolveRscript();

  // One R invocation for both the version and the package list. R takes about
  // a second to start, so asking twice doubles the wait for no reason.
  // find.package() locates without loading, which matters because loading
  // alakazam drags in the whole Bioconductor subtree.
  const probe = [
    `cat(R.version.string, "\\n")`,
    `pkgs <- c(${REQUIRED_R_PACKAGES.map(p => `"${p}"`).join(', ')})`,
    `cat(paste(pkgs[!sapply(pkgs, function(p) length(find.package(p, quiet = TRUE)) > 0)], collapse = " "), "\\n")`,
  ].join('; ');

  const res = await tryRun(rscript, ['-e', probe]);

  if (!res.ok) {
    return [{
      id: 'r',
      label: 'R',
      status: 'missing',
      required: true,
      problem:
        'R is not installed. AutoAB needs it to estimate the clonal distance threshold '
        + 'and to build phylogenetic trees. Everything else it needs is already built in.',
      fix: 'download-r',
    }];
  }

  // Line 1 is the version banner, line 2 the packages that could not be found.
  const lines = res.stdout.split(/\r?\n/);
  const version = (lines[0] || '').trim() || firstLine(res.stderr);
  const missing = (lines[1] || '').trim().split(/\s+/).filter(Boolean);

  const items: DependencyItem[] = [{
    id: 'r',
    label: 'R',
    status: 'ok',
    required: true,
    detail: version,
  }];

  items.push(missing.length
    ? {
      id: 'rpackages',
      label: 'R packages',
      status: 'missing',
      required: true,
      problem: `R is installed but these packages are missing: ${missing.join(', ')}. AutoAB can install them for you.`,
      fix: 'install-r-packages',
    }
    : {
      id: 'rpackages',
      label: 'R packages',
      status: 'ok',
      required: true,
      detail: REQUIRED_R_PACKAGES.join(', '),
    });

  return items;
}

export async function checkDependencies(input: DependencyCheckInput): Promise<DependencyReport> {
  // Run the three groups concurrently: they are independent, and R alone is
  // slow enough that doing them in sequence is noticeable.
  const [python, igblast, r] = await Promise.all([
    checkPython(input),
    checkIgblast(input),
    checkR(),
  ]);

  const items: DependencyItem[] = [python, ...igblast, ...r];

  return {
    ok: items.every(i => !i.required || i.status === 'ok'),
    items,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Run a repair, streaming its output back so the user can watch rather than
 * stare at a spinner. Resolves with the exit status.
 */
export function runFix(
  fix: FixAction,
  onOutput: (line: string) => void
): Promise<{ success: boolean; message: string }> {
  let command: string;
  let args: string[];

  if (fix === 'install-rosetta') {
    if (process.platform !== 'darwin') {
      return Promise.resolve({ success: false, message: 'Rosetta 2 only exists on macOS.' });
    }
    // softwareupdate needs root. Routing it through osascript gives the
    // standard macOS authentication prompt instead of failing on permissions.
    command = '/usr/bin/osascript';
    args = ['-e', 'do shell script "/usr/sbin/softwareupdate --install-rosetta --agree-to-license" with administrator privileges'];
  } else if (fix === 'install-r-packages') {
    // Install into the user library so no administrator rights are needed;
    // R does not create that directory on its own when running non-interactively.
    //
    // alakazam and shazam depend on Biostrings, GenomicAlignments and IRanges,
    // which live on Bioconductor rather than CRAN. Installing straight from
    // CRAN therefore fails on the dependency, so this goes through BiocManager,
    // which knows both repositories and matches the Bioconductor release to the
    // installed R version.
    const rCode = [
      'lib <- Sys.getenv("R_LIBS_USER")',
      'if (!nzchar(lib) || lib == "NULL") lib <- file.path(path.expand("~"), "R", "autoab-library")',
      'dir.create(lib, recursive = TRUE, showWarnings = FALSE)',
      '.libPaths(c(lib, .libPaths()))',
      'options(repos = c(CRAN = "https://cloud.r-project.org"))',
      `pkgs <- c(${REQUIRED_R_PACKAGES.map(p => `"${p}"`).join(', ')})`,
      'need <- pkgs[!sapply(pkgs, requireNamespace, quietly = TRUE)]',
      'if (length(need)) {',
      '  if (!requireNamespace("BiocManager", quietly = TRUE)) install.packages("BiocManager", lib = lib)',
      '  BiocManager::install(need, lib = lib, ask = FALSE, update = FALSE)',
      '}',
      'still <- pkgs[!sapply(pkgs, requireNamespace, quietly = TRUE)]',
      'if (length(still)) { cat("FAILED:", paste(still, collapse=" "), "\\n"); quit(status = 1) }',
      'cat("All packages installed into", lib, "\\n")',
    ].join('\n');
    command = resolveRscript();
    args = ['-e', rCode];
  } else {
    return Promise.resolve({ success: false, message: `Unknown repair: ${fix}` });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ success: false, message: String(e) });
      return;
    }

    const pump = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) onOutput(line);
      }
    };
    child.stdout?.on('data', pump);
    child.stderr?.on('data', pump);

    child.on('error', (e) => resolve({ success: false, message: e.message }));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, message: 'Done.' });
      } else if (fix === 'install-rosetta' && code === 1) {
        // osascript exits 1 when the user dismisses the password prompt.
        resolve({ success: false, message: 'Installation was cancelled or the password prompt was dismissed.' });
      } else {
        resolve({ success: false, message: `The installer exited with code ${code}. See the log above.` });
      }
    });
  });
}
