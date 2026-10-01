#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

INSTALL_TO_DESKTOP=false
for arg in "$@"; do
  if [ "$arg" = "--desktop" ]; then
    INSTALL_TO_DESKTOP=true
  fi
done

APPIMAGE_SRC=$(ls "$DESKTOP_DIR/dist"/Agelgay-*.AppImage 2>/dev/null | head -n 1 || true)
if [ -z "$APPIMAGE_SRC" ] || [ ! -f "$APPIMAGE_SRC" ]; then
  echo "Error: Could not find built AppImage in $DESKTOP_DIR/dist/"
  echo "Please run 'npm run build:linux' inside the desktop directory first."
  exit 1
fi

ICON_SRC="$DESKTOP_DIR/assets/icon.png"
if [ ! -f "$ICON_SRC" ]; then
  echo "Error: Icon file missing at $ICON_SRC"
  exit 1
fi

# Create target directories
mkdir -p "$HOME/Applications"
mkdir -p "$HOME/.local/share/icons"
mkdir -p "$HOME/.local/share/applications"

APPIMAGE_DEST="$HOME/Applications/Agelgay.AppImage"
ICON_DEST="$HOME/.local/share/icons/agelgay.png"
DESKTOP_FILE_DEST="$HOME/.local/share/applications/agelgay.desktop"

# Step 1: Copy AppImage and make executable
echo "Installing AppImage to $APPIMAGE_DEST..."
cp "$APPIMAGE_SRC" "$APPIMAGE_DEST"
chmod +x "$APPIMAGE_DEST"

# Step 2: Copy icon
echo "Installing icon to $ICON_DEST..."
cp "$ICON_SRC" "$ICON_DEST"

# Step 3: Write .desktop launcher
echo "Creating desktop entry at $DESKTOP_FILE_DEST..."
cat <<EOF > "$DESKTOP_FILE_DEST"
[Desktop Entry]
Type=Application
Name=Agelgay
Exec=$APPIMAGE_DEST --no-sandbox
Icon=$ICON_DEST
Terminal=false
Categories=Utility;
StartupWMClass=Agelgay
EOF
chmod +x "$DESKTOP_FILE_DEST"

# Step 4: Update desktop database if available
if command -v update-desktop-database >/dev/null 2>&1; then
  echo "Updating desktop database..."
  update-desktop-database "$HOME/.local/share/applications" || true
fi

# Step 5: Desktop shortcut if requested
if [ "$INSTALL_TO_DESKTOP" = true ]; then
  mkdir -p "$HOME/Desktop"
  DESKTOP_SHORTCUT="$HOME/Desktop/agelgay.desktop"
  cp "$DESKTOP_FILE_DEST" "$DESKTOP_SHORTCUT"
  chmod +x "$DESKTOP_SHORTCUT"
  echo "Created desktop shortcut at $DESKTOP_SHORTCUT"
  echo "[Note] GNOME Desktop users: Right-click the desktop icon and select 'Allow Launching' to enable it."
fi

echo "Agelgay desktop launcher installation complete!"
