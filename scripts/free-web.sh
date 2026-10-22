#!/bin/sh
# One free web server: workflow engine, worker, and API in the same machine.
set -eu

temporal server start-dev --headless --ip 127.0.0.1 --port 7233 --db-filename /tmp/temporal.db &

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

pnpm --filter @shipfix/worker start:prod &
exec pnpm --filter @shipfix/api start:prod
