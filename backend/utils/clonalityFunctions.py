import subprocess
import matplotlib.pyplot as plt
import matplotlib.image as mpimg
import sys
import os

from .toolpaths import find_changeo_script, find_rscript

# Get paths - calculate from backend/utils to geneGUI
backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
geneHome = os.path.abspath(os.path.join(backend_dir, '..', 'geneGUI'))
outs_dir = os.path.join(geneHome, "outs")


def make_db(i, rj, rv, rd, s):
    # MakeDb.py creates output in current directory, so change to outs_dir
    # Use --failed flag to also process non-productive sequences
    original_cwd = os.getcwd()
    try:
        os.chdir(outs_dir)
        # Use relative paths from outs_dir
        i_rel = os.path.relpath(i, outs_dir) if os.path.isabs(i) else i
        cmd = [find_changeo_script('MakeDb'), 'igblast', '-i', i_rel, '-r', rj, rv, rd, '-s', s, '--failed']
        print(cmd)
        command = subprocess.Popen(cmd, stdout=subprocess.PIPE)
        output = command.communicate()[0]
    finally:
        os.chdir(original_cwd)
    
def define_clonality(db, dist, act='set', model='ham', norm='len', mode='allele', link='average'):
    # DefineClones.py creates output in current directory, so change to outs_dir
    original_cwd = os.getcwd()
    try:
        os.chdir(outs_dir)
        # Use relative path from outs_dir
        db_rel = os.path.relpath(db, outs_dir) if os.path.isabs(db) else db
        #nproc
        cmd = [find_changeo_script('DefineClones'), '-d', db_rel, '--act', act, '--model', model, '--norm', norm, '--dist', dist, '--mode', mode, '--link', link]
        
        # Debug: Print the exact command being run
        print(f"[DEBUG] Running DefineClones.py with command: {' '.join(cmd)}")
        
        command = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
        output, errors = command.communicate()
        
        if errors:
            print(f"[DEBUG] DefineClones.py stderr: {errors.decode('utf-8', errors='ignore')}")
        if output:
            print(f"[DEBUG] DefineClones.py stdout: {output.decode('utf-8', errors='ignore')}")
    finally:
        os.chdir(original_cwd)

def showImage(pathToPlot=None):
    if pathToPlot is None:
        pathToPlot = os.path.join(outs_dir, "distributionPlot.png")
    img = mpimg.imread(pathToPlot)
    plt.imshow(img)
    plt.show()

def create_germline(db, v, d, j):
    # CreateGermlines.py creates output in current directory, so change to outs_dir
    original_cwd = os.getcwd()
    try:
        os.chdir(outs_dir)
        # Use relative path from outs_dir
        db_rel = os.path.relpath(db, outs_dir) if os.path.isabs(db) else db
        cmd = [find_changeo_script('CreateGermlines'), '-d', db_rel, '-r', v, d, j, '-g', 'dmask', '--cloned' ]
        command = subprocess.Popen(cmd, stdout=subprocess.PIPE, shell=False)
        output = command.communicate()[0]
        print(output)
    finally:
        os.chdir(original_cwd)



class ThresholdUnavailable(Exception):
    """The clonal distance threshold could not be computed.

    Carries a message written for the person running the analysis, because it
    is surfaced verbatim in the threshold dialog.

    This exists so that a broken R install cannot pass for a result. The
    previous behaviour was to return a hardcoded 0.1 on every failure path,
    which let the pipeline finish and report success while every clone
    assignment rested on a number that had nothing to do with the data.
    """

    def __init__(self, message, detail=None):
        super().__init__(message)
        self.message = message
        self.detail = detail


def _missing_r_packages(stderr):
    """Package names R complained about, e.g. 'there is no package called shazam'."""
    import re
    return re.findall(r"there is no package called [`'\"]([^`'\"]+)", stderr or '')


def findDist(dbPath, pathToScript=None, pathToPlot=None):
    """Estimate the clonal distance threshold via shazam's distToNearest.

    Returns the threshold as a float. Raises ThresholdUnavailable if it cannot
    be computed; callers must surface that rather than substituting a default.
    """
    if pathToScript is None:
        # R script is in backend/scripts, not geneGUI/src/scripts
        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        pathToScript = os.path.join(backend_dir, "scripts", "calculateDistribution.R")
    if pathToPlot is None:
        pathToPlot = os.path.join(outs_dir, "distributionPlot.png")

    if not os.path.exists(dbPath):
        raise ThresholdUnavailable(
            "No aligned sequences were available to estimate a threshold from.",
            detail=f"Expected {dbPath}",
        )
    if os.path.getsize(dbPath) == 0:
        raise ThresholdUnavailable(
            "The alignment produced no sequences, so no threshold can be estimated.",
            detail=f"{dbPath} is empty",
        )

    command = find_rscript()
    args = [dbPath, pathToPlot]
    cmd = [command, pathToScript] + args

    # Rscript locates R_HOME itself; overriding it here would break every
    # install whose R does not sit where this machine's does.
    r_env = os.environ.copy()

    try:
        result = subprocess.run(cmd, shell=False, stderr=subprocess.PIPE, stdout=subprocess.PIPE, timeout=300, text=True, env=r_env)
    except FileNotFoundError:
        raise ThresholdUnavailable(
            "R was not found. AutoAB needs R to estimate the clonal distance "
            "threshold; everything else it needs is built in.",
            detail=f"Tried to run: {command}",
        )
    except subprocess.TimeoutExpired:
        raise ThresholdUnavailable(
            "Estimating the threshold took longer than 5 minutes and was stopped.",
            detail="This usually means an unusually large repertoire.",
        )
    except OSError as e:
        raise ThresholdUnavailable("R could not be started.", detail=str(e))

    if result.returncode != 0 and not result.stdout:
        missing = _missing_r_packages(result.stderr)
        if missing:
            raise ThresholdUnavailable(
                "R is installed but is missing the packages AutoAB needs: "
                + ", ".join(sorted(set(missing))) + ".",
                detail=(result.stderr or '')[-800:],
            )
        raise ThresholdUnavailable(
            "R failed while estimating the threshold.",
            detail=(result.stderr or '')[-800:],
        )

    if result.returncode != 0:
        # Non-zero but it still printed something; parse it and let the value
        # checks below decide whether the output is usable.
        print(f"Warning: R script returned non-zero exit code: {result.returncode}")
        if result.stderr:
            print(f"R script stderr: {result.stderr[:500]}")

    output_str = result.stdout or ''

    # R prints the threshold as the last line; fall back to scanning for a
    # decimal if the script also emitted diagnostics after it.
    import re
    lines = output_str.strip().split('\n')
    distribution = None

    if lines:
        try:
            distribution = float(lines[-1].strip())
        except ValueError:
            pass

    if distribution is None:
        numbers = re.findall(r'\d+\.\d+', output_str)
        if numbers:
            distribution = float(numbers[-1])

    if distribution is None:
        raise ThresholdUnavailable(
            "R ran but did not report a usable threshold value.",
            detail=f"Last output: {output_str.strip()[-300:] or '(no output)'}",
        )

    if not 0 < distribution < 1:
        raise ThresholdUnavailable(
            f"R reported an implausible threshold of {distribution}; "
            "a nearest-neighbour distance must lie between 0 and 1.",
            detail=f"Last output: {output_str.strip()[-300:]}",
        )

    print(f"Successfully calculated distance threshold: {distribution}")
    return distribution