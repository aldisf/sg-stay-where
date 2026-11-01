---
name: schedule-polls
description: Set up, check, change or remove the scheduled job that polls sg-stay-where every 2 hours without a chat session open. Use after the first poll when the user wants automatic polls, when polls look stalled, or to switch the agent that polls.
---

# Schedule polls

A poll started in a chat stops when the chat ends. The scheduled job runs
`npm run poll` (`node src/cli.js poll`), which starts a fresh agent each time. It survives closed
laptops, reboots and forgotten sessions, and runs a missed poll once on wake.

Ask before creating, changing or removing a job. Run one poll by hand first
(`npm run poll`) and check its log in `data/poll-logs/`.

1. **Pick the agent**: `SSW_AGENT=claude` (default) or `codex`. Only Claude
   Code's poll is limited to the tracker's own CLI
   (docs/polling.md, "What stops a poll from sending").
2. **macOS**: `SSW_AGENT=<agent> scripts/install-macos.sh poll` (`both` also
   runs the server). Check it with
   `launchctl print gui/$(id -u)/sg-stay-where.poll | grep -E 'state|last exit'`.
3. **Linux**: first run the server as a service too; one started in a chat
   stops with the chat, and every poll after that finds no tracker.
   `~/.config/systemd/user/sg-stay-where.service`:
   ```ini
   [Unit]
   Description=sg-stay-where server
   [Service]
   WorkingDirectory=<repo>
   ExecStart=/usr/bin/env node --no-warnings=ExperimentalWarning <repo>/src/cli.js serve
   Restart=on-failure
   [Install]
   WantedBy=default.target
   ```
   Stop any `npm start` first, then `systemctl --user enable --now sg-stay-where.service`.
   Then write `~/.config/systemd/user/sg-stay-where-poll.service`:
   ```ini
   [Unit]
   Description=sg-stay-where poll
   [Service]
   Type=oneshot
   WorkingDirectory=<repo>
   Environment=SSW_AGENT=claude
   ExecStart=/usr/bin/env node --no-warnings=ExperimentalWarning <repo>/src/cli.js poll
   ```
   and `~/.config/systemd/user/sg-stay-where-poll.timer`:
   ```ini
   [Unit]
   Description=sg-stay-where poll every 2 hours
   [Timer]
   OnCalendar=0/2:00
   Persistent=true
   [Install]
   WantedBy=timers.target
   ```
   Then `systemctl --user daemon-reload && systemctl --user enable --now sg-stay-where-poll.timer`,
   and check `systemctl --user list-timers`. It runs in the user's desktop
   session, where Chrome is.
4. **Windows** (PowerShell): `$env:SSW_AGENT = "<agent>"`, then
   `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 poll`
   (`both` also runs the server, at sign-in, restarted if it stops). Check it with
   `Get-ScheduledTaskInfo sg-stay-where-poll` (`LastRunTime`, `LastTaskResult`).
   The tasks keep the agent and the Node and agent folders found at install time;
   re-run the installer after changing either.
   Tasks run only while the user is signed in, where Chrome is.
5. **Check it in the app.** The header shows "Polled 2h ago". An amber "Polls
   stalled" means a job exists but nothing ran for 4 hours: look at the newest
   log in `data/poll-logs/`, and check the computer was on and Chrome open.
6. **Change the agent**: re-run step 2 or 4, or edit the Linux service and restart the timer.
7. **Remove**: macOS `launchctl bootout gui/$(id -u)/sg-stay-where.poll` and
   `rm ~/Library/LaunchAgents/sg-stay-where.poll.plist`; Linux
   `systemctl --user disable --now sg-stay-where-poll.timer` and delete the poll
   unit files (`sg-stay-where.service` is the server; remove it only when
   uninstalling); Windows `Unregister-ScheduledTask sg-stay-where-poll -Confirm:$false`.

Polls on demand only: no job. The header's Poll now button starts one poll in
the background; the user doesn't need a chat open.
