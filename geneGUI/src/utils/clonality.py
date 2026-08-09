from src.utils import clonalityFunctions
import subprocess
import os

DIST = 0

# Get outs directory path - go up to geneGUI directory
geneHome = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
outs_dir = os.path.join(geneHome, "outs")


def generate_db_dist(j, v, d, fasta):
    global DIST

    fmt7_path = os.path.join(outs_dir, "ig_out_data.fmt7")
    db_pass_path = os.path.join(outs_dir, "ig_out_data_db-pass.tsv")
    clonalityFunctions.make_db(fmt7_path, j, v, d, fasta)
    DIST = clonalityFunctions.findDist(db_pass_path)
    #will return a new clone and display
#this is when the window pops up
def finish_clonality(j, v, d, fasta, dist):
    db_pass_path = os.path.join(outs_dir, "ig_out_data_db-pass.tsv")
    clone_pass_path = os.path.join(outs_dir, "ig_out_data_db-pass_clone-pass.tsv")
    clonalityFunctions.define_clonality(db_pass_path, dist)
    clonalityFunctions.create_germline(clone_pass_path, v, d, j)

def get_dist():
    global DIST
    return DIST

#displays the distrobution plot image
def display_Image():
    clonalityFunctions.showImage()

