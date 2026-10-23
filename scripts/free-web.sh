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

# A workflow engine that stops answering (without exiting) leaves a run
# spinning on the next step forever. Start this only after the first boot
# has succeeded, and require two minutes of failed checks so a slow answer
# during startup does not kill a healthy engine.
(
  misses=0
  sleep 90
  while true; do
    sleep 20
    if timeout 8 temporal operator cluster health --address 127.0.0.1:7233 >/dev/null 2>&1; then
      misses=0
      continue
    fi
    misses=$((misses + 1))
    if [ "$misses" -lt 6 ]; then
      continue
    fi
    echo "workflow engine is not answering; restarting it" >&2
    for proc in /proc/[0-9]*; do
      pid=${proc#/proc/}
      cmd=$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)
      case "$cmd" in
        *"temporal server start-dev"*) kill "$pid" 2>/dev/null || true ;;
      esac
      cwd=$(readlink "$proc/cwd" 2>/dev/null || true)
      case "$cwd" in
        */apps/worker|*/apps/worker/*) kill "$pid" 2>/dev/null || true ;;
      esac
    done
    misses=0
    sleep 90
  done
) &

# The worker exits for good if its first connection to the workflow engine
# times out. Keep it running or accepted deploys sit with nobody to execute them.
while true; do
  pnpm --filter @shipfix/worker start:prod || echo "worker exited; starting it again" >&2
  sleep 3
done &

exec pnpm --filter @shipfix/api start:prod
