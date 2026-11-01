# Installs two scheduled tasks for this checkout (Windows):
#   sg-stay-where-server  keeps the app running (starts at sign-in, restarts if it stops)
#   sg-stay-where-poll    runs one poll every 2 hours on the hour (Claude Code by default)
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 [server|poll|both]
#   Set $env:SSW_AGENT = "codex" first to schedule Codex.
# Remove: Unregister-ScheduledTask sg-stay-where-server, sg-stay-where-poll -Confirm:$false
param([ValidateSet("server", "poll", "both")][string]$Which = "server")
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
New-Item -ItemType Directory -Force (Join-Path $repo "data\poll-logs") | Out-Null
$q = { param($s) "'" + ($s -replace "'", "''") + "'" }
$cli = "& $(& $q $node) --no-warnings=ExperimentalWarning $(& $q (Join-Path $repo 'src\cli.js'))"

# A hidden PowerShell runs node, so no console window stays open. Tasks run as you,
# only while you're signed in: polls need your Chrome.
function Install-Task($name, $command, $trigger, $settings) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$command`"" -WorkingDirectory $repo
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  "installed $name"
}

if ($Which -in "server", "both") {
  $log = & $q (Join-Path $repo "data\serve.log")
  # The loop restarts the app if it stops, as KeepAlive does on macOS.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Install-Task "sg-stay-where-server" "while (`$true) { $cli serve --log $log; Start-Sleep 5 }" (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) $settings
  Start-ScheduledTask "sg-stay-where-server"
  "restart after code changes: Stop-ScheduledTask sg-stay-where-server; Start-ScheduledTask sg-stay-where-server"
}
if ($Which -in "poll", "both") {
  $agent = if ($env:SSW_AGENT) { "`$env:SSW_AGENT = $(& $q $env:SSW_AGENT); " } else { "" }
  # Every 2 hours from midnight; StartWhenAvailable runs a poll missed during sleep once on wake.
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 2)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
  Install-Task "sg-stay-where-poll" "$agent$cli poll; exit `$LASTEXITCODE" $trigger $settings
}
