#!/bin/zsh
# Scheduled jobs installed before `npm run poll` existed call this; it runs the same poll.
cd "${0:A:h}/.." || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
exec node --no-warnings=ExperimentalWarning src/cli.js poll
