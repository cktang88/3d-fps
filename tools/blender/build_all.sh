#!/usr/bin/env bash
# Build every FP rig sequentially (one Blender at a time). Usage: tools/blender/build_all.sh <blender> <sf_dir> <work_dir> [out_dir|-] [ids...]
set -u
B=$1; SF=$2; W=$3; OUT=${4:--}; shift 4 || true
IDS=${*:-"m4a1 ak47 scarl mp5a5 vss m24 awm shotgun p226 m1911"}
for id in $IDS; do
  dst=-; [ "$OUT" != "-" ] && dst="$OUT/$id.glb"
  timeout 1500 "$B" -b --python "$(dirname "$0")/build_rig.py" -- "$id" "$SF" "$W" "$dst" 2>&1 | grep -E "\[rig\].*(PENET|done|exported|hand fit)|Error|Traceback" | sed "s/^/$id: /"
done
