# created by Vihan Bagal

import sys
import typing
from PyQt6.QtCore import *
from PyQt6.QtGui import *
from PyQt6.QtWidgets import *
from PyQt6 import uic
from os.path import expanduser
import qdarkstyle
from tabulate import tabulate
import pandas as pd
import os
import sys
import glob
import io
import subprocess
from Bio.Seq import Seq

# Add geneGUI directory to path for imports
geneHome = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, geneHome)

from src.utils import clean as cl
from src.utils import blast
from src.utils import clonality as clone
os.unsetenv("PYTHONHOME")
print(geneHome)

# Create outs directory for all output files
outs_dir = os.path.join(geneHome, "outs")
if not os.path.exists(outs_dir):
    os.makedirs(outs_dir)
# Create subdirectories in outs
for subdir in ["trees", "clean_fasta", "clean_db_files", "build-trees-input"]:
    subdir_path = os.path.join(outs_dir, subdir)
    if not os.path.exists(subdir_path):
        os.makedirs(subdir_path)

###########BUILDING IGPHYML##########
# #export the src folder to $PATH env variable
# os.environ['PATH'] += os.pathsep + geneHome+"/igphyml/src"
# #subprocess.call(["export", f"PATH={geneHome+"/igphyml/src"}:$PATH"])
# #subprocess.call('echo $PATH', shell=True)
# #build the program
# subprocess.call([geneHome+"/igphyml/make_phyml_omp"])
# subprocess.call(["igphyml"])
###########BUILDING IGPHYML##########


class menuWindow(QMainWindow):
    def __init__(self, controller=None):
        super().__init__()
        self.controller = controller  # Store reference to QStackedWidget
    
        self.Fasta_Data = []
        self.Fasta_Paths = []
        self.combined_fasta = None
        self.Database_Path_V_clean = ""
        self.Database_Path_D_clean = ""
        self.Database_Path_J_clean = ""
        self.Database_Path_V = ""
        self.Database_Path_D = ""
        self.Database_Path_J = ""

        self.setStyleSheet(qdarkstyle.load_stylesheet())
        self.initUI()


    #loads proper UI for the menu screen
    def initUI(self):
        ui_dir = os.path.dirname(os.path.abspath(__file__))
        uic.loadUi(os.path.join(ui_dir, "menu.ui"), self)
        self.setWindowTitle("B-Cell Repertoire Analysis Tool")

        self.selFasta = self.findChild(QPushButton, "fastaButton")
        self.outFasta = self.findChild(QLineEdit, "fastaOut")

        self.cleanCheck = self.findChild(QCheckBox, "cleanBox")

        self.databaseSel = self.findChild(QComboBox, "databaseSelect")

        self.customDataV = self.findChild(QPushButton, "chooseV")
        self.customDataD = self.findChild(QPushButton, "chooseD")
        self.customDataJ = self.findChild(QPushButton, "chooseJ")

        self.dataOutV = self.findChild(QLineEdit, "databaseOutV")
        self.dataOutD = self.findChild(QLineEdit, "databaseOutD")
        self.dataOutJ = self.findChild(QLineEdit, "databaseOutJ")

        self.start = self.findChild(QPushButton, "startA")

        self.selFasta.clicked.connect(self.importFasta)
        self.databaseSel.currentTextChanged.connect(self.on_combobox_changed)

        self.customDataV.clicked.connect(self.chooseDatabFile_V)
        self.customDataD.clicked.connect(self.chooseDatabFile_D)
        self.customDataJ.clicked.connect(self.chooseDatabFile_J)

        self.start.clicked.connect(self.startAnalysis)
        self.show()
    #sets the choose database button active when Custom is selected
    def on_combobox_changed(self, value):
        self.customDataV.setEnabled(value == "Custom")
        self.customDataD.setEnabled(value == "Custom")
        self.customDataJ.setEnabled(value == "Custom")

        if(value == "IMGT"):
            self.Database_Path_V = os.path.join(geneHome, "data", "IMGT_Human_Database", "Human_V.fasta")
            print(self.Database_Path_V)
            self.Database_Path_D = os.path.join(geneHome, "data", "IMGT_Human_Database", "Human_D.fasta")
            self.Database_Path_J = os.path.join(geneHome, "data", "IMGT_Human_Database", "Human_J.fasta")
    #opens a prompt to choose a database file
    def chooseDatabFile_V(self):
        self.Database_Path_V = QFileDialog.getOpenFileName(self, 'Open file')[0]
        self.dataOutV.setText(self.Database_Path_V)
        self.dataOutV.setCursorPosition(0)
    def chooseDatabFile_D(self):
        self.Database_Path_D = QFileDialog.getOpenFileName(self, 'Open file')[0]
        self.dataOutD.setText(self.Database_Path_D)
        self.dataOutD.setCursorPosition(0)
    def chooseDatabFile_J(self):
        self.Database_Path_J = QFileDialog.getOpenFileName(self, 'Open file')[0]
        self.dataOutJ.setText(self.Database_Path_J)
        self.dataOutJ.setCursorPosition(0)

    #pulls up dialog to import fasta file
    def importFasta(self):
        fdir = QFileDialog.getExistingDirectory(self, 'Open Directory')
        if(fdir == ""):
            return
        fpaths = [f for f in os.listdir(fdir) if not f.startswith('.')]
        self.Fasta_Paths.clear()
        for i in fpaths:
            self.Fasta_Paths.append(fdir+"/"+i)
        
        for i in self.Fasta_Paths:
            with open(i, "r") as txt_file:
                self.Fasta_Data.append("".join((txt_file.readlines())))
        self.Fasta_Data = "\n".join(self.Fasta_Data)

        self.outFasta.setText(fdir)
        self.outFasta.setCursorPosition(0)

    #function for combining all fasta files into one
    def combine_fasta(self, fasta_files):
        #takes in a list of fasta files and returns the combined one
        combined_path = os.path.join(outs_dir, 'combined.fasta')
        with io.open(combined_path, 'w') as outfile:
            for fasta in fasta_files:
                base = os.path.basename(fasta)
                with io.open(fasta, 'r') as infile:
                    for line in infile:
                        if(line.startswith('>')):
                            outfile.write(line[0:-1] + '_' + base + "\n")
                        else:
                            outfile.write(line)
        return combined_path

    #runs cleaning files, pulls up error messages if insufficent data is entered
    def startAnalysis(self):


        #prevents user from starting analysis if fasta file is not selected
        if(self.Fasta_Paths == ""):
            war = QMessageBox(self)
            war.setText("Please select a fasta file before starting analysis.")
            war.exec()
            return

        if(self.databaseSel.currentText() == "Custom"):
            if(self.Database_Path_V == ""):
                datawar = QMessageBox(self)
                datawar.setText("You have chosen a custom database.\nPlease choose a database file or choose a different database")
                datawar.exec()
                return
        #checks if the user wants to clean the fasta file and does so if needed
        if(self.cleanCheck.isChecked()):
            # Use outs/clean_fasta directory
            clean_fasta_dir = os.path.join(outs_dir, 'clean_fasta')
            if not os.path.exists(clean_fasta_dir):
                os.makedirs(clean_fasta_dir)
            # Reinitialize Fasta_Data as a list since it was converted to string in importFasta()
            self.Fasta_Data = []
            valid_paths = []
            for i, val in enumerate(self.Fasta_Paths):
                fileName = os.path.basename(val)
                
                # First verify the input file exists and is readable
                if not os.path.exists(val):
                    warning = QMessageBox(self)
                    warning.setText(f"Input fasta file does not exist: {val}")
                    warning.exec()
                    continue
                
                if os.path.getsize(val) == 0:
                    warning = QMessageBox(self)
                    warning.setText(f"Input fasta file is empty: {fileName}")
                    warning.exec()
                    continue
                
                # Handle case where filename might not have a dot
                dot_index = fileName.find(".")
                if dot_index == -1:
                    newPath = os.path.join(clean_fasta_dir, fileName + "_clean")
                else:
                    newPath = os.path.join(clean_fasta_dir, fileName[0:dot_index] + "_clean" + fileName[dot_index:])

                # Check if cleaned file already exists and is valid
                needs_cleaning = True
                if os.path.exists(newPath):
                    # Check if existing file is valid (non-empty and has at least one sequence)
                    try:
                        if os.path.getsize(newPath) > 0:
                            # Quick check: see if file has at least one header line
                            with open(newPath, "r") as test_file:
                                has_header = any(line.startswith('>') for line in test_file)
                            if has_header:
                                needs_cleaning = False
                    except:
                        # If we can't read it, we need to recreate it
                        needs_cleaning = True

                # Clean the file if needed
                if needs_cleaning:
                    # Remove existing file if it exists (might be corrupted)
                    if os.path.exists(newPath):
                        try:
                            os.remove(newPath)
                        except:
                            pass
                    try:
                        #cleans the fasta file using clean.py
                        cl.clean_imgt(val, newPath)
                    except FileExistsError:
                        # File was created between check and creation, try to use it
                        pass
                    except Exception as e:
                        # If cleaning fails, show error with details
                        warning = QMessageBox(self)
                        warning.setText(f"Failed to clean fasta file {fileName}:\n{str(e)}\n\nInput file: {val}")
                        warning.exec()
                        # Skip this file - don't add to valid paths or Fasta_Data
                        continue

                # Verify file exists and is readable before reading
                if os.path.exists(newPath) and os.path.getsize(newPath) > 0:
                    try:
                        # Update path to point to cleaned file
                        valid_paths.append(newPath)
                        with open(newPath, "r") as txt_file:
                            content = "".join((txt_file.readlines()))
                            if content.strip():  # Make sure content is not just whitespace
                                self.Fasta_Data.append(content)
                            else:
                                # File exists but is empty/whitespace only
                                warning = QMessageBox(self)
                                warning.setText(f"Cleaned fasta file {fileName} contains no valid sequences.")
                                warning.exec()
                                valid_paths.pop()  # Remove from valid_paths
                    except Exception as e:
                        # Error reading file
                        warning = QMessageBox(self)
                        warning.setText(f"Error reading cleaned fasta file {fileName}:\n{str(e)}")
                        warning.exec()
                else:
                    # File doesn't exist or is empty
                    warning = QMessageBox(self)
                    warning.setText(f"Cleaned fasta file {fileName} is empty or doesn't exist.\nExpected path: {newPath}")
                    warning.exec()
            # Update Fasta_Paths to only include valid cleaned files
            self.Fasta_Paths = valid_paths
            # Convert Fasta_Data back to string after cleaning
            if self.Fasta_Data:
                self.Fasta_Data = "\n".join(self.Fasta_Data)
            else:
                # No valid cleaned files, show error with more details
                error = QMessageBox(self)
                error.setText(f"No valid cleaned fasta files were created.\n\nChecked {len(self.Fasta_Paths)} input files.\nPlease check your input files and try again.")
                error.exec()
                return
        
        #cleans the database files and stores the cleaned files in a folder
        #first removes all items from any previous runs
        clean_db_dir = os.path.join(outs_dir, 'clean_db_files')
        files = glob.glob(os.path.join(clean_db_dir, "*"))
        for f in files:
            os.remove(f)
        #cleans V Database files and neatly creates new cleaned file name files 
        vname = os.path.basename(self.Database_Path_V)
        self.Database_Path_V_clean = os.path.join(clean_db_dir, vname[0:vname.find(".")] + "_clean" + vname[vname.find("."):])
        cl.clean_imgt(self.Database_Path_V, self.Database_Path_V_clean)

        #cleans D Database files and neatly creates new cleaned file name files 
        dname = os.path.basename(self.Database_Path_D)
        self.Database_Path_D_clean = os.path.join(clean_db_dir, dname[0:dname.find(".")] + "_clean" + dname[dname.find("."):])
        cl.clean_imgt(self.Database_Path_D, self.Database_Path_D_clean)

        #cleans J Database files and neatly creates new cleaned file name files 
        jname = os.path.basename(self.Database_Path_J)
        self.Database_Path_J_clean = os.path.join(clean_db_dir, jname[0:jname.find(".")] + "_clean" + jname[jname.find("."):])
        cl.clean_imgt(self.Database_Path_J, self.Database_Path_J_clean)


        #joins the fasta list into one file for easy analysis
        self.combined_fasta = self.combine_fasta(self.Fasta_Paths)

        #initializes the progress window to display all information
        mainW = mainWindow(menu_window=self)  # Pass self (menuWindow) to mainWindow
        self.controller.addWidget(mainW)
        self.controller.setCurrentWidget(mainW)


#class to create and load the UI for the Blast and Change-o progress bar
class progressWindow(QWidget):
    def __init__(self):
        super().__init__()
        #loads the dark theme
        self.setStyleSheet(qdarkstyle.load_stylesheet())
        self.initUI()


			
    def initUI(self):
        ui_dir = os.path.dirname(os.path.abspath(__file__))
        uic.loadUi(os.path.join(ui_dir, "progress.ui"), self)
        self.progress = self.findChild(QProgressBar, "progressBar")
        self.proglabel = self.findChild(QLabel, "prog_label")
        self.console = self.findChild(QTextEdit, "console_out")


        #self.thread_manager.start(self.run_analysis)
        #self.thread_manager.start(self.update_bar)


    

#Sequence class, all sequences are stored as this seq obj
class Sequence():
    def __init__(self, name, seq):
        self.name = name
        self.seq = Seq(''.join(seq.split()))
        if(self.isProt()):
            self.type = "prot"
        else:
            self.type = "nucl"

    def __str__(self):
        return self.name

    #checks if sequence is a protien or nucleotide
    def isProt(self):
        alpha = "BDEFHIJKLMOPQRSUVWXYZ"
        for i in self.seq:
            if i in alpha:
                return True
        return False

class mainWindow(QMainWindow):
    # Signal to request threshold dialog (emitted from worker thread, handled on main thread)
    request_threshold = pyqtSignal(float, object)  # calculated_dist, result_container
    
    def __init__(self, menu_window=None):
        super().__init__()
        #loads the dark theme
        self.setStyleSheet(qdarkstyle.load_stylesheet())
        self.menuW = menu_window  # Store reference to menuWindow
        # Connect signal to slot that will run on main thread
        self.request_threshold.connect(self._show_threshold_dialog, Qt.ConnectionType.QueuedConnection)
        self.initUI()

    #sorting criteria key
    def takename(self, elem):
        return elem.name

    #Takes the data from the fasta file a puts in into a list of Sequnece objects
    def sortNames(self):
        with open(self.menuW.combined_fasta, "r") as txt_file:
            lines = txt_file.readlines()
            fastaList = []
            startJoin = 0
            for i in range(1, len(lines)):
                if((lines[i][0] == ">") or i == len(lines) - 1):
                    # Strip newline from sequence name
                    seq_name = lines[startJoin][1:].strip()
                    fastaList.append(Sequence(seq_name, ''.join(lines[startJoin+1:i])))
                    startJoin = i
            # Handle last sequence if file doesn't end with newline
            if startJoin < len(lines):
                seq_name = lines[startJoin][1:].strip()
                fastaList.append(Sequence(seq_name, ''.join(lines[startJoin+1:])))
            fastaList = sorted(fastaList, key=self.takename)

            return fastaList
    
    def filterTree(self, search_text):
        """Filter tree items based on search text. Shows/hides FASTA files and sequences."""
        if not hasattr(self, 'tree') or not self.tree:
            return
        
        search_text = search_text.lower().strip()
        
        # If search is empty, show all items
        if not search_text:
            root = self.tree.invisibleRootItem()
            for i in range(root.childCount()):
                item = root.child(i)
                item.setHidden(False)
                # Show all children
                for j in range(item.childCount()):
                    item.child(j).setHidden(False)
            return
        
        # Filter items
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            fasta_item = root.child(i)
            fasta_name = fasta_item.text(0).lower()
            
            # Check if FASTA file name matches
            fasta_matches = search_text in fasta_name
            
            # Check if any child sequence matches
            has_matching_child = False
            for j in range(fasta_item.childCount()):
                seq_item = fasta_item.child(j)
                seq_name = seq_item.text(0).lower()
                
                if search_text in seq_name:
                    seq_item.setHidden(False)
                    has_matching_child = True
                else:
                    seq_item.setHidden(True)
            
            # Show FASTA file if it matches or has matching children
            if fasta_matches or has_matching_child:
                fasta_item.setHidden(False)
                # If FASTA matches, show all its children
                if fasta_matches:
                    for j in range(fasta_item.childCount()):
                        fasta_item.child(j).setHidden(False)
            else:
                fasta_item.setHidden(True)
    
    #asks the user for file input, creates a new file at that location and stores db-pass-clone pass data there
    def exportData(self):
        name = QFileDialog.getSaveFileName(self, 'Export Analysis Data', "Analysis_Data.tsv", "Data (*.tsv)")[0]
        datafile_path = os.path.join(outs_dir, "ig_out_data_db-pass_clone-pass.tsv")
        datafile = open(datafile_path, "r")
        if(name == ""):
            return
        data = datafile.read()
        file = open(name,'w')
        file.write(data)
        file.close()
        datafile.close()



    #if user selects item in tree, displays proper name, genes and other important information from the dataframe
    def onItemClicked(self): 
        # Check if dataframes are loaded
        if not hasattr(self, 'df') or self.df is None or self.df.empty:
            # Show message that analysis is still running
            return
        if not hasattr(self, 'clonedf') or self.clonedf is None or self.clonedf.empty:
            # Show message that analysis is still running
            return
            
        # Check if clicked item is a parent (file name) or child (sequence)
        current_item = self.tree.currentItem()
        if current_item is None:
            return
            
        # Only process child items (sequences), not parent items (file names)
        if current_item.parent() is None:
            # This is a parent item (file name), don't process it
            return
            
        #gets all the items from the qt designer file
        self.nameBox = self.findChild(QLineEdit, "nameBox")
        self.vbox = self.findChild(QLineEdit, "vGene")
        self.dbox = self.findChild(QLineEdit, "dGene")
        self.jbox = self.findChild(QLineEdit, "jGene")
        self.vloc = self.findChild(QLineEdit, "vLocus")
        self.dloc = self.findChild(QLineEdit, "dLocus")
        self.jloc = self.findChild(QLineEdit, "jLocus")
        self.cdlenbox = self.findChild(QLineEdit, "CDR_len")
        self.cdDNA = self.findChild(QLineEdit, "CDR_DNA")
        self.somatic = self.findChild(QLineEdit, "Som_mut")
        self.isotype = self.findChild(QLineEdit, "isobox")
        self.peptide = self.findChild(QLineEdit, "peptide")
        self.cloneidbox = self.findChild(QLineEdit, "clone_id")
        self.clonecountbox = self.findChild(QLineEdit, "clone_count")

        # Get item name and strip any trailing whitespace/newlines
        item = current_item.text(0).strip()
        print(f"ITEM:{item}:ITEM")
        
        # Try to find matching data - handle case where query id might not match exactly
        data = self.df.loc[self.df['query id'] == item]
        if data.empty:
            # Try without the file suffix in case there's a mismatch
            item_base = item.split('_')[0] if '_' in item else item
            # Use na=False to handle NaN values in the query id column
            data = self.df.loc[self.df['query id'].str.startswith(item_base, na=False)]
            if not data.empty:
                item = data.iloc[0]['query id']  # Update item to match found query id
        
        # If still no data found, clear all fields and return
        if data.empty:
            self.nameBox.setText("")
            self.vbox.setText("")
            self.dbox.setText("")
            self.jbox.setText("")
            self.vloc.setText("")
            self.dloc.setText("")
            self.jloc.setText("")
            self.cdlenbox.setText("")
            self.cdDNA.setText("")
            self.somatic.setText("")
            self.isotype.setText("")
            self.peptide.setText("")
            self.cloneidbox.setText("")
            self.clonecountbox.setText("0")
            return
        
        #get clonality ID and number of clones
        clonedata = (self.clonedf.loc[self.clonedf['sequence_id'] == item])
        try:
            c = str(clonedata.iloc[0]['clone_id'])
        except:
            c = ""
        self.cloneidbox.setText(c)
        if(c == ""):
            c = 0
        clone_count = len(self.clonedf.loc[self.clonedf['clone_id'] == int(c)])
        self.clonecountbox.setText(str(clone_count))


        #CDR3
        try:
            cdr3Data = data.loc[data['chain type'] == "CDR3"].iloc[0]
            print(f"ITEM:{cdr3Data}:ITEM")
            self.somatic.setText(str(int(cdr3Data["alignment length"])))
            DNA = str(cdr3Data["subject id"])
            self.cdDNA.setText(DNA)
            self.cdlenbox.setText(str(len(DNA)))
            self.peptide.setText(str(cdr3Data["% identity"]))
        except:
            print("no CDR3 data")
        #displays V, D, J data
        # if it does not exist, sets it to empty
        try:
            vData = data.loc[data['chain type'] == "V"].iloc[0]
            print(f"ITEM:{vData}:ITEM")
        except:
            vData = pd.DataFrame()
        try:
            dData = data.loc[data['chain type'] == "D"].iloc[0]
        except:
            dData = pd.DataFrame()
        try:
            jData = data.loc[data['chain type'] == "J"].iloc[0]
        except:
            jData = pd.DataFrame()

        #populate the gene data
        #parses and sets v locus data
        if(not vData.empty):
            g = vData['subject id']
            self.vbox.setText(g)
            idx = g.index("*")
            self.vloc.setText(g[3]+g[2]+g[4:idx])
            if("L" in g):
                self.isotype.setText("Lambda")
            if("K" in g):
                self.isotype.setText("Kappa")
            else:
                self.isotype.setText("Heavy")
        else:
            self.vbox.setText("")
            self.vloc.setText("")
        #parses and sets d locus data
        if(not dData.empty):
            g = dData['subject id']
            self.dbox.setText(g)
            idx = g.index("*")
            self.dloc.setText(g[3]+g[2]+g[4:idx])
        else:
            self.dbox.setText("")
            self.dloc.setText("")
        #parses and sets j locus data
        if(not jData.empty):
            g = jData['subject id']
            self.jbox.setText(g)
            idx = g.index("*")
            self.jloc.setText(g[3]+g[2]+g[4:idx])
        else:
            self.jbox.setText("")
            self.jloc.setText("")


        for i in self.menuW.Fasta_Paths:
            if(item in i):
                return
        self.nameBox.setText(item)
        self.nameBox.setCursorPosition(0)


    def _show_threshold_dialog(self, calculated_dist, result_container):
        """Show threshold dialog on main thread (called via signal)"""
        threshold = self.getCustomThreshold(calculated_dist)
        result_container['value'] = threshold
    
    def getCustomThreshold(self, default_dist=None):
        # Use provided default or get from clone module
        if default_dist is None:
            default_dist = clone.get_dist()
        
        flag = True
        while flag:
            num,ok = QInputDialog.getText(self,"Custom clustering threshold","enter a custom clustering threshold, or cancel to use calculated value \n Calculated threshold is: " + str(default_dist))
            try:
                if(not ok):
                    flag = False
                else:
                    float(num)
                    flag = False
            except:
                clusterWar = QMessageBox(self)
                clusterWar.setText("Please enter a valid number as a Custom clustering threshold")
                clusterWar.exec()
        if ok:
            return str(num)
        else:
            return str(default_dist)
        
    #loads proper UI
    def initUI(self):
        ui_dir = os.path.dirname(os.path.abspath(__file__))
        uic.loadUi(os.path.join(ui_dir, "main.ui"), self)
        self.fbox = self.findChild(QPlainTextEdit, "fBOX")
        self.tabs = self.findChild(QTabWidget, "tabWidget")
        self.plab = self.findChild(QLabel, "Path_label")
        self.align = self.findChild(QTextEdit, "AlignmentBox")
        self.tree = self.findChild(QTreeWidget, "nameList")
        self.search_box = self.findChild(QLineEdit, "searchBox")
        self.igout = self.findChild(QTextEdit, "igblastOut")
        self.tree_list = self.findChild(QListWidget, "tree_select")
        self.tree_image = self.findChild(QLabel, "graphics_label")

        
        
        self.tabs.setTabText(0, "Fasta File")
        self.tabs.setTabText(1, "Record")
        self.tabs.setTabText(2, "Igblast")

        #set muli-select to the tree view
        self.tree.setSelectionMode(self.tree.selectionMode().MultiSelection)

        # Populate Fasta File tab - handle both string and list cases
        if self.menuW and self.menuW.Fasta_Data:
            if isinstance(self.menuW.Fasta_Data, list):
                self.fbox.insertPlainText("\n".join(self.menuW.Fasta_Data))
            else:
                self.fbox.insertPlainText(self.menuW.Fasta_Data)
        if self.menuW:
            self.plab.setText(self.menuW.combined_fasta)

        #creates a thread to run IGBLAST and clonality
        self.thread_manager = QThreadPool()

        #when something in the tree is selected, it will display the correct information
        self.tree.itemClicked.connect(self.onItemClicked)

        self.tree_list.itemClicked.connect(self.list_selected)

        #parses the data into a list of Seq objects
        self.fasta = self.sortNames()

        #builds the tree to display the sequences
        for f in self.menuW.Fasta_Paths:
            b_name = os.path.basename(f)
            fasta_path = QTreeWidgetItem(self.tree)
            fasta_path.setText(0, b_name)
            # set the child - sequence names now have format: original_name_filename.fasta
            for i in self.fasta:
                seq_name = str(i).strip()
                # Check if sequence name ends with the filename (without newline now)
                if seq_name.endswith("_" + b_name):
                    seq_item = QTreeWidgetItem(fasta_path)
                    seq_item.setText(0, seq_name)
        
        # Expand all items by default so users can see the structure
        self.tree.expandAll()
        
        # Connect search box to filter function
        if self.search_box:
            self.search_box.textChanged.connect(self.filterTree)
        
        #if the user selects the show dist plot option, it will show it
        self.Show_Distrobution_Plot.triggered.connect(clone.display_Image)

        #
        self.ExportData.triggered.connect(self.exportData)

        #combines make database command and runs it
        self.igblast_db_file_V = ""
        self.igblast_db_file_D = ""
        self.igblast_db_file_J = ""
        if(self.menuW.Database_Path_V != ""):

            #make V Database
            n = os.path.basename(self.menuW.Database_Path_V_clean)
            pathname = os.path.join(geneHome, "data", "Database-Files", n)


            cmd = f"{geneHome}/bin/makeblastdb -parse_seqids -dbtype nucl -in {self.menuW.Database_Path_V_clean} -out {pathname}"
            self.igblast_db_file_V = pathname
            os.system(cmd)

            #make D Database
            n = os.path.basename(self.menuW.Database_Path_D_clean)
            pathname = os.path.join(geneHome, "data", "Database-Files", n)

            
            cmd = f"{geneHome}/bin/makeblastdb -parse_seqids -dbtype nucl -in {self.menuW.Database_Path_D_clean} -out {pathname}"
            self.igblast_db_file_D = pathname
            os.system(cmd)

            #make J Database
            n = os.path.basename(self.menuW.Database_Path_J_clean)
            pathname = os.path.join(geneHome, "data", "Database-Files", n)

            
            cmd = f"{geneHome}/bin/makeblastdb -parse_seqids -dbtype nucl -in {self.menuW.Database_Path_J_clean} -out {pathname}"
            self.igblast_db_file_J = pathname
            os.system(cmd)

        self.progW = progressWindow()
        self.progW.show()
        # Don't get custom threshold yet - wait until after distance is calculated
        # Store that user wants to use custom threshold, but get the value later
        self.use_custom_threshold = False  # Will be set if user provides custom value

        #runs a command that records all terminal output and saves it to output.txt
        # a = subprocess.Popen(["script", "-q", "output.txt"], stdout=subprocess.PIPE)

        self.thread_manager.start(self.run_analysis_blast)

    def list_selected(self):
        s =self.tree_list.currentItem().text()
        image_profile = QImage(os.path.join(outs_dir, "trees", s))
        #image_profile = image_profile.scaled(250,250, aspectRatioMode=Qt.KeepAspectRatio, transformMode=Qt.SmoothTransformation)
        self.tree_image.setPixmap(QPixmap.fromImage(image_profile)) 

    def show_trees(self):
        #show the images in the gui
        trees_dir = os.path.join(outs_dir, "trees")
        files = os.listdir(trees_dir)
        for f in files:
            item = QListWidgetItem(f)
            self.tree_list.addItem(item)

    def update_value(self, val, msg):
        self.progW.progress.setValue(val)
        self.progW.proglabel.setText(msg)

    @pyqtSlot()
    def run_analysis_blast(self):

        #s = pyqtSignal()

        self.df = blast.blast_get_top_hits_v(
            input_fp = self.menuW.combined_fasta,
            db_V_fp = self.igblast_db_file_V,
            db_D_fp = self.igblast_db_file_D,
            db_J_fp = self.igblast_db_file_J
        )[0]
        self.df.to_csv(os.path.join(outs_dir, "outdata.csv"))

        # os.system("exit")
        # os.system("exit")

        self.update_value(25, "Formatting Database:")

        try:
            clone.generate_db_dist(self.menuW.Database_Path_J, self.menuW.Database_Path_V, self.menuW.Database_Path_D, self.menuW.combined_fasta)
            # Get the calculated distance
            calculated_dist = clone.get_dist()
            print(f"Using calculated distance threshold: {calculated_dist}")
        except Exception as e:
            print(f"Warning: Error in generate_db_dist: {str(e)}")
            # Continue with default distance if calculation fails
            if hasattr(clone, 'DIST'):
                clone.DIST = 0.1
            calculated_dist = 0.1
        
        # Request threshold dialog on main thread using signal/slot
        result_container = {'value': None}
        self.request_threshold.emit(calculated_dist, result_container)
        
        # Wait for dialog to complete (process events to allow signal to be handled)
        from PyQt6.QtCore import QEventLoop, QTimer
        loop = QEventLoop()
        # Use a timer to periodically check if result is ready
        def check_result():
            if result_container['value'] is not None:
                loop.quit()
            else:
                QTimer.singleShot(100, check_result)
        
        QTimer.singleShot(100, check_result)
        loop.exec()
        
        # Get the result
        if result_container['value'] is not None:
            self.customThresh = result_container['value']
        else:
            # Fallback to calculated value if something went wrong
            self.customThresh = str(calculated_dist)
        
        print(f"Using distance threshold: {self.customThresh}")
        
        self.update_value(40, "Finding Clones: ")

        try:
            clone.finish_clonality(self.menuW.Database_Path_J, self.menuW.Database_Path_V, self.menuW.Database_Path_D, self.menuW.combined_fasta, self.customThresh)
        except Exception as e:
            print(f"Warning: Error in finish_clonality: {str(e)}")
            # Try to continue even if clonality fails
        self.update_value(50, "Building Tree: ")

        #read clone data
        self.clonedf = pd.read_table(os.path.join(outs_dir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv'))

        #sort the df by clone_id frequency
        self.clonedf['clone_freq'] = self.clonedf.groupby('clone_id')['sequence_id'].transform('count')
        self.clonedf.sort_values('clone_freq', inplace=True, ascending=False)

        #ge the first 5 rows and save it to a tsv file
        tempdf = self.clonedf.copy()
        tempdf.drop_duplicates(subset="clone_id", keep=False, inplace=True)
        tempdf = tempdf.head(20)
        tempdf.drop(columns=tempdf.columns[-1],  axis=1,  inplace=True)
        build_trees_input_path = os.path.join(outs_dir, 'build-trees-input.tsv')
        tempdf.to_csv(build_trees_input_path, sep="\t", index=False)

        #runs the build tress command and saves the tree as a pdf
        build_trees_dir = os.path.join(outs_dir, 'build-trees-input')
        os.system(f"rm -rf {build_trees_dir}")
        # Change to outs directory for BuildTrees.py to create files there
        original_cwd = os.getcwd()
        try:
            os.chdir(outs_dir)
            # BuildTrees.py will create files in current directory, so we need to pass relative path
            build_trees_input_rel = os.path.relpath(build_trees_input_path, outs_dir)
            os.system(f"BuildTrees.py -d {build_trees_input_rel} --collapse --igphyml --clean all --optimize n")
        finally:
            os.chdir(original_cwd)
        # Update visualize-tree.R to use outs directory
        visualize_tree_script = os.path.join(geneHome, 'src', 'scripts', 'visualize-tree.R')
        try:
            result = subprocess.run(
                [f"Rscript", visualize_tree_script, outs_dir],
                capture_output=True,
                text=True,
                timeout=300
            )
            if result.returncode != 0:
                print(f"Warning: visualize-tree.R returned non-zero exit code: {result.returncode}")
                if result.stderr:
                    print(f"R script stderr: {result.stderr}")
        except subprocess.TimeoutExpired:
            print("Warning: visualize-tree.R timed out after 5 minutes")
        except Exception as e:
            print(f"Warning: Error running visualize-tree.R: {str(e)}")
        self.update_value(100, "Done!")

        self.show_trees()
        #stops recording terminal output

        

    
    #@pyqtSlot()
    #def run_analysis_changeo(self)
        

        # #generates table it igblast output data
        # self.igout.setFont(QFont('Courier', 13))
        # self.igout.setText(tabulate(progressW.df, headers = 'keys', tablefmt = 'psql'))
        # #runs clonality and generates data files




#inintalizes app object and generates the main and menu windows
if __name__ == '__main__':
    app = QApplication([])
    icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cells.icns')
    app.setWindowIcon(QIcon(icon_path))
    controler = QStackedWidget()
    #generates the main window and window "holder"
    menuW = menuWindow(controller=controler)
    controler.addWidget(menuW)
    controler.setGeometry(100,100,1200,700)
    controler.show()
    sys.exit(app.exec())


