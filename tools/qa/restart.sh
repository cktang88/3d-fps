#!/bin/bash
# Restart the shared QA runner cleanly (in-flight jobs are re-queued automatically).
cd "$(dirname "$0")/../.."
LOG=${QA_LOG:-/tmp/qa_runner.log}
PID=$(pgrep -f "^node tools/qa/runner.mjs")
if [ -n "$PID" ]; then kill -TERM $PID; for i in $(seq 1 20); do kill -0 $PID 2>/dev/null || break; sleep 0.5; done; kill -9 $PID 2>/dev/null; fi
# Reap any browser/Xvfb orphaned by a hard kill.
ps -eo pid,ppid,cmd | grep -E "[c]hromium|[X]vfb :9" | awk '$2==1{print $1}' | xargs -r kill -9
echo "--- restart $(date +%T)" >> "$LOG"
exec node tools/qa/runner.mjs >> "$LOG" 2>&1
