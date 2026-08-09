import pandas
import re
import sys
import os


def clean_imgt(in_path, out_path):
    # Verify input file exists
    if not os.path.exists(in_path):
        raise FileNotFoundError(f"Input file does not exist: {in_path}")
    
    if os.path.getsize(in_path) == 0:
        raise ValueError(f"Input file is empty: {in_path}")

    in_file = open(in_path, 'r')
    out_file = open(out_path, "x")
    
    sequence_count = 0
    line_count = 0

    try:
        for line in in_file:
            line_count += 1
            if len(line) == 0:
                continue  # Skip empty lines
                
            if(line[0] == '>'):
                sequence_count += 1
                boundaries = list(find_all(line))
                # Check if we found at least 2 pipe characters
                if len(boundaries) >= 2:
                    germline_name = line[boundaries[0]+1: boundaries[1]]
                else:
                    # If no pipe characters found, use the entire header (minus the >)
                    # or just the first part before any pipe
                    if len(boundaries) == 1:
                        # One pipe found, use everything before it
                        germline_name = line[1:boundaries[0]]
                    else:
                        # No pipes found, use entire header minus >
                        germline_name = line[1:].strip()

                new_line = '>'+germline_name+'\n'
                out_file.write(new_line)
            else:
                # Only write sequence lines (skip empty lines that aren't headers)
                if line.strip():
                    out_file.write(line.replace(".",""))
        
        # Verify we found at least one sequence
        if sequence_count == 0:
            raise ValueError(f"No sequences found in input file: {in_path}")
            
    except Exception as e:
        # Close files before re-raising
        in_file.close()
        try:
            out_file.close()
            # Remove the output file if creation failed
            if os.path.exists(out_path):
                os.remove(out_path)
        except:
            pass
        raise Exception(f"Error cleaning file {in_path}: {str(e)}")
    finally:
        in_file.close()
        out_file.close()

def find_all(a_str, sub = '|', numToFind = 2):
    """
    Function that finds all occurences of a given character in a string
    :param a_str: string to search through
    :param sub:  char searching for
    :param numToFind: how many occurences of sub are we looking for
    """
    start = 0
    numFound = 0
    while (numFound < numToFind):
        start = a_str.find(sub, start)
        if start == -1: return
        yield start
        numFound += 1
        start += len(sub) # use start += 1 to find overlapping matches




