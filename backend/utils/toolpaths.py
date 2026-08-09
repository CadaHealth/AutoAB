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
