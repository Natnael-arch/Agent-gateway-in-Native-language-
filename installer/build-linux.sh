#!/usr/bin/env bash
# ==============================================================================
# Agelgay Linux Installer Bundle Builder Script
# Assembles a self-contained, portable Linux distribution (Agelgay-linux-x64.tar.gz)
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -d "$REPO_ROOT/agent-gateway" ] && [ -d "$REPO_ROOT/../agent-gateway" ]; then
    REPO_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
fi

BUILD_DIR="$REPO_ROOT/build"
BUNDLE_DIR="$BUILD_DIR/Agelgay"
NODE_VERSION="v22.14.0"
NODE_TAR="node-${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"

echo "======================================================="
echo " Building Agelgay Linux Self-Contained Installer Bundle"
echo "======================================================="
echo "Repo Root: $REPO_ROOT"
echo "Build Dir: $BUNDLE_DIR"
echo ""

# 1. Clean build directory
rm -rf "$BUILD_DIR"
mkdir -p "$BUNDLE_DIR"

# 2. Download and unpack portable Node.js v22 LTS runtime
echo "[1/5] Downloading portable Node.js ${NODE_VERSION}..."
mkdir -p "$BUNDLE_DIR/node"
curl -sL "$NODE_URL" | tar -xJ --strip-components=1 -C "$BUNDLE_DIR/node"
echo "      Bundled Node version: $("$BUNDLE_DIR/node/bin/node" -v)"

# 3. Copy agent-gateway application and install production dependencies
echo "[2/5] Packaging agent-gateway app & installing node_modules..."
mkdir -p "$BUNDLE_DIR/agent-gateway"
rsync -a --exclude='.git' --exclude='.env' --exclude='logs' --exclude='installer' "$REPO_ROOT/agent-gateway/" "$BUNDLE_DIR/agent-gateway/"

# Install production node_modules using the bundled node runtime
(
  cd "$BUNDLE_DIR/agent-gateway"
  "$BUNDLE_DIR/node/bin/npm" install --omit=dev --no-audit --no-fund --quiet
)

# 4. Copy real Hermes distribution
echo "[3/5] Packaging real Hermes distribution..."
mkdir -p "$BUNDLE_DIR/hermes"
if [ -d "$HOME/.hermes" ]; then
  rsync -a \
    --exclude='sessions' \
    --exclude='logs' \
    --exclude='audio_cache' \
    --exclude='image_cache' \
    --exclude='cache' \
    --exclude='state.db*' \
    --exclude='kanban.db*' \
    --exclude='.git' \
    "$HOME/.hermes/" "$BUNDLE_DIR/hermes/"
else
  echo "Warning: ~/.hermes not found; creating stub hermes directory" >&2
  mkdir -p "$BUNDLE_DIR/hermes"
  echo "model:" > "$BUNDLE_DIR/hermes/config.yaml"
  echo "  provider: deepseek" >> "$BUNDLE_DIR/hermes/config.yaml"
fi

# 5. Create launcher scripts & copy activate.js
echo "[4/5] Writing activate.sh and start.sh launchers..."
cp "$REPO_ROOT/agent-gateway/installer/activate.js" "$BUNDLE_DIR/activate.js"

cat << 'EOF' > "$BUNDLE_DIR/activate.sh"
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_BIN="$SCRIPT_DIR/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "Error: Portable Node binary not found at $NODE_BIN" >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/activate.js" "$@"
EOF
chmod +x "$BUNDLE_DIR/activate.sh"

cat << 'EOF' > "$BUNDLE_DIR/start.sh"
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_BIN="$SCRIPT_DIR/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "Error: Portable Node binary not found at $NODE_BIN" >&2
  exit 1
fi

echo "======================================================="
echo "🇪🇹 Agelgay Amharic Agent Gateway Server (Linux)"
echo "======================================================="
echo "Starting gateway using portable Node: $NODE_BIN"
echo "Listening on http://localhost:3000"
echo "Press Ctrl+C to stop the gateway."
echo ""

exec "$NODE_BIN" "$SCRIPT_DIR/agent-gateway/server.js" "$@"
EOF
chmod +x "$BUNDLE_DIR/start.sh"

# 6. Compress into self-contained tarball
echo "[5/5] Creating Agelgay-linux-x64.tar.gz tarball..."
tar -czf "$BUILD_DIR/Agelgay-linux-x64.tar.gz" -C "$BUILD_DIR" Agelgay

echo ""
echo "======================================================="
echo " SUCCESS: Agelgay-linux-x64.tar.gz built successfully!"
echo " Location: $BUILD_DIR/Agelgay-linux-x64.tar.gz"
echo " Size: $(du -h "$BUILD_DIR/Agelgay-linux-x64.tar.gz" | cut -f1)"
echo "======================================================="
