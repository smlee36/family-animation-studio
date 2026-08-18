#!/usr/bin/env bash
set -euo pipefail

SOURCE="${WAN22_MODEL_SOURCE:-/NHNHOME/WORKSPACE/26mss002_U1A/wan22/models/Wan2.2-I2V-A14B}"
TARGET="${WAN22_LOCAL_MODEL:-/NHNHOME/.family-animation-models/Wan2.2-I2V-A14B}"

mkdir -p -m 700 "$(dirname "$TARGET")" "$TARGET"
rm -f "$TARGET/.ready"
rsync -a --info=progress2 "$SOURCE/" "$TARGET/"
touch "$TARGET/.ready"
echo "Wan 2.2 local NVMe cache ready: $TARGET"
