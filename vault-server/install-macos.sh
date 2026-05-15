#!/bin/bash
#
# Installs the GHL Vault as a properly-named macOS background agent.
#
# Without this, launchd runs the bare `node` binary, so macOS labels it
# "node — Item from unidentified developer" in System Settings > Login
# Items. This wraps it in a real .app bundle ("GHL Vault") and ad-hoc
# code-signs it so it shows a proper name.
#
# Usage:  ./install-macos.sh          (install / reinstall)
#         ./install-macos.sh remove   (uninstall)
#
set -euo pipefail

APP_NAME="GHL Vault"
BUNDLE_ID="com.ventryx.ghl-vault"
APP_DIR="$HOME/Applications/${APP_NAME}.app"
PLIST="$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="${REPO_DIR}/server.js"
NODE_BIN="$(command -v node)"

unload_agent() {
  launchctl unload -w "$PLIST" 2>/dev/null || true
}

if [[ "${1:-}" == "remove" ]]; then
  echo "Removing ${APP_NAME}..."
  unload_agent
  rm -f "$PLIST"
  rm -rf "$APP_DIR"
  echo "Removed. (vault-data.json kept in ${REPO_DIR})"
  exit 0
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH" >&2
  exit 1
fi
if [[ ! -f "$SERVER_JS" ]]; then
  echo "ERROR: server.js not found at $SERVER_JS" >&2
  exit 1
fi

echo "Node:    $NODE_BIN"
echo "Server:  $SERVER_JS"
echo "App:     $APP_DIR"

# --- Build the .app bundle ------------------------------------------------
unload_agent
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"

# Launcher executable — execs node with the vault server
cat > "$APP_DIR/Contents/MacOS/ghl-vault" <<EOF
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "${REPO_DIR}"
exec "${NODE_BIN}" "${SERVER_JS}"
EOF
chmod +x "$APP_DIR/Contents/MacOS/ghl-vault"

# Info.plist — this is what macOS reads for the display name
cat > "$APP_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>     <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>      <string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key>      <string>ghl-vault</string>
  <key>CFBundlePackageType</key>     <string>APPL</string>
  <key>CFBundleShortVersionString</key> <string>1.0</string>
  <key>CFBundleVersion</key>         <string>1</string>
  <key>LSUIElement</key>            <true/>
  <key>LSBackgroundOnly</key>       <true/>
</dict>
</plist>
EOF

# Ad-hoc code sign so it has a stable identity (removes the worst of the
# "unidentified" churn; a Developer ID would remove it entirely).
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null \
  && echo "Code-signed (ad-hoc)." \
  || echo "WARN: codesign failed (not fatal)."

# --- Write the launchd agent pointing at the bundle ----------------------
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>${BUNDLE_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${APP_DIR}/Contents/MacOS/ghl-vault</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>StandardOutPath</key>  <string>/tmp/ghl-vault.log</string>
  <key>StandardErrorPath</key><string>/tmp/ghl-vault.err</string>
</dict>
</plist>
EOF

launchctl load -w "$PLIST"
sleep 1

echo "--------------------------------------------------------"
if launchctl list | grep -q "$BUNDLE_ID"; then
  echo "Loaded. Health:"
  curl -s http://127.0.0.1:7777/api/health || echo "(not responding yet — check /tmp/ghl-vault.err)"
  echo
  echo
  echo "It will now appear as \"${APP_NAME}\" in System Settings > General"
  echo "> Login Items & Extensions > Allow in the Background."
else
  echo "WARN: agent not listed. Check /tmp/ghl-vault.err"
fi
echo "--------------------------------------------------------"
