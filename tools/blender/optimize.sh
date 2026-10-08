#!/usr/bin/env bash
# Optimise exported FP rigs for the web: dedup, prune, cap textures at 1024 px, WebP. No mesh compression
# (the game's GLTFLoader has no Draco/Meshopt decoder). No flatten/join: node names are a runtime contract.
#   tools/blender/optimize.sh <in_dir> <out_dir> [ids...]
set -eu
IN=$1; OUT=$2; shift 2
IDS=${*:-"m4a1 ak47 scarl mp5a5 vss m24 awm shotgun p226 m1911"}
mkdir -p "$OUT"
cd "$(dirname "$0")/../.."
for id in $IDS; do
  [ -f "$IN/$id.glb" ] || { echo "skip $id"; continue; }
  t=$(mktemp -d)
  npx gltf-transform dedup "$IN/$id.glb" "$t/a.glb" >/dev/null
  npx gltf-transform prune "$t/a.glb" "$t/b.glb" --keep-leaves true >/dev/null
  npx gltf-transform resize "$t/b.glb" "$t/c.glb" --width 1024 --height 1024 >/dev/null
  npx gltf-transform webp "$t/c.glb" "$OUT/$id.glb" --quality 88 >/dev/null
  echo "$id $(du -h "$IN/$id.glb" | cut -f1) -> $(du -h "$OUT/$id.glb" | cut -f1)"
  rm -rf "$t"
done
