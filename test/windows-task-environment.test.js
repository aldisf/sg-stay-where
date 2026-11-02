import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Windows tasks preserve agent selection and tool paths without registering real jobs', { skip: process.platform !== 'win32' }, t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssw-task-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installer = fileURLToPath(new URL('../scripts/install-windows.ps1', import.meta.url));
  const harness = path.join(dir, 'harness.ps1');
  writeFileSync(harness, `param([string]$Installer)
$ErrorActionPreference = 'Stop'
$global:tasks = @()
function Get-Command { param($Name, $CommandType, $ErrorAction)
  if ($Name -eq 'node') { [pscustomobject]@{Source='C:\\Node Tools\\node.exe'} }
  elseif ($Name -eq 'codex') { [pscustomobject]@{Source="C:\\Agent's Tools\\codex.exe"} }
}
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Settings,[switch]$Force) $global:tasks += [pscustomobject]@{name=$TaskName;arguments=$Action.Arguments} }
function Start-ScheduledTask { param($TaskName) }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User,[switch]$Once,$At,$RepetitionInterval) @{} }
function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$MultipleInstances,[switch]$StartWhenAvailable) @{} }
$env:SSW_AGENT='codex'
$null = & $Installer both
if ($global:tasks.Count -ne 2) { throw 'Expected two mocked tasks' }
$global:tasks | ConvertTo-Json -Compress
`);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', harness, installer], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const task of JSON.parse(result.stdout)) {
    assert.match(task.arguments, /\$env:SSW_AGENT = 'codex'/);
    assert.ok(task.arguments.includes("C:\\Node Tools;C:\\Agent''s Tools"), task.arguments);
    assert.match(task.arguments, /\$env:PATH/);
  }
});
