"""Locating the external programs the pipeline shells out to.

The pipeline calls Rscript, the Change-O console scripts and the IgBLAST
binaries as separate processes. Where those live differs per machine and per
platform, so nothing here may be hardcoded, earlier versions pinned absolute
macOS framework paths, which worked on exactly one computer.

Every lookup can be overridden with an environment variable, which is the
escape hatch for unusual installs.
"""

import os
import shutil
from typing import List, Optional


def _is_windows() -> bool:
    return os.name == 'nt'


def _repo_gene_home() -> str:
    """geneGUI as it sits in a source checkout, one level above backend/."""
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.abspath(os.path.join(backend_dir, '..', 'geneGUI'))


def data_dir() -> str:
    """Reference databases (IMGT germlines, CoV-AbDab, internal_data).

    Inside the packaged app these live at Resources/data, not at
    ../geneGUI/data: electron-builder flattens them. Deriving the location from
    backend/ therefore worked only in a source checkout, and the packaged app
    failed at "Database V not found" on the first run. The Electron main
    process passes the real location, so prefer that.
    """
    return (os.environ.get('AUTOAB_DATA_DIR')
            or os.environ.get('IGDATA')
            or os.path.join(_repo_gene_home(), 'data'))


def bin_dir() -> str:
    """IgBLAST and makeblastdb. Resources/bin when packaged."""
    return os.environ.get('AUTOAB_BIN_DIR') or os.path.join(_repo_gene_home(), 'bin')


def cache_dir() -> str:
    """Where generated build products go, currently the BLAST indexes.

    Defaults to the data directory, which is right for a source checkout and
    wrong for the packaged app: there the data lives in Contents/Resources and
    is not writable, so the Electron main process overrides this.
    """
    path = os.environ.get('AUTOAB_CACHE_DIR') or data_dir()
    os.makedirs(path, exist_ok=True)
    return path


def outs_dir() -> str:
    """Scratch directory the Change-O tools are run from.

    This one is written to, so it must never resolve inside the .app bundle:
    an application in /Applications is not writable by the user running it.
    The Electron main process points this at its userData directory.
    """
    path = os.environ.get('AUTOAB_OUTS_DIR') or os.path.join(_repo_gene_home(), 'outs')
    os.makedirs(path, exist_ok=True)
    return path


def exe(name: str) -> str:
    """Append the platform's executable suffix."""
    return f'{name}.exe' if _is_windows() else name


def _first_on_path(names: List[str]) -> Optional[str]:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def find_rscript() -> str:
    """Absolute path to Rscript.

    Override with AUTOAB_RSCRIPT. Falls back to the bare name so the caller
    still produces a recognisable 'command not found' rather than a silent
    misfire.
    """
    override = os.environ.get('AUTOAB_RSCRIPT')
    if override:
        return override
    return _first_on_path([exe('Rscript')]) or exe('Rscript')


def find_changeo_script(stem: str) -> str:
    """Absolute path to a Change-O/pRESTO console script.

    changeo installs these via setuptools `scripts=`, so on POSIX they keep the
    .py suffix (``MakeDb.py``) while pip's Windows shim drops it and produces
    ``MakeDb.exe``. Try both spellings.
    """
    override = os.environ.get(f'AUTOAB_{stem.upper()}')
    if override:
        return override
    candidates = [f'{stem}.py', exe(stem)] if not _is_windows() else [exe(stem), f'{stem}.py']
    return _first_on_path(candidates) or f'{stem}.py'


def find_igblast_binary(bin_dir: str, name: str) -> str:
    """Path to an IgBLAST/BLAST executable.

    Prefers the copy installed into the repository's own bin directory by
    scripts/install.sh, then falls back to PATH.
    """
    override = os.environ.get(f'AUTOAB_{name.upper()}')
    if override:
        return override

    local = os.path.join(bin_dir, exe(name))
    if os.path.exists(local):
        return local
    return _first_on_path([exe(name)]) or local
