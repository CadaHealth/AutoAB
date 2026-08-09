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



def findDist(dbPath, pathToScript=None, pathToPlot=None):
    if pathToScript is None:
        # R script is in backend/scripts, not geneGUI/src/scripts
        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        pathToScript = os.path.join(backend_dir, "scripts", "calculateDistribution.R")
    if pathToPlot is None:
        pathToPlot = os.path.join(outs_dir, "distributionPlot.png")
    
    # Check if input file exists and is not empty
    if not os.path.exists(dbPath):
        print(f"Warning: Database file does not exist: {dbPath}")
        return 0.1  # Return default distance
    if os.path.getsize(dbPath) == 0:
        print(f"Warning: Database file is empty: {dbPath}")
        return 0.1  # Return default distance
    
    command = find_rscript()
    args = [dbPath, pathToPlot]
    cmd = [command, pathToScript] + args

    # Rscript locates R_HOME itself; overriding it here would break every
    # install whose R does not sit where this machine's does.
    r_env = os.environ.copy()

    try:
        result = subprocess.run(cmd, shell=False, stderr=subprocess.PIPE, stdout=subprocess.PIPE, timeout=300, text=True, env=r_env)
        
        # Check return code - should be 0 if successful
        if result.returncode != 0:
            print(f"Warning: R script returned non-zero exit code: {result.returncode}")
            if result.stderr:
                print(f"R script stderr: {result.stderr[:500]}")  # Print first 500 chars
            # Try to parse output anyway in case it still produced a value
            if result.stdout:
                output_str = result.stdout
            else:
                return 0.1
        
        # Parse output - look for the threshold value
        output_str = result.stdout if result.stdout else str(result)
        
        # Try to extract the distribution value from R output
        # R output format: the last line should be the number
        import re
        # Look for numbers in the output, prefer the last one on its own line
        lines = output_str.strip().split('\n')
        distribution = None
        
        # Try to find a number on the last line
        if lines:
            last_line = lines[-1].strip()
            try:
                distribution = float(last_line)
            except ValueError:
                pass
        
        # If that didn't work, look for any decimal number
        if distribution is None:
            numbers = re.findall(r'\d+\.\d+', output_str)
            if numbers:
                # Take the last number found
                distribution = float(numbers[-1])
            else:
                # Try integers
                numbers = re.findall(r'\d+', output_str)
                if numbers:
                    distribution = float(numbers[-1]) / 10.0  # Convert to decimal
        
        if distribution is None:
            print(f"Warning: Could not parse R script output. Last 200 chars: {output_str[-200:]}")
            return 0.1  # Return default distance
        
        # Validate the distribution is reasonable (between 0 and 1)
        if distribution < 0 or distribution > 1:
            print(f"Warning: Parsed distance value {distribution} is out of range, using default 0.1")
            return 0.1
        
        print(f"Successfully calculated distance threshold: {distribution}")
        return distribution
    except subprocess.TimeoutExpired:
        print("Warning: R script timed out after 5 minutes. Using default distance.")
        return 0.1  # Return default distance
    except subprocess.CalledProcessError as e:
        print(f"Warning: R script failed with return code {e.returncode}")
        if e.stderr:
            stderr_str = e.stderr.decode('utf-8', errors='ignore')
            print(f"R script stderr: {stderr_str}")
        if e.output:
            output_str = e.output.decode('utf-8', errors='ignore')
            print(f"R script stdout: {output_str}")
        # Return a default distance value instead of crashing
        print("Using default distance threshold of 0.1")
        return 0.1
    except Exception as e:
        print(f"Warning: Unexpected error running R script: {str(e)}")
        print("Using default distance threshold of 0.1")
        return 0.1  # Return default distance