---
name: uninstall
description: Shut sg-stay-where down and remove it from the user's machine: background services, scheduled polls, the WhatsApp link and session, remote access, data and the repo. Use when the user wants to stop using it, start over, or clean up.
---

# Shut down and remove

Ask what the user wants removed and confirm each deletion before running it.
Nothing here can be undone without a backup.

1. **Backup, if they want one.** `data/` holds projects, listings, chats and
   photos: `cp -R data ~/sg-stay-where-backup-$(date +%Y%m%d)`. Tell them it
   contains private chats.
2. **Stop polls and the server.**
   - macOS: `launchctl bootout gui/$(id -u)/sg-stay-where.poll`,
     `launchctl bootout gui/$(id -u)/sg-stay-where.server`, then
     `rm ~/Library/LaunchAgents/sg-stay-where.*.plist`.
   - Linux: `systemctl --user disable --now sg-stay-where-poll.timer sg-stay-where.service`,
     then delete those unit files in `~/.config/systemd/user/` (or remove a cron line).
   - Windows: `Unregister-ScheduledTask sg-stay-where-poll, sg-stay-where-server -Confirm:$false`.
   - Stop any `npm start` still running.
3. **Unlink WhatsApp.** The user does this on their phone: WhatsApp → Settings →
   Linked devices → the sg-stay-where device → Log out.
4. **Delete the WhatsApp session.** The user runs this themselves; agents never
   open or touch that folder: `rm -rf ~/.config/sg-stay-where/`, plus the
   folder in `SSW_WA_AUTH_DIR` if they set one.
5. **Remote access.** If they set up Tailscale for their phone:
   `tailscale serve status`, then `tailscale serve --https=8431 off` (or the
   port it shows).
6. **Delete the data.** `rm -rf data data-demo`.
7. **Browser and agents.** Remove the bookmarklet if they added one, and any
   browser tool they configured only for polls. Chrome itself stays.
8. **Delete the repo** last, from outside it: `rm -rf <path>/sg-stay-where`.
   The user runs this if you are working inside the folder.
9. **Report** what was removed, what is left, and where the backup is.
