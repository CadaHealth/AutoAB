import sys
import subprocess
import pandas as pd
from io import StringIO
import warnings
import numpy as np
from Bio import SeqIO
import os


def blast_get_top_hits_v(input_fp, db_V_fp, db_J_fp, db_D_fp, organism='human'):
    """
    Function that parses the hits table from blastp (bin/igblast(p/n)) into pandas dataframe. The hits table shows the top 3 hits (default) of the germline seuqences that are with highest identity % to the query seuqence.
    :param input_fp: string, file path of the input fasta file
    :param db_fp:  string, file path of the serach database, i.e. the value for `-germline_db_V` argument
    :param organism: string, optimal, default = human
    :return: a tuple of (df, output data)
    """
    # Get the geneGUI directory path - go up to geneGUI directory
    geneHome = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    outs_dir = os.path.join(geneHome, "outs")
    #runs the igblastn command
    igblastn_path = os.path.join(geneHome, 'bin', 'igblastn')
    aux_data_path = os.path.join(geneHome, 'data', 'optional_data', 'human_gl.aux')
    # IGDATA should point to the parent directory containing 'internal_data' folder
    igdata_path = os.path.join(geneHome, 'data')
    # Set IGDATA environment variable so igblastn can find internal_data
    env = os.environ.copy()
    env['IGDATA'] = igdata_path
    cmd = [igblastn_path, '-germline_db_V', db_V_fp, '-germline_db_D', db_D_fp, '-germline_db_J', db_J_fp,'-query', input_fp, '-outfmt', '7 std qseq sseq btop', '-auxiliary_data', aux_data_path]#, '-out', 'ig_out_data.fmt7', "-organism", organism]
    a = subprocess.Popen(cmd, stdout=subprocess.PIPE, cwd=geneHome, env=env)
    out = a.communicate()[0].decode('utf-8')
    b = StringIO(out)
    # parse output into string
    all_data = [x.strip() for x in str(b.getvalue()).split('#')]

    fmt7_path = os.path.join(outs_dir, "ig_out_data.fmt7")
    with open(fmt7_path, "w") as txt_file:
        txt_file.write(out)

    # the hit table is the 2nd from the last in the list above.

    hits=[]
    for line in all_data:
        if 'hits found' in line:
            hits+=line.split('\n')[1:]
        if("Query: " in line):
            cur_query = line[7:]
        if("Sub-region sequence details" in line):
            dna, prot = line.split('\n')[1].split('\t')[1:3]
        if("CDR3-IMGT" in line):
            somatic_mutations = 0
            d = line.split("\n")
            for s in d:
                if("Total" in s):
                    somatic_mutations = int(s.split()[5])
            x = ("CDR3\t" + cur_query + '\t' + dna+ "\t" + prot + "\t" + str(somatic_mutations) + "\n")
            hits.append(x)

    #default fields
    fields = 'chain type\tquery id\tsubject id\t% identity\talignment length\tmismatches\tgap opens\tgaps\tq.start\tq.ends\t s.start\ts.end\tevalue\tbit score\tquery seq\tsubject seq\tBTOP'

    # add col header
    hits.insert(0, fields)
    # parse into df
    #print('\n'.join(hits))
    data = StringIO('\n'.join(hits))
    df = pd.read_csv(data, sep='\t')
    csv_path = os.path.join(outs_dir, 'out.csv')
    df.to_csv(csv_path)
    # get df, the best matching germline allele & identity
    return df, out
    #except:
      #  print('None of the seuqenced you provided in the fasta file ')
       # return None, None, None


# Test call removed - uncomment below to test locally
# blast_get_top_hits_v("fasta_files/1018.fasta", "Database-Files/IGHV_clean.fasta", "Database-Files/IG_HKL_J_clean.fasta", "Database-Files/IGHD_clean.fasta")