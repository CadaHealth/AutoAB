/**
 * Runtime dependency inspection, and the repairs the app can perform itself.
 *
 * AutoAB ships its own Python, IgBLAST and reference data, so the only thing a
 * user has to supply is R. This module works out what is actually present and,
 * where possible, offers to fix it without sending the user to a terminal.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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

const RUN_OPTS = { encoding: 'utf-8' as const, timeout: 20000 };

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
function checkPython(input: DependencyCheckInput): DependencyItem {
  const probe = [
    'import sys, json',
    'mods = ["Bio","pandas","numpy","matplotlib","scipy","airr","changeo","presto"]',
    'missing = []',
    'for m in mods:',
    '    try: __import__(m)',
    '    except Exception: missing.append(m)',
    'print(json.dumps({"version": sys.version.split()[0], "missing": missing}))',
  ].join('\n');

  const res = spawnSync(input.pythonPath, ['-c', probe], RUN_OPTS);
  const label = input.pythonIsBundled ? 'Python (built in)' : 'Python';

  if (res.error || res.status !== 0) {
    return {
      id: 'python',
      label,
      status: 'error',
      required: true,
      problem: input.pythonIsBundled
        ? 'The built-in Python runtime could not be started. The app may be damaged; reinstalling it should fix this.'
        : 'No Python with the analysis packages could be found.',
      detail: firstLine(res.stderr) || String(res.error || ''),
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
function checkIgblast(input: DependencyCheckInput): DependencyItem[] {
  const exe = process.platform === 'win32' ? 'igblastn.exe' : 'igblastn';
  const bin = path.join(input.binDir, exe);
  const items: DependencyItem[] = [];

  if (!fs.existsSync(bin)) {
    items.push({
      id: 'igblast',
      label: 'IgBLAST',
      status: 'missing',
      required: true,
      problem: 'The IgBLAST aligner is missing from the application bundle. Reinstalling AutoAB should restore it.',
      detail: `Expected at ${bin}`,
    });
    return items;
  }

  const res = spawnSync(bin, ['-version'], RUN_OPTS);
  const combined = `${res.stdout || ''}${res.stderr || ''}`;
  const badCpu = /bad cpu type|Exec format error/i.test(combined)
    || (res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOEXEC';

  const needsRosetta = process.platform === 'darwin' && process.arch === 'arm64';

  if (badCpu) {
    items.push({
      id: 'igblast',
      label: 'IgBLAST',
      status: 'error',
      required: true,
      problem: 'IgBLAST could not run on this Mac.',
      detail: firstLine(combined),
    });
    if (needsRosetta) {
      items.push({
        id: 'rosetta',
        label: 'Rosetta 2',
        status: 'missing',
        required: true,
        problem:
          'IgBLAST is only published as an Intel program, so Apple Silicon Macs need Rosetta 2 to run it. '
          + 'AutoAB can install it for you; macOS will ask for your password.',
        fix: 'install-rosetta',
      });
    }
    return items;
  }

  if (res.status !== 0 && !firstLine(combined)) {
    items.push({
      id: 'igblast',
      label: 'IgBLAST',
      status: 'error',
      required: true,
      problem: 'IgBLAST is present but did not respond.',
      detail: firstLine(combined) || String(res.error || ''),
    });
    return items;
  }

  items.push({
    id: 'igblast',
    label: 'IgBLAST',
    status: 'ok',
    required: true,
    detail: firstLine(combined) + (needsRosetta ? ' (Intel build, via Rosetta 2)' : ''),
  });
  return items;
}

/** Locate Rscript the same way the Python backend does, so both agree. */
export function resolveRscript(): string {
  const override = process.env.AUTOAB_RSCRIPT;
  if (override) return override;
  return process.platform === 'win32' ? 'Rscript.exe' : 'Rscript';
}

function checkR(): DependencyItem[] {
  const rscript = resolveRscript();
  const res = spawnSync(rscript, ['--version'], RUN_OPTS);

  if (res.error || res.status !== 0) {
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

  // R prints its banner to stdout on modern versions and stderr on older ones.
  const version = firstLine(res.stdout) || firstLine(res.stderr);

  const pkgProbe = `cat(paste(sapply(c(${REQUIRED_R_PACKAGES.map(p => `"${p}"`).join(',')}),`
    + ` function(p) if (requireNamespace(p, quietly=TRUE)) "" else p), collapse=" "))`;
  const pkgRes = spawnSync(rscript, ['-e', pkgProbe], RUN_OPTS);
  const missing = (pkgRes.stdout || '').trim().split(/\s+/).filter(Boolean);

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

export function checkDependencies(input: DependencyCheckInput): DependencyReport {
  const items: DependencyItem[] = [
    checkPython(input),
    ...checkIgblast(input),
    ...checkR(),
  ];

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
    const rCode = [
      'lib <- Sys.getenv("R_LIBS_USER")',
      'if (!nzchar(lib) || lib == "NULL") lib <- file.path(path.expand("~"), "R", "autoab-library")',
      'dir.create(lib, recursive = TRUE, showWarnings = FALSE)',
      '.libPaths(c(lib, .libPaths()))',
      `pkgs <- c(${REQUIRED_R_PACKAGES.map(p => `"${p}"`).join(', ')})`,
      'need <- pkgs[!sapply(pkgs, requireNamespace, quietly = TRUE)]',
      'if (length(need)) install.packages(need, lib = lib, repos = "https://cloud.r-project.org")',
      'still <- pkgs[!sapply(pkgs, requireNamespace, quietly = TRUE)]',
      'if (length(still)) { cat("FAILED:", paste(still, collapse=" "), "\\n"); quit(status = 1) }',
      'cat("All packages installed into", lib, "\\n")',
    ].join('; ');
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
