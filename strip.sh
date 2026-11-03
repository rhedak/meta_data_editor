#!/usr/bin/env bash
# Strip all metadata from the files in input/ (including subfolders) and
# write clean copies to out/, keeping the folder structure.
#
# Usage: ./strip.sh [input_dir] [output_dir]
set -euo pipefail

cd "$(dirname "$0")"
exec node cli/strip.js "$@"
