import glob
from setuptools import setup
import os

home = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # Go up to geneGUI directory
APP = ['src/gui/main.py']
# Change to geneGUI directory for glob patterns
os.chdir(home)
DATA_FILES = [
                ('src/gui', glob.glob('src/gui/*.ui') + glob.glob('src/gui/*.icns')),
                ('src/utils', glob.glob('src/utils/*.py')),
                ('src/scripts', glob.glob('src/scripts/*.R')),
                ('bin', glob.glob('bin/')), 
                ('data/optional_data', glob.glob('data/optional_data/')), 
                ('data/internal_data', glob.glob('data/internal_data/')),
                ('data/Database-Files', glob.glob('data/Database-Files/')),
                ('data/IMGT_Human_Database', glob.glob('data/IMGT_Human_Database/'))
            ]


OPTIONS = {'iconfile':'src/gui/cells.icns'}
setup(
    app=APP,
    data_files=DATA_FILES,
    options={'py2app': OPTIONS},
    setup_requires=['py2app'], 
    install_requires=['PyQt6', 'qdarkstyle', 'tabulate', 'pandas', 'biopython', 'changeo']
)