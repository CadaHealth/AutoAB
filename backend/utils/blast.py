import sys
import subprocess
import pandas as pd
from io import StringIO
import warnings
import numpy as np
from Bio import SeqIO
import os

from .toolpaths import find_igblast_binary


def blast_get_top_hits_v(input_fp, db_V_fp, db_J_fp, db_D_fp, organism='human', bin_dir=None, data_dir=None, output_dir=None, db_C_fp=None):
    """
    Function that parses the hits table from igblastn into pandas dataframe.
    :param input_fp: string, file path of the input fasta file
    :param db_V_fp: string, file path of the V gene database
    :param db_J_fp: string, file path of the J gene database
    :param db_D_fp: string, file path of the D gene database
    :param organism: string, optional, default = human
    :param bin_dir: string, optional, path to bin directory (if None, will calculate)
    :param data_dir: string, optional, path to data directory (if None, will calculate)
    :param output_dir: string, optional, path to output directory (if None, will calculate)
    :param db_C_fp: string, optional, path to C gene BLAST database (for IgBLAST >= 1.18)
    :return: a tuple of (df, output data)
    """
    # Calculate paths if not provided. Resolved centrally rather than derived
    # from this file's location: the packaged app has no geneGUI directory, its
    # resources are flattened into Resources/{bin,data}, and its scratch space
    # lives outside the bundle entirely.
    if bin_dir is None or data_dir is None or output_dir is None:
        from .toolpaths import bin_dir as _bin, data_dir as _data, outs_dir as _outs

        if bin_dir is None:
            bin_dir = _bin()
        if data_dir is None:
            data_dir = _data()
        if output_dir is None:
            output_dir = _outs()

    geneHome = os.path.dirname(bin_dir) if bin_dir else os.path.dirname(data_dir)
    
    #runs the igblastn command
    igblastn_path = find_igblast_binary(bin_dir, 'igblastn')
    # Species-aware auxiliary data file. Defaults to human; falls back to human
    # if a species-specific aux file is missing so the call doesn't crash.
    species = (organism or 'human').lower()
    aux_filename = f'{species}_gl.aux'
    aux_data_path = os.path.join(data_dir, 'optional_data', aux_filename)
    if not os.path.exists(aux_data_path):
        aux_data_path = os.path.join(data_dir, 'optional_data', 'human_gl.aux')
    # IGDATA should point to the parent directory containing 'internal_data' folder
    igdata_path = data_dir
    # Set IGDATA environment variable so igblastn can find internal_data
    env = os.environ.copy()
    env['IGDATA'] = igdata_path
    cmd = [igblastn_path, '-germline_db_V', db_V_fp, '-germline_db_D', db_D_fp, '-germline_db_J', db_J_fp,
           '-organism', species]
    if db_C_fp:
        cmd.extend(['-c_region_db', db_C_fp])
    cmd.extend(['-query', input_fp, '-outfmt', '7 std qseq sseq btop', '-auxiliary_data', aux_data_path])
    a = subprocess.Popen(cmd, stdout=subprocess.PIPE, cwd=geneHome, env=env)
    out = a.communicate()[0].decode('utf-8')
    b = StringIO(out)
    # parse output into string
    all_data = [x.strip() for x in str(b.getvalue()).split('#')]

    fmt7_path = os.path.join(output_dir, "ig_out_data.fmt7")
    with open(fmt7_path, "w") as txt_file:
        txt_file.write(out)

    # the hit table is the 2nd from the last in the list above.
    #
    # IgBLAST blocks come in arbitrary order; for some queries the
    # "Sub-region sequence details" block can be missing (e.g. when no
    # CDR3 was detected) while "CDR3-IMGT" still appears later. In that
    # case the previous query's dna/prot would leak across, defend
    # against that by resetting at every Query boundary and skipping the
    # CDR3 row when the sub-region wasn't seen for this query.

    hits = []
    cur_query = ''
    dna = None
    prot = None
    for line in all_data:
        if 'hits found' in line:
            hits += line.split('\n')[1:]
        if "Query: " in line:
            cur_query = line[7:]
            dna = None
            prot = None
        if "Sub-region sequence details" in line:
            try:
                dna, prot = line.split('\n')[1].split('\t')[1:3]
            except (IndexError, ValueError):
                dna = None
                prot = None
        if "CDR3-IMGT" in line:
            somatic_mutations = 0
            d = line.split("\n")
            for s in d:
                if "Total" in s:
                    parts = s.split()
                    if len(parts) > 5 and parts[5].isdigit():
                        somatic_mutations = int(parts[5])
            if dna is not None and prot is not None:
                x = ("CDR3\t" + cur_query + '\t' + dna + "\t" + prot + "\t" + str(somatic_mutations) + "\n")
                hits.append(x)

    #default fields
    fields = 'chain type\tquery id\tsubject id\t% identity\talignment length\tmismatches\tgap opens\tgaps\tq.start\tq.ends\t s.start\ts.end\tevalue\tbit score\tquery seq\tsubject seq\tBTOP'

    # add col header
    hits.insert(0, fields)
    # parse into df
    #print('\n'.join(hits))
    data = StringIO('\n'.join(hits))
    df = pd.read_csv(data, sep='\t')
    csv_path = os.path.join(output_dir, 'out.csv')
    df.to_csv(csv_path)
    # get df, the best matching germline allele & identity
    return df, out
    #except:
      #  print('None of the seuqenced you provided in the fasta file ')
       # return None, None, None


# Test call removed - uncomment below to test locally
# blast_get_top_hits_v("fasta_files/1018.fasta", "Database-Files/IGHV_clean.fasta", "Database-Files/IG_HKL_J_clean.fasta", "Database-Files/IGHD_clean.fasta")