#!/bin/sh
# Optional per-user menu entry for an already runnable portable Linux bundle.
set -eu
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
APPLICATIONS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPLICATIONS"
test ! -e "$APPLICATIONS/lattice-friday.desktop" || { echo "Lattice menu entry exists; keep it or remove that entry explicitly." >&2; exit 1; }
ESCAPED=$(printf '%s' "$SOURCE/lattice-p0" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g; s/%/%%/g')
cat > "$APPLICATIONS/lattice-friday.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Lattice Friday
Exec="$ESCAPED"
Terminal=false
Categories=Development;
EOF
echo "Menu entry created. Keep the extracted bundle in this location."
