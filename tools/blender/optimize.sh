#!/usr/bin/env bash
# Optimise exported FP rigs for the web: atlas the many-material guns (ATLAS ids, tools/blender/atlas_fp.mjs, 2048 px
# atlas), dedup, prune, cap other textures at 1024 px, weld, quantize, WebP, and (MESHOPT=1, the default) meshopt
# geometry compression (src/core/Assets.js registers MeshoptDecoder). No flatten/join: node names are a runtime contract.
#   tools/blender/optimize.sh <in_dir> <out_dir> [ids...]
set -eu
IN=$1; OUT=$2; shift 2
IDS=${*:-"m4a1 ak47 scarl mp5a5 vss m24 awm shotgun p226 m1911"}
ATLAS=${ATLAS:-"vss p226"}
MESHOPT=${MESHOPT:-1}
mkdir -p "$OUT"
cd "$(dirname "$0")/../.."
for id in $IDS; do
  [ -f "$IN/$id.glb" ] || { echo "skip $id"; continue; }
  t=$(mktemp -d)
  if [[ " $ATLAS " == *" $id "* ]]; then   # sources capped at 1024 first, then packed into one 2048 atlas
    npx gltf-transform resize "$IN/$id.glb" "$t/r.glb" --width 1024 --height 1024 >/dev/null
    node tools/blender/atlas_fp.mjs "$t/r.glb" "$t/a0.glb" 2048 | tail -2
    npx gltf-transform dedup "$t/a0.glb" "$t/a.glb" >/dev/null
    npx gltf-transform prune "$t/a.glb" "$t/c.glb" --keep-leaves true >/dev/null
  else
    npx gltf-transform dedup "$IN/$id.glb" "$t/a.glb" >/dev/null
    npx gltf-transform prune "$t/a.glb" "$t/b.glb" --keep-leaves true >/dev/null
    npx gltf-transform resize "$t/b.glb" "$t/c.glb" --width 1024 --height 1024 >/dev/null
  fi
  npx gltf-transform weld "$t/c.glb" "$t/d.glb" >/dev/null
  npx gltf-transform quantize "$t/d.glb" "$t/e.glb" >/dev/null   # KHR_mesh_quantization: no decoder needed
  if [ "${MESHOPT:-0}" = 1 ]; then   # needs GLTFLoader.setMeshoptDecoder (src/core/Assets.js)
    npx gltf-transform webp "$t/e.glb" "$t/f.glb" --quality 88 >/dev/null
    npx gltf-transform meshopt "$t/f.glb" "$OUT/$id.glb" >/dev/null
  else
    npx gltf-transform webp "$t/e.glb" "$OUT/$id.glb" --quality 88 >/dev/null
  fi
  python3 "$(dirname "$0")/share_arms_textures.py" "$OUT/$id.glb" >/dev/null   # arms maps -> shared fp/arms_*.webp
  echo "$id $(du -h "$IN/$id.glb" | cut -f1) -> $(du -h "$OUT/$id.glb" | cut -f1)"
  rm -rf "$t"
done
