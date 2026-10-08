#!/bin/sh
# Engineering setup, not a formal installer. No system packages or sandbox flags.
set -eu
test "$(id -u)" = 0 || { echo "Run once with sudo sh install-ubuntu.sh" >&2; exit 1; }
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
TARGET=/opt/lattice-friday-demo
ENTRY=/usr/share/applications/lattice-friday.desktop
test ! -e "$TARGET" && test ! -e "$ENTRY" || { echo "Friday setup already exists; refusing to overwrite it." >&2; exit 1; }
test -f "$SOURCE/app/runtime/chrome-sandbox"
mkdir "$TARGET"
cp -a "$SOURCE/." "$TARGET/"
chown -R root:root "$TARGET"
chmod -R go-w "$TARGET"
chmod 4755 "$TARGET/app/runtime/chrome-sandbox"
cat > "$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=Lattice Friday
Exec=$TARGET/lattice-p0
Terminal=false
Categories=Development;
EOF
chmod 644 "$ENTRY"
echo "Lattice Friday is available in the application menu. Launch as your normal user."
