#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"; then
    osascript -e 'display dialog "Zombi Roles needs Node.js 24 or newer, a free program from nodejs.org.\n\nYour browser will open the download page. Choose the LTS version and install it, then double-click this file again." buttons {"OK"} default button "OK" with title "Zombi Roles"'
    open "https://nodejs.org/en/download"
    exit 0
fi

# Runs in the background with no window. Shut down from the panel.
nohup node launcher.mjs >/dev/null 2>&1 &
disown
(sleep 0.3; osascript -e 'tell application "Terminal" to close (every window whose name contains "Zombi Roles Launcher")' >/dev/null 2>&1) &
