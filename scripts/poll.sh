#!/bin/zsh
# One unattended poll (see docs/polling.md): a coding agent runs
# scripts/poll-prompt.md with its browser tool. Safe to run by hand.
#   SSW_AGENT        claude (default) or codex
#   SSW_POLL_PROMPT  prompt file (default scripts/poll-prompt.md)
#   SSW_DATA_DIR     where the lock and poll-logs/ go (default data)
set -u
cd "${0:A:h}/.."
data=${SSW_DATA_DIR:-data}
mkdir -p "$data/poll-logs"
lock=$data/poll.lock
if [[ -e $lock ]] && kill -0 "$(cat $lock)" 2>/dev/null; then
  echo "poll already running (pid $(cat $lock))"; exit 0
fi
echo $$ > $lock
trap 'rm -f $lock' EXIT

# Back-to-back polls look like a burst to the sites (Cloudflare checks follow).
last_file=$data/poll.last
now=$(date +%s)
if [[ -z ${SSW_POLL_GAP_CHECKED:-} && -f $last_file ]]; then
  mins=$(( (now - $(cat $last_file)) / 60 ))
  if (( mins < 20 )); then
    echo "skipped: last poll started $mins min ago; polls start at least 20 minutes apart"; exit 0
  fi
fi
echo $now > $last_file

log="$data/poll-logs/$(date +%Y%m%d-%H%M).log"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
prompt=$(cat "${SSW_POLL_PROMPT:-scripts/poll-prompt.md}")
agent=${SSW_AGENT:-claude}

# Each agent's non-interactive mode with its closest tool restriction.
# Only Claude can limit shell commands to the tracker's CLI; see docs/polling.md.
case $agent in
  # The prompt goes first: --allowedTools takes every argument after it.
  claude) cmd=(claude -p "$prompt" --chrome
            --allowedTools "mcp__claude-in-chrome" "Read" "Bash(node src/cli.js api:*)" "Bash(node src/cli.js attach:*)") ;;
  # The sandbox blocks 127.0.0.1 unless network access is on.
  # --approve-for-me lets Codex's own reviewer approve its Chrome tool; network reaches 127.0.0.1.
  codex)  cmd=(codex exec --approve-for-me -c sandbox_workspace_write.network_access=true "$prompt") ;;
  *) echo "SSW_AGENT must be claude or codex (got '$agent')" >&2; exit 2 ;;
esac

# stdout is the agent's final report; progress and errors go to the .err log.
"${cmd[@]}" < /dev/null > "$log" 2> "${log%.log}.err.log"
code=$?
[[ -s ${log%.log}.err.log ]] || rm -f "${log%.log}.err.log"

headline=$(cat "$log" "${log%.log}.err.log" 2>/dev/null | grep -v '^\s*$' | grep -v '^Warning:' | head -1 | cut -c1-180)
if [[ $(uname) == Darwin ]]; then
  osascript -e "display notification \"${headline//\"/'}\" with title \"sg-stay-where poll ($agent)\"" 2>/dev/null
fi
echo "exit $code, log $log"
exit $code
