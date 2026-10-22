#!/bin/sh
# One free web server: workflow engine, worker, and API in the same machine.
set -eu

# Restart the workflow engine if it exits. The website otherwise keeps
# accepting runs that nobody can execute.
while true; do
  temporal server start-dev --headless --ip 127.0.0.1 --port 7233 --db-filename /tmp/temporal.db || echo "workflow engine exited; starting it again" >&2
  sleep 2
done &

ready=0
i=0
while [ "$i" -lt 60 ]; do
  if temporal operator cluster health --address 127.0.0.1:7233 >/dev/null 2>&1; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "workflow engine did not start" >&2
  exit 1
fi

i=0
while [ "$i" -lt 60 ]; do
  if temporal operator namespace describe --namespace default --address 127.0.0.1:7233 >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

# The worker exits for good if its first connection to the workflow engine
# times out. Keep it running or accepted deploys sit with nobody to execute them.
while true; do
  pnpm --filter @shipfix/worker start:prod || echo "worker exited; starting it again" >&2
  sleep 3
done &

exec pnpm --filter @shipfix/api start:prod
