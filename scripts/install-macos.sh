#!/bin/zsh
# Installs two LaunchAgents for this checkout (macOS only):
#   sg-stay-where.server  keeps `npm start` running (starts at login, restarts on crash)
#   sg-stay-where.poll    runs scripts/poll.sh every 2 hours (Claude Code by default)
# Usage: [SSW_AGENT=codex] scripts/install-macos.sh [server|poll|both]   (default: server)
# Remove: launchctl bootout gui/$(id -u)/sg-stay-where.<server|poll>; rm ~/Library/LaunchAgents/sg-stay-where.*.plist
set -eu
cd "${0:A:h}/.."
repo=$PWD
node=$(command -v node)
which=${1:-server}
agents=~/Library/LaunchAgents
mkdir -p "$agents" data/poll-logs

install_agent() {
  local label=$1 body=$2
  local plist="$agents/$label.plist"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>WorkingDirectory</key><string>$repo</string>
$body
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "installed $label ($plist)"
}

if [[ $which == server || $which == both ]]; then
  install_agent sg-stay-where.server "  <key>ProgramArguments</key><array><string>$node</string><string>--no-warnings=ExperimentalWarning</string><string>$repo/src/cli.js</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$repo/data/serve.log</string>
  <key>StandardErrorPath</key><string>$repo/data/serve.log</string>"
  echo "restart after code changes: launchctl kickstart -k gui/\$(id -u)/sg-stay-where.server"
fi
if [[ $which == poll || $which == both ]]; then
  # Calendar times, not StartInterval: launchd runs a poll missed during sleep once on wake.
  hours=""
  for h in 0 2 4 6 8 10 12 14 16 18 20 22; do hours="$hours<dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>0</integer></dict>"; done
  env=""
  [[ -n ${SSW_AGENT:-} ]] && env="
  <key>EnvironmentVariables</key><dict><key>SSW_AGENT</key><string>$SSW_AGENT</string></dict>"
  install_agent sg-stay-where.poll "  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>$repo/scripts/poll.sh</string></array>$env
  <key>StartCalendarInterval</key><array>$hours</array>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$repo/data/poll-logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$repo/data/poll-logs/launchd.log</string>"
fi
